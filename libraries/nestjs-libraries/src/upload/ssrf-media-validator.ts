import dns from 'dns';
import { HttpException, HttpStatus } from '@nestjs/common';
import ipaddr from 'ipaddr.js';

export const ALLOWED_MEDIA_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/quicktime',
  'video/webm',
]);

export const ALLOWED_MEDIA_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.mp4',
  '.mov',
  '.webm',
]);

/**
 * Parses and verifies whether an IP string (IPv4, IPv6, or alternate formats)
 * belongs to private, loopback, link-local, multicast, or reserved ranges.
 */
export function isPrivateOrReservedIp(ipStr: string): boolean {
  try {
    let cleanIp = ipStr.trim();
    // Handle IPv4-mapped IPv6
    if (cleanIp.startsWith('::ffff:')) {
      cleanIp = cleanIp.slice(7);
    }

    // Check alternate numeric representations (e.g. 2130706433, 0177.0.0.1, 0x7f000001)
    if (/^\d+$/.test(cleanIp)) {
      const num = parseInt(cleanIp, 10);
      if (num >= 0 && num <= 0xffffffff) {
        cleanIp = [
          (num >>> 24) & 255,
          (num >>> 16) & 255,
          (num >>> 8) & 255,
          num & 255,
        ].join('.');
      }
    } else if (/^0x[0-9a-f]+$/i.test(cleanIp)) {
      const num = parseInt(cleanIp, 16);
      if (num >= 0 && num <= 0xffffffff) {
        cleanIp = [
          (num >>> 24) & 255,
          (num >>> 16) & 255,
          (num >>> 8) & 255,
          num & 255,
        ].join('.');
      }
    }

    if (!ipaddr.isValid(cleanIp)) {
      return true; // Malformed IP - fail closed
    }

    const addr = ipaddr.parse(cleanIp);
    const range = addr.range();

    const blockedRanges = new Set([
      'loopback',
      'private',
      'linkLocal',
      'carrierGradeNat',
      'uniqueLocal',
      'multicast',
      'broadcast',
      'reserved',
      'unspecified',
    ]);

    return blockedRanges.has(range);
  } catch {
    return true; // Fail closed on parsing failure
  }
}

/**
 * Validates a media URL against SSRF vulnerabilities, DNS rebinding, and invalid formats.
 */
export async function validateMediaUrlComprehensive(
  urlStr: string,
  options: {
    isProduction?: boolean;
    checkHead?: boolean;
    timeoutMs?: number;
    skipDns?: boolean;
  } = {}
): Promise<{ valid: boolean; finalUrl: string; contentType?: string }> {
  const isProd = options.isProduction ?? (process.env.NODE_ENV === 'production');
  let currentUrl = urlStr;
  let redirectCount = 0;
  const maxRedirects = 3;

  while (redirectCount <= maxRedirects) {
    let parsed: URL;
    try {
      parsed = new URL(currentUrl);
    } catch {
      throw new HttpException(`Malformed media URL: ${currentUrl}`, HttpStatus.BAD_REQUEST);
    }

    // 1. Restrict protocols strictly to HTTP and HTTPS
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new HttpException(
        `Disallowed URL protocol '${parsed.protocol}'. Only HTTP and HTTPS are permitted.`,
        HttpStatus.BAD_REQUEST
      );
    }

    // 2. Reject credentials in URL (e.g. http://user:pass@host)
    if (parsed.username || parsed.password) {
      throw new HttpException('Embedded credentials in media URL are prohibited.', HttpStatus.BAD_REQUEST);
    }

    const hostname = parsed.hostname.toLowerCase();

    // 3. Resolve DNS and check all returned IPv4 and IPv6 addresses against private/reserved ranges
    if (!options.skipDns && (isProd || !['localhost', '127.0.0.1', '::1'].includes(hostname))) {
      // Check direct IP hostname
      if (ipaddr.isValid(hostname) || /^\d+$/.test(hostname) || /^0x[0-9a-f]+$/i.test(hostname)) {
        if (isPrivateOrReservedIp(hostname)) {
          throw new HttpException(
            `Media URL points to a prohibited or private IP address: ${hostname}`,
            HttpStatus.BAD_REQUEST
          );
        }
      } else {
        // Resolve DNS
        let addresses: dns.LookupAddress[] = [];
        try {
          addresses = await dns.promises.lookup(hostname, { all: true });
        } catch (err: any) {
          throw new HttpException(
            `Unable to resolve media hostname '${hostname}': ${err.message}`,
            HttpStatus.BAD_REQUEST
          );
        }

        if (addresses.length === 0) {
          throw new HttpException(`No DNS records found for media hostname '${hostname}'`, HttpStatus.BAD_REQUEST);
        }

        for (const record of addresses) {
          if (isPrivateOrReservedIp(record.address)) {
            throw new HttpException(
              `Media hostname '${hostname}' resolves to prohibited internal address: ${record.address}`,
              HttpStatus.BAD_REQUEST
            );
          }
        }
      }
    }

    // 4. Validate extension and recognizable storage format
    const pathname = parsed.pathname.toLowerCase();
    const hasValidExt = Array.from(ALLOWED_MEDIA_EXTENSIONS).some((ext) => pathname.endsWith(ext));
    const isKnownStorage =
      pathname.includes('/storage/v1/object/') ||
      pathname.includes('/uploads/') ||
      parsed.searchParams.has('token');

    if (!hasValidExt && !isKnownStorage) {
      throw new HttpException(
        `Unsupported media extension for URL: ${pathname}. Allowed formats: JPG, PNG, WEBP, GIF, MP4, MOV, WEBM`,
        HttpStatus.BAD_REQUEST
      );
    }

    // 5. Optional HEAD check to verify Content-Type and detect redirect-based SSRF
    if (options.checkHead && isProd) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 5000);

        const headRes = await fetch(currentUrl, {
          method: 'HEAD',
          redirect: 'manual', // Manual handling to inspect each redirect hop
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if ([301, 302, 303, 307, 308].includes(headRes.status)) {
          const location = headRes.headers.get('location');
          if (!location) {
            throw new HttpException('Redirect response missing Location header', HttpStatus.BAD_REQUEST);
          }
          currentUrl = new URL(location, currentUrl).toString();
          redirectCount++;
          continue; // Loop back and validate redirect target!
        }

        const contentType = (headRes.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (contentType && !ALLOWED_MEDIA_CONTENT_TYPES.has(contentType) && contentType !== 'application/octet-stream') {
          throw new HttpException(
            `Unsupported media Content-Type: ${contentType}. Must be image or video.`,
            HttpStatus.BAD_REQUEST
          );
        }

        return { valid: true, finalUrl: currentUrl, contentType };
      } catch (err: any) {
        if (err instanceof HttpException) throw err;
        throw new HttpException(`Failed to verify media target header: ${err.message}`, HttpStatus.BAD_REQUEST);
      }
    }

    return { valid: true, finalUrl: currentUrl };
  }

  throw new HttpException('Too many redirects while verifying media URL', HttpStatus.BAD_REQUEST);
}
