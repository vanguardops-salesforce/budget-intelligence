import { NextResponse } from 'next/server';
import { getSecrets } from '@/lib/env';
import { logger } from '@/lib/logger';

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

    // Phase 2: Iterate all active plaid_items, run sync for each
    return NextResponse.json({ status: 'not_implemented' }, { status: 501 });
  } catch (error) {
    logger.error('Heal job cron error', { error_message: String(error) });
    return NextResponse.json({ error: 'Internal error.' }, { status: 500 });
  }
}
