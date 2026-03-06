import { createBrowserClient } from '@supabase/ssr';
import { publicEnv } from '../env';

/**
 * Browser-side Supabase client. Uses the anon key only.
 * RLS policies enforce data isolation.
 */
export function createClient() {
  return createBrowserClient(
    publicEnv.NEXT_PUBLIC_SUPABASE_URL,
    publicEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
}
