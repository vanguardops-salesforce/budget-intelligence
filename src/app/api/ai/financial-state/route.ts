export const dynamic = "force-dynamic";

import { NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { requireMFA } from '@/lib/supabase/auth-config';
import { toClientError } from '@/lib/errors';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { getClientIP, writeAuditLog } from '@/lib/audit';
import { logger } from '@/lib/logger';
import { computeFinancialState } from '@/lib/ai/financial-intelligence';

export async function GET(request: Request) {
  try {
    const supabase = createServerSupabaseClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
    }

    await requireMFA(supabase);

    const rateCheck = checkRateLimit(RATE_LIMITS.FINANCIAL_STATE, user.id);
    if (!rateCheck.allowed) {
      return NextResponse.json({ error: 'Too many requests.' }, { status: 429 });
    }

    const ip = getClientIP(request.headers) ?? 'unknown';

    // Compute full financial state
    const state = await computeFinancialState(supabase, user.id);

    await writeAuditLog(supabase, {
      userId: user.id,
      action: 'FINANCIAL_STATE_ACCESSED',
      ipAddress: ip,
      details: {
        net_worth: state.net_worth.total,
        entity_count: state.entities.length,
        alert_count: state.alerts.length,
      },
    });

    return NextResponse.json(state);
  } catch (error) {
    logger.error('Financial state error', { error_message: String(error) });
    const clientError = toClientError(error);
    return NextResponse.json({ error: clientError.error }, { status: clientError.status });
  }
}
