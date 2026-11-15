import { describe, expect, it } from 'vitest';
import { sanitizeReturnUrl } from './safe.return.url';

describe('sanitizeReturnUrl', () => {
  it('preserves safe same-origin relative paths', () => {
    expect(sanitizeReturnUrl('/launches')).toBe('/launches');
    expect(sanitizeReturnUrl('/launches?connect=facebook#top')).toBe('/launches?connect=facebook#top');
    expect(sanitizeReturnUrl('/settings/profile')).toBe('/settings/profile');
  });

  it('rejects absolute and protocol-relative URLs', () => {
    expect(sanitizeReturnUrl('https://evil.example')).toBe('/launches');
    expect(sanitizeReturnUrl('//evil.example/path')).toBe('/launches');
    expect(sanitizeReturnUrl('/\\\\evil.example')).toBe('/launches');
  });

  it('rejects script schemes and backslash path tricks', () => {
    expect(sanitizeReturnUrl('/javascript:alert(1)')).toBe('/launches');
    expect(sanitizeReturnUrl('/data:text/html,hello')).toBe('/launches');
    expect(sanitizeReturnUrl('/\\evil.example')).toBe('/launches');
    expect(sanitizeReturnUrl('/safe\\\\..\\\\evil')).toBe('/launches');
  });

  it('uses the configured fallback for absent or malformed values', () => {
    expect(sanitizeReturnUrl(null)).toBe('/launches');
    expect(sanitizeReturnUrl('')).toBe('/launches');
    expect(sanitizeReturnUrl('not-a-path', '/home')).toBe('/home');
  });
});
