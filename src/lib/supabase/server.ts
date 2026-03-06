import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { publicEnv, getSecrets } from '../env';

/**
 * Server-side Supabase client — uses cookies for auth.
 * Respects RLS policies (runs as authenticated user).
 * Use in Server Components, Route Handlers, Server Actions.
 */
export function createServerSupabaseClient() {
  const cookieStore = cookies();

  return createServerClient(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value;
        },
        set(name: string, value: string, options: CookieOptions) {
          try {
            cookieStore.set({ name, value, ...options });
          } catch {
            // Can't set cookies in Server Components — ignore
          }
        },
        remove(name: string, options: CookieOptions) {
          try {
            cookieStore.set({ name, value: '', ...options });
          } catch {
            // Can't remove cookies in Server Components — ignore
          }
        },
      },
    }
  );
}

/**
 * Service-role Supabase client — bypasses ALL RLS.
 * Use ONLY for:
 *   - Accessing private.plaid_tokens
 *   - Webhook processing
 *   - Cron job operations
 *   - Admin operations that need cross-user access
 *
 * NEVER expose this client or its results directly to the browser.
 */
export function createServiceRoleClient() {
  const secrets = getSecrets();
  return createSupabaseClient(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    secrets.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  );
}
