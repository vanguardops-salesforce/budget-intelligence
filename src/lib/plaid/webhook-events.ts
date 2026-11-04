/**
 * Classification and handling of stored Plaid webhook events.
 *
 * The processor used to filter pending events with
 *   .in('webhook_type', ['TRANSACTIONS', 'INITIAL_UPDATE', 'HISTORICAL_UPDATE', 'DEFAULT_UPDATE'])
 * but the last three are webhook *codes*, not types — the column only ever
 * holds 'TRANSACTIONS' or 'ITEM' for these. Three of the four entries matched
 * nothing and 'ITEM' was absent, so no ITEM event was ever processed: an
 * ITEM/ERROR from 2026-08-14 and an ITEM/NEW_ACCOUNTS_AVAILABLE from
 * 2026-08-17 (almost certainly the missing card) both sat 'pending' for weeks.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { PlaidApi } from 'plaid';
import { refreshAccountsForItem } from './accounts';
import { requiresReauth } from './errors';
import { logger } from '../logger';
import { writeAuditLog } from '../audit';

/** Webhook types the processor consumes. These are real `webhook_type` values. */
export const PROCESSED_WEBHOOK_TYPES = ['TRANSACTIONS', 'ITEM'] as const;

/**
 * TRANSACTIONS codes that mean "there is new transaction data to pull".
 * Everything else under TRANSACTIONS is informational.
 */
export const TRANSACTION_SYNC_CODES: ReadonlySet<string> = new Set([
  'SYNC_UPDATES_AVAILABLE',
  'INITIAL_UPDATE',
  'HISTORICAL_UPDATE',
  'DEFAULT_UPDATE',
  'TRANSACTIONS_REMOVED',
]);

export type EventAction =
  /** Run /transactions/sync for the item. */
  | 'sync'
  /** Re-read the item's accounts from Plaid. */
  | 'refresh_accounts'
  /** Apply the item error carried in the payload. */
  | 'item_error'
  /** The item was repaired in Link — clear its error state. */
  | 'login_repaired'
  /** Recognised but nothing to do. */
  | 'noop';

/**
 * Decide what a stored event requires, from its type and code alone.
 * Pure, so the routing table is unit-testable without a database.
 */
export function classifyWebhookEvent(
  webhookType: string,
  webhookCode: string
): EventAction {
  if (webhookType === 'TRANSACTIONS') {
    return TRANSACTION_SYNC_CODES.has(webhookCode) ? 'sync' : 'noop';
  }

  if (webhookType === 'ITEM') {
    switch (webhookCode) {
      case 'ERROR':
        return 'item_error';
      case 'NEW_ACCOUNTS_AVAILABLE':
        return 'refresh_accounts';
      case 'LOGIN_REPAIRED':
        return 'login_repaired';
      case 'PENDING_EXPIRATION':
      case 'PENDING_DISCONNECT':
        return 'item_error';
      default:
        return 'noop';
    }
  }

  return 'noop';
}

/**
 * Read the Plaid error_code out of a stored webhook payload.
 *
 * PENDING_EXPIRATION / PENDING_DISCONNECT carry no `error` object — the code
 * itself is the condition, so it is used directly.
 */
export function errorCodeFromPayload(
  payload: Record<string, unknown> | null | undefined,
  webhookCode: string
): string {
  const errorObj = payload?.error as Record<string, unknown> | undefined;
  const code = errorObj?.error_code;
  if (typeof code === 'string' && code) return code;
  if (webhookCode === 'PENDING_EXPIRATION' || webhookCode === 'PENDING_DISCONNECT') {
    return webhookCode;
  }
  return 'UNKNOWN';
}

/** Map a Plaid item error code to the status the item should carry. */
export function statusForErrorCode(errorCode: string): 'reauth_required' | 'degraded' {
  return requiresReauth(errorCode) ? 'reauth_required' : 'degraded';
}

export interface ItemContext {
  id: string;
  user_id: string;
  entity_id: string;
}

/**
 * Apply an ITEM/ERROR (or pending-expiration) event to the item.
 * Escalates to reauth_required for codes that only the user can clear.
 */
export async function applyItemError(
  supabase: SupabaseClient,
  item: ItemContext,
  payload: Record<string, unknown> | null | undefined,
  webhookCode: string
): Promise<string> {
  const errorCode = errorCodeFromPayload(payload, webhookCode);
  const status = statusForErrorCode(errorCode);

  await supabase
    .from('plaid_items')
    .update({ status, last_error_code: errorCode })
    .eq('id', item.id);

  await writeAuditLog(supabase, {
    userId: item.user_id,
    action: 'PLAID_ITEM_ERROR',
    entityType: 'plaid_item',
    entityId: item.id,
    details: { error_code: errorCode, webhook_code: webhookCode, status },
  });

  logger.warn('Applied Plaid item error from webhook', {
    plaid_item_id: item.id,
    error_code: errorCode,
    status,
  });

  return errorCode;
}

/**
 * Handle ITEM/LOGIN_REPAIRED: Plaid repaired the login without our relink flow
 * (for example the user fixed it in another client). Reconcile accounts, then
 * clear the error state.
 */
export async function applyLoginRepaired(
  supabase: SupabaseClient,
  plaidClient: PlaidApi,
  accessToken: string,
  item: ItemContext
): Promise<number> {
  const { createdAccountIds } = await refreshAccountsForItem(
    supabase,
    plaidClient,
    accessToken,
    item.id,
    item.user_id,
    item.entity_id
  );

  await supabase
    .from('plaid_items')
    .update({ status: 'connected', last_error_code: null, error_count: 0 })
    .eq('id', item.id);

  await writeAuditLog(supabase, {
    userId: item.user_id,
    action: 'PLAID_ITEM_RELINKED',
    entityType: 'plaid_item',
    entityId: item.id,
    details: { source: 'LOGIN_REPAIRED webhook', accounts_created: createdAccountIds.length },
  });

  logger.info('Item repaired via LOGIN_REPAIRED webhook', {
    plaid_item_id: item.id,
    accounts_created: createdAccountIds.length,
  });

  return createdAccountIds.length;
}

/**
 * Handle ITEM/NEW_ACCOUNTS_AVAILABLE: the institution exposed an account the
 * item does not yet carry. Pull it in so its transactions can be mapped.
 */
export async function applyNewAccountsAvailable(
  supabase: SupabaseClient,
  plaidClient: PlaidApi,
  accessToken: string,
  item: ItemContext
): Promise<number> {
  const { createdAccountIds } = await refreshAccountsForItem(
    supabase,
    plaidClient,
    accessToken,
    item.id,
    item.user_id,
    item.entity_id
  );

  if (createdAccountIds.length > 0) {
    await writeAuditLog(supabase, {
      userId: item.user_id,
      action: 'PLAID_ACCOUNTS_DISCOVERED',
      entityType: 'plaid_item',
      entityId: item.id,
      details: { accounts_created: createdAccountIds.length },
    });
  }

  logger.info('Processed NEW_ACCOUNTS_AVAILABLE', {
    plaid_item_id: item.id,
    accounts_created: createdAccountIds.length,
  });

  return createdAccountIds.length;
}
