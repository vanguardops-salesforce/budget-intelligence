import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient, createServiceRoleClient } from '@/lib/supabase/server';
import { requireMFA } from '@/lib/supabase/auth-config';
import { toClientError } from '@/lib/errors';
import { writeAuditLog, getClientIP } from '@/lib/audit';
import { logger } from '@/lib/logger';
import { runDataHealthAudit, getLatestAudit } from '@/lib/audit/runner';

/**
 * POST /api/audit/run
 * Manually trigger the Data Health audit for the authenticated user and return
 * the resulting run + findings so the dashboard panel can refresh.
 *
 * Authorizes as the user (auth + MFA), then executes with a service-role client
 * scoped to that user_id — mirroring the cron, and matching the read-across-all
 * -of-the-user's-data nature of the audit.
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = createServerSupabaseClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
    }

    await requireMFA(supabase);

    const service = createServiceRoleClient();
    await runDataHealthAudit(service, user.id, 'manual');
    const latest = await getLatestAudit(service, user.id);

    const ip = getClientIP(request.headers) ?? 'unknown';
    await writeAuditLog(supabase, {
      userId: user.id,
      action: 'FINANCIAL_STATE_ACCESSED',
      entityType: 'audit_run',
      entityId: latest?.run.id,
      details: { triggered_by: 'manual', findings: latest?.findings.length ?? 0 },
      ipAddress: ip,
    });

    return NextResponse.json({ latest });
  } catch (error) {
    logger.error('Manual audit run error', { error_message: String(error) });
    const clientError = toClientError(error);
    return NextResponse.json({ error: clientError.error }, { status: clientError.status });
  }
}
