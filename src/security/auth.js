const crypto = require('crypto');

const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 horas

/**
 * Compara a senha informada com a senha da sala usando comparação
 * em tempo constante (proteção contra Timing Attacks).
 */
function verifyRoomPassword(inputPassword) {
  const configuredPassword = process.env.ROOM_PASSWORD || 'stage1080p';
  if (typeof inputPassword !== 'string' || inputPassword.length === 0) {
    return false;
  }

  const inputHash = crypto.createHash('sha256').update(inputPassword, 'utf8').digest();
  const targetHash = crypto.createHash('sha256').update(configuredPassword, 'utf8').digest();

  return crypto.timingSafeEqual(inputHash, targetHash);
}

/**
 * Higieniza e valida o apelido (nome) do usuário.
 */
function sanitizeDisplayName(rawName) {
  if (typeof rawName !== 'string') return '';
  const cleaned = rawName
    .replace(/[\u0000-\u001F\u007F<>"]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, 28);
}

/**
 * Gera um token de sessão assinado via HMAC-SHA256.
 */
function createSessionToken({ peerId, displayName }) {
  const now = Date.now();
  const payload = {
    peerId: peerId || crypto.randomUUID(),
    displayName,
    iat: now,
    exp: now + TOKEN_TTL_MS
  };

  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(payloadB64)
    .digest('base64url');

  return `${payloadB64}.${signature}`;
}

/**
 * Valida a assinatura e a expiração de um token de sessão.
 */
function verifySessionToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) {
    return null;
  }

  const [payloadB64, signature] = token.split('.');
  if (!payloadB64 || !signature) {
    return null;
  }

  const expectedSignature = crypto
    .createHmac('sha256', SESSION_SECRET)
    .update(payloadB64)
    .digest('base64url');

  const sigBuf = Buffer.from(signature, 'utf8');
  const expBuf = Buffer.from(expectedSignature, 'utf8');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (!payload.exp || Date.now() > payload.exp) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

module.exports = {
  verifyRoomPassword,
  sanitizeDisplayName,
  createSessionToken,
  verifySessionToken
};
