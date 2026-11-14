import dns from 'dns';
import http from 'http';
import https from 'https';
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
 * Custom DNS lookup function that validates all resolved IP addresses at socket
 * creation time, strictly preventing DNS rebinding attacks.
 */
export function ssrfSafeLookup(
  hostname: string,
  options: any,
  callback: (err: Error | null, address?: any, family?: number) => void
): void {
  dns.lookup(hostname, { all: true }, (err, addresses) => {
    if (err) return callback(err);
    if (!addresses || addresses.length === 0) {
      return callback(new Error(`No DNS records found for host '${hostname}'`));
    }
    for (const record of addresses) {
      if (isPrivateOrReservedIp(record.address)) {
        return callback(
          new Error(`Blocked SSRF target: '${hostname}' resolves to prohibited internal address ${record.address}`)
        );
      }
    }
    if (options && options.all) {
      return callback(null, addresses);
    }
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

/**
 * Performs a HEAD request using Node's native HTTP/HTTPS client with socket-level
 * IP pinning / safe lookup to prevent DNS rebinding.
 */
export async function performSsrfSafeHead(
  urlStr: string,
  timeoutMs: number = 5000
): Promise<{ status: number; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;

    const timer = setTimeout(() => {
      req.destroy(new Error(`Media verification timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const req = lib.request(
      parsed,
      {
        method: 'HEAD',
        lookup: ssrfSafeLookup,
        headers: {
          'User-Agent': 'WallzaOS-Media-Validator/1.0',
        },
      },
      (res) => {
        clearTimeout(timer);
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === 'string') headers[k.toLowerCase()] = v;
          else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(', ');
        }
        res.resume();
        resolve({ status: res.statusCode || 0, headers });
      }
    );

    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    req.end();
  });
}

/**
 * Validates a media URL against SSRF vulnerabilities, DNS rebinding, redirect chains,
 * and unsupported media types.
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

    const rawHostname = parsed.hostname.toLowerCase();
    const cleanHostname = rawHostname.startsWith('[') && rawHostname.endsWith(']')
      ? rawHostname.slice(1, -1)
      : rawHostname;

    // 3. Resolve DNS and check all returned IPv4 and IPv6 addresses against private/reserved ranges
    if (!options.skipDns && (isProd || !['localhost', '127.0.0.1', '::1'].includes(cleanHostname))) {
      // Check direct IP hostname
      if (ipaddr.isValid(cleanHostname) || /^\d+$/.test(cleanHostname) || /^0x[0-9a-f]+$/i.test(cleanHostname)) {
        if (isPrivateOrReservedIp(cleanHostname)) {
          throw new HttpException(
            `Media URL points to a prohibited or private IP address: ${rawHostname}`,
            HttpStatus.BAD_REQUEST
          );
        }
      } else {
        // Resolve DNS pre-check
        let addresses: dns.LookupAddress[] = [];
        try {
          addresses = await dns.promises.lookup(rawHostname, { all: true });
        } catch (err: any) {
          throw new HttpException(
            `Unable to resolve media hostname '${rawHostname}': ${err.message}`,
            HttpStatus.BAD_REQUEST
          );
        }

        if (addresses.length === 0) {
          throw new HttpException(`No DNS records found for media hostname '${rawHostname}'`, HttpStatus.BAD_REQUEST);
        }

        for (const record of addresses) {
          if (isPrivateOrReservedIp(record.address)) {
            throw new HttpException(
              `Media hostname '${rawHostname}' resolves to prohibited internal address: ${record.address}`,
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

    // 5. Real HEAD check to verify Content-Type, follow & validate redirects, and prevent DNS rebinding
    if (options.checkHead) {
      try {
        const headRes = await performSsrfSafeHead(currentUrl, options.timeoutMs ?? 5000);

        if ([301, 302, 303, 307, 308].includes(headRes.status)) {
          const location = headRes.headers['location'];
          if (!location) {
            throw new HttpException('Redirect response missing Location header', HttpStatus.BAD_REQUEST);
          }
          currentUrl = new URL(location, currentUrl).toString();
          redirectCount++;
          if (redirectCount > maxRedirects) {
            throw new HttpException(
              `Too many redirects while verifying media URL (maximum ${maxRedirects} permitted)`,
              HttpStatus.BAD_REQUEST
            );
          }
          continue; // Loop back and re-validate entire redirect destination!
        }

        if (headRes.status >= 400) {
          throw new HttpException(
            `Media target URL is unreachable or returned HTTP status ${headRes.status}`,
            HttpStatus.BAD_REQUEST
          );
        }

        const contentType = (headRes.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
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
