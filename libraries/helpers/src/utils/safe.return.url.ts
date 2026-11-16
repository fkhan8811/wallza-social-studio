/**
 * Validates whether a given returnUrl is a safe same-origin relative path.
 * Rejects external URLs, protocol-relative URLs (//evil.com), javascript:, data:,
 * and backslash path tricks (\evil.com).
 */
export function sanitizeReturnUrl(returnUrl?: string | null, fallback = '/launches'): string {
  if (!returnUrl || typeof returnUrl !== 'string') {
    return fallback;
  }

  const trimmed = returnUrl.trim();
  if (!trimmed) {
    return fallback;
  }

  // Must begin with a single forward slash and not a double slash (protocol-relative)
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.startsWith('/\\')) {
    return fallback;
  }

  // Reject windows backslashes
  if (trimmed.includes('\\')) {
    return fallback;
  }

  // Reject dangerous schemes anywhere in the relative path
  const lower = trimmed.toLowerCase();
  if (
    lower.includes('javascript:') ||
    lower.includes('data:') ||
    lower.includes('vbscript:') ||
    lower.includes('\0')
  ) {
    return fallback;
  }

  // Try parsing against a dummy localhost origin to ensure the browser URL parser parses it strictly as pathname + search + hash
  try {
    const dummyOrigin = 'http://localhost';
    const parsed = new URL(trimmed, dummyOrigin);
    if (parsed.origin !== dummyOrigin) {
      return fallback;
    }
    // Return pathname + search + hash
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}
