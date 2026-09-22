/**
 * Plaid transaction sync engine.
 * Implements the /transactions/sync cursor-based approach.
 *
 * Pipeline:
 * 1. Decrypt the access token from private.plaid_tokens
 * 2. Reconcile `accounts` against Plaid so the account map is complete
 * 3. Call Plaid /transactions/sync with the cursor
 * 4. Upsert added/modified transactions, soft-delete removed ones
 * 5. Commit the cursor and mark the item healthy — only if every transaction
 *    was mapped to an account and written
 *
 * The invariant that matters: the cursor is committed only after the rows on
 * that page are durably stored. /transactions/sync never re-offers a page, so
 * advancing past unwritten rows loses them permanently.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { AccountBase, RemovedTransaction, Transaction as PlaidTransaction } from 'plaid';
import { getPlaidClient } from './client';
import { refreshAccountsForItem } from './accounts';
import {
  extractPlaidError,
  requiresReauth,
  UnknownAccountError,
  UNMAPPED_ACCOUNT_ERROR_CODE,
} from './errors';
import { decrypt } from '../crypto';
import { logger } from '../logger';
import { writeAuditLog } from '../audit';

export interface SyncResult {
  /** Rows actually written to `transactions`, not the size of Plaid's page. */
  added: number;
  modified: number;
  removed: number;
  cursor: string;
  /** plaid_account_ids created by the pre-sync account refresh. */
  createdAccounts: string[];
}

/**
 * Sync transactions for a single plaid_item.
 * Uses cursor-based pagination to get incremental updates.
 *
 * @param supabase - Service role client (bypasses RLS)
 * @param plaidItemDbId - The UUID of the plaid_items row
 * @param userId - The owning user's ID
 * @param entityId - The entity this item belongs to
 */
export async function syncTransactionsForItem(
  supabase: SupabaseClient,
  plaidItemDbId: string,
  userId: string,
  entityId: string
): Promise<SyncResult> {
  const plaidClient = getPlaidClient();

  // 1. Get the current cursor and plaid_item_id
  const { data: plaidItem, error: itemError } = await supabase
    .from('plaid_items')
    .select('plaid_item_id, transactions_cursor')
    .eq('id', plaidItemDbId)
    .single();

  if (itemError || !plaidItem) {
    throw new Error(`Failed to fetch plaid_item ${plaidItemDbId}: ${itemError?.message}`);
  }

  // 2. Decrypt the access token via RPC (private schema not exposed via PostgREST)
  const { data: encryptedToken, error: tokenError } = await supabase
    .rpc('get_plaid_token', { p_plaid_item_id: plaidItemDbId });

  if (tokenError || !encryptedToken) {
    throw new Error(`Failed to fetch token for plaid_item ${plaidItemDbId}: ${tokenError?.message}`);
  }

  const accessToken = decrypt(encryptedToken);

  // 3. Reconcile accounts with Plaid BEFORE ingesting anything, so the map
  //    covers accounts added or reissued since the last run. Building it from
  //    whatever rows happened to exist is what silently dropped 254 Capital One
  //    transactions after a relink changed the item's account_ids.
  const { accountMap, deletedAccountIds, createdAccountIds } = await refreshAccountsForItem(
    supabase,
    plaidClient,
    accessToken,
    plaidItemDbId,
    userId,
    entityId
  );

  // 4. Paginate through /transactions/sync
  let cursor = plaidItem.transactions_cursor || '';
  let hasMore = true;
  let totalAdded = 0;
  let totalModified = 0;
  let totalRemoved = 0;
  let latestAccounts: AccountBase[] = [];

  while (hasMore) {
    const response = await plaidClient.transactionsSync({
      access_token: accessToken,
      cursor: cursor || undefined,
      count: 500,
    });

    const { added, modified, removed, next_cursor, has_more } = response.data;
    latestAccounts = response.data.accounts;

    if (added.length > 0) {
      totalAdded += await upsertTransactions(
        supabase, added, userId, entityId, accountMap, plaidItemDbId, deletedAccountIds
      );
    }

    if (modified.length > 0) {
      totalModified += await upsertTransactions(
        supabase, modified, userId, entityId, accountMap, plaidItemDbId, deletedAccountIds
      );
    }

    if (removed.length > 0) {
      await softDeleteTransactions(supabase, removed);
      totalRemoved += removed.length;
    }

    cursor = next_cursor;
    hasMore = has_more;
  }

  // Persist account balances from the sync response. Non-fatal per account:
  // transactions are already synced, so log failures and continue.
  const balanceUpdatedAt = new Date().toISOString();
  for (const plaidAcct of latestAccounts) {
    const accountId = accountMap.get(plaidAcct.account_id);
    if (!accountId) continue;

    const { error: balanceError } = await supabase
      .from('accounts')
      .update({
        current_balance: plaidAcct.balances.current,
        available_balance: plaidAcct.balances.available,
        updated_at: balanceUpdatedAt,
      })
      .eq('id', accountId);

    if (balanceError) {
      logger.error('Failed to update account balance from sync response', {
        plaid_item_id: plaidItemDbId,
        account_id: accountId,
        error_message: balanceError.message,
      });
    }
  }

  // 5. Commit the cursor and mark the item healthy.
  //
  //    Reached only when every transaction on every page mapped to an account
  //    and was written — upsertTransactions throws otherwise — so stamping
  //    last_successful_sync here genuinely means "this data is stored".
  //
  //    `status` is reset alongside the error fields. Without it an item that
  //    crossed the failure threshold stayed 'degraded' forever, which is why
  //    healthy items read degraded with error_count 0 and last_error_code NULL.
  const { error: updateError } = await supabase
    .from('plaid_items')
    .update({
      transactions_cursor: cursor,
      last_successful_sync: new Date().toISOString(),
      status: 'connected',
      last_error_code: null,
      error_count: 0,
    })
    .eq('id', plaidItemDbId);

  if (updateError) {
    // The rows are stored but the cursor is not. Failing loudly is correct:
    // a silent miss here would re-deliver this page next run, and the caller
    // needs to record the failure rather than report a clean sync.
    logger.error('Failed to commit plaid_item cursor after successful ingest', {
      plaid_item_id: plaidItemDbId,
      error_message: updateError.message,
    });
    throw new Error(
      `Ingest succeeded but cursor commit failed for plaid_item ${plaidItemDbId}: ${updateError.message}`
    );
  }

  // 6. Refresh account balances via /accounts/balance/get so the stored
  //    snapshot (and its updated_at) stays fresh. Non-fatal: transactions are
  //    already synced, so surface failures for monitoring without failing the run.
  try {
    const balanceResponse = await plaidClient.accountsBalanceGet({
      access_token: accessToken,
    });

    const nowIso = new Date().toISOString();
    for (const acct of balanceResponse.data.accounts) {
      const accountId = accountMap.get(acct.account_id);
      if (!accountId) continue;

      const { error: balanceUpdateError } = await supabase
        .from('accounts')
        .update({
          current_balance: acct.balances.current,
          available_balance: acct.balances.available,
          updated_at: nowIso,
        })
        .eq('id', accountId);

      if (balanceUpdateError) {
        logger.error('Failed to update account balance', {
          plaid_item_id: plaidItemDbId,
          account_id: accountId,
          error_message: balanceUpdateError.message,
        });
      }
    }
  } catch (balanceError) {
    logger.warn('Failed to refresh account balances', {
      plaid_item_id: plaidItemDbId,
      error_message: String(balanceError),
    });
  }

  // 7. Audit log
  await writeAuditLog(supabase, {
    userId,
    action: 'PLAID_SYNC_COMPLETED',
    entityType: 'plaid_item',
    entityId: plaidItemDbId,
    details: {
      // Rows actually written, not the size of the page Plaid returned.
      added: totalAdded,
      modified: totalModified,
      removed: totalRemoved,
      cursor_updated: true,
      accounts_created: createdAccountIds.length,
    },
  });

  logger.info('Transaction sync completed', {
    plaid_item_id: plaidItemDbId,
    added: totalAdded,
    modified: totalModified,
    removed: totalRemoved,
  });

  return {
    added: totalAdded,
    modified: totalModified,
    removed: totalRemoved,
    cursor,
    createdAccounts: createdAccountIds,
  };
}

/**
 * Upsert transactions from Plaid into the transactions table.
 * Uses plaid_transaction_id as the unique key for conflict resolution.
 *
 * Returns the number of rows actually written. Callers accumulate that rather
 * than the length of Plaid's array, so a sync can no longer report `added: 254`
 * while storing nothing.
 *
 * Throws UnknownAccountError if any transaction references a plaid_account_id
 * that is neither mapped nor deliberately soft-deleted. By this point
 * `refreshAccountsForItem` has already reconciled with Plaid, so an unmapped id
 * means something we genuinely do not understand — and dropping it would lose
 * the transaction for good once the cursor advances past its page.
 *
 * Transactions for a soft-deleted account are skipped without error: that row
 * was removed on purpose, so excluding its data is the intended behaviour and
 * must not fail the whole item's sync.
 */
async function upsertTransactions(
  supabase: SupabaseClient,
  transactions: PlaidTransaction[],
  userId: string,
  entityId: string,
  accountMap: Map<string, string>,
  plaidItemDbId: string,
  deletedAccountIds: Set<string>
): Promise<number> {
  const unknownAccountIds = new Set<string>();
  const rows = [];
  let skippedDeleted = 0;

  for (const txn of transactions) {
    const accountId = accountMap.get(txn.account_id);
    if (!accountId) {
      if (deletedAccountIds.has(txn.account_id)) {
        skippedDeleted++;         // intentionally excluded account
        continue;
      }
      unknownAccountIds.add(txn.account_id);
      continue;
    }

    rows.push({
      user_id: userId,
      entity_id: entityId,
      account_id: accountId,
      plaid_transaction_id: txn.transaction_id,
      amount: txn.amount,
      date: txn.date,
      merchant_name: txn.merchant_name || txn.name || null,
      plaid_category: txn.category || null,
      is_recurring:
        txn.personal_finance_category?.primary === 'LOAN_PAYMENTS' ||
        txn.personal_finance_category?.primary === 'RENT_AND_UTILITIES' ||
        false,
    });
  }

  // Abort before writing anything: a partial write followed by a thrown error
  // would leave the cursor uncommitted anyway, and re-running re-delivers the
  // whole page, so writing nothing keeps the retry clean.
  if (unknownAccountIds.size > 0) {
    const dropped = transactions.length - rows.length - skippedDeleted;
    logger.error('Plaid returned transactions for unmapped accounts — aborting sync', {
      plaid_item_id: plaidItemDbId,
      unknown_account_ids: Array.from(unknownAccountIds),
      dropped_count: dropped,
    });
    throw new UnknownAccountError(plaidItemDbId, Array.from(unknownAccountIds), dropped);
  }

  if (skippedDeleted > 0) {
    logger.info('Skipped transactions for soft-deleted accounts', {
      plaid_item_id: plaidItemDbId,
      skipped_count: skippedDeleted,
    });
  }

  if (rows.length === 0) return 0;

  const { error } = await supabase
    .from('transactions')
    .upsert(rows, {
      onConflict: 'plaid_transaction_id',
      ignoreDuplicates: false,
    });

  if (error) {
    logger.error('Failed to upsert transactions', {
      error_message: error.message,
      count: rows.length,
    });
    throw new Error(`Transaction upsert failed: ${error.message}`);
  }

  return rows.length;
}

/**
 * Soft-delete transactions that Plaid reports as removed.
 */
async function softDeleteTransactions(
  supabase: SupabaseClient,
  removed: RemovedTransaction[]
): Promise<void> {
  const plaidIds = removed
    .map((r) => r.transaction_id)
    .filter((id): id is string => !!id);

  if (plaidIds.length === 0) return;

  const { error } = await supabase
    .from('transactions')
    .update({ deleted_at: new Date().toISOString() })
    .in('plaid_transaction_id', plaidIds);

  if (error) {
    logger.error('Failed to soft-delete transactions', {
      error_message: error.message,
      count: plaidIds.length,
    });
  }
}

/**
 * Record a sync failure on a plaid_item.
 *
 * `errorCode` must be a real Plaid error_code where one exists — use
 * `extractPlaidError` at the call site rather than passing an invented literal.
 * The code is what decides the item's fate, so a constant like the old
 * 'HEAL_SYNC_ERROR' made every failure look identical and left items retrying
 * a login problem nightly forever.
 *
 * Escalation:
 *   - a code in REAUTH_ERROR_CODES  → `reauth_required` immediately, on the
 *     first occurrence. These never self-heal, so counting to five first just
 *     delays the only action that can fix it — asking the user to re-link.
 *   - otherwise, `degraded` once consecutive failures reach ERROR_THRESHOLD.
 */
export async function recordSyncFailure(
  supabase: SupabaseClient,
  plaidItemDbId: string,
  userId: string,
  errorCode: string,
  errorMessage?: string
): Promise<void> {
  const { data: item } = await supabase
    .from('plaid_items')
    .select('error_count')
    .eq('id', plaidItemDbId)
    .single();

  const newErrorCount = (item?.error_count || 0) + 1;
  const ERROR_THRESHOLD = 5;

  const updates: Record<string, unknown> = {
    last_error_code: errorCode,
    error_count: newErrorCount,
  };

  const needsReauth = requiresReauth(errorCode);
  if (needsReauth) {
    updates.status = 'reauth_required';
  } else if (newErrorCount >= ERROR_THRESHOLD) {
    updates.status = 'degraded';
  }

  await supabase
    .from('plaid_items')
    .update(updates)
    .eq('id', plaidItemDbId);

  await writeAuditLog(supabase, {
    userId,
    action: 'PLAID_SYNC_FAILED',
    entityType: 'plaid_item',
    entityId: plaidItemDbId,
    details: {
      error_code: errorCode,
      error_count: newErrorCount,
      error_message: errorMessage ?? null,
      escalated_to: updates.status ?? null,
    },
  });

  logger.warn('Recorded Plaid sync failure', {
    plaid_item_id: plaidItemDbId,
    error_code: errorCode,
    error_count: newErrorCount,
    escalated_to: updates.status ?? null,
  });
}

/**
 * Record a failed sync from a thrown error, resolving the right error code.
 *
 * An UnknownAccountError is our own fault rather than Plaid's, so it is
 * recorded under a local sentinel instead of a Plaid code — it must not
 * escalate the item to `reauth_required`, because re-linking would not fix it.
 */
export async function recordSyncFailureFromError(
  supabase: SupabaseClient,
  plaidItemDbId: string,
  userId: string,
  error: unknown
): Promise<string> {
  if (error instanceof UnknownAccountError) {
    await recordSyncFailure(
      supabase,
      plaidItemDbId,
      userId,
      UNMAPPED_ACCOUNT_ERROR_CODE,
      error.message
    );
    return UNMAPPED_ACCOUNT_ERROR_CODE;
  }

  const { errorCode, errorMessage } = extractPlaidError(error);
  await recordSyncFailure(supabase, plaidItemDbId, userId, errorCode, errorMessage);
  return errorCode;
}
