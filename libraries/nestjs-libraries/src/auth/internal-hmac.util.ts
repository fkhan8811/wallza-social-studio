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

// Secondary in-memory sliding window cache for fast deduplication / fallback
const memoryNonceCache = new Map<string, number>();

function pruneMemoryNonces() {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [key, ts] of memoryNonceCache.entries()) {
    if (ts < cutoff) memoryNonceCache.delete(key);
  }
}

setInterval(pruneMemoryNonces, 5 * 60 * 1000).unref();

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

/**
 * Signs an internal server-to-server request using canonical HMAC-SHA256.
 * Note: Requirement 1 strictly removes the Authorization Bearer header to prevent
 * shared-secret exposure in network proxies or request headers.
 */
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
  const signature = crypto
    .createHmac('sha256', secret)
    .update(canonical, 'utf8')
    .digest('hex');

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
  prisma?: any; // Optional PrismaClient / PrismaService for persistent DB-backed replay protection
  pool?: any;   // Optional pg Pool for persistent DB-backed replay protection
}

export async function verifyInternalRequestAsync(
  req: Request,
  options: VerifyHmacOptions
): Promise<{ valid: boolean; error?: string }> {
  return verifyInternalRequestInternal(req, options, true);
}

export function verifyInternalRequest(
  req: Request,
  options: VerifyHmacOptions
): { valid: boolean; error?: string } {
  // Synchronous signature verification with in-memory or non-blocking DB record
  const result = verifyInternalRequestInternal(req, options, false);
  return result as { valid: boolean; error?: string };
}

function verifyInternalRequestInternal(
  req: Request,
  options: VerifyHmacOptions,
  asyncDb: boolean
): { valid: boolean; error?: string } | Promise<{ valid: boolean; error?: string }> {
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

  // 1. Audience verification
  const expectedAudience = options.expectedAudience.trim().toLowerCase();
  if (audienceHeader !== expectedAudience) {
    return {
      valid: false,
      error: `Invalid audience: expected ${expectedAudience}, got ${audienceHeader}`,
    };
  }

  // 2. Timestamp & Clock Skew (default 5 minutes)
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

  // 3. Signature verification (constant-time, safe against malformed inputs)
  try {
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
  } catch {
    return {
      valid: false,
      error: 'Malformed signature or verification parameters',
    };
  }

  // 4. Persistent Replay Protection (Fail-Closed)
  // Only a successful unique database insert permits verification.
  if (options.prisma) {
    if (asyncDb) {
      return (async () => {
        try {
          await options.prisma.internalRequestNonce.create({
            data: {
              audience: audienceHeader,
              nonce: nonceHeader,
              timestamp: BigInt(timestamp),
            },
          });
          return { valid: true };
        } catch (dbErr: any) {
          if (dbErr?.code === 'P2002') {
            return {
              valid: false,
              error: 'HMAC nonce has already been consumed (replay attack detected)',
            };
          }
          // Fail closed on Prisma connection errors, missing tables, migration failures, etc.
          return {
            valid: false,
            error: `HMAC persistent replay verification failed closed: database error (${dbErr?.message || 'DB error'})`,
          };
        }
      })();
    } else {
      if (process.env.NODE_ENV === 'production') {
        throw new Error(
          '[Security Violation] Production handlers must call verifyInternalRequestAsync() to await persistent DB nonce checks.'
        );
      }
    }
  }

  if (options.pool) {
    if (asyncDb) {
      return (async () => {
        try {
          const insertRes = await options.pool.query(
            `INSERT INTO public.internal_request_nonces (audience, nonce, timestamp, created_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (audience, nonce) DO NOTHING
             RETURNING 1`,
            [audienceHeader, nonceHeader, timestamp]
          );
          if (!insertRes || !insertRes.rows || insertRes.rows.length === 0) {
            return { valid: false, error: 'HMAC nonce has already been consumed (replay attack detected)' };
          }
          return { valid: true };
        } catch (dbErr: any) {
          if (dbErr?.code === '23505') {
            return { valid: false, error: 'HMAC nonce has already been consumed (replay attack detected)' };
          }
          return {
            valid: false,
            error: `HMAC persistent replay verification failed closed: database error (${dbErr?.message || 'DB error'})`,
          };
        }
      })();
    }
  }

  if (process.env.NODE_ENV === 'production') {
    return {
      valid: false,
      error: 'Database provider (Prisma or Pool) required for persistent HMAC verification in production. In-memory fallback forbidden.',
    };
  }

  // Non-production test runner fallback only when no DB is provided:
  const nonceKey = `${audienceHeader}:${nonceHeader}`;
  if (memoryNonceCache.has(nonceKey)) {
    return { valid: false, error: 'HMAC nonce has already been consumed (replay attack detected)' };
  }
  memoryNonceCache.set(nonceKey, Date.now());

  return { valid: true };
}
