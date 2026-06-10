import { type SupabaseClient } from '@supabase/supabase-js';
import { computeFinancialState } from './ai/financial-intelligence';
import { detectRecurringPatterns } from './ai/recurring-detection';
import { logger } from './logger';

export interface SnapshotRunResult {
  total_users: number;
  created: number;
  skipped: number;
  errors: number;
}

/**
 * Generate today's financial snapshot for every user with an active account.
 * Stores a FinancialState JSON blob per user per day for trend analysis
 * and AI context injection.
 *
 * Idempotent: users that already have a snapshot for today are skipped,
 * backed by the UNIQUE(user_id, snapshot_date) constraint.
 *
 * Called from the daily heal cron (after balances are refreshed) and from
 * the manual /api/cron/snapshots endpoint. Vercel Hobby only schedules two
 * cron jobs per project, so snapshots piggyback on the heal job instead of
 * having their own cron entry.
 */
export async function generateDailySnapshots(
  supabase: SupabaseClient
): Promise<SnapshotRunResult> {
  const today = new Date().toISOString().split('T')[0];

  // Get all distinct user IDs that have at least one active account
  const { data: users, error: usersError } = await supabase
    .from('accounts')
    .select('user_id')
    .eq('is_active', true)
    .is('deleted_at', null);

  if (usersError) {
    logger.error('Failed to fetch users for snapshots', { error_message: usersError.message });
    throw new Error('Failed to fetch users for snapshots.');
  }

  // Deduplicate user IDs
  const uniqueUserIds = Array.from(new Set((users ?? []).map((u: { user_id: string }) => u.user_id)));

  if (uniqueUserIds.length === 0) {
    logger.info('Snapshot run: no active users found');
    return { total_users: 0, created: 0, skipped: 0, errors: 0 };
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

  logger.info('Snapshot run completed', {
    total_users: uniqueUserIds.length,
    created,
    skipped,
    errors,
  });

  return { total_users: uniqueUserIds.length, created, skipped, errors };
}
