import { describe, expect, it } from 'vitest';
import { mapWallzaProviderCredentials } from './wallza.provider.credentials';

describe('mapWallzaProviderCredentials', () => {
  it('maps Bluesky and WordPress custom field names to provider contracts', () => {
    expect(mapWallzaProviderCredentials(
      'bluesky',
      { service: 'https://bsky.social', identifier: 'faisal.bsky.social', password: 'app-password' },
      'did:plc:account'
    )).toEqual({
      service: 'https://bsky.social',
      identifier: 'faisal.bsky.social',
      password: 'app-password',
    });

    expect(mapWallzaProviderCredentials(
      'wordpress',
      { domain: 'https://example.com', username: 'publisher', password: 'wp-app-password' },
      '123'
    )).toEqual({
      domain: 'https://example.com',
      username: 'publisher',
      password: 'wp-app-password',
    });
  });

  it('maps Lemmy service, identifier and password fields correctly', () => {
    expect(mapWallzaProviderCredentials(
      'lemmy',
      { service: 'https://lemmy.world', identifier: 'publisher', password: 'lemmy-password' },
      '42'
    )).toEqual({
      service: 'https://lemmy.world',
      identifier: 'publisher',
      password: 'lemmy-password',
    });
  });

  it('supports API-token providers with the established field names', () => {
    expect(mapWallzaProviderCredentials('devto', { apiKey: 'devto-key' }, 'devto-id'))
      .toEqual({ apiKey: 'devto-key' });
    expect(mapWallzaProviderCredentials('hashnode', { personalAccessToken: 'hashnode-key', publicationId: 'pub-1' }, 'hashnode-id'))
      .toEqual({ apiKey: 'hashnode-key', publicationId: 'pub-1' });
    expect(mapWallzaProviderCredentials('medium', { apiKey: 'medium-key' }, 'medium-id'))
      .toEqual({ apiKey: 'medium-key' });
    expect(mapWallzaProviderCredentials('nostr', { password: 'nostr-private-key' }, 'nostr-id'))
      .toEqual({ password: 'nostr-private-key' });
  });

  it('maps Listmonk URL and Basic Auth credentials', () => {
    expect(mapWallzaProviderCredentials(
      'listmonk',
      { url: 'https://mail.example.com', username: 'admin', password: 'listmonk-password' },
      'listmonk-id'
    )).toEqual({
      url: 'https://mail.example.com',
      username: 'admin',
      password: 'listmonk-password',
    });
  });

  it('supports legacy aliases and account-token fallback', () => {
    expect(mapWallzaProviderCredentials(
      'bluesky',
      { identifier: 'publisher', appPassword: 'legacy-password' },
      'fallback-id'
    )).toMatchObject({ identifier: 'publisher', password: 'legacy-password' });

    expect(mapWallzaProviderCredentials(
      'wordpress',
      { siteUrl: 'https://example.com', username: 'publisher' },
      'wp-id',
      'legacy-token'
    )).toMatchObject({ domain: 'https://example.com', password: 'legacy-token' });
  });

  it('returns null instead of guessing a mapping for unsupported direct providers', () => {
    expect(mapWallzaProviderCredentials('unknown-provider', { password: 'secret' }, 'id'))
      .toBeNull();
  });
});
