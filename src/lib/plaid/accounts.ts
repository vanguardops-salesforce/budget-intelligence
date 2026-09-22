/**
 * Account reconciliation between Plaid and the `accounts` table.
 *
 * Every transaction write depends on mapping Plaid's `account_id` to our
 * `accounts.id`. When that map is missing an entry the transactions for it
 * cannot be stored — so the map has to be refreshed from Plaid before a sync
 * rather than built blindly from whatever rows happen to exist.
 *
 * This is what went wrong with Capital One item ccffe6d8 on 2026-09-22: the
 * 2026-09-21 relink left the item returning account_ids that had no `accounts`
 * row, the map came up empty for all of them, and the 254 transactions Plaid
 * returned were dropped while the cursor still advanced. The server-side
 * request log for that run shows the shape of it exactly — a GET on accounts,
 * then no POST to transactions and no PATCH to accounts at all, followed by the
 * cursor PATCH.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { AccountBase, PlaidApi } from 'plaid';
import { logger } from '../logger';

/** Plaid account types we accept; anything else is stored as 'other'. */
const KNOWN_ACCOUNT_TYPES = new Set(['depository', 'credit', 'investment', 'loan']);

function normalizeType(type: unknown): string {
  return typeof type === 'string' && KNOWN_ACCOUNT_TYPES.has(type) ? type : 'other';
}

export interface AccountRefreshResult {
  /** plaid_account_id → accounts.id, for active (non-deleted) accounts. */
  accountMap: Map<string, string>;
  /**
   * plaid_account_ids that exist but are soft-deleted. Their transactions are
   * skipped deliberately rather than treated as a mapping failure — the row was
   * removed on purpose, so refusing to sync the whole item would be wrong.
   */
  deletedAccountIds: Set<string>;
  /** plaid_account_ids that had no row before this refresh. */
  createdAccountIds: string[];
  /** Rows created plus rows refreshed. */
  upserted: number;
}

/**
 * Fetch the item's accounts from Plaid and upsert them, then return a fresh
 * plaid_account_id → accounts.id map built from the database.
 *
 * Upsert is keyed on `accounts.plaid_account_id` (UNIQUE), so an account that
 * already exists is updated in place and a newly-surfaced one — a card added
 * during an update-mode relink, or an id the institution reissued — is created.
 * That makes the unmapped-account failure self-healing rather than silent.
 *
 * Throws if Plaid or the upsert fails: callers must not proceed to ingest
 * transactions against a map they could not verify.
 */
export async function refreshAccountsForItem(
  supabase: SupabaseClient,
  plaidClient: PlaidApi,
  accessToken: string,
  plaidItemDbId: string,
  userId: string,
  entityId: string
): Promise<AccountRefreshResult> {
  const response = await plaidClient.accountsGet({ access_token: accessToken });
  const plaidAccounts: AccountBase[] = response.data.accounts ?? [];

  // Which plaid_account_ids do we already hold? Deleted rows are included:
  // their plaid_account_id still occupies the UNIQUE index, so inserting over
  // one would fail, and their transactions must be skipped rather than treated
  // as unmapped.
  const { data: existingRows, error: existingError } = await supabase
    .from('accounts')
    .select('id, plaid_account_id, deleted_at')
    .eq('plaid_item_id', plaidItemDbId);

  if (existingError) {
    throw new Error(
      `Failed to read existing accounts for plaid_item ${plaidItemDbId}: ${existingError.message}`
    );
  }

  const known = new Set((existingRows ?? []).map((r) => r.plaid_account_id as string));
  const nowIso = new Date().toISOString();

  // Creates and refreshes are handled separately, NOT as one blanket upsert.
  //
  // `accounts.entity_id` is user-owned: /api/accounts/assign-entity lets an
  // account be attributed to a different entity than its plaid_item. An upsert
  // that included entity_id would silently reset that assignment on every
  // nightly sync, so a refresh touches only Plaid-owned fields. user_id is
  // likewise never rewritten.
  const toCreate = plaidAccounts.filter((a) => !known.has(a.account_id));
  const toRefresh = plaidAccounts.filter((a) => known.has(a.account_id));

  if (toCreate.length > 0) {
    const { error: insertError } = await supabase.from('accounts').insert(
      toCreate.map((acct) => ({
        user_id: userId,
        entity_id: entityId,
        plaid_item_id: plaidItemDbId,
        plaid_account_id: acct.account_id,
        name: acct.name,
        official_name: acct.official_name || null,
        type: normalizeType(acct.type),
        subtype: acct.subtype || null,
        current_balance: acct.balances.current,
        available_balance: acct.balances.available,
        currency: acct.balances.iso_currency_code || 'USD',
        mask: acct.mask || null,
      }))
    );

    if (insertError) {
      throw new Error(
        `Failed to create accounts for plaid_item ${plaidItemDbId}: ${insertError.message}`
      );
    }

    logger.info('Discovered new Plaid accounts during refresh', {
      plaid_item_id: plaidItemDbId,
      created_count: toCreate.length,
    });
  }

  // Refresh Plaid-owned fields on accounts we already hold. Failures here are
  // not fatal: the map below is what the sync actually depends on, and stale
  // balances are surfaced by the Data Health stale-balance check.
  for (const acct of toRefresh) {
    const { error: updateError } = await supabase
      .from('accounts')
      .update({
        name: acct.name,
        official_name: acct.official_name || null,
        type: normalizeType(acct.type),
        subtype: acct.subtype || null,
        current_balance: acct.balances.current,
        available_balance: acct.balances.available,
        currency: acct.balances.iso_currency_code || 'USD',
        mask: acct.mask || null,
        updated_at: nowIso,
      })
      .eq('plaid_account_id', acct.account_id);

    if (updateError) {
      logger.error('Failed to refresh account from Plaid', {
        plaid_item_id: plaidItemDbId,
        plaid_account_id: acct.account_id,
        error_message: updateError.message,
      });
    }
  }

  // Rebuild the map from the database so it reflects what was actually stored,
  // including rows created by a concurrent run.
  const { data: accounts, error: mapError } = await supabase
    .from('accounts')
    .select('id, plaid_account_id, deleted_at')
    .eq('plaid_item_id', plaidItemDbId);

  if (mapError) {
    throw new Error(
      `Failed to rebuild account map for plaid_item ${plaidItemDbId}: ${mapError.message}`
    );
  }

  const accountMap = new Map<string, string>();
  const deletedAccountIds = new Set<string>();
  for (const acct of accounts ?? []) {
    const plaidAccountId = acct.plaid_account_id as string;
    if (acct.deleted_at) {
      deletedAccountIds.add(plaidAccountId);
    } else {
      accountMap.set(plaidAccountId, acct.id as string);
    }
  }

  return {
    accountMap,
    deletedAccountIds,
    createdAccountIds: toCreate.map((a) => a.account_id),
    upserted: toCreate.length + toRefresh.length,
  };
}
