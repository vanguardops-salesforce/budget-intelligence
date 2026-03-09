/**
 * Plaid webhook signature verification.
 * Uses Plaid's JWK-based JWT verification to ensure webhook authenticity.
 *
 * Plaid signs webhooks with a JWT in the `plaid-verification` header.
 * We verify the JWT using Plaid's public JWKS endpoint.
 */

import { createHash, createVerify } from 'crypto';
import { getPlaidClient } from './client';
import { logger } from '../logger';

export interface WebhookVerificationResult {
  verified: boolean;
  error?: string;
}

interface JWTHeader {
  alg: string;
  kid: string;
  typ: string;
}

interface JWTPayload {
  iat: number;
  request_body_sha256: string;
}

interface JWK {
  alg: string;
  crv: string;
  kid: string;
  kty: string;
  use: string;
  x: string;
  y: string;
}

// Cache verification keys to avoid repeated API calls (TTL: 30 minutes)
const keyCache = new Map<string, { key: JWK; fetchedAt: number }>();
const KEY_CACHE_TTL_MS = 30 * 60 * 1000;

/**
 * Verify a Plaid webhook request using JWT signature verification.
 *
 * Verification steps:
 * 1. Extract the JWT from the `plaid-verification` header
 * 2. Decode the JWT header to get the key ID (kid)
 * 3. Fetch the verification key from Plaid using the kid
 * 4. Verify the JWT signature using the public key
 * 5. Verify the request body SHA-256 hash matches
 * 6. Verify the JWT was issued within the last 5 minutes
 */
export async function verifyPlaidWebhook(
  body: string,
  headers: Headers
): Promise<WebhookVerificationResult> {
  try {
    const token = headers.get('plaid-verification');
    if (!token) {
      return { verified: false, error: 'Missing plaid-verification header' };
    }

    const parts = token.split('.');
    if (parts.length !== 3) {
      return { verified: false, error: 'Malformed JWT token' };
    }

    const headerJson = Buffer.from(parts[0], 'base64url').toString('utf8');
    const payloadJson = Buffer.from(parts[1], 'base64url').toString('utf8');

    let jwtHeader: JWTHeader;
    let jwtPayload: JWTPayload;
    try {
      jwtHeader = JSON.parse(headerJson);
      jwtPayload = JSON.parse(payloadJson);
    } catch {
      return { verified: false, error: 'Failed to parse JWT' };
    }

    if (!jwtHeader.kid) {
      return { verified: false, error: 'Missing kid in JWT header' };
    }

    // Fetch the verification key from Plaid
    const jwk = await getVerificationKey(jwtHeader.kid);
    if (!jwk) {
      return { verified: false, error: 'Failed to fetch verification key' };
    }

    // Verify JWT signature using ES256 (ECDSA with P-256 and SHA-256)
    const signatureValid = verifyES256Signature(
      `${parts[0]}.${parts[1]}`,
      parts[2],
      jwk
    );

    if (!signatureValid) {
      return { verified: false, error: 'Invalid JWT signature' };
    }

    // Verify request body hash
    const bodyHash = createHash('sha256').update(body).digest('hex');
    if (bodyHash !== jwtPayload.request_body_sha256) {
      return { verified: false, error: 'Body hash mismatch' };
    }

    // Reject if issued more than 5 minutes ago
    const issuedAt = jwtPayload.iat;
    const now = Math.floor(Date.now() / 1000);
    const MAX_AGE_SECONDS = 5 * 60;

    if (now - issuedAt > MAX_AGE_SECONDS) {
      return { verified: false, error: 'Webhook JWT expired' };
    }

    return { verified: true };
  } catch (error) {
    logger.error('Webhook verification error', { error_message: String(error) });
    return { verified: false, error: 'Verification failed unexpectedly' };
  }
}

/**
 * Fetch a Plaid verification key by key ID.
 * Uses an in-memory cache with 30-minute TTL.
 */
async function getVerificationKey(kid: string): Promise<JWK | null> {
  const cached = keyCache.get(kid);
  if (cached && Date.now() - cached.fetchedAt < KEY_CACHE_TTL_MS) {
    return cached.key;
  }

  try {
    const plaidClient = getPlaidClient();
    const response = await plaidClient.webhookVerificationKeyGet({
      key_id: kid,
    });

    const jwk = response.data.key as unknown as JWK;
    keyCache.set(kid, { key: jwk, fetchedAt: Date.now() });
    return jwk;
  } catch (error) {
    logger.error('Failed to fetch Plaid verification key', {
      kid,
      error_message: String(error),
    });
    return null;
  }
}

/**
 * Verify an ES256 (ECDSA P-256 + SHA-256) JWT signature.
 */
function verifyES256Signature(
  signingInput: string,
  signatureB64url: string,
  jwk: JWK
): boolean {
  try {
    // Convert JWK x/y coordinates to uncompressed EC point (0x04 || x || y)
    const xBuf = Buffer.from(jwk.x, 'base64url');
    const yBuf = Buffer.from(jwk.y, 'base64url');
    const uncompressedPoint = Buffer.concat([Buffer.from([0x04]), xBuf, yBuf]);

    // DER-encode as SubjectPublicKeyInfo for EC P-256
    const ecOid = Buffer.from('06072a8648ce3d0201', 'hex'); // OID 1.2.840.10045.2.1
    const p256Oid = Buffer.from('06082a8648ce3d030107', 'hex'); // OID 1.2.840.10045.3.1.7
    const algorithmIdentifier = derSequence(Buffer.concat([ecOid, p256Oid]));
    const bitString = Buffer.concat([
      Buffer.from([0x03, uncompressedPoint.length + 1, 0x00]),
      uncompressedPoint,
    ]);
    const spki = derSequence(Buffer.concat([algorithmIdentifier, bitString]));

    const pem =
      '-----BEGIN PUBLIC KEY-----\n' +
      spki.toString('base64').match(/.{1,64}/g)!.join('\n') +
      '\n-----END PUBLIC KEY-----';

    // Plaid uses raw R||S format — Node expects DER
    const rawSig = Buffer.from(signatureB64url, 'base64url');
    const derSig = rawSignatureToDER(rawSig);

    const verifier = createVerify('SHA256');
    verifier.update(signingInput);
    return verifier.verify(pem, derSig);
  } catch (error) {
    logger.error('ES256 verification failed', { error_message: String(error) });
    return false;
  }
}

function derSequence(content: Buffer): Buffer {
  const len = derLength(content.length);
  return Buffer.concat([Buffer.from([0x30]), len, content]);
}

function derLength(length: number): Buffer {
  if (length < 128) {
    return Buffer.from([length]);
  }
  const bytes: number[] = [];
  let temp = length;
  while (temp > 0) {
    bytes.unshift(temp & 0xff);
    temp >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/**
 * Convert raw R||S ECDSA signature to DER format.
 */
function rawSignatureToDER(raw: Buffer): Buffer {
  const halfLen = raw.length / 2;
  const r = raw.subarray(0, halfLen);
  const s = raw.subarray(halfLen);

  const derR = intToDER(r);
  const derS = intToDER(s);

  const content = Buffer.concat([derR, derS]);
  return derSequence(content);
}

function intToDER(value: Buffer): Buffer {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) {
    start++;
  }
  let trimmed = value.subarray(start);

  if (trimmed[0] & 0x80) {
    trimmed = Buffer.concat([Buffer.from([0x00]), trimmed]);
  }

  return Buffer.concat([Buffer.from([0x02, trimmed.length]), trimmed]);
}
