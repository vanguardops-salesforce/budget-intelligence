import { z } from 'zod';

// Public environment variables — safe for browser
const publicSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  NEXT_PUBLIC_APP_URL: z.string().url(),
});

// Plaid environment — validated to prevent accidental misconfiguration
const plaidEnvSchema = z.enum(['sandbox', 'development', 'production']);
export type PlaidEnv = z.infer<typeof plaidEnvSchema>;

// Server-only secrets — NEVER expose to browser
const secretSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  PLAID_CLIENT_ID: z.string().min(1),
  PLAID_SECRET: z.string().min(1),
  PLAID_WEBHOOK_SECRET: z.string().min(1),
  PLAID_ENV: plaidEnvSchema,
  OPENAI_API_KEY: z.string().startsWith('sk-'),
  FMP_API_KEY: z.string().min(1),
  ENCRYPTION_KEY: z.string().length(64),
  CRON_SECRET: z.string().min(16),
});

export type PublicEnv = z.infer<typeof publicSchema>;
export type Secrets = z.infer<typeof secretSchema>;

export const publicEnv = publicSchema.parse({
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
});

let _secrets: Secrets | null = null;

export function getSecrets(): Secrets {
  if (typeof window !== 'undefined') {
    throw new Error('CRITICAL: getSecrets() called in browser context.');
  }
  if (!_secrets) {
    _secrets = secretSchema.parse({
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
      PLAID_CLIENT_ID: process.env.PLAID_CLIENT_ID,
      PLAID_SECRET: process.env.PLAID_SECRET,
      PLAID_WEBHOOK_SECRET: process.env.PLAID_WEBHOOK_SECRET,
      PLAID_ENV: process.env.PLAID_ENV,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      FMP_API_KEY: process.env.FMP_API_KEY,
      ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
      CRON_SECRET: process.env.CRON_SECRET,
    });
  }
  return _secrets;
}
