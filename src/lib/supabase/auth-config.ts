import type { SupabaseClient } from '@supabase/supabase-js';
import { MFARequiredError } from '../errors';

/**
 * Verify that the current user has MFA enrolled and has completed the MFA challenge.
 * Throws MFARequiredError if either condition is not met.
 *
 * Call this on every authenticated route/page to enforce AAL2.
 */
export async function requireMFA(supabase: SupabaseClient): Promise<void> {
  const { data: factors, error: factorsError } = await supabase.auth.mfa.listFactors();

  if (factorsError) {
    throw new Error('Failed to check MFA status');
  }

  // No TOTP factors enrolled — redirect to enrollment
  if (!factors || factors.totp.length === 0) {
    throw new MFARequiredError('enrollment');
  }

  // Check the current assurance level
  const { data: aal, error: aalError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();

  if (aalError) {
    throw new Error('Failed to check authentication assurance level');
  }

  // User has factors but hasn't completed MFA challenge this session
  if (aal?.currentLevel !== 'aal2') {
    throw new MFARequiredError('challenge');
  }
}

/**
 * Get the current authenticated user or null.
 * Does NOT check MFA — use requireMFA separately.
 */
export async function getUser(supabase: SupabaseClient) {
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return null;
  return user;
}
