import crypto from 'crypto';
import type { Request } from 'express';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';

const INSECURE_SECRETS = new Set([
  'dev_wallza_internal_secret',
  'wallza-default-internal-secret-for-dev-only',
  'default',
  'secret',
  'change-me',
  'test',
  'password',
  '123456',
]);

export function getInternalSecret(): string {
  const secret = process.env.WALLZAOS_INTERNAL_SECRET || process.env.WALLZA_INTERNAL_SECRET;

  if (!secret || typeof secret !== 'string' || secret.trim().length === 0) {
    throw new Error('[InternalAuth] Missing required WALLZAOS_INTERNAL_SECRET. Failing closed.');
  }

  const trimmed = secret.trim();
  const isProduction = process.env.NODE_ENV === 'production';

  if (isProduction) {
    if (INSECURE_SECRETS.has(trimmed.toLowerCase()) || trimmed.length < 32) {
      throw new Error(
        '[InternalAuth] WALLZAOS_INTERNAL_SECRET is using an insecure or default value in production. Failing closed.'
      );
    }
  }

  return trimmed;
}

export function computeBodySha256(rawBody: any): string {
  const payload =
    rawBody === undefined || rawBody === null
      ? ''
      : Buffer.isBuffer(rawBody)
      ? rawBody.toString('utf8')
      : typeof rawBody === 'string'
      ? rawBody
      : JSON.stringify(rawBody);
  return crypto.createHash('sha256').update(payload, 'utf8').digest('hex');
}

export function signInternalRequest(options: {
  method: string;
  path: string;
  audience: string;
  body?: any;
  secret?: string;
}): {
  'x-wallza-timestamp': string;
  'x-wallza-nonce': string;
  'x-wallza-audience': string;
  'x-wallza-signature': string;
} {
  const secret = options.secret || getInternalSecret();
  const timestamp = Date.now().toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const audience = options.audience.trim().toLowerCase();
  const method = options.method.trim().toUpperCase();
  const path = options.path.split('?')[0].trim();
  const bodyHash = computeBodySha256(options.body);

  const canonical = `${audience}:${method}:${path}:${timestamp}:${nonce}:${bodyHash}`;
  const signature = crypto.createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');

  return {
    'x-wallza-timestamp': timestamp,
    'x-wallza-nonce': nonce,
    'x-wallza-audience': audience,
    'x-wallza-signature': signature,
  };
}

export interface VerifyHmacOptions {
  expectedAudience: string;
  maxSkewMs?: number;
  secret?: string;
}

export async function verifyWallzaInternalRequest(
  req: Request & { rawBody?: Buffer | string },
  options: VerifyHmacOptions
): Promise<{ valid: boolean; error?: string }> {
  let secret: string;
  try {
    secret = options.secret || getInternalSecret();
  } catch (err: any) {
    return { valid: false, error: err.message };
  }

  const timestampHeader = (req.headers['x-wallza-timestamp'] as string) || '';
  const nonceHeader = (req.headers['x-wallza-nonce'] as string) || '';
  const audienceHeader = ((req.headers['x-wallza-audience'] as string) || '').trim().toLowerCase();
  const signatureHeader = (req.headers['x-wallza-signature'] as string) || '';

  if (!timestampHeader || !nonceHeader || !audienceHeader || !signatureHeader) {
    return { valid: false, error: 'Missing required internal HMAC authentication headers' };
  }

  // Strict format validation on original raw header strings
  if (!/^\d{13,16}$/.test(timestampHeader)) {
    return { valid: false, error: 'Malformed timestamp: must be strict integer millisecond timestamp' };
  }

  if (!/^[0-9a-fA-F]{64}$/.test(signatureHeader)) {
    return { valid: false, error: 'Malformed signature: must be exactly 64 hexadecimal characters' };
  }

  if (!/^[a-zA-Z0-9_\-]{8,128}$/.test(nonceHeader)) {
    return { valid: false, error: 'Malformed nonce: must be alphanumeric string between 8 and 128 characters' };
  }

  // 1. Audience verification
  const expectedAudience = options.expectedAudience.trim().toLowerCase();
  if (audienceHeader !== expectedAudience) {
    return { valid: false, error: `Invalid audience: expected ${expectedAudience}, got ${audienceHeader}` };
  }

  // 2. Timestamp & Clock Skew (default 5 minutes)
  const timestamp = Number(timestampHeader);
  if (isNaN(timestamp)) {
    return { valid: false, error: 'Invalid timestamp header' };
  }

  const maxSkew = options.maxSkewMs ?? 300_000;
  const skew = Math.abs(Date.now() - timestamp);
  if (skew > maxSkew) {
    return { valid: false, error: `Request timestamp out of bounds (skew: ${skew}ms, max: ${maxSkew}ms)` };
  }

  // 3. Signature verification (constant-time)
  try {
    const method = req.method.toUpperCase();
    const rawPath = (req.originalUrl || req.url || req.path || '').split('?')[0].trim();
    // Prefer req.rawBody if available from NestJS rawBody option, fallback to req.body
    const bodySource = (req as any).rawBody !== undefined ? (req as any).rawBody : req.body;
    const bodyHash = computeBodySha256(bodySource);

    const pathsToCheck = Array.from(new Set([
      rawPath,
      req.path,
      rawPath.replace(/^\/api/, ''),
      '/api' + rawPath,
      req.path ? req.path.replace(/^\/api/, '') : '',
      req.path ? '/api' + req.path : '',
    ])).filter(Boolean);

    let verified = false;
    for (const p of pathsToCheck) {
      const canonical = `${audienceHeader}:${method}:${p}:${timestampHeader}:${nonceHeader}:${bodyHash}`;
      const expectedSignature = crypto.createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');

      if (
        signatureHeader.length === expectedSignature.length &&
        crypto.timingSafeEqual(Buffer.from(signatureHeader, 'hex'), Buffer.from(expectedSignature, 'hex'))
      ) {
        verified = true;
        break;
      }
    }

    if (!verified) {
      return { valid: false, error: 'HMAC signature mismatch or request tampering detected' };
    }
  } catch (err: any) {
    return { valid: false, error: 'Malformed signature or verification parameters' };
  }

  // 4. Redis-backed replay nonce protection (atomic SET NX with 300s TTL)
  const nonceKey = `wallza:nonce:${audienceHeader}:${nonceHeader}`;
  try {
    const acquired = await ioRedis.set(nonceKey, timestampHeader, 'EX', 300, 'NX');
    if (!acquired) {
      return { valid: false, error: 'Replay attack detected: nonce already used' };
    }
  } catch (redisErr: any) {
    // If Redis is temporarily down in dev/test, fallback check or fail-closed in production
    if (process.env.NODE_ENV === 'production') {
      return { valid: false, error: 'Replay prevention storage unavailable in production. Failing closed.' };
    }
  }

  return { valid: true };
}
