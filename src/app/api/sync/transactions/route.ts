import { NextResponse } from 'next/server';
import { getSecrets } from '@/lib/env';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { syncTransactionsForItem, getEncryptedToken } from '@/lib/plaid/sync';
import { writeAuditLog } from '@/lib/audit';
import { logger } from '@/lib/logger';
import type { PlaidItem, PlaidWebhookEvent } from '@/lib/types';

/**
 * Cron endpoint: Process pending webhook events and sync transactions.
 * Protected by CRON_SECRET bearer token.
 * Vercel Cron: runs every 5 minutes.
 */
export async function GET(request: Request) {
  try {
    // Verify CRON_SECRET
    const authHeader = request.headers.get('authorization');
    const secrets = getSecrets();

    if (authHeader !== `Bearer ${secrets.CRON_SECRET}`) {
      logger.warn('Unauthorized cron access attempt', {
        endpoint: 'sync/transactions',
      });
      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    }

    const supabase = createServiceRoleClient();

    // Fetch pending webhook events (TRANSACTIONS type)
    const { data: events, error: fetchError } = await supabase
      .from('plaid_webhook_events')
      .select('*')
      .eq('status', 'pending')
      .in('webhook_type', ['TRANSACTIONS'])
      .order('created_at', { ascending: true })
      .limit(50);

    if (fetchError) {
      logger.error('Failed to fetch pending webhook events', {
        error_message: fetchError.message,
      });
      return NextResponse.json({ error: 'Internal error.' }, { status: 500 });
    }

    if (!events || events.length === 0) {
      return NextResponse.json({ status: 'ok', processed: 0 });
    }

    // Group events by plaid_item_id to deduplicate (only sync once per item)
    const itemIds = Array.from(new Set(events.map((e: PlaidWebhookEvent) => e.plaid_item_id)));
    let totalProcessed = 0;
    let totalErrors = 0;

    for (const itemId of itemIds) {
      const itemEvents = events.filter((e: PlaidWebhookEvent) => e.plaid_item_id === itemId);

      // Mark events as processing
      await supabase
        .from('plaid_webhook_events')
        .update({ status: 'processing' })
        .in('id', itemEvents.map((e: PlaidWebhookEvent) => e.id));

      try {
        // Fetch the plaid_item record
        const { data: plaidItem } = await supabase
          .from('plaid_items')
          .select('*')
          .eq('id', itemId)
          .single();

        if (!plaidItem) {
          throw new Error(`Plaid item not found: ${itemId}`);
        }

        // Get encrypted token
        const encryptedToken = await getEncryptedToken(supabase, itemId);
        if (!encryptedToken) {
          throw new Error(`No token found for plaid item: ${itemId}`);
        }

        // Run sync
        const result = await syncTransactionsForItem(
          supabase,
          plaidItem as PlaidItem,
          encryptedToken
        );

        // Mark events as completed
        await supabase
          .from('plaid_webhook_events')
          .update({
            status: 'completed',
            processed_at: new Date().toISOString(),
          })
          .in('id', itemEvents.map((e: PlaidWebhookEvent) => e.id));

        // Audit log
        await writeAuditLog(supabase, {
          userId: plaidItem.user_id,
          action: 'PLAID_SYNC_COMPLETED',
          entityType: 'plaid_item',
          entityId: itemId,
          details: {
            added: result.added,
            modified: result.modified,
            removed: result.removed,
          },
        });

        totalProcessed += itemEvents.length;
      } catch (error) {
        logger.error('Sync failed for plaid item', {
          error_message: String(error),
          plaid_item_id: itemId,
        });

        // Mark events as failed
        await supabase
          .from('plaid_webhook_events')
          .update({
            status: 'failed',
            error_message: String(error).slice(0, 500),
            processed_at: new Date().toISOString(),
          })
          .in('id', itemEvents.map((e: PlaidWebhookEvent) => e.id));

        // Update plaid_item error state
        await supabase
          .from('plaid_items')
          .update({
            status: 'degraded',
            last_error_code: 'SYNC_FAILED',
          })
          .eq('id', itemId);

        totalErrors++;
      }
    }

    logger.info('Transaction sync cron completed', {
      processed: String(totalProcessed),
      errors: String(totalErrors),
      items: String(itemIds.length),
    });

    return NextResponse.json({
      status: 'ok',
      processed: totalProcessed,
      errors: totalErrors,
      items: itemIds.length,
    });
  } catch (error) {
    logger.error('Transaction sync cron error', { error_message: String(error) });
    return NextResponse.json({ error: 'Internal error.' }, { status: 500 });
  }
}
