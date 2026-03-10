export const dynamic = "force-dynamic";

'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useRouter } from 'next/navigation';

export default function MFASetupPage() {
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [factorId, setFactorId] = useState<string | null>(null);
  const [verifyCode, setVerifyCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<'enroll' | 'verify'>('enroll');
  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    enrollMFA();
  }, []);

  async function enrollMFA() {
    setLoading(true);
    try {
      const { data, error: enrollError } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: 'Budget Intelligence TOTP',
      });

      if (enrollError || !data) {
        setError('Failed to set up MFA. Please try again.');
        return;
      }

      setQrCode(data.totp.qr_code);
      setSecret(data.totp.secret);
      setFactorId(data.id);
      setStep('verify');
    } catch {
      setError('Something went wrong during MFA setup.');
    } finally {
      setLoading(false);
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
        setError('Failed to create MFA challenge.');
        return;
      }

      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId,
        challengeId: challenge.id,
        code: verifyCode,
      });

      if (verifyError) {
        setError('Invalid code. Please try again.');
        return;
      }

      fetch('/api/auth/audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'AUTH_MFA_ENROLLED' }),
      }).catch(() => {});

      // MFA enrolled and verified — redirect to dashboard
      router.push('/');
    } catch {
      setError('Verification failed. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="w-full max-w-md space-y-6 rounded-lg border bg-white p-8 shadow-sm">
        <div className="text-center">
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">
            Set Up Two-Factor Authentication
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            MFA is required to access Budget Intelligence. Scan the QR code with your
            authenticator app (Google Authenticator, Authy, 1Password, etc).
          </p>
        </div>

        {loading && !qrCode && (
          <div className="text-center text-sm text-gray-500">Setting up MFA...</div>
        )}

        {step === 'verify' && qrCode && (
          <div className="space-y-4">
            <div className="flex justify-center">
              {/* QR code is a data URI from Supabase */}
              <img src={qrCode} alt="MFA QR Code" className="h-48 w-48" />
            </div>

            {secret && (
              <div className="rounded-md bg-gray-50 p-3 text-center">
                <p className="text-xs text-gray-500">
                  Can&apos;t scan? Enter this secret manually:
                </p>
                <code className="mt-1 block break-all text-sm font-mono text-gray-900">
                  {secret}
                </code>
              </div>
            )}

            <form onSubmit={handleVerify} className="space-y-4">
              <div>
                <label
                  htmlFor="code"
                  className="block text-sm font-medium text-gray-700"
                >
                  Enter verification code
                </label>
                <input
                  id="code"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  required
                  autoComplete="one-time-code"
                  value={verifyCode}
                  onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, ''))}
                  className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-center text-lg tracking-widest shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  placeholder="000000"
                />
              </div>

              {error && (
                <div className="rounded-md bg-red-50 p-3 text-sm text-red-600">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading || verifyCode.length !== 6}
                className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading ? 'Verifying...' : 'Verify & Complete Setup'}
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
