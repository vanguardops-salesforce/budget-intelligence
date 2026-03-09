/**
 * Plaid transaction sync engine.
 * Implements the /transactions/sync cursor-based approach.
 *
 * Pipeline:
 * 1. Decrypt the access token from private.plaid_tokens
 * 2. Call Plaid /transactions/sync with the cursor
 * 3. Upsert added/modified transactions, soft-delete removed ones
 * 4. Update the cursor and sync timestamp on plaid_items
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { RemovedTransaction, Transaction as PlaidTransaction } from 'plaid';
import { getPlaidClient } from './client';
import { decrypt } from '../crypto';
import { logger } from '../logger';
import { writeAuditLog } from '../audit';

export interface SyncResult {
  added: number;
  modified: number;
  removed: number;
  cursor: string;
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

  // 2. Decrypt the access token from private schema
  const { data: tokenRow, error: tokenError } = await supabase
    .schema('private')
    .from('plaid_tokens')
    .select('access_token_encrypted')
    .eq('plaid_item_id', plaidItemDbId)
    .single();

  if (tokenError || !tokenRow) {
    throw new Error(`Failed to fetch token for plaid_item ${plaidItemDbId}: ${tokenError?.message}`);
  }

  const accessToken = decrypt(tokenRow.access_token_encrypted);

  // 3. Build account lookup map (plaid_account_id → account UUID)
  const { data: accounts, error: acctError } = await supabase
    .from('accounts')
    .select('id, plaid_account_id')
    .eq('plaid_item_id', plaidItemDbId)
    .is('deleted_at', null);

  if (acctError) {
    throw new Error(`Failed to fetch accounts for plaid_item ${plaidItemDbId}: ${acctError.message}`);
  }

  const accountMap = new Map<string, string>();
  for (const acct of accounts || []) {
    accountMap.set(acct.plaid_account_id, acct.id);
  }

  // 4. Paginate through /transactions/sync
  let cursor = plaidItem.transactions_cursor || '';
  let hasMore = true;
  let totalAdded = 0;
  let totalModified = 0;
  let totalRemoved = 0;

  while (hasMore) {
    const response = await plaidClient.transactionsSync({
      access_token: accessToken,
      cursor: cursor || undefined,
      count: 500,
    });

    const { added, modified, removed, next_cursor, has_more } = response.data;

    if (added.length > 0) {
      await upsertTransactions(supabase, added, userId, entityId, accountMap);
      totalAdded += added.length;
    }

    if (modified.length > 0) {
      await upsertTransactions(supabase, modified, userId, entityId, accountMap);
      totalModified += modified.length;
    }

    if (removed.length > 0) {
      await softDeleteTransactions(supabase, removed);
      totalRemoved += removed.length;
    }

    cursor = next_cursor;
    hasMore = has_more;
  }

  // 5. Update cursor and sync timestamp
  const { error: updateError } = await supabase
    .from('plaid_items')
    .update({
      transactions_cursor: cursor,
      last_successful_sync: new Date().toISOString(),
      last_error_code: null,
      error_count: 0,
    })
    .eq('id', plaidItemDbId);

  if (updateError) {
    logger.error('Failed to update plaid_item cursor', {
      plaid_item_id: plaidItemDbId,
      error_message: updateError.message,
    });
  }

  // 6. Audit log
  await writeAuditLog(supabase, {
    userId,
    action: 'PLAID_SYNC_COMPLETED',
    entityType: 'plaid_item',
    entityId: plaidItemDbId,
    details: {
      added: totalAdded,
      modified: totalModified,
      removed: totalRemoved,
      cursor_updated: true,
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
  };
}

/**
 * Upsert transactions from Plaid into the transactions table.
 * Uses plaid_transaction_id as the unique key for conflict resolution.
 */
async function upsertTransactions(
  supabase: SupabaseClient,
  transactions: PlaidTransaction[],
  userId: string,
  entityId: string,
  accountMap: Map<string, string>
): Promise<void> {
  const rows = transactions
    .map((txn) => {
      const accountId = accountMap.get(txn.account_id);
      if (!accountId) {
        logger.warn('Unknown account_id in transaction, skipping', {
          plaid_account_id: txn.account_id,
          plaid_transaction_id: txn.transaction_id,
        });
        return null;
      }

      return {
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
      };
    })
    .filter(Boolean);

  if (rows.length === 0) return;

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
 * Increments error_count and marks item as degraded after 5 consecutive failures.
 */
export async function recordSyncFailure(
  supabase: SupabaseClient,
  plaidItemDbId: string,
  userId: string,
  errorCode: string
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

  if (newErrorCount >= ERROR_THRESHOLD) {
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
    details: { error_code: errorCode, error_count: newErrorCount },
  });
}
