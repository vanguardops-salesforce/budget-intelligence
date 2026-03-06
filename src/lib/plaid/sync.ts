import { type SupabaseClient } from '@supabase/supabase-js';
import { getPlaidClient } from './client';
import { decrypt } from '../crypto';
import { logger } from '../logger';
import type { PlaidItem } from '../types';

export interface SyncResult {
  added: number;
  modified: number;
  removed: number;
  cursor: string;
}

/**
 * Sync transactions for a single Plaid item using /transactions/sync.
 * Uses cursor-based pagination to fetch incremental updates.
 *
 * @param supabase - Service role client (bypasses RLS)
 * @param plaidItem - The plaid_items row
 * @param encryptedAccessToken - Encrypted access token from private.plaid_tokens
 */
export async function syncTransactionsForItem(
  supabase: SupabaseClient,
  plaidItem: PlaidItem,
  encryptedAccessToken: string
): Promise<SyncResult> {
  const plaid = getPlaidClient();
  const accessToken = decrypt(encryptedAccessToken);

  let cursor = plaidItem.transactions_cursor ?? undefined;
  let added = 0;
  let modified = 0;
  let removed = 0;
  let hasMore = true;

  while (hasMore) {
    const response = await plaid.transactionsSync({
      access_token: accessToken,
      cursor,
      count: 500,
    });

    const data = response.data;

    // Process added transactions
    if (data.added.length > 0) {
      const plaidAccountIds = Array.from(new Set(data.added.map((t) => t.account_id)));
      const { data: accountMap } = await supabase
        .from('accounts')
        .select('id, plaid_account_id')
        .in('plaid_account_id', plaidAccountIds);

      const accountLookup = new Map(
        (accountMap ?? []).map((a: { id: string; plaid_account_id: string }) => [a.plaid_account_id, a.id])
      );

      const rows = data.added
        .map((txn) => ({
          user_id: plaidItem.user_id,
          entity_id: plaidItem.entity_id,
          account_id: accountLookup.get(txn.account_id) ?? null,
          plaid_transaction_id: txn.transaction_id,
          amount: txn.amount,
          date: txn.date,
          merchant_name: txn.merchant_name ?? txn.name ?? null,
          plaid_category: txn.personal_finance_category
            ? { primary: txn.personal_finance_category.primary, detailed: txn.personal_finance_category.detailed }
            : null,
          is_recurring: false,
        }))
        .filter((row) => row.account_id !== null);

      if (rows.length > 0) {
        const { error } = await supabase
          .from('transactions')
          .upsert(rows, { onConflict: 'plaid_transaction_id' });

        if (error) {
          logger.error('Failed to upsert added transactions', {
            error_message: error.message,
            plaid_item_id: plaidItem.plaid_item_id,
            count: String(rows.length),
          });
        }
      }
      added += rows.length;
    }

    // Process modified transactions
    if (data.modified.length > 0) {
      for (const txn of data.modified) {
        const { error } = await supabase
          .from('transactions')
          .update({
            amount: txn.amount,
            date: txn.date,
            merchant_name: txn.merchant_name ?? txn.name ?? null,
            plaid_category: txn.personal_finance_category
              ? { primary: txn.personal_finance_category.primary, detailed: txn.personal_finance_category.detailed }
              : null,
          })
          .eq('plaid_transaction_id', txn.transaction_id);

        if (error) {
          logger.error('Failed to update modified transaction', {
            error_message: error.message,
            plaid_transaction_id: txn.transaction_id,
          });
        }
      }
      modified += data.modified.length;
    }

    // Process removed transactions (soft-delete)
    if (data.removed.length > 0) {
      const removedIds = data.removed
        .map((r) => r.transaction_id)
        .filter((id): id is string => id != null);

      if (removedIds.length > 0) {
        const { error } = await supabase
          .from('transactions')
          .update({ deleted_at: new Date().toISOString() })
          .in('plaid_transaction_id', removedIds);

        if (error) {
          logger.error('Failed to soft-delete removed transactions', {
            error_message: error.message,
            count: String(removedIds.length),
          });
        }
      }
      removed += removedIds.length;
    }

    cursor = data.next_cursor;
    hasMore = data.has_more;
  }

  // Update account balances
  await syncAccountBalances(supabase, plaidItem, accessToken);

  // Save cursor and update sync timestamp
  await supabase
    .from('plaid_items')
    .update({
      transactions_cursor: cursor,
      last_successful_sync: new Date().toISOString(),
      error_count: 0,
      last_error_code: null,
      status: 'connected',
    })
    .eq('id', plaidItem.id);

  logger.info('Transaction sync completed', {
    plaid_item_id: plaidItem.plaid_item_id,
    added: String(added),
    modified: String(modified),
    removed: String(removed),
  });

  return { added, modified, removed, cursor: cursor ?? '' };
}

/**
 * Fetch and update account balances from Plaid.
 */
async function syncAccountBalances(
  supabase: SupabaseClient,
  plaidItem: PlaidItem,
  accessToken: string
): Promise<void> {
  const plaid = getPlaidClient();

  try {
    const response = await plaid.accountsGet({ access_token: accessToken });

    for (const account of response.data.accounts) {
      await supabase
        .from('accounts')
        .update({
          current_balance: account.balances.current,
          available_balance: account.balances.available,
        })
        .eq('plaid_account_id', account.account_id);
    }
  } catch (error) {
    logger.error('Failed to sync account balances', {
      error_message: String(error),
      plaid_item_id: plaidItem.plaid_item_id,
    });
  }
}

/**
 * Get the encrypted access token for a plaid item.
 * Uses service role client to query private.plaid_tokens via RPC.
 */
export async function getEncryptedToken(
  supabase: SupabaseClient,
  plaidItemId: string
): Promise<string | null> {
  // Use raw SQL via rpc since private schema isn't exposed via PostgREST
  const { data, error } = await supabase.rpc('get_plaid_token', {
    p_plaid_item_id: plaidItemId,
  });

  if (error || !data) {
    logger.error('Failed to fetch encrypted token', {
      error_message: error?.message ?? 'No token found',
      plaid_item_id: plaidItemId,
    });
    return null;
  }

  return data;
}
