import { NextResponse } from 'next/server';
import { getSecrets } from '@/lib/env';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { generateDailySnapshots } from '@/lib/snapshots';
import { logger } from '@/lib/logger';

/**
 * Manual endpoint: Generate daily financial snapshots for all users.
 *
 * Snapshots normally run as the last step of the daily heal cron
 * (/api/sync/heal) because Vercel Hobby only schedules two cron jobs per
 * project. This endpoint exists for manual baselines and re-runs; it is
 * idempotent (one snapshot per user per day).
 *
 * Protected by CRON_SECRET bearer token.
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
    const result = await generateDailySnapshots(supabase);

    return NextResponse.json({ status: 'ok', ...result });
  } catch (error) {
    logger.error('Snapshot cron error', { error_message: String(error) });
    return NextResponse.json({ error: 'Internal error.' }, { status: 500 });
  }
}
