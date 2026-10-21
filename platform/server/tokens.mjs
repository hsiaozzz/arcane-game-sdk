import { createHmac, timingSafeEqual, randomUUID, sign, verify, createPrivateKey, createPublicKey } from 'node:crypto';
import { assert, PlatformError } from './errors.mjs';

const encode = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
const decode = value => JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
export const opaqueId = prefix => `${prefix}_${randomUUID()}`;

export function secretEqual(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function validateClaims(claims, { audience, now, maxLifetime = 7 * 86400_000 }) {
  assert(claims && claims.iss === 'arcane-game-platform' && claims.aud === audience,
    'INVALID_TOKEN', '凭证用途不匹配。', 401);
  assert(Number.isSafeInteger(claims.iat) && Number.isSafeInteger(claims.exp) &&
    claims.iat <= now + 5000 && claims.exp > now && claims.exp > claims.iat && claims.exp - claims.iat <= maxLifetime,
    'TOKEN_EXPIRED', '凭证已过期，请重新连接。', 401);
  assert(typeof claims.jti === 'string' && claims.jti.length >= 16 && typeof claims.sub === 'string' && claims.sub.length <= 128,
    'INVALID_TOKEN', '凭证格式无效。', 401);
  return claims;
}

export function createTokenService({ secret, now = Date.now }) {
  assert(typeof secret === 'string' && secret.length >= 32, 'CONFIG_ERROR', 'Token signing secret must be at least 32 characters.', 500);
  return {
    issue(audience, subject, fields = {}, lifetime = 300_000) {
      const at = now();
      const claims = { ...fields, iss: 'arcane-game-platform', aud: audience, sub: subject, iat: at, exp: at + lifetime, jti: randomUUID() };
      const body = `${encode({ alg: 'HS256', typ: 'JWT', v: 1 })}.${encode(claims)}`;
      return { token: `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`, expiresAt: claims.exp, claims };
    },
    verify(token, audience, maxLifetime) {
      assert(typeof token === 'string' && token.length <= 8192, 'INVALID_TOKEN', '缺少有效凭证。', 401);
      const parts = token.split('.');
      assert(parts.length === 3 && parts.every(p => /^[A-Za-z0-9_-]+$/.test(p)), 'INVALID_TOKEN', '凭证格式无效。', 401);
      const body = `${parts[0]}.${parts[1]}`;
      assert(secretEqual(parts[2], createHmac('sha256', secret).update(body).digest('base64url')), 'INVALID_TOKEN', '凭证签名无效。', 401);
      try {
        const header = decode(parts[0]);
        assert(header.alg === 'HS256' && header.typ === 'JWT' && header.v === 1, 'INVALID_TOKEN', '凭证格式无效。', 401);
        return validateClaims(decode(parts[1]), { audience, now: now(), maxLifetime });
      } catch (error) {
        if (error instanceof PlatformError) throw error;
        throw new PlatformError('INVALID_TOKEN', '凭证格式无效。', 401);
      }
    },
  };
}

export function createMatchTicketService({ privateKey, publicKey, now = Date.now }) {
  const signingKey = privateKey ? createPrivateKey(privateKey) : null;
  const verificationKey = publicKey ? createPublicKey(publicKey) : signingKey ? createPublicKey(signingKey) : null;
  assert(verificationKey?.asymmetricKeyType === 'ed25519', 'CONFIG_ERROR', 'An Ed25519 match verification key is required.', 500);
  const keyId = 'arcane-match-v1';
  return {
    publicKey: verificationKey.export({ type: 'spki', format: 'pem' }),
    issue(subject, fields, lifetime = 30_000) {
      assert(signingKey, 'CONFIG_ERROR', 'This service cannot sign match tickets.', 500);
      const at = now();
      const claims = { ...fields, sub: subject, iss: 'arcane-game-platform', aud: 'arcane-match', iat: at, exp: at + lifetime, jti: randomUUID() };
      const body = `${encode({ alg: 'EdDSA', typ: 'JWT', kid: keyId })}.${encode(claims)}`;
      return { ticket: `${body}.${sign(null, Buffer.from(body), signingKey).toString('base64url')}`, expiresAt: claims.exp };
    },
    verify(ticket) {
      assert(typeof ticket === 'string' && ticket.length < 8192, 'INVALID_TOKEN', '比赛入场凭证无效。', 401);
      const parts = ticket.split('.');
      assert(parts.length === 3 && parts.every(p => /^[A-Za-z0-9_-]+$/.test(p)), 'INVALID_TOKEN', '比赛入场凭证无效。', 401);
      try {
        const header = decode(parts[0]);
        assert(header.alg === 'EdDSA' && header.kid === keyId &&
          verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), verificationKey, Buffer.from(parts[2], 'base64url')),
          'INVALID_TOKEN', '比赛入场凭证签名无效。', 401);
        return validateClaims(decode(parts[1]), { audience: 'arcane-match', now: now(), maxLifetime: 60_000 });
      } catch (error) {
        if (error instanceof PlatformError) throw error;
        throw new PlatformError('INVALID_TOKEN', '比赛入场凭证格式无效。', 401);
      }
    },
  };
}
