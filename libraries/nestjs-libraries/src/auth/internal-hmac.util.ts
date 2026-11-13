import crypto from 'crypto';
import type { Request } from 'express';

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

const seenNonces = new Map<string, number>();

function pruneOldNonces() {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [nonce, timestamp] of seenNonces.entries()) {
    if (timestamp < cutoff) {
      seenNonces.delete(nonce);
    }
  }
}

setInterval(pruneOldNonces, 5 * 60 * 1000).unref();

export function getInternalSecret(): string {
  const secret =
    process.env.WALLZAOS_INTERNAL_SECRET || process.env.WALLZA_INTERNAL_SECRET;

  if (!secret || typeof secret !== 'string' || secret.trim().length === 0) {
    throw new Error(
      '[InternalAuth] Missing required WALLZAOS_INTERNAL_SECRET. Failing closed.'
    );
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

export function computeBodySha256(body: any): string {
  const payload =
    body === undefined || body === null
      ? ''
      : typeof body === 'string'
      ? body
      : JSON.stringify(body);
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
  authorization: string;
} {
  const secret = options.secret || getInternalSecret();
  const timestamp = Date.now().toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const audience = options.audience.trim().toLowerCase();
  const method = options.method.trim().toUpperCase();
  const path = options.path.split('?')[0].trim();
  const bodyHash = computeBodySha256(options.body);

  const canonical = `${audience}:${method}:${path}:${timestamp}:${nonce}:${bodyHash}`;
  const signature = crypto
    .createHmac('sha256', secret)
    .update(canonical, 'utf8')
    .digest('hex');

  return {
    'x-wallza-timestamp': timestamp,
    'x-wallza-nonce': nonce,
    'x-wallza-audience': audience,
    'x-wallza-signature': signature,
    authorization: `Bearer ${secret}`,
  };
}

export function verifyInternalRequest(
  req: Request,
  options: {
    expectedAudience: string;
    maxSkewMs?: number;
    secret?: string;
  }
): { valid: boolean; error?: string } {
  let secret: string;
  try {
    secret = options.secret || getInternalSecret();
  } catch (err: any) {
    return { valid: false, error: err.message };
  }

  const timestampHeader = (req.headers['x-wallza-timestamp'] as string) || '';
  const nonceHeader = (req.headers['x-wallza-nonce'] as string) || '';
  const audienceHeader = (
    (req.headers['x-wallza-audience'] as string) || ''
  ).trim().toLowerCase();
  const signatureHeader = (req.headers['x-wallza-signature'] as string) || '';

  if (!timestampHeader || !nonceHeader || !audienceHeader || !signatureHeader) {
    return {
      valid: false,
      error: 'Missing required internal HMAC authentication headers',
    };
  }

  const expectedAudience = options.expectedAudience.trim().toLowerCase();
  if (audienceHeader !== expectedAudience) {
    return {
      valid: false,
      error: `Invalid audience: expected ${expectedAudience}, got ${audienceHeader}`,
    };
  }

  const timestamp = Number(timestampHeader);
  if (isNaN(timestamp)) {
    return { valid: false, error: 'Invalid timestamp header' };
  }

  const maxSkew = options.maxSkewMs ?? 300_000;
  const skew = Math.abs(Date.now() - timestamp);
  if (skew > maxSkew) {
    return {
      valid: false,
      error: `Request timestamp out of bounds (skew: ${skew}ms, max: ${maxSkew}ms)`,
    };
  }

  pruneOldNonces();
  if (seenNonces.has(nonceHeader)) {
    return { valid: false, error: 'Replay attack detected: nonce already used' };
  }

  const method = req.method.toUpperCase();
  const rawPath = (req.originalUrl || req.url || req.path || '')
    .split('?')[0]
    .trim();
  const bodyHash = computeBodySha256(req.body);

  const pathsToCheck = Array.from(new Set([rawPath, req.path])).filter(Boolean);

  let verified = false;
  for (const p of pathsToCheck) {
    const canonical = `${audienceHeader}:${method}:${p}:${timestampHeader}:${nonceHeader}:${bodyHash}`;
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(canonical, 'utf8')
      .digest('hex');

    if (
      signatureHeader.length === expectedSignature.length &&
      crypto.timingSafeEqual(
        Buffer.from(signatureHeader, 'hex'),
        Buffer.from(expectedSignature, 'hex')
      )
    ) {
      verified = true;
      break;
    }
  }

  if (!verified) {
    return {
      valid: false,
      error: 'HMAC signature mismatch or request tampering detected',
    };
  }

  seenNonces.set(nonceHeader, Date.now());
  return { valid: true };
}
