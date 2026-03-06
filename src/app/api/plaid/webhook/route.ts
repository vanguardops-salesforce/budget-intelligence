import { NextResponse } from 'next/server';
import { verifyPlaidWebhook } from '@/lib/plaid/webhook';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { getClientIP, writeAuditLog } from '@/lib/audit';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';

export async function POST(request: Request) {
  const ip = getClientIP(request.headers) ?? 'unknown';

  try {
    // Rate limit webhooks
    const rateCheck = checkRateLimit(RATE_LIMITS.WEBHOOK, ip);
    if (!rateCheck.allowed) {
      return NextResponse.json({ error: 'Too many requests.' }, { status: 429 });
    }

    const body = await request.text();

    // CRITICAL: Verify webhook signature BEFORE any processing
    const verification = await verifyPlaidWebhook(body, request.headers);
    if (!verification.verified) {
      const supabase = createServiceRoleClient();
      // Log failed verification attempt — requires knowing the user, but we log IP at minimum
      logger.warn('Webhook verification failed', { ip_address: ip, error: verification.error });

      // Phase 2: Write audit log entry for WEBHOOK_VERIFICATION_FAILED
      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    }

    // Phase 2: Parse webhook, store in plaid_webhook_events, ACK quickly
    return NextResponse.json({ received: true }, { status: 200 });
  } catch (error) {
    logger.error('Webhook processing error', { error_message: String(error), ip_address: ip });
    return NextResponse.json({ error: 'Internal error.' }, { status: 500 });
  }
}
