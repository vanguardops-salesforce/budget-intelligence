export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase/server';
import { requireMFA } from '@/lib/supabase/auth-config';
import { getPlaidClient } from '@/lib/plaid/client';
import { refreshAccountsForItem } from '@/lib/plaid/accounts';
import { decrypt } from '@/lib/crypto';
import { toClientError, ValidationError } from '@/lib/errors';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { getClientIP, writeAuditLog } from '@/lib/audit';
import { logger } from '@/lib/logger';

const schema = z.object({
  plaid_item_id: z.string().uuid(),
});

/**
 * POST /api/plaid/relink-complete
 *
 * Called by the client when Plaid Link's update-mode flow reports success.
 *
 * Until this existed, nothing ran after a relink: the client simply refreshed
 * the page and relied on a comment's promise that "Plaid handles this
 * automatically via webhook". It does not — no LOGIN_REPAIRED handler existed,
 * items linked before the webhook URL was configured receive no webhooks at
 * all, and ITEM-type events were filtered out of the processor. So a successful
 * re-authentication left the item sitting in reauth_required with no new
 * accounts, exactly as reported.
 *
 * Three things have to happen here, and all three are idempotent:
 *   1. reconcile accounts with Plaid, creating any account the user added or
 *      whose id the institution reissued;
 *   2. clear the item's error state and mark it connected;
 *   3. requeue webhook events that were failed only because the item was in
 *      reauth, so the data they announced is not lost.
 */
export async function POST(request: Request) {
  try {
    const supabase = createServerSupabaseClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
    }

    await requireMFA(supabase);

    const ip = getClientIP(request.headers) ?? 'unknown';
    const rateCheck = checkRateLimit(RATE_LIMITS.PLAID_LINK, user.id);
    if (!rateCheck.allowed) {
      return NextResponse.json({ error: 'Too many requests.' }, { status: 429 });
    }

    const body = await request.json();
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError('Invalid request body');
    }

    const { plaid_item_id } = parsed.data;

    // Ownership is enforced by RLS on the user-scoped client: a plaid_item the
    // caller does not own simply does not come back.
    const { data: plaidItem, error: itemError } = await supabase
      .from('plaid_items')
      .select('id, entity_id, status')
      .eq('id', plaid_item_id)
      .single();

    if (itemError || !plaidItem) {
      return NextResponse.json({ error: 'Item not found.' }, { status: 404 });
    }

    const serviceClient = createServiceRoleClient();
    const { data: encryptedToken, error: tokenError } = await serviceClient
      .rpc('get_plaid_token', { p_plaid_item_id: plaidItem.id });

    if (tokenError || !encryptedToken) {
      logger.error('Failed to fetch token after relink', { plaid_item_id: plaidItem.id });
      return NextResponse.json({ error: 'Failed to retrieve credentials.' }, { status: 500 });
    }

    const accessToken = decrypt(encryptedToken);
    const plaidClient = getPlaidClient();

    // 1. Reconcile accounts — this is what persists a newly selected card.
    const { accountMap, createdAccountIds } = await refreshAccountsForItem(
      serviceClient,
      plaidClient,
      accessToken,
      plaidItem.id,
      user.id,
      plaidItem.entity_id
    );

    // 2. Clear the error state. Only after the accounts above are stored, so a
    //    failure there leaves the item visibly needing attention.
    const { error: statusError } = await serviceClient
      .from('plaid_items')
      .update({
        status: 'connected',
        last_error_code: null,
        error_count: 0,
      })
      .eq('id', plaidItem.id);

    if (statusError) {
      logger.error('Failed to reset item status after relink', {
        plaid_item_id: plaidItem.id,
        error_message: statusError.message,
      });
      return NextResponse.json({ error: 'Failed to update connection.' }, { status: 500 });
    }

    // 3. Requeue webhook events that failed only because the item was in
    //    reauth. They announced transaction updates we never ingested.
    const { data: requeued, error: requeueError } = await serviceClient
      .from('plaid_webhook_events')
      .update({ status: 'pending', error_message: null, processed_at: null })
      .eq('plaid_item_id', plaidItem.id)
      .eq('status', 'failed')
      .select('id');

    if (requeueError) {
      // Non-fatal: the connection is repaired and the nightly heal sweep will
      // pick the data up regardless.
      logger.warn('Failed to requeue webhook events after relink', {
        plaid_item_id: plaidItem.id,
        error_message: requeueError.message,
      });
    }

    await writeAuditLog(serviceClient, {
      userId: user.id,
      action: 'PLAID_ITEM_RELINKED',
      entityType: 'plaid_item',
      entityId: plaidItem.id,
      details: {
        previous_status: plaidItem.status,
        accounts_total: accountMap.size,
        accounts_created: createdAccountIds.length,
        webhook_events_requeued: requeued?.length ?? 0,
      },
      ipAddress: ip,
    });

    logger.info('Relink completed', {
      plaid_item_db_id: plaidItem.id,
      accounts_created: createdAccountIds.length,
      webhook_events_requeued: requeued?.length ?? 0,
    });

    return NextResponse.json({
      success: true,
      accounts_total: accountMap.size,
      accounts_created: createdAccountIds.length,
      webhook_events_requeued: requeued?.length ?? 0,
    });
  } catch (error) {
    logger.error('relink-complete error', { error_message: String(error) });
    const clientError = toClientError(error);
    return NextResponse.json({ error: clientError.error }, { status: clientError.status });
  }
}
