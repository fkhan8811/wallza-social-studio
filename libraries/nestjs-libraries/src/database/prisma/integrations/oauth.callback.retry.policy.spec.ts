import { describe, expect, it } from 'vitest';
import {
  getOAuthCallbackRetryDelayMs,
  MAX_OAUTH_CALLBACK_ATTEMPTS,
  sanitizeOAuthCallbackError,
} from './oauth.callback.retry.policy';

describe('OAuth callback retry policy', () => {
  it('uses bounded exponential delays with bounded jitter', () => {
    expect(getOAuthCallbackRetryDelayMs(1, () => 0)).toBe(5_000);
    expect(getOAuthCallbackRetryDelayMs(2, () => 0.5)).toBe(11_000);
    expect(getOAuthCallbackRetryDelayMs(99, () => 0)).toBe(30 * 60 * 1000);
    expect(getOAuthCallbackRetryDelayMs(99, () => 1)).toBeLessThanOrEqual(36 * 60 * 1000);
  });

  it('normalizes invalid attempt values and keeps retries bounded', () => {
    expect(getOAuthCallbackRetryDelayMs(Number.NaN, () => 0)).toBe(5_000);
    expect(MAX_OAUTH_CALLBACK_ATTEMPTS).toBe(5);
  });

  it('redacts authorization values, credential fields, URLs and multiline content', () => {
    const sanitized = sanitizeOAuthCallbackError(
      'Authorization: Bearer secret-token access_token=abc123 password=hunter2 https://provider.example/path\nnext-line'
    );
    expect(sanitized).not.toContain('secret-token');
    expect(sanitized).not.toContain('abc123');
    expect(sanitized).not.toContain('hunter2');
    expect(sanitized).not.toContain('https://provider.example');
    expect(sanitized).not.toContain('\n');
    expect(sanitized).toContain('[REDACTED]');
    expect(sanitized).toContain('[remote-url]');
  });
});
