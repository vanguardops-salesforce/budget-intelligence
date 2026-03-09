import { NextResponse } from 'next/server';
import { verifyPlaidWebhook } from '@/lib/plaid/webhook';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { getClientIP, writeAuditLog } from '@/lib/audit';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';

/**
 * Plaid webhook endpoint.
 * Receives async notifications from Plaid about transaction updates,
 * item status changes, etc.
 *
 * Flow:
 * 1. Rate limit by IP
 * 2. Verify webhook signature (JWT)
 * 3. Parse the event and look up the plaid_item
 * 4. Store in plaid_webhook_events as "pending"
 * 5. ACK immediately — processing happens in the sync cron
 */
export async function POST(request: Request) {
  const ip = getClientIP(request.headers) ?? 'unknown';

  try {
    const rateCheck = checkRateLimit(RATE_LIMITS.WEBHOOK, ip);
    if (!rateCheck.allowed) {
      return NextResponse.json({ error: 'Too many requests.' }, { status: 429 });
    }

    const body = await request.text();

    // CRITICAL: Verify webhook signature BEFORE any processing
    const verification = await verifyPlaidWebhook(body, request.headers);
    if (!verification.verified) {
      logger.warn('Webhook verification failed', { ip_address: ip, error: verification.error });

      const supabase = createServiceRoleClient();
      await writeAuditLog(supabase, {
        userId: '00000000-0000-0000-0000-000000000000',
        action: 'WEBHOOK_VERIFICATION_FAILED',
        details: { ip_address: ip, error: verification.error },
        ipAddress: ip,
      });

      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    }

    // Parse the webhook payload
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body);
    } catch {
      return NextResponse.json({ error: 'Invalid JSON.' }, { status: 400 });
    }

    const webhookType = payload.webhook_type as string;
    const webhookCode = payload.webhook_code as string;
    const plaidItemId = payload.item_id as string;
    const webhookId = (payload.webhook_id as string) || `${webhookType}_${webhookCode}_${Date.now()}`;

    if (!webhookType || !webhookCode || !plaidItemId) {
      logger.warn('Webhook missing required fields', { payload_keys: Object.keys(payload) });
      return NextResponse.json({ error: 'Invalid webhook payload.' }, { status: 400 });
    }

    const supabase = createServiceRoleClient();

    // Look up the plaid_item by plaid_item_id
    const { data: plaidItem, error: lookupError } = await supabase
      .from('plaid_items')
      .select('id, user_id')
      .eq('plaid_item_id', plaidItemId)
      .single();

    if (lookupError || !plaidItem) {
      logger.warn('Webhook for unknown plaid_item', { plaid_item_id: plaidItemId });
      // ACK anyway to prevent Plaid retries
      return NextResponse.json({ received: true }, { status: 200 });
    }

    // Handle item-level error webhooks immediately
    if (webhookType === 'ITEM' && webhookCode === 'ERROR') {
      const errorObj = payload.error as Record<string, unknown> | undefined;
      const errorCode = (errorObj?.error_code as string) || 'UNKNOWN';

      await supabase
        .from('plaid_items')
        .update({
          status: errorCode === 'ITEM_LOGIN_REQUIRED' ? 'reauth_required' : 'degraded',
          last_error_code: errorCode,
        })
        .eq('id', plaidItem.id);

      await writeAuditLog(supabase, {
        userId: plaidItem.user_id,
        action: 'PLAID_ITEM_ERROR',
        entityType: 'plaid_item',
        entityId: plaidItem.id,
        details: { error_code: errorCode, webhook_code: webhookCode },
        ipAddress: ip,
      });
    }

    // Store the webhook event for async processing by the sync cron
    const { error: insertError } = await supabase
      .from('plaid_webhook_events')
      .upsert(
        {
          user_id: plaidItem.user_id,
          plaid_item_id: plaidItem.id,
          webhook_type: webhookType,
          webhook_code: webhookCode,
          plaid_webhook_id: webhookId,
          payload,
          status: 'pending',
        },
        { onConflict: 'plaid_webhook_id' }
      );

    if (insertError) {
      logger.error('Failed to store webhook event', {
        error_message: insertError.message,
        plaid_item_id: plaidItemId,
      });
    }

    await writeAuditLog(supabase, {
      userId: plaidItem.user_id,
      action: 'WEBHOOK_RECEIVED',
      entityType: 'plaid_item',
      entityId: plaidItem.id,
      details: { webhook_type: webhookType, webhook_code: webhookCode },
      ipAddress: ip,
    });

    logger.info('Webhook received and stored', {
      webhook_type: webhookType,
      webhook_code: webhookCode,
      plaid_item_id: plaidItemId,
    });

    return NextResponse.json({ received: true }, { status: 200 });
  } catch (error) {
    logger.error('Webhook processing error', { error_message: String(error), ip_address: ip });
    return NextResponse.json({ error: 'Internal error.' }, { status: 500 });
  }
}
