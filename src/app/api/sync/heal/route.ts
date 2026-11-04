import { NextResponse } from 'next/server';
import { getSecrets } from '@/lib/env';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { syncTransactionsForItem, recordSyncFailureFromError } from '@/lib/plaid/sync';
import { requiresReauth } from '@/lib/plaid/errors';
import { logger } from '@/lib/logger';

/**
 * Consecutive failures after which a 'degraded' item stops being retried by the
 * nightly sweep. Items needing re-auth drop out immediately via their status;
 * this ceiling stops everything else from retrying a broken connection forever
 * (Amex 18dedaa2 reached 39 identical attempts before this existed).
 */
const MAX_HEAL_ATTEMPTS = 10;

/**
 * Cron endpoint: Heal job — runs /transactions/sync for all active plaid_items.
 * Safety net for missed webhooks.
 * Protected by CRON_SECRET bearer token.
 * Vercel Cron: runs daily at 3 AM.
 *
 * This ensures data integrity by syncing ALL active items regardless of
 * whether webhooks were received. Missed webhooks, network issues, or
 * Plaid outages are all covered by this daily sweep.
 *
 * Items in 'reauth_required' or 'disconnected' are never swept: only the user
 * can resolve those, so retrying them nightly just burns Plaid calls and
 * inflates error_count. Items stuck failing for other reasons are capped at
 * MAX_HEAL_ATTEMPTS and reported as needing attention instead.
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

    // Fetch sweepable plaid_items (connected or degraded — never
    // disconnected/reauth_required, which only the user can clear).
    const { data: items, error: fetchError } = await supabase
      .from('plaid_items')
      .select('id, user_id, entity_id, plaid_item_id, status, last_successful_sync, error_count')
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
    let totalSkipped = 0;
    const results: Array<{ item_id: string; status: string; details?: string }> = [];

    for (const item of items) {
      // Give up on an item that has failed this many times in a row without
      // escalating to reauth: something is wrong that retrying will not fix.
      if ((item.error_count ?? 0) >= MAX_HEAL_ATTEMPTS) {
        totalSkipped++;
        results.push({
          item_id: item.id,
          status: 'skipped',
          details: `${item.error_count} consecutive failures — needs investigation`,
        });
        logger.warn('Heal skipping item past its retry ceiling', {
          plaid_item_db_id: item.id,
          error_count: item.error_count,
        });
        continue;
      }

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
          accounts_created: result.createdAccounts.length,
        });
      } catch (error) {
        totalErrors++;

        // Persist the real Plaid error_code (or a local sentinel), never an
        // invented literal — the code is what decides whether the item
        // escalates to reauth_required instead of looping nightly.
        const errorCode = await recordSyncFailureFromError(
          supabase,
          item.id,
          item.user_id,
          error
        );

        results.push({
          item_id: item.id,
          status: 'error',
          details: errorCode,
        });

        logger.error('Heal sync failed for item', {
          plaid_item_db_id: item.id,
          error_code: errorCode,
          needs_reauth: requiresReauth(errorCode),
          error_message: String(error).slice(0, 500),
        });
      }
    }

    logger.info('Heal job completed', {
      total_items: items.length,
      healed: totalHealed,
      errors: totalErrors,
      skipped: totalSkipped,
    });

    return NextResponse.json({
      status: 'ok',
      total: items.length,
      healed: totalHealed,
      errors: totalErrors,
      skipped: totalSkipped,
      results,
    });
  } catch (error) {
    logger.error('Heal job cron error', { error_message: String(error) });
    return NextResponse.json({ error: 'Internal error.' }, { status: 500 });
  }
}
