import { NextResponse } from 'next/server';
import { getSecrets } from '@/lib/env';
import { logger } from '@/lib/logger';

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

    // Phase 2: Poll unprocessed webhook events, decrypt tokens, call /transactions/sync
    return NextResponse.json({ status: 'not_implemented' }, { status: 501 });
  } catch (error) {
    logger.error('Transaction sync cron error', { error_message: String(error) });
    return NextResponse.json({ error: 'Internal error.' }, { status: 500 });
  }
}
