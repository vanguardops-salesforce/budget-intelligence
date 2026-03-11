```

Find the catch block at the bottom and replace:
```
logger.error('logger.error('create-link-token error', { error_message: String(error), response_data: JSON.stringify((error as any)?.response?.data), webhook_url: process.env.NEXT_PUBLIC_APP_URL, plaid_env: process.env.PLAID_ENV });create-link-token error', { error_message: String(error) });
```

With:
```
logger.error('create-link-token error', { error_message: String(error), response_data: JSON.stringify((error as any)?.response?.data), webhook_url: process.env.NEXT_PUBLIC_APP_URL, plaid_env: process.env.PLAID_ENV });export const dynamic = "force-dynamic";

import { NextResponse } from 'next/server';
import { CountryCode, Products } from 'plaid';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { requireMFA } from '@/lib/supabase/auth-config';
import { getPlaidClient } from '@/lib/plaid/client';
import { toClientError } from '@/lib/errors';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { getClientIP, writeAuditLog } from '@/lib/audit';
import { publicEnv } from '@/lib/env';
import { logger } from '@/lib/logger';

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

    // Parse optional entity_id from the request body
    let entityId: string | undefined;
    try {
      const body = await request.json();
      entityId = body.entity_id;
    } catch {
      // No body or invalid JSON — entity_id is optional
    }

    // If entity_id provided, verify the user owns it
    if (entityId) {
      const { data: entity, error: entityError } = await supabase
        .from('entities')
        .select('id')
        .eq('id', entityId)
        .eq('is_active', true)
        .single();

      if (entityError || !entity) {
        return NextResponse.json({ error: 'Invalid entity.' }, { status: 400 });
      }
    }

    const plaidClient = getPlaidClient();
    const webhookUrl = `${publicEnv.NEXT_PUBLIC_APP_URL}/api/plaid/webhook`;

    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: user.id },
      client_name: 'Budget Intelligence',
      products: [Products.Transactions],
      country_codes: [CountryCode.Us],
      language: 'en',
      webhook: webhookUrl,
    });

    logger.info('Link token created', { user_id: user.id });

    return NextResponse.json({
      link_token: response.data.link_token,
      expiration: response.data.expiration,
    });
  } catch (error) {
    logger.error('logger.error('create-link-token error', { error_message: String(error) });create-link-token error', { error_message: String(error), response_data: (error as any)?.response?.data, webhook_url: `${process.env.NEXT_PUBLIC_APP_URL}/api/plaid/webhook`, plaid_env: process.env.PLAID_ENV });
    const clientError = toClientError(error);
    return NextResponse.json({ error: clientError.error }, { status: clientError.status });
  }
}
