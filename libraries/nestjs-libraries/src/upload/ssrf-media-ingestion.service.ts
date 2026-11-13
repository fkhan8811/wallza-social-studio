import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import ipaddr from 'ipaddr.js';
import { Readable } from 'node:stream';
import {
  isPrivateOrReservedIp,
  ssrfSafeLookup,
  ALLOWED_MEDIA_CONTENT_TYPES,
  ALLOWED_MEDIA_EXTENSIONS,
} from './ssrf-media-validator';
import { LocalStorage } from './local.storage';
import { IUploadProvider } from './upload.interface';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { fileTypeFromBuffer } = require('file-type');

export interface MediaIngestionOptions {
  maxSizeBytes?: number; // default: 50MB
  timeoutMs?: number; // default: 15s
  connectTimeoutMs?: number; // default: 5s
  maxRedirects?: number; // default: 3
  isProduction?: boolean;
}

export interface IngestedMedia {
  originalUrl: string;
  finalUrl: string;
  url: string; // Controlled internal storage URL
  path: string; // Controlled storage path
  mimeType: string;
  size: number;
}

const DEFAULT_MAX_SIZE_BYTES = 50 * 1024 * 1024; // 50MB
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_REDIRECTS = 3;

/**
 * Dedicated SSRF-Protected Media Ingestion Service.
 *
 * Downloads external media (including Supabase Storage signed URLs) through socket-level
 * IP-pinned connections, disables automatic redirects in favor of manual destination
 * validation, enforces size/timeout/mime limits, sniffs magic bytes, and stores the
 * validated media in controlled private storage.
 */
@Injectable()
export class SsrfMediaIngestionService {
  private _storage: IUploadProvider;

  constructor() {
    const uploadDir =
      process.env.UPLOAD_DIRECTORY ||
      require('path').resolve(process.cwd(), 'uploads');
    this._storage = new LocalStorage(uploadDir);
  }

  /**
   * Sets a custom storage provider (e.g. for testing).
   */
  setStorageProvider(storage: IUploadProvider) {
    this._storage = storage;
  }

  /**
   * Safely ingests an external media URL into controlled private storage.
   * If the URL is already an internal storage URL, it returns it safely.
   */
  async ingestMedia(
    urlStr: string,
    options: MediaIngestionOptions = {}
  ): Promise<IngestedMedia> {
    const isProd =
      options.isProduction ?? (process.env.NODE_ENV === 'production');
    const maxSizeBytes = options.maxSizeBytes || DEFAULT_MAX_SIZE_BYTES;
    const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    const connectTimeoutMs =
      options.connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS;
    const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

    // 1. Check if the URL is already in controlled private storage
    const trimmed = (urlStr || '').trim();
    if (!trimmed) {
      throw new HttpException('Media URL cannot be empty.', HttpStatus.BAD_REQUEST);
    }

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:4200';
    if (
      trimmed.startsWith('/uploads/') ||
      trimmed.startsWith(frontendUrl + '/uploads/') ||
      (!trimmed.startsWith('http://') && !trimmed.startsWith('https://'))
    ) {
      // Already internal controlled storage
      return {
        originalUrl: trimmed,
        finalUrl: trimmed,
        url: trimmed,
        path: trimmed,
        mimeType: 'application/octet-stream',
        size: 0,
      };
    }

    // 2. Download external media with socket-level IP pinning and manual redirect inspection
    let currentUrl = trimmed;
    let redirectCount = 0;

    while (redirectCount <= maxRedirects) {
      let parsed: URL;
      try {
        parsed = new URL(currentUrl);
      } catch {
        throw new HttpException(
          `Malformed media URL: ${currentUrl}`,
          HttpStatus.BAD_REQUEST
        );
      }

      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new HttpException(
          `Disallowed protocol '${parsed.protocol}'. Only HTTP and HTTPS are permitted.`,
          HttpStatus.BAD_REQUEST
        );
      }

      if (parsed.username || parsed.password) {
        throw new HttpException(
          'Embedded credentials in media URL are prohibited.',
          HttpStatus.BAD_REQUEST
        );
      }

      const hostname = parsed.hostname.toLowerCase();

      // Check destination IP before connection
      if (isProd || !['localhost', '127.0.0.1', '::1'].includes(hostname)) {
        if (ipaddr.isValid(hostname)) {
          if (isPrivateOrReservedIp(hostname)) {
            throw new HttpException(
              `Media target '${hostname}' is a prohibited private/reserved IP address.`,
              HttpStatus.BAD_REQUEST
            );
          }
        } else {
          // Pre-resolve and inspect all records
          try {
            const records = await dns.promises.lookup(hostname, { all: true });
            if (!records || records.length === 0) {
              throw new HttpException(
                `Could not resolve media host '${hostname}'`,
                HttpStatus.BAD_REQUEST
              );
            }
            for (const record of records) {
              if (isPrivateOrReservedIp(record.address)) {
                throw new HttpException(
                  `Media host '${hostname}' resolves to prohibited private address: ${record.address}`,
                  HttpStatus.BAD_REQUEST
                );
              }
            }
          } catch (dnsErr: any) {
            if (dnsErr instanceof HttpException) throw dnsErr;
            throw new HttpException(
              `DNS resolution failed for '${hostname}': ${dnsErr.message}`,
              HttpStatus.BAD_REQUEST
            );
          }
        }
      }

      // Execute request with manual redirect checking and socket pinning
      const fetchResult = await this.executeSafeRequest(parsed, {
        connectTimeoutMs,
        timeoutMs,
        maxSizeBytes,
      });

      if (fetchResult.isRedirect) {
        redirectCount++;
        if (redirectCount > maxRedirects) {
          throw new HttpException(
            `Too many redirects (maximum ${maxRedirects} allowed)`,
            HttpStatus.BAD_REQUEST
          );
        }
        currentUrl = fetchResult.redirectUrl!;
        continue;
      }

      // We have the final 200 OK response buffer!
      const buffer = fetchResult.data!;
      let mimeType = fetchResult.contentType || 'application/octet-stream';

      // 3. Sniff magic bytes using file-type to verify authentic media format
      try {
        const detected = await fileTypeFromBuffer(buffer);
        if (detected) {
          mimeType = detected.mime;
        }
      } catch {}

      const isAllowedMime =
        ALLOWED_MEDIA_CONTENT_TYPES.has(mimeType.toLowerCase()) ||
        mimeType.startsWith('image/') ||
        mimeType.startsWith('video/');

      if (!isAllowedMime) {
        throw new HttpException(
          `Prohibited media content type '${mimeType}'. Only supported images and videos are permitted.`,
          HttpStatus.BAD_REQUEST
        );
      }

      // 4. Save the verified buffer into Postiz controlled private storage
      const ext = this.extractExtension(parsed.pathname, mimeType);
      const filename = `media_${Date.now()}_${Math.random().toString(36).substring(2, 9)}.${ext}`;

      const uploaded = await this._storage.uploadFile({
        buffer,
        mimetype: mimeType,
        size: buffer.length,
        originalname: filename,
        filename,
        path: '',
        fieldname: 'media',
        destination: '',
        stream: Readable.from(buffer),
        encoding: '7bit',
      });

      const controlledUrl = uploaded.path;
      return {
        originalUrl: trimmed,
        finalUrl: currentUrl,
        url: controlledUrl,
        path: uploaded.path,
        mimeType,
        size: buffer.length,
      };
    }

    throw new HttpException(
      `Media ingestion failed after ${maxRedirects} redirects`,
      HttpStatus.BAD_REQUEST
    );
  }

  private executeSafeRequest(
    parsed: URL,
    config: { connectTimeoutMs: number; timeoutMs: number; maxSizeBytes: number }
  ): Promise<{
    isRedirect: boolean;
    redirectUrl?: string;
    data?: Buffer;
    contentType?: string;
  }> {
    return new Promise((resolve, reject) => {
      const isHttps = parsed.protocol === 'https:';
      const client = isHttps ? https : http;

      const req = client.request(
        parsed,
        {
          method: 'GET',
          lookup: ssrfSafeLookup, // Socket-level IP pinning prevents DNS rebinding
          headers: {
            'User-Agent': 'WallzaOS-Media-Ingestion/1.0',
            Accept: 'image/*,video/*,*/*',
          },
        },
        (res) => {
          const status = res.statusCode || 0;

          // Manual redirect inspection
          if ([301, 302, 303, 307, 308].includes(status)) {
            const location = res.headers.location;
            if (!location) {
              res.resume();
              return reject(
                new HttpException(
                  'Redirect status code received without Location header',
                  HttpStatus.BAD_REQUEST
                )
              );
            }
            try {
              const redirectUrl = new URL(location, parsed.href).href;
              res.resume();
              return resolve({ isRedirect: true, redirectUrl });
            } catch {
              res.resume();
              return reject(
                new HttpException(
                  `Invalid redirect Location: ${location}`,
                  HttpStatus.BAD_REQUEST
                )
              );
            }
          }

          if (status !== 200) {
            res.resume();
            return reject(
              new HttpException(
                `External media source returned HTTP ${status}`,
                HttpStatus.BAD_REQUEST
              )
            );
          }

          const rawContentType = res.headers['content-type'] || '';
          const contentType = rawContentType.split(';')[0].trim().toLowerCase();

          // Check Content-Length if present
          const declaredLength = parseInt(
            (res.headers['content-length'] as string) || '0',
            10
          );
          if (declaredLength > config.maxSizeBytes) {
            res.destroy();
            return reject(
              new HttpException(
                `Media exceeds maximum allowed size of ${Math.round(config.maxSizeBytes / (1024 * 1024))}MB`,
                HttpStatus.PAYLOAD_TOO_LARGE
              )
            );
          }

          const chunks: Buffer[] = [];
          let totalBytes = 0;

          res.on('data', (chunk: Buffer) => {
            totalBytes += chunk.length;
            if (totalBytes > config.maxSizeBytes) {
              res.destroy();
              return reject(
                new HttpException(
                  `Media response exceeded maximum allowed size of ${Math.round(config.maxSizeBytes / (1024 * 1024))}MB`,
                  HttpStatus.PAYLOAD_TOO_LARGE
                )
              );
            }
            chunks.push(chunk);
          });

          res.on('end', () => {
            resolve({
              isRedirect: false,
              data: Buffer.concat(chunks),
              contentType,
            });
          });

          res.on('error', (err) => {
            reject(
              new HttpException(
                `Error streaming media: ${err.message}`,
                HttpStatus.BAD_REQUEST
              )
            );
          });
        }
      );

      // Connection timeout
      req.setTimeout(config.connectTimeoutMs, () => {
        req.destroy(new Error(`Media connection timed out after ${config.connectTimeoutMs}ms`));
      });

      req.on('error', (err: any) => {
        if (err.message && err.message.includes('Blocked SSRF')) {
          reject(new HttpException(err.message, HttpStatus.BAD_REQUEST));
        } else {
          reject(
            new HttpException(
              `Media fetch request failed: ${err.message}`,
              HttpStatus.BAD_REQUEST
            )
          );
        }
      });

      req.end();
    });
  }

  private extractExtension(pathname: string, mimeType: string): string {
    const lastDot = pathname.lastIndexOf('.');
    if (lastDot !== -1) {
      const ext = pathname.substring(lastDot).toLowerCase();
      if (ALLOWED_MEDIA_EXTENSIONS.has(ext)) {
        return ext.replace('.', '');
      }
    }
    switch (mimeType) {
      case 'image/jpeg':
        return 'jpg';
      case 'image/png':
        return 'png';
      case 'image/webp':
        return 'webp';
      case 'image/gif':
        return 'gif';
      case 'video/mp4':
        return 'mp4';
      case 'video/quicktime':
        return 'mov';
      case 'video/webm':
        return 'webm';
      default:
        return 'bin';
    }
  }
}
