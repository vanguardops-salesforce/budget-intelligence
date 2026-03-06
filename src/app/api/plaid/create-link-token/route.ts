import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { requireMFA } from '@/lib/supabase/auth-config';
import { toClientError } from '@/lib/errors';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { getClientIP, writeAuditLog } from '@/lib/audit';
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

    // Phase 2: Implement Plaid Link token creation
    return NextResponse.json({ error: 'Not yet implemented.' }, { status: 501 });
  } catch (error) {
    logger.error('create-link-token error', { error_message: String(error) });
    const clientError = toClientError(error);
    return NextResponse.json({ error: clientError.error }, { status: clientError.status });
  }
}
