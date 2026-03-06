import { NextResponse } from 'next/server';
import { verifyPlaidWebhook } from '@/lib/plaid/webhook';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { getClientIP, writeAuditLog } from '@/lib/audit';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { logger } from '@/lib/logger';

interface PlaidWebhookBody {
  webhook_type: string;
  webhook_code: string;
  item_id: string;
  webhook_id?: string;
  error?: {
    error_code: string;
    error_message: string;
  };
  new_transactions?: number;
  removed_transactions?: string[];
}

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
      logger.warn('Webhook verification failed', { ip_address: ip, error: verification.error });

      // Find any user associated with the item for audit logging
      const parsed = safeParseBody(body);
      if (parsed?.item_id) {
        const { data: item } = await supabase
          .from('plaid_items')
          .select('user_id')
          .eq('plaid_item_id', parsed.item_id)
          .single();

        if (item) {
          await writeAuditLog(supabase, {
            userId: item.user_id,
            action: 'WEBHOOK_VERIFICATION_FAILED',
            details: { ip_address: ip, error: verification.error },
            ipAddress: ip,
          });
        }
      }

      return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
    }

    // Parse the verified webhook body
    const webhook = JSON.parse(body) as PlaidWebhookBody;
    const supabase = createServiceRoleClient();

    // Look up the internal plaid_item record
    const { data: plaidItem } = await supabase
      .from('plaid_items')
      .select('id, user_id')
      .eq('plaid_item_id', webhook.item_id)
      .single();

    if (!plaidItem) {
      logger.warn('Webhook for unknown plaid item', { plaid_item_id: webhook.item_id });
      // ACK anyway to prevent Plaid from retrying endlessly
      return NextResponse.json({ received: true }, { status: 200 });
    }

    // Handle ITEM webhook types (errors, status changes)
    if (webhook.webhook_type === 'ITEM') {
      await handleItemWebhook(supabase, plaidItem, webhook);
      return NextResponse.json({ received: true }, { status: 200 });
    }

    // Store webhook event for async processing by cron
    const webhookId = webhook.webhook_id ?? `${webhook.webhook_type}_${webhook.webhook_code}_${Date.now()}`;

    const { error: insertError } = await supabase
      .from('plaid_webhook_events')
      .upsert(
        {
          user_id: plaidItem.user_id,
          plaid_item_id: plaidItem.id,
          webhook_type: webhook.webhook_type,
          webhook_code: webhook.webhook_code,
          plaid_webhook_id: webhookId,
          payload: webhook as unknown as Record<string, unknown>,
          status: 'pending',
        },
        { onConflict: 'plaid_webhook_id' }
      );

    if (insertError) {
      logger.error('Failed to store webhook event', {
        error_message: insertError.message,
        webhook_type: webhook.webhook_type,
        webhook_code: webhook.webhook_code,
      });
      return NextResponse.json({ error: 'Internal error.' }, { status: 500 });
    }

    // Audit log
    await writeAuditLog(supabase, {
      userId: plaidItem.user_id,
      action: 'WEBHOOK_RECEIVED',
      entityType: 'plaid_item',
      entityId: plaidItem.id,
      details: {
        webhook_type: webhook.webhook_type,
        webhook_code: webhook.webhook_code,
      },
      ipAddress: ip,
    });

    logger.info('Webhook stored for processing', {
      webhook_type: webhook.webhook_type,
      webhook_code: webhook.webhook_code,
      plaid_item_id: webhook.item_id,
    });

    // ACK quickly — actual sync happens via cron
    return NextResponse.json({ received: true }, { status: 200 });
  } catch (error) {
    logger.error('Webhook processing error', { error_message: String(error), ip_address: ip });
    return NextResponse.json({ error: 'Internal error.' }, { status: 500 });
  }
}

/**
 * Handle ITEM-level webhooks (errors, pending expiration, etc.)
 * These update the plaid_items status directly without going through the queue.
 */
async function handleItemWebhook(
  supabase: ReturnType<typeof createServiceRoleClient>,
  plaidItem: { id: string; user_id: string },
  webhook: PlaidWebhookBody
): Promise<void> {
  const updates: Record<string, unknown> = {};

  switch (webhook.webhook_code) {
    case 'ERROR':
      updates.status = webhook.error?.error_code === 'ITEM_LOGIN_REQUIRED'
        ? 'reauth_required'
        : 'degraded';
      updates.last_error_code = webhook.error?.error_code ?? 'UNKNOWN';
      updates.error_count = plaidItem.id; // Will be incremented via SQL
      break;

    case 'PENDING_EXPIRATION':
      updates.status = 'degraded';
      break;

    case 'USER_PERMISSION_REVOKED':
      updates.status = 'disconnected';
      break;

    default:
      return;
  }

  if (Object.keys(updates).length > 0) {
    if (updates.status === 'degraded' || updates.status === 'reauth_required') {
      delete updates.error_count;
    }

    await supabase
      .from('plaid_items')
      .update(updates)
      .eq('id', plaidItem.id);

    await writeAuditLog(supabase, {
      userId: plaidItem.user_id,
      action: 'PLAID_ITEM_ERROR',
      entityType: 'plaid_item',
      entityId: plaidItem.id,
      details: {
        webhook_code: webhook.webhook_code,
        error_code: webhook.error?.error_code,
      },
    });

    logger.warn('Plaid item status updated via webhook', {
      plaid_item_id: plaidItem.id,
      webhook_code: webhook.webhook_code,
      new_status: updates.status as string,
    });
  }
}

function safeParseBody(body: string): PlaidWebhookBody | null {
  try {
    return JSON.parse(body) as PlaidWebhookBody;
  } catch {
    return null;
  }
}
