import { NextResponse } from 'next/server';
import { getSecrets } from '@/lib/env';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { computeFinancialState } from '@/lib/ai/financial-intelligence';
import { detectRecurringPatterns } from '@/lib/ai/recurring-detection';
import { logger } from '@/lib/logger';

/**
 * Cron endpoint: Generate daily financial snapshots for all users.
 * Stores a FinancialState JSON blob per user per day for trend analysis
 * and AI context injection.
 *
 * Protected by CRON_SECRET bearer token.
 * Vercel Cron: runs daily at 4 AM UTC (after heal job at 3 AM).
 */
export async function GET(request: Request) {
  try {
    const authHeader = request.headers.get('authorization');
    const secrets = getSecrets();

    if (authHeader !== `Bearer ${secrets.CRON_SECRET}`) {
      logger.warn('Unauthorized cron access attempt', { endpoint: 'cron/snapshots' });
      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    }

    const supabase = createServiceRoleClient();
    const today = new Date().toISOString().split('T')[0];

    // Get all distinct user IDs that have at least one active account
    const { data: users, error: usersError } = await supabase
      .from('accounts')
      .select('user_id')
      .eq('is_active', true)
      .is('deleted_at', null);

    if (usersError) {
      logger.error('Failed to fetch users for snapshots', { error_message: usersError.message });
      return NextResponse.json({ error: 'Internal error.' }, { status: 500 });
    }

    // Deduplicate user IDs
    const uniqueUserIds = Array.from(new Set((users ?? []).map((u: { user_id: string }) => u.user_id)));

    if (uniqueUserIds.length === 0) {
      logger.info('Snapshot cron: no active users found');
      return NextResponse.json({ status: 'ok', snapshots: 0 });
    }

    let created = 0;
    let skipped = 0;
    let errors = 0;

    for (const userId of uniqueUserIds) {
      try {
        // Check if snapshot already exists for today
        const { data: existing } = await supabase
          .from('financial_snapshots')
          .select('id')
          .eq('user_id', userId)
          .eq('snapshot_date', today)
          .maybeSingle();

        if (existing) {
          skipped++;
          continue;
        }

        // Refresh recurring patterns before computing snapshot
        await detectRecurringPatterns(supabase, userId);

        // Compute and store the snapshot
        const state = await computeFinancialState(supabase, userId);

        const { error: insertError } = await supabase
          .from('financial_snapshots')
          .insert({
            user_id: userId,
            snapshot_date: today,
            data: state,
          });

        if (insertError) {
          logger.error('Failed to insert snapshot', {
            user_id: userId,
            error_message: insertError.message,
          });
          errors++;
        } else {
          created++;
        }
      } catch (error) {
        logger.error('Snapshot computation failed for user', {
          user_id: userId,
          error_message: String(error),
        });
        errors++;
      }
    }

    logger.info('Snapshot cron completed', {
      total_users: uniqueUserIds.length,
      created,
      skipped,
      errors,
    });

    return NextResponse.json({
      status: 'ok',
      total_users: uniqueUserIds.length,
      created,
      skipped,
      errors,
    });
  } catch (error) {
    logger.error('Snapshot cron error', { error_message: String(error) });
    return NextResponse.json({ error: 'Internal error.' }, { status: 500 });
  }
}
