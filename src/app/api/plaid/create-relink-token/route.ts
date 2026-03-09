import { NextResponse } from 'next/server';
import { z } from 'zod';
import { CountryCode } from 'plaid';
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase/server';
import { requireMFA } from '@/lib/supabase/auth-config';
import { getPlaidClient } from '@/lib/plaid/client';
import { decrypt } from '@/lib/crypto';
import { toClientError, ValidationError } from '@/lib/errors';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { getClientIP, writeAuditLog } from '@/lib/audit';
import { publicEnv } from '@/lib/env';
import { logger } from '@/lib/logger';

const schema = z.object({
  plaid_item_id: z.string().uuid(),
});

/**
 * POST /api/plaid/create-relink-token
 * Creates a link token in update mode for re-authenticating a degraded/errored Plaid item.
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

    // Verify item ownership via RLS
    const { data: plaidItem, error: itemError } = await supabase
      .from('plaid_items')
      .select('id, plaid_item_id')
      .eq('id', plaid_item_id)
      .single();

    if (itemError || !plaidItem) {
      return NextResponse.json({ error: 'Item not found.' }, { status: 404 });
    }

    // Decrypt the access token
    const serviceClient = createServiceRoleClient();
    const { data: tokenRow, error: tokenError } = await serviceClient
      .schema('private')
      .from('plaid_tokens')
      .select('access_token_encrypted')
      .eq('plaid_item_id', plaidItem.id)
      .single();

    if (tokenError || !tokenRow) {
      logger.error('Failed to fetch token for re-link', { plaid_item_id: plaidItem.id });
      return NextResponse.json({ error: 'Failed to retrieve credentials.' }, { status: 500 });
    }

    const accessToken = decrypt(tokenRow.access_token_encrypted);

    const plaidClient = getPlaidClient();
    const webhookUrl = `${publicEnv.NEXT_PUBLIC_APP_URL}/api/plaid/webhook`;

    // Create link token in update mode with the existing access token
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: user.id },
      client_name: 'Budget Intelligence',
      country_codes: [CountryCode.Us],
      language: 'en',
      webhook: webhookUrl,
      access_token: accessToken,
    });

    await writeAuditLog(serviceClient, {
      userId: user.id,
      action: 'PLAID_ITEM_REAUTH',
      entityType: 'plaid_item',
      entityId: plaidItem.id,
      details: { action: 'relink_token_created' },
      ipAddress: ip,
    });

    logger.info('Re-link token created', { plaid_item_db_id: plaidItem.id });

    return NextResponse.json({
      link_token: response.data.link_token,
      expiration: response.data.expiration,
    });
  } catch (error) {
    logger.error('create-relink-token error', { error_message: String(error) });
    const clientError = toClientError(error);
    return NextResponse.json({ error: clientError.error }, { status: clientError.status });
  }
}
