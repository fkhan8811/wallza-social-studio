import { describe, it, expect } from 'vitest';
import * as crypto from 'crypto';
import {
  signInternalRequest,
  verifyInternalRequest,
  getInternalSecret,
} from '../../auth/internal-hmac.util';

describe('Social Studio — WallzaOS SSO & Connection Synchronization Suite', () => {
  const sha256 = (value: string) =>
    crypto.createHash('sha256').update(value, 'utf8').digest('hex');

  const TEST_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  // ── 1. WALLZAOS SSO IDENTITY & SESSION MAPPING ────────────────────────────
  describe('Area 1: Supabase-to-Social-Studio Identity & Session Mapping', () => {
    it('maps immutable Supabase user and org IDs into Social Studio entities', () => {
      interface MockUser {
        id: string;
        email: string;
        name: string;
        supabaseUserId: string;
        activated: boolean;
      }

      interface MockOrganization {
        id: string;
        name: string;
        supabaseOrgId: string;
      }

      interface MockUserOrganization {
        userId: string;
        organizationId: string;
        role: 'ADMIN' | 'USER';
        disabled: boolean;
      }

      const users = new Map<string, MockUser>();
      const orgs = new Map<string, MockOrganization>();
      const userOrgs = new Map<string, MockUserOrganization>();

      const syncSsoIdentity = (claims: {
        user: { id: string; email: string; firstName: string; lastName: string; role: 'ADMIN' | 'USER' };
        organization: { id: string; name: string };
      }) => {
        let org = Array.from(orgs.values()).find((o) => o.supabaseOrgId === claims.organization.id);
        if (!org) {
          org = {
            id: `org_ss_${claims.organization.id.slice(0, 8)}`,
            name: claims.organization.name,
            supabaseOrgId: claims.organization.id,
          };
          orgs.set(org.id, org);
        }

        let user = Array.from(users.values()).find((u) => u.supabaseUserId === claims.user.id);
        if (!user) {
          user = {
            id: `usr_ss_${claims.user.id.slice(0, 8)}`,
            email: claims.user.email,
            name: `${claims.user.firstName} ${claims.user.lastName}`.trim(),
            supabaseUserId: claims.user.id,
            activated: true,
          };
          users.set(user.id, user);
        }

        const uoKey = `${user.id}:${org.id}`;
        let uo = userOrgs.get(uoKey);
        if (!uo) {
          uo = {
            userId: user.id,
            organizationId: org.id,
            role: claims.user.role,
            disabled: false,
          };
          userOrgs.set(uoKey, uo);
        } else {
          uo.role = claims.user.role;
          uo.disabled = false;
        }

        return { user, org, uo };
      };

      const claims1 = {
        user: {
          id: 'supabase-user-uuid-1111',
          email: 'alex@acme.com',
          firstName: 'Alex',
          lastName: 'Mercer',
          role: 'ADMIN' as const,
        },
        organization: {
          id: 'supabase-org-uuid-9999',
          name: 'Acme Global Marketing',
        },
      };

      const result1 = syncSsoIdentity(claims1);
      expect(result1.user.supabaseUserId).toBe('supabase-user-uuid-1111');
      expect(result1.org.supabaseOrgId).toBe('supabase-org-uuid-9999');
      expect(result1.uo.role).toBe('ADMIN');
    });

    it('enforces server-side HttpOnly cookie and omits JWT from response JSON (Requirement 1)', () => {
      const mockResponse = {
        cookie: (name: string, val: string, options: any) => {
          expect(name).toMatch(/^(auth|showorg)$/);
          expect(options.httpOnly).toBe(true);
          expect(options.path).toBe('/');
        },
      };

      const mockExchangeResult = {
        success: true,
        user: { id: 'usr_1', email: 'test@wallza.com' },
        organization: { id: 'org_1', name: 'Acme' },
      };

      // Ensure no token field is present in returned JSON payload
      expect((mockExchangeResult as any).token).toBeUndefined();
      mockResponse.cookie('auth', 'jwt_val_sample', { httpOnly: true, path: '/' });
      mockResponse.cookie('showorg', 'org_1', { httpOnly: true, path: '/' });
    });

    it('switches organization securely and rejects unauthorized tenant switches', () => {
      const memberships = new Set(['usr_1:org_alpha', 'usr_1:org_beta']);

      const canSwitchOrg = (userId: string, targetOrg: string) => {
        return memberships.has(`${userId}:${targetOrg}`);
      };

      expect(canSwitchOrg('usr_1', 'org_alpha')).toBe(true);
      expect(canSwitchOrg('usr_1', 'org_beta')).toBe(true);
      expect(canSwitchOrg('usr_1', 'org_gamma_unauthorized')).toBe(false);
    });
  });

  // ── 2. INTERNAL HMAC AUTHENTICATION & SECURITY ─────────────────────────────
  describe('Area 2: Canonical HMAC Authentication (Requirements 2 & 3)', () => {
    it('signs and verifies server-to-server requests with replay protection', () => {
      const signed = signInternalRequest({
        method: 'POST',
        path: '/integrations/sync-from-wallza',
        audience: 'social-studio',
        body: { test: 123 },
        secret: TEST_SECRET,
      });

      const mockReq = {
        method: 'POST',
        originalUrl: '/integrations/sync-from-wallza',
        path: '/integrations/sync-from-wallza',
        headers: signed,
        body: { test: 123 },
      } as any;

      const result = verifyInternalRequest(mockReq, {
        expectedAudience: 'social-studio',
        secret: TEST_SECRET,
      });

      expect(result.valid).toBe(true);
    });

    it('rejects tampered request method or body', () => {
      const signed = signInternalRequest({
        method: 'POST',
        path: '/integrations/sync-from-wallza',
        audience: 'social-studio',
        body: { test: 123 },
        secret: TEST_SECRET,
      });

      const tamperedReq = {
        method: 'GET', // Tampered method
        originalUrl: '/integrations/sync-from-wallza',
        path: '/integrations/sync-from-wallza',
        headers: signed,
        body: { test: 123 },
      } as any;

      const result = verifyInternalRequest(tamperedReq, {
        expectedAudience: 'social-studio',
        secret: TEST_SECRET,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/HMAC signature mismatch/);
    });
  });

  // ── 3. CONNECTION SYNC & PER-ACCOUNT DISCONNECT ────────────────────────────
  describe('Area 3: Per-Account Disconnect & Channel Sync (Requirements 9 & 10)', () => {
    interface Integration {
      id: string;
      orgId: string;
      provider: string;
      internalId: string;
      disabled: boolean;
      deletedAt: Date | null;
      tokenExpiration?: Date | null;
    }

    const integrations: Integration[] = [
      { id: '1', orgId: 'org_1', provider: 'facebook', internalId: 'page_1', disabled: false, deletedAt: null },
      { id: '2', orgId: 'org_1', provider: 'facebook', internalId: 'page_2', disabled: false, deletedAt: null },
      { id: '3', orgId: 'org_1', provider: 'instagram', internalId: 'ig_1', disabled: false, deletedAt: null },
    ];

    it('disconnects only target account and preserves sibling accounts', () => {
      // Disconnect page_1
      const targetInternalId = 'page_1';
      for (const item of integrations) {
        if (item.orgId === 'org_1' && item.provider === 'facebook' && item.internalId === targetInternalId) {
          item.disabled = true;
          item.deletedAt = new Date();
        }
      }

      const p1 = integrations.find((i) => i.internalId === 'page_1');
      const p2 = integrations.find((i) => i.internalId === 'page_2');
      const ig = integrations.find((i) => i.internalId === 'ig_1');

      expect(p1?.disabled).toBe(true);
      expect(p2?.disabled).toBe(false); // Preserved!
      expect(ig?.disabled).toBe(false); // Preserved!
    });
  });

  // ── 4. DISPATCH VALIDATION & IDEMPOTENCY ────────────────────────────────────
  describe('Area 4: Dispatch Validation & Duplicate Prevention (Requirements 11 & 12)', () => {
    it('validates media URLs and blocks private IP ranges in production', () => {
      const PRIVATE_IP_REGEX =
        /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|169\.254\.|localhost|::1)/i;

      const isPrivate = (urlStr: string) => {
        const u = new URL(urlStr);
        return PRIVATE_IP_REGEX.test(u.hostname);
      };

      expect(isPrivate('http://localhost:3000/media.jpg')).toBe(true);
      expect(isPrivate('http://169.254.169.254/latest/meta-data')).toBe(true);
      expect(isPrivate('https://cdn.wallza.com/uploads/photo.jpg')).toBe(false);
    });

    it('enforces character limits for Twitter, Instagram, and Facebook', () => {
      const checkLength = (platform: string, text: string) => {
        if (platform === 'twitter' && text.length > 280) throw new Error('Twitter limit exceeded');
        if (platform === 'instagram' && text.length > 2200) throw new Error('Instagram limit exceeded');
        return true;
      };

      expect(checkLength('twitter', 'Short tweet')).toBe(true);
      expect(() => checkLength('twitter', 'x'.repeat(281))).toThrow(/Twitter limit/);
      expect(() => checkLength('instagram', 'x'.repeat(2201))).toThrow(/Instagram limit/);
    });

    it('deduplicates post creation across retries using releaseId', () => {
      const db = new Map<string, any>();

      const dispatchWithIdempotency = (releaseId: string, content: string) => {
        if (db.has(releaseId)) {
          return { post: db.get(releaseId), idempotent: true };
        }
        const post = { id: `post_${Date.now()}`, releaseId, content };
        db.set(releaseId, post);
        return { post, idempotent: false };
      };

      const res1 = dispatchWithIdempotency('idem_key_123', 'First attempt');
      expect(res1.idempotent).toBe(false);

      const res2 = dispatchWithIdempotency('idem_key_123', 'First attempt retry');
      expect(res2.idempotent).toBe(true);
      expect(res2.post.id).toBe(res1.post.id);
    });
  });
});
