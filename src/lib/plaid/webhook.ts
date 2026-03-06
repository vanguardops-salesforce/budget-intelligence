import { createHmac, timingSafeEqual } from 'crypto';
import { getSecrets } from '../env';
import { logger } from '../logger';

export interface WebhookVerificationResult {
  verified: boolean;
  error?: string;
}

/**
 * Verify a Plaid webhook using HMAC-SHA256 signature.
 *
 * Plaid sends a `Plaid-Verification` header containing the HMAC signature.
 * We recompute the HMAC over the raw request body using PLAID_WEBHOOK_SECRET
 * and compare using constant-time comparison.
 *
 * NOTE: For production with Plaid's JWS-based verification, upgrade to
 * fetching the verification key from /webhook_verification_key/get and
 * verifying the JWS token with jose. This implementation works for
 * sandbox/development with a shared secret.
 */
export async function verifyPlaidWebhook(
  body: string,
  headers: Headers
): Promise<WebhookVerificationResult> {
  try {
    const plaidSignature = headers.get('plaid-verification');

    if (!plaidSignature) {
      return { verified: false, error: 'Missing Plaid-Verification header' };
    }

    const secrets = getSecrets();
    const expectedSignature = createHmac('sha256', secrets.PLAID_WEBHOOK_SECRET)
      .update(body)
      .digest('hex');

    // Constant-time comparison to prevent timing attacks
    const sigBuffer = Buffer.from(plaidSignature, 'utf8');
    const expectedBuffer = Buffer.from(expectedSignature, 'utf8');

    if (sigBuffer.length !== expectedBuffer.length) {
      return { verified: false, error: 'Signature mismatch' };
    }

    if (!timingSafeEqual(sigBuffer, expectedBuffer)) {
      return { verified: false, error: 'Signature mismatch' };
    }

    return { verified: true };
  } catch (error) {
    logger.error('Webhook verification error', { error_message: String(error) });
    return { verified: false, error: 'Verification failed unexpectedly' };
  }
}
