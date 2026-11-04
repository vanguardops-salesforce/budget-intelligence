import { NextResponse } from 'next/server';
import { getSecrets } from '@/lib/env';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { syncTransactionsForItem, recordSyncFailureFromError } from '@/lib/plaid/sync';
import { getPlaidClient } from '@/lib/plaid/client';
import { decrypt } from '@/lib/crypto';
import {
  PROCESSED_WEBHOOK_TYPES,
  classifyWebhookEvent,
  applyItemError,
  applyLoginRepaired,
  applyNewAccountsAvailable,
  type EventAction,
} from '@/lib/plaid/webhook-events';
import { runDataHealthAudit } from '@/lib/audit/runner';
import { logger } from '@/lib/logger';

/**
 * Cron endpoint: Process pending webhook events and sync transactions.
 * Protected by CRON_SECRET bearer token.
 * Vercel Cron: runs every 5 minutes.
 *
 * Flow:
 * 1. Fetch all pending webhook events (TRANSACTIONS and ITEM)
 * 2. Apply ITEM events — errors, repairs, newly available accounts
 * 3. Group the remaining sync-triggering events by plaid_item
 * 4. Run syncTransactionsForItem for each unique item
 * 5. Mark webhook events as completed/failed
 *
 * Events for an item awaiting re-auth are LEFT PENDING rather than failed:
 * 'failed' is terminal here (only 'pending' is ever re-read), so failing them
 * discarded the notification permanently. 128 events were stranded that way.
 */
export async function GET(request: Request) {
  try {
    const authHeader = request.headers.get('authorization');
    const secrets = getSecrets();

    if (authHeader !== `Bearer ${secrets.CRON_SECRET}`) {
      logger.warn('Unauthorized cron access attempt', { endpoint: 'sync/transactions' });
      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    }

    const supabase = createServiceRoleClient();

    // Fetch pending webhook events. The filter is on webhook_type, so it must
    // list types ('TRANSACTIONS', 'ITEM') — the previous list mixed in codes
    // like DEFAULT_UPDATE, which matched nothing and excluded ITEM entirely.
    const { data: pendingEvents, error: fetchError } = await supabase
      .from('plaid_webhook_events')
      .select('id, plaid_item_id, webhook_type, webhook_code, payload')
      .eq('status', 'pending')
      .in('webhook_type', [...PROCESSED_WEBHOOK_TYPES])
      .order('created_at', { ascending: true })
      .limit(100);

    if (fetchError) {
      logger.error('Failed to fetch pending webhook events', { error_message: fetchError.message });
      return NextResponse.json({ error: 'Internal error.' }, { status: 500 });
    }

    const events = pendingEvents ?? [];

    // Split events by what they require. ITEM events are applied directly;
    // only sync-triggering TRANSACTIONS events are grouped into a sync run.
    const itemEventMap = new Map<string, string[]>();
    const directEvents: Array<{
      id: string;
      plaid_item_id: string;
      webhook_code: string;
      payload: Record<string, unknown> | null;
      action: EventAction;
    }> = [];
    const noopEventIds: string[] = [];

    for (const event of events) {
      const action = classifyWebhookEvent(event.webhook_type, event.webhook_code);
      if (action === 'sync') {
        const existing = itemEventMap.get(event.plaid_item_id) || [];
        existing.push(event.id);
        itemEventMap.set(event.plaid_item_id, existing);
      } else if (action === 'noop') {
        noopEventIds.push(event.id);
      } else {
        directEvents.push({
          id: event.id,
          plaid_item_id: event.plaid_item_id,
          webhook_code: event.webhook_code,
          payload: (event.payload ?? null) as Record<string, unknown> | null,
          action,
        });
      }
    }

    // Recognised but uninteresting events are closed out so they stop being
    // re-read on every run.
    if (noopEventIds.length > 0) {
      await markEvents(supabase, noopEventIds, 'completed');
    }

    let totalProcessed = 0;
    let totalErrors = 0;
    let totalItemEvents = 0;
    let totalDeferred = 0;

    // ── 1. ITEM events ────────────────────────────────────────────────────
    for (const event of directEvents) {
      await supabase
        .from('plaid_webhook_events')
        .update({ status: 'processing' })
        .eq('id', event.id);

      try {
        const { data: item, error: itemError } = await supabase
          .from('plaid_items')
          .select('id, user_id, entity_id')
          .eq('id', event.plaid_item_id)
          .single();

        if (itemError || !item) {
          await markEvents(supabase, [event.id], 'failed', 'Plaid item not found');
          totalErrors++;
          continue;
        }

        if (event.action === 'item_error') {
          await applyItemError(supabase, item, event.payload, event.webhook_code);
        } else {
          // Both remaining actions reconcile accounts, so they need a token.
          const { data: encryptedToken, error: tokenError } = await supabase
            .rpc('get_plaid_token', { p_plaid_item_id: item.id });

          if (tokenError || !encryptedToken) {
            throw new Error(`Failed to fetch token: ${tokenError?.message}`);
          }

          const accessToken = decrypt(encryptedToken);
          const plaidClient = getPlaidClient();

          if (event.action === 'login_repaired') {
            await applyLoginRepaired(supabase, plaidClient, accessToken, item);
          } else if (event.action === 'refresh_accounts') {
            await applyNewAccountsAvailable(supabase, plaidClient, accessToken, item);
          }
        }

        await markEvents(supabase, [event.id], 'completed');
        totalItemEvents++;
      } catch (error) {
        const message = String(error);
        logger.error('Failed to process ITEM webhook event', {
          event_id: event.id,
          webhook_code: event.webhook_code,
          error_message: message,
        });
        await markEvents(supabase, [event.id], 'failed', message);
        totalErrors++;
      }
    }

    // ── 2. Transaction syncs ──────────────────────────────────────────────
    for (const [plaidItemDbId, eventIds] of itemEventMap) {
      // Mark events as processing
      await supabase
        .from('plaid_webhook_events')
        .update({ status: 'processing' })
        .in('id', eventIds);

      try {
        // Fetch item details for sync
        const { data: item, error: itemError } = await supabase
          .from('plaid_items')
          .select('id, user_id, entity_id, status')
          .eq('id', plaidItemDbId)
          .single();

        if (itemError || !item) {
          logger.warn('Plaid item not found for sync', { plaid_item_db_id: plaidItemDbId });
          await markEvents(supabase, eventIds, 'failed', 'Plaid item not found');
          totalErrors++;
          continue;
        }

        // Items awaiting re-auth cannot be synced yet. Leave the events PENDING
        // rather than failing them: 'failed' is terminal (only 'pending' is
        // re-read), so failing here would discard the notification for good.
        // They are picked up automatically once the user re-links.
        if (item.status === 'reauth_required' || item.status === 'disconnected') {
          logger.info('Deferring sync for non-active item', {
            plaid_item_db_id: plaidItemDbId,
            status: item.status,
            deferred_events: eventIds.length,
          });
          await supabase
            .from('plaid_webhook_events')
            .update({ status: 'pending' })
            .in('id', eventIds);
          totalDeferred += eventIds.length;
          continue;
        }

        const result = await syncTransactionsForItem(
          supabase,
          item.id,
          item.user_id,
          item.entity_id
        );

        await markEvents(supabase, eventIds, 'completed');
        totalProcessed++;

        logger.info('Cron sync completed for item', {
          plaid_item_db_id: plaidItemDbId,
          added: result.added,
          modified: result.modified,
          removed: result.removed,
          accounts_created: result.createdAccounts.length,
        });
      } catch (error) {
        const errorMessage = String(error);
        logger.error('Sync failed for plaid_item', {
          plaid_item_db_id: plaidItemDbId,
          error_message: errorMessage,
        });

        await markEvents(supabase, eventIds, 'failed', errorMessage);

        // Fetch item to record failure
        const { data: item } = await supabase
          .from('plaid_items')
          .select('user_id')
          .eq('id', plaidItemDbId)
          .single();

        if (item) {
          // Persist the real Plaid error_code so the item can escalate.
          await recordSyncFailureFromError(supabase, plaidItemDbId, item.user_id, error);
        }

        totalErrors++;
      }
    }

    logger.info('Transaction sync cron completed', {
      items_processed: totalProcessed,
      items_errored: totalErrors,
      item_events_processed: totalItemEvents,
      events_deferred: totalDeferred,
      events_total: events.length,
    });

    // Run the Data Health audit right after the sync, regardless of whether any
    // events were processed. Audit failures must never crash the cron.
    const audit = await runDataHealthAuditForAllUsers(supabase, {
      ok: totalErrors === 0,
      itemsProcessed: totalProcessed,
      itemsErrored: totalErrors,
    });

    return NextResponse.json({
      status: 'ok',
      processed: totalProcessed,
      errors: totalErrors,
      item_events: totalItemEvents,
      deferred: totalDeferred,
      events: events.length,
      audit,
    });
  } catch (error) {
    logger.error('Transaction sync cron error', { error_message: String(error) });
    return NextResponse.json({ error: 'Internal error.' }, { status: 500 });
  }
}

async function markEvents(
  supabase: ReturnType<typeof createServiceRoleClient>,
  eventIds: string[],
  status: 'completed' | 'failed',
  errorMessage?: string
): Promise<void> {
  const updates: Record<string, unknown> = {
    status,
    processed_at: new Date().toISOString(),
  };

  if (errorMessage) {
    updates.error_message = errorMessage.slice(0, 1000);
  }

  await supabase
    .from('plaid_webhook_events')
    .update(updates)
    .in('id', eventIds);
}

/**
 * Run the Data Health audit for every user that owns active accounts. Mirrors
 * the snapshot cron's user-discovery. Per-user failures are logged but never
 * propagate — the audit must not crash the sync cron.
 */
async function runDataHealthAuditForAllUsers(
  supabase: ReturnType<typeof createServiceRoleClient>,
  syncState: { ok: boolean; itemsProcessed: number; itemsErrored: number }
): Promise<{ users: number; failed: number }> {
  const { data: accountRows, error } = await supabase
    .from('accounts')
    .select('user_id')
    .eq('is_active', true)
    .is('deleted_at', null);

  if (error) {
    logger.error('Audit: failed to list users', { error_message: error.message });
    return { users: 0, failed: 0 };
  }

  const userIds = Array.from(
    new Set((accountRows ?? []).map((r: { user_id: string }) => r.user_id))
  );

  let failed = 0;
  for (const userId of userIds) {
    try {
      await runDataHealthAudit(supabase, userId, 'cron', syncState);
    } catch (err) {
      failed++;
      logger.error('Audit run failed for user', {
        user_id: userId,
        error_message: String(err),
      });
    }
  }

  return { users: userIds.length, failed };
}
