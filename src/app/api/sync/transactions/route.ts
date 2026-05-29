import { NextResponse } from 'next/server';
import { getSecrets } from '@/lib/env';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { syncTransactionsForItem, recordSyncFailure } from '@/lib/plaid/sync';
import { runDataHealthAudit } from '@/lib/audit/runner';
import { logger } from '@/lib/logger';

/**
 * Cron endpoint: Process pending webhook events and sync transactions.
 * Protected by CRON_SECRET bearer token.
 * Vercel Cron: runs every 5 minutes.
 *
 * Flow:
 * 1. Fetch all pending webhook events for TRANSACTIONS type
 * 2. Group by plaid_item to avoid duplicate syncs
 * 3. Run syncTransactionsForItem for each unique item
 * 4. Mark webhook events as completed/failed
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

    // Fetch pending webhook events (transaction-related)
    const { data: pendingEvents, error: fetchError } = await supabase
      .from('plaid_webhook_events')
      .select('id, plaid_item_id, webhook_type, webhook_code')
      .eq('status', 'pending')
      .in('webhook_type', ['TRANSACTIONS', 'INITIAL_UPDATE', 'HISTORICAL_UPDATE', 'DEFAULT_UPDATE'])
      .order('created_at', { ascending: true })
      .limit(100);

    if (fetchError) {
      logger.error('Failed to fetch pending webhook events', { error_message: fetchError.message });
      return NextResponse.json({ error: 'Internal error.' }, { status: 500 });
    }

    // Group events by plaid_item_id to deduplicate. The daily cron still runs
    // the Data Health audit below even when there are no pending events.
    const events = pendingEvents ?? [];
    const itemEventMap = new Map<string, string[]>();
    for (const event of events) {
      const existing = itemEventMap.get(event.plaid_item_id) || [];
      existing.push(event.id);
      itemEventMap.set(event.plaid_item_id, existing);
    }

    let totalProcessed = 0;
    let totalErrors = 0;

    // Process each unique plaid_item
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

        // Skip items that need re-auth
        if (item.status === 'reauth_required' || item.status === 'disconnected') {
          logger.info('Skipping sync for non-active item', {
            plaid_item_db_id: plaidItemDbId,
            status: item.status,
          });
          await markEvents(supabase, eventIds, 'failed', `Item status: ${item.status}`);
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
          await recordSyncFailure(supabase, plaidItemDbId, item.user_id, 'SYNC_ERROR');
        }

        totalErrors++;
      }
    }

    logger.info('Transaction sync cron completed', {
      items_processed: totalProcessed,
      items_errored: totalErrors,
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
