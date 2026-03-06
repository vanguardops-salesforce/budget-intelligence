import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { getSecrets } from './env';

const ALGORITHM = 'aes-256-gcm';
const SALT = 'budget-intel-salt';
const KEY_LENGTH = 32;

function deriveKey(): Buffer {
  return scryptSync(getSecrets().ENCRYPTION_KEY, SALT, KEY_LENGTH);
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns: iv:authTag:ciphertext (all hex-encoded)
 */
export function encrypt(plaintext: string): string {
  const key = deriveKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Decrypt a ciphertext string produced by encrypt().
 * Throws on tampered or malformed input.
 */
export function decrypt(ciphertext: string): string {
  const key = deriveKey();
  const parts = ciphertext.split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed ciphertext');
  }
  const [ivHex, authTagHex, encrypted] = parts;

  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}
