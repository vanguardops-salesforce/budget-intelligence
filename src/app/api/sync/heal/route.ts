import { NextResponse } from 'next/server';
import { getSecrets } from '@/lib/env';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { syncTransactionsForItem, getEncryptedToken } from '@/lib/plaid/sync';
import { writeAuditLog } from '@/lib/audit';
import { logger } from '@/lib/logger';
import type { PlaidItem } from '@/lib/types';

/**
 * Cron endpoint: Heal job — runs /transactions/sync for all active plaid_items.
 * Safety net for missed webhooks.
 * Protected by CRON_SECRET bearer token.
 * Vercel Cron: runs daily at 3 AM.
 */
export async function GET(request: Request) {
  try {
    // Verify CRON_SECRET
    const authHeader = request.headers.get('authorization');
    const secrets = getSecrets();

    if (authHeader !== `Bearer ${secrets.CRON_SECRET}`) {
      logger.warn('Unauthorized cron access attempt', { endpoint: 'sync/heal' });
      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    }

    const supabase = createServiceRoleClient();

    // Fetch all active plaid items (connected or degraded — not disconnected)
    const { data: plaidItems, error: fetchError } = await supabase
      .from('plaid_items')
      .select('*')
      .in('status', ['connected', 'degraded']);

    if (fetchError) {
      logger.error('Failed to fetch plaid items for heal', {
        error_message: fetchError.message,
      });
      return NextResponse.json({ error: 'Internal error.' }, { status: 500 });
    }

    if (!plaidItems || plaidItems.length === 0) {
      return NextResponse.json({ status: 'ok', healed: 0, message: 'No active items' });
    }

    let healed = 0;
    let errors = 0;

    for (const item of plaidItems as PlaidItem[]) {
      try {
        const encryptedToken = await getEncryptedToken(supabase, item.id);
        if (!encryptedToken) {
          logger.warn('No token for plaid item during heal', {
            plaid_item_id: item.id,
          });
          errors++;
          continue;
        }

        const result = await syncTransactionsForItem(supabase, item, encryptedToken);

        await writeAuditLog(supabase, {
          userId: item.user_id,
          action: 'PLAID_SYNC_COMPLETED',
          entityType: 'plaid_item',
          entityId: item.id,
          details: {
            trigger: 'heal_job',
            added: result.added,
            modified: result.modified,
            removed: result.removed,
          },
        });

        healed++;
      } catch (error) {
        logger.error('Heal sync failed for item', {
          error_message: String(error),
          plaid_item_id: item.id,
        });

        await writeAuditLog(supabase, {
          userId: item.user_id,
          action: 'PLAID_SYNC_FAILED',
          entityType: 'plaid_item',
          entityId: item.id,
          details: {
            trigger: 'heal_job',
            error: String(error).slice(0, 200),
          },
        });

        // Increment error count on the item
        await supabase
          .from('plaid_items')
          .update({
            error_count: item.error_count + 1,
            last_error_code: 'HEAL_SYNC_FAILED',
          })
          .eq('id', item.id);

        errors++;
      }
    }

    logger.info('Heal job completed', {
      total: String(plaidItems.length),
      healed: String(healed),
      errors: String(errors),
    });

    return NextResponse.json({
      status: 'ok',
      total: plaidItems.length,
      healed,
      errors,
    });
  } catch (error) {
    logger.error('Heal job cron error', { error_message: String(error) });
    return NextResponse.json({ error: 'Internal error.' }, { status: 500 });
  }
}
