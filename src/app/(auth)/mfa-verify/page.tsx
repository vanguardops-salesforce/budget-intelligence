
'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useRouter } from 'next/navigation';

export default function MFAVerifyPage() {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [factorId, setFactorId] = useState<string | null>(null);
  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    loadFactor();
  }, []);

  async function loadFactor() {
    const { data: factors } = await supabase.auth.mfa.listFactors();
    if (factors && factors.totp.length > 0) {
      setFactorId(factors.totp[0].id);
    } else {
      // No TOTP factor — redirect to setup
      router.push('/mfa-setup');
    }
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    if (!factorId) return;

    setError(null);
    setLoading(true);

    try {
      const { data: challenge, error: challengeError } =
        await supabase.auth.mfa.challenge({ factorId });

      if (challengeError || !challenge) {
        setError('Failed to create verification challenge.');
        return;
      }

      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId,
        challengeId: challenge.id,
        code,
      });

      if (verifyError) {
        setError('Invalid code. Please try again.');
        setCode('');
        return;
      }

      fetch('/api/auth/audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'AUTH_MFA_VERIFIED' }),
      }).catch(() => {});

      // MFA verified — redirect to dashboard
      router.push('/');
    } catch {
      setError('Verification failed. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="w-full max-w-sm space-y-6 rounded-lg border bg-white p-8 shadow-sm">
        <div className="text-center">
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">
            Two-Factor Verification
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Enter the 6-digit code from your authenticator app.
          </p>
        </div>

        <form onSubmit={handleVerify} className="space-y-4">
          <div>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              autoComplete="one-time-code"
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              className="block w-full rounded-md border border-gray-300 px-3 py-3 text-center text-2xl tracking-[0.5em] shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder="000000"
            />
          </div>

          {error && (
            <div className="rounded-md bg-red-50 p-3 text-sm text-red-600">{error}</div>
          )}

          <button
            type="submit"
            disabled={loading || code.length !== 6}
            className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? 'Verifying...' : 'Verify'}
          </button>
        </form>

        <button
          onClick={async () => {
            await supabase.auth.signOut();
            router.push('/login');
          }}
          className="w-full text-center text-sm text-gray-400 hover:text-gray-600"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
