import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { requireMFA } from '@/lib/supabase/auth-config';
import { toClientError } from '@/lib/errors';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { getClientIP, writeAuditLog } from '@/lib/audit';
import { logger } from '@/lib/logger';
import { getPlaidClient } from '@/lib/plaid/client';
import { CountryCode, Products } from 'plaid';
import { publicEnv } from '@/lib/env';
import { z } from 'zod';

const bodySchema = z.object({
  entity_id: z.string().uuid(),
});

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
      await writeAuditLog(supabase, {
        userId: user.id,
        action: 'RATE_LIMIT_EXCEEDED',
        details: { endpoint: 'create-link-token', ip_address: ip },
        ipAddress: ip,
      });
      return NextResponse.json({ error: 'Too many requests.' }, { status: 429 });
    }

    const body = await request.json();
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
    }

    // Verify the entity belongs to this user
    const { data: entity } = await supabase
      .from('entities')
      .select('id')
      .eq('id', parsed.data.entity_id)
      .eq('user_id', user.id)
      .eq('is_active', true)
      .single();

    if (!entity) {
      return NextResponse.json({ error: 'Entity not found.' }, { status: 404 });
    }

    const plaid = getPlaidClient();
    const webhookUrl = `${publicEnv.NEXT_PUBLIC_APP_URL}/api/plaid/webhook`;

    const response = await plaid.linkTokenCreate({
      user: { client_user_id: user.id },
      client_name: 'Budget Intelligence',
      products: [Products.Transactions],
      country_codes: [CountryCode.Us],
      language: 'en',
      webhook: webhookUrl,
    });

    logger.info('Link token created', { user_id: user.id, entity_id: parsed.data.entity_id });

    return NextResponse.json({
      link_token: response.data.link_token,
      expiration: response.data.expiration,
    });
  } catch (error) {
    logger.error('create-link-token error', { error_message: String(error) });
    const clientError = toClientError(error);
    return NextResponse.json({ error: clientError.error }, { status: clientError.status });
  }
}
