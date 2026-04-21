import { NextResponse } from 'next/server';
import { getSecrets } from '@/lib/env';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';

/**
 * Cron endpoint: generate action_items for credit card statements due within
 * the next 5 days. Delegates to the SQL function generate_cc_payment_action_items
 * which is idempotent (will not duplicate existing rows).
 *
 * Protected by CRON_SECRET bearer token.
 */
export async function GET(request: Request) {
  try {
    const authHeader = request.headers.get('authorization');
    const secrets = getSecrets();

    if (authHeader !== `Bearer ${secrets.CRON_SECRET}`) {
      logger.warn('Unauthorized cron access attempt', {
        endpoint: 'cron/generate-cc-action-items',
      });
      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    }

    const supabase = createServiceRoleClient();

    const { error } = await supabase.rpc('generate_cc_payment_action_items');

    if (error) {
      logger.error('generate_cc_payment_action_items RPC failed', {
        error_message: error.message,
      });
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ status: 'ok' });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error('generate-cc-action-items cron error', { error_message: msg });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
