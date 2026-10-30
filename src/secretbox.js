'use strict';
/**
 * Small symmetric cipher used to keep secrets (the SMTP password) out of
 * data/mail.json in readable form. AES-256-GCM with a key derived from the
 * app's session secret, so the stored value is useless without it.
 *
 * Format:  v1.<iv base64url>.<tag base64url>.<ciphertext base64url>
 */
const crypto = require('crypto');

const PREFIX = 'v1';

function keyFor(secret) {
  return crypto.createHash('sha256').update(String(secret || '')).digest();
}

/** Encrypt a string. Empty input yields an empty string (nothing to hide). */
function seal(plain, secret) {
  const text = String(plain == null ? '' : plain);
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFor(secret), iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString('base64url'), tag.toString('base64url'), enc.toString('base64url')].join('.');
}

/** Decrypt what seal() produced. Returns '' when the value is missing or unreadable. */
function open(sealed, secret) {
  const s = String(sealed || '');
  if (!s) return '';
  const parts = s.split('.');
  if (parts.length !== 4 || parts[0] !== PREFIX) return '';
  try {
    const iv = Buffer.from(parts[1], 'base64url');
    const tag = Buffer.from(parts[2], 'base64url');
    const data = Buffer.from(parts[3], 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyFor(secret), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

module.exports = { seal, open };
