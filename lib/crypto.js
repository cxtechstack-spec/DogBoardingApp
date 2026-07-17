// AES-256-GCM encryption for secrets stored at rest (per-client GHL API tokens).
// Uses Node's built-in crypto module — no new dependency.
//
// Requires ENCRYPTION_KEY in .env: a 32-byte key, hex-encoded (64 hex chars).
// Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
// Losing this key makes every stored token unrecoverable — back it up somewhere safe,
// separate from the database itself.
import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // recommended IV length for GCM

function getKey() {
  const keyHex = process.env.ENCRYPTION_KEY;
  if (!keyHex) throw new Error('ENCRYPTION_KEY environment variable is not set');
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
  return key;
}

export function encrypt(plaintext) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext.toString('base64')}`;
}

export function decrypt(encoded) {
  const [ivB64, authTagB64, ciphertextB64] = encoded.split(':');
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}
