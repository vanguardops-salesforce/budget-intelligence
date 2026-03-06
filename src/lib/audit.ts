import { type SupabaseClient } from '@supabase/supabase-js';
import type { AuditAction } from './types';
import { sanitizeForLog } from './logger';
import { logger } from './logger';

interface AuditParams {
  userId: string;
  action: AuditAction;
  entityType?: string;
  entityId?: string;
  details?: Record<string, unknown>;
  ipAddress?: string;
}

/**
 * Write an audit log entry. Uses the service_role client to bypass RLS
 * when called from server context, or the user's client for user-initiated events.
 *
 * All details are sanitized before storage — secrets are never persisted.
 */
export async function writeAuditLog(
  supabase: SupabaseClient,
  params: AuditParams
): Promise<void> {
  const sanitizedDetails = params.details ? sanitizeForLog(params.details) : null;

  const { error } = await supabase.from('audit_log').insert({
    user_id: params.userId,
    action: params.action,
    entity_type: params.entityType ?? null,
    entity_id: params.entityId ?? null,
    details: sanitizedDetails,
    ip_address: params.ipAddress ?? null,
  });

  if (error) {
    // Audit failures should not crash the app, but must be logged
    logger.error('Failed to write audit log', {
      action: params.action,
      error_message: error.message,
      error_code: error.code,
    });
  }
}

/**
 * Extract client IP from request headers (Vercel / Cloudflare / standard).
 */
export function getClientIP(headers: Headers): string | null {
  return (
    headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    headers.get('x-real-ip') ??
    null
  );
}
