export type WallzaCredentialValues = Record<string, unknown>;

const readString = (...values: unknown[]): string => {
  const match = values.find((value) => typeof value === 'string' && value.trim());
  return typeof match === 'string' ? match.trim() : '';
};

/**
 * Adapts Wallza's credential field names to the exact payload expected by
 * each Postiz provider's authenticate() implementation. Returns null for
 * direct-credential providers that do not have an explicit adapter.
 */
export function mapWallzaProviderCredentials(
  provider: string,
  credentials: WallzaCredentialValues = {},
  internalId: string,
  token?: string
): Record<string, string> | null {
  const providerId = provider.trim().toLowerCase();
  const fallbackToken = readString(token);

  switch (providerId) {
    case 'bluesky':
      return {
        service: readString(credentials.service) || 'https://bsky.social',
        identifier: readString(credentials.identifier) || internalId.trim(),
        password: readString(credentials.password, credentials.appPassword) || fallbackToken,
      };
    case 'wordpress':
      return {
        domain: readString(credentials.domain, credentials.siteUrl),
        username: readString(credentials.username),
        password: readString(credentials.password, credentials.applicationPassword) || fallbackToken,
      };
    case 'devto':
      return { apiKey: readString(credentials.apiKey) || fallbackToken };
    case 'hashnode':
      return {
        apiKey: readString(credentials.personalAccessToken, credentials.apiKey) || fallbackToken,
        publicationId: readString(credentials.publicationId),
      };
    case 'medium':
      return { apiKey: readString(credentials.apiKey) || fallbackToken };
    case 'nostr':
      return {
        password: readString(credentials.password, credentials.privateKey) || fallbackToken,
      };
    case 'listmonk':
      return {
        url: readString(credentials.url),
        username: readString(credentials.username),
        password: readString(credentials.password) || fallbackToken,
      };
    case 'lemmy':
      return {
        service: readString(credentials.service, credentials.instance) || 'https://lemmy.world',
        identifier: readString(credentials.identifier, credentials.username) || internalId.trim(),
        password: readString(credentials.password) || fallbackToken,
      };
    default:
      return null;
  }
}
