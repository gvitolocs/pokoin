const crypto = require('node:crypto');

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const ENCRYPTION_VERSION = 1;
const KEY_BYTES = 32;

function configError(message) {
  const error = new Error(message);
  error.statusCode = 500;
  error.code = 'cardtrader_encryption_config';
  return error;
}

function parseEncryptionKey(rawValue = process.env.CARDTRADER_TOKEN_ENCRYPTION_KEY) {
  const value = String(rawValue || '').trim();
  if (!value) {
    throw configError('CARDTRADER_TOKEN_ENCRYPTION_KEY is not configured.');
  }

  const candidates = [];
  if (/^[0-9a-f]{64}$/i.test(value)) {
    candidates.push(Buffer.from(value, 'hex'));
  }
  try {
    candidates.push(Buffer.from(value, 'base64'));
  } catch (_) {
    // Ignore invalid base64 and try the UTF-8 fallback below.
  }
  candidates.push(Buffer.from(value, 'utf8'));

  const key = candidates.find((candidate) => candidate.length === KEY_BYTES);
  if (!key) {
    throw configError(
      'CARDTRADER_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes.',
    );
  }
  return key;
}

function encryptSecret(plaintext, rawKey) {
  const value = String(plaintext || '');
  if (!value) {
    return null;
  }
  const key = parseEncryptionKey(rawKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(value, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    version: ENCRYPTION_VERSION,
    algorithm: ENCRYPTION_ALGORITHM,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function decryptSecret(encrypted, rawKey) {
  if (!encrypted) {
    return '';
  }
  if (
    encrypted.version !== ENCRYPTION_VERSION ||
    encrypted.algorithm !== ENCRYPTION_ALGORITHM
  ) {
    const error = new Error('Unsupported CardTrader secret encryption format.');
    error.statusCode = 500;
    throw error;
  }
  const key = parseEncryptionKey(rawKey);
  const decipher = crypto.createDecipheriv(
    ENCRYPTION_ALGORITHM,
    key,
    Buffer.from(String(encrypted.iv || ''), 'base64'),
  );
  decipher.setAuthTag(Buffer.from(String(encrypted.tag || ''), 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(String(encrypted.ciphertext || ''), 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

module.exports = {
  ENCRYPTION_ALGORITHM,
  decryptSecret,
  encryptSecret,
  parseEncryptionKey,
};
