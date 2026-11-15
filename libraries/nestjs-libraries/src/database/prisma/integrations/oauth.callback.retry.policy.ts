export const MAX_OAUTH_CALLBACK_ATTEMPTS = 5;
const BASE_RETRY_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 30 * 60 * 1000;

/** Remove likely credentials, authorization values, URLs and multiline payloads from logs. */
export function sanitizeOAuthCallbackError(value: unknown): string | null {
  if (!value) return null;
  return String(value)
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/(access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|password|authorization)\s*[:=]\s*["']?[^\s,"']+/gi, '$1=[REDACTED]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[remote-url]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 500);
}

/** Persisted retry delay with bounded exponential backoff and bounded jitter. */
export function getOAuthCallbackRetryDelayMs(
  attempts: number,
  random: () => number = Math.random
): number {
  const safeAttempts = Number.isFinite(attempts)
    ? Math.max(1, Math.floor(attempts))
    : 1;
  const exponentialDelay = Math.min(
    MAX_RETRY_DELAY_MS,
    BASE_RETRY_DELAY_MS * (2 ** Math.min(20, safeAttempts - 1))
  );
  const randomValue = Math.min(0.999999999, Math.max(0, random()));
  const jitter = Math.floor(randomValue * Math.max(1, exponentialDelay * 0.2));
  return exponentialDelay + jitter;
}
