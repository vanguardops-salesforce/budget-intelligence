import { NextResponse } from 'next/server';
import { getSecrets } from '@/lib/env';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { syncTransactionsForItem, recordSyncFailure } from '@/lib/plaid/sync';
import { logger } from '@/lib/logger';

/**
 * Cron endpoint: Heal job — runs /transactions/sync for all active plaid_items.
 * Safety net for missed webhooks.
 * Protected by CRON_SECRET bearer token.
 * Vercel Cron: runs daily at 3 AM.
 *
 * This ensures data integrity by syncing ALL active items regardless of
 * whether webhooks were received. Missed webhooks, network issues, or
 * Plaid outages are all covered by this daily sweep.
 */
export async function GET(request: Request) {
  try {
    const authHeader = request.headers.get('authorization');
    const secrets = getSecrets();

    if (authHeader !== `Bearer ${secrets.CRON_SECRET}`) {
      logger.warn('Unauthorized cron access attempt', { endpoint: 'sync/heal' });
      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    }

    const supabase = createServiceRoleClient();

    // Fetch ALL active plaid_items (connected or degraded — not disconnected/reauth)
    const { data: items, error: fetchError } = await supabase
      .from('plaid_items')
      .select('id, user_id, entity_id, plaid_item_id, status, last_successful_sync')
      .in('status', ['connected', 'degraded']);

    if (fetchError) {
      logger.error('Failed to fetch plaid_items for heal', { error_message: fetchError.message });
      return NextResponse.json({ error: 'Internal error.' }, { status: 500 });
    }

    if (!items || items.length === 0) {
      logger.info('Heal job: no active plaid_items found');
      return NextResponse.json({ status: 'ok', healed: 0 });
    }

    let totalHealed = 0;
    let totalErrors = 0;
    const results: Array<{ item_id: string; status: string; details?: string }> = [];

    for (const item of items) {
      try {
        const result = await syncTransactionsForItem(
          supabase,
          item.id,
          item.user_id,
          item.entity_id
        );

        totalHealed++;
        results.push({
          item_id: item.id,
          status: 'healed',
          details: `+${result.added} ~${result.modified} -${result.removed}`,
        });

        logger.info('Heal sync completed for item', {
          plaid_item_db_id: item.id,
          added: result.added,
          modified: result.modified,
          removed: result.removed,
        });
      } catch (error) {
        const errorMessage = String(error);
        totalErrors++;
        results.push({
          item_id: item.id,
          status: 'error',
          details: errorMessage.slice(0, 200),
        });

        logger.error('Heal sync failed for item', {
          plaid_item_db_id: item.id,
          error_message: errorMessage,
        });

        await recordSyncFailure(supabase, item.id, item.user_id, 'HEAL_SYNC_ERROR');
      }
    }

    logger.info('Heal job completed', {
      total_items: items.length,
      healed: totalHealed,
      errors: totalErrors,
    });

    return NextResponse.json({
      status: 'ok',
      total: items.length,
      healed: totalHealed,
      errors: totalErrors,
      results,
    });
  } catch (error) {
    logger.error('Heal job cron error', { error_message: String(error) });
    return NextResponse.json({ error: 'Internal error.' }, { status: 500 });
  }
}
