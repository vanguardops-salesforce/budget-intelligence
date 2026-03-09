import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { writeAuditLog, getClientIP } from '@/lib/audit';
import { toClientError } from '@/lib/errors';
import { logger } from '@/lib/logger';

const auditSchema = z.object({
  action: z.enum(['AUTH_LOGIN', 'AUTH_FAILED_LOGIN', 'AUTH_MFA_ENROLLED', 'AUTH_MFA_VERIFIED']),
});

/**
 * Lightweight endpoint for client-side auth pages to log audit events.
 * Requires an authenticated session (user must exist).
 */
export async function POST(request: Request) {
  try {
    const supabase = createServerSupabaseClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
    }

    const body = await request.json();
    const parsed = auditSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
    }

    const ip = getClientIP(request.headers) ?? 'unknown';
    await writeAuditLog(supabase, {
      userId: user.id,
      action: parsed.data.action,
      ipAddress: ip,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('Auth audit error', { error_message: String(error) });
    const clientError = toClientError(error);
    return NextResponse.json({ error: clientError.error }, { status: clientError.status });
  }
}
