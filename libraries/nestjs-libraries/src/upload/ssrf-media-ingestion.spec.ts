import { describe, it, expect, vi, beforeEach } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import {
  SsrfMediaIngestionService,
  IngestedMedia,
} from './ssrf-media-ingestion.service';
import { isPrivateOrReservedIp } from './ssrf-media-validator';
import { IUploadProvider } from './upload.interface';

class MockControlledStorage implements IUploadProvider {
  public savedFiles: any[] = [];

  async uploadFile(file: any): Promise<any> {
    this.savedFiles.push(file);
    return {
      filename: file.filename,
      path: `http://localhost:4200/uploads/2026/11/${file.filename}`,
      originalname: file.originalname,
      mimetype: file.mimetype,
      size: file.size,
    };
  }
}

describe('SsrfMediaIngestionService — SSRF, Redirect, Size and Protocol Hardening', () => {
  let ingestionService: SsrfMediaIngestionService;
  let mockStorage: MockControlledStorage;

  beforeEach(() => {
    ingestionService = new SsrfMediaIngestionService();
    mockStorage = new MockControlledStorage();
    ingestionService.setStorageProvider(mockStorage);
  });

  describe('IPv6 and IPv4 Private/Reserved Target Validation', () => {
    it('rejects loopback IPv6 (::1)', () => {
      expect(isPrivateOrReservedIp('::1')).toBe(true);
      expect(isPrivateOrReservedIp('0:0:0:0:0:0:0:1')).toBe(true);
    });

    it('rejects unique local IPv6 (fc00::/7)', () => {
      expect(isPrivateOrReservedIp('fc00::1')).toBe(true);
      expect(isPrivateOrReservedIp('fd12:3456:789a:1::1')).toBe(true);
    });

    it('rejects link-local IPv6 (fe80::/10)', () => {
      expect(isPrivateOrReservedIp('fe80::1')).toBe(true);
      expect(isPrivateOrReservedIp('fe80::200:5aee:feaa:20a2')).toBe(true);
    });

    it('rejects IPv4-mapped IPv6 (::ffff:127.0.0.1 and ::ffff:192.168.1.1)', () => {
      expect(isPrivateOrReservedIp('::ffff:127.0.0.1')).toBe(true);
      expect(isPrivateOrReservedIp('::ffff:192.168.1.1')).toBe(true);
      expect(isPrivateOrReservedIp('::ffff:169.254.169.254')).toBe(true);
    });

    it('rejects AWS/GCP cloud metadata IP (169.254.169.254)', () => {
      expect(isPrivateOrReservedIp('169.254.169.254')).toBe(true);
    });

    it('allows public IPv4 and IPv6 addresses', () => {
      expect(isPrivateOrReservedIp('8.8.8.8')).toBe(false);
      expect(isPrivateOrReservedIp('1.1.1.1')).toBe(false);
      expect(isPrivateOrReservedIp('2606:4700:4700::1111')).toBe(false);
    });
  });

  describe('Private IP Redirect Attacks', () => {
    it('aborts immediately when an external URL redirects to a private IP (169.254.169.254 or 127.0.0.1)', async () => {
      // Create local HTTP server simulating external redirect to private IP
      const server = http.createServer((req, res) => {
        if (req.url === '/redirect-to-metadata') {
          res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
          res.end();
        } else if (req.url === '/redirect-to-local') {
          res.writeHead(302, { Location: 'http://127.0.0.1:8080/admin' });
          res.end();
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const port = (server.address() as AddressInfo).port;

      try {
        await expect(
          ingestionService.ingestMedia(`http://127.0.0.1:${port}/redirect-to-metadata`, {
            isProduction: true,
          })
        ).rejects.toThrow();

        await expect(
          ingestionService.ingestMedia(`http://127.0.0.1:${port}/redirect-to-local`, {
            isProduction: true,
          })
        ).rejects.toThrow();
      } finally {
        server.close();
      }
    });

    it('enforces maximum redirect limit (rejects infinite redirect loop)', async () => {
      let reqCount = 0;
      const server = http.createServer((req, res) => {
        reqCount++;
        res.writeHead(302, { Location: `/loop-${reqCount}` });
        res.end();
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const port = (server.address() as AddressInfo).port;

      try {
        await expect(
          ingestionService.ingestMedia(`http://127.0.0.1:${port}/loop-0`, {
            isProduction: false,
            maxRedirects: 3,
          })
        ).rejects.toThrow(/Too many redirects/i);
      } finally {
        server.close();
      }
    });
  });

  describe('Oversized Media Responses', () => {
    it('aborts and rejects when media exceeds maximum allowed size (e.g. 50MB limit)', async () => {
      const server = http.createServer((req, res) => {
        res.writeHead(200, {
          'Content-Type': 'image/jpeg',
          'Content-Length': '60000000', // 60MB declared
        });
        res.write(Buffer.alloc(1000));
        res.end();
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const port = (server.address() as AddressInfo).port;

      try {
        await expect(
          ingestionService.ingestMedia(`http://127.0.0.1:${port}/large.jpg`, {
            isProduction: false,
            maxSizeBytes: 10 * 1024, // 10KB cap for test
          })
        ).rejects.toThrow(/exceeds maximum allowed size/i);
      } finally {
        server.close();
      }
    });

    it('terminates streaming response if byte chunks exceed maxSizeBytes even without declared Content-Length', async () => {
      const server = http.createServer((req, res) => {
        res.writeHead(200, {
          'Content-Type': 'image/jpeg',
          // No Content-Length (chunked transfer)
        });
        // Send chunks exceeding 10KB limit
        for (let i = 0; i < 20; i++) {
          res.write(Buffer.alloc(1024, 'a'));
        }
        res.end();
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const port = (server.address() as AddressInfo).port;

      try {
        await expect(
          ingestionService.ingestMedia(`http://127.0.0.1:${port}/chunked.jpg`, {
            isProduction: false,
            maxSizeBytes: 10 * 1024, // 10KB cap
          })
        ).rejects.toThrow(/exceeded maximum allowed size/i);
      } finally {
        server.close();
      }
    });
  });

  describe('Controlled Storage & Supabase Signed URL Preservation', () => {
    it('returns internal /uploads/ URLs directly without re-fetching', async () => {
      const internalUrl = 'http://localhost:4200/uploads/2026/11/banner.png';
      const result = await ingestionService.ingestMedia(internalUrl);
      expect(result.url).toBe(internalUrl);
      expect(result.path).toBe(internalUrl);
      expect(mockStorage.savedFiles.length).toBe(0);
    });

    it('safely ingests valid public media into controlled private storage', async () => {
      // Create minimal valid 1x1 PNG buffer
      const png1x1 = Buffer.from(
        '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
        'hex'
      );

      const server = http.createServer((req, res) => {
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': String(png1x1.length),
        });
        res.end(png1x1);
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const port = (server.address() as AddressInfo).port;

      try {
        const publicUrl = `http://127.0.0.1:${port}/media/avatar.png?token=signed_supabase_token`;
        const result = await ingestionService.ingestMedia(publicUrl, {
          isProduction: false,
        });

        expect(result.originalUrl).toBe(publicUrl);
        expect(result.url).toContain('/uploads/');
        expect(mockStorage.savedFiles.length).toBe(1);
        expect(mockStorage.savedFiles[0].mimetype).toBe('image/png');
      } finally {
        server.close();
      }
    });
  });
});
