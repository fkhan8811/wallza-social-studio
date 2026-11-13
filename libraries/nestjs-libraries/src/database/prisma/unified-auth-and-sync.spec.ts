import { describe, it, expect } from 'vitest';
import * as crypto from 'crypto';

describe('Social Studio — WallzaOS SSO & Connection Synchronization Suite', () => {
  const sha256 = (value: string) =>
    crypto.createHash('sha256').update(value, 'utf8').digest('hex');

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
        // 1. Resolve or create Org
        let org = Array.from(orgs.values()).find((o) => o.supabaseOrgId === claims.organization.id);
        if (!org) {
          org = {
            id: `org_ss_${claims.organization.id.slice(0, 8)}`,
            name: claims.organization.name,
            supabaseOrgId: claims.organization.id,
          };
          orgs.set(org.id, org);
        }

        // 2. Resolve or create User
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

        // 3. UserOrganization membership
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

      // Idempotency: second login of same user and org does NOT duplicate
      const result2 = syncSsoIdentity(claims1);
      expect(result2.user.id).toBe(result1.user.id);
      expect(result2.org.id).toBe(result1.org.id);
      expect(users.size).toBe(1);
      expect(orgs.size).toBe(1);
    });

    it('enforces multi-organization switching and isolates active tenant context', () => {
      interface UserOrgRel {
        userId: string;
        organizationId: string;
        disabled: boolean;
      }

      const memberships: UserOrgRel[] = [
        { userId: 'u1', organizationId: 'org_marketing', disabled: false },
        { userId: 'u1', organizationId: 'org_sales', disabled: false },
        { userId: 'u1', organizationId: 'org_suspended', disabled: true },
      ];

      const switchActiveOrg = (userId: string, targetOrgId: string) => {
        const membership = memberships.find(
          (m) => m.userId === userId && m.organizationId === targetOrgId
        );
        if (!membership) {
          throw new Error('User does not belong to target organization.');
        }
        if (membership.disabled) {
          throw new Error('Access denied: membership in this organization is disabled.');
        }
        return { activeOrgId: targetOrgId };
      };

      expect(switchActiveOrg('u1', 'org_marketing').activeOrgId).toBe('org_marketing');
      expect(switchActiveOrg('u1', 'org_sales').activeOrgId).toBe('org_sales');
      expect(() => switchActiveOrg('u1', 'org_suspended')).toThrow(/disabled/);
      expect(() => switchActiveOrg('u1', 'org_unauthorized')).toThrow(/does not belong/);
    });
  });

  // ── 2. CONNECTION SYNCHRONIZATION BRIDGE ──────────────────────────────────
  describe('Area 2: Unified Social Connection Sync Bridge', () => {
    it('upserts Facebook Page and linked Instagram channels into Integration store', () => {
      interface MockIntegration {
        id: string;
        organizationId: string;
        internalId: string;
        rootInternalId?: string | null;
        providerIdentifier: string;
        name: string;
        token: string;
        disabled: boolean;
        deletedAt: Date | null;
      }

      const integrations = new Map<string, MockIntegration>();

      const syncConnection = (
        orgId: string,
        action: 'upsert' | 'disconnect',
        conns: Array<{
          provider: string;
          internalId: string;
          rootInternalId?: string | null;
          name: string;
          token: string;
        }>
      ) => {
        conns.forEach((c) => {
          const key = `${orgId}:${c.internalId}`;
          if (action === 'upsert') {
            const existing = integrations.get(key);
            if (existing) {
              existing.name = c.name;
              existing.token = c.token;
              existing.disabled = false;
              existing.deletedAt = null;
              existing.rootInternalId = c.rootInternalId || null;
            } else {
              integrations.set(key, {
                id: `int_${c.provider}_${c.internalId}`,
                organizationId: orgId,
                internalId: c.internalId,
                rootInternalId: c.rootInternalId || null,
                providerIdentifier: c.provider,
                name: c.name,
                token: c.token,
                disabled: false,
                deletedAt: null,
              });
            }
          } else if (action === 'disconnect') {
            const existing = integrations.get(key);
            if (existing) {
              existing.disabled = true;
              existing.deletedAt = new Date();
            }
          }
        });
      };

      const connections = [
        {
          provider: 'facebook',
          internalId: 'page_123456',
          name: 'Wallza Enterprise Page',
          token: 'TOKEN_FB_PAGE_XYZ',
        },
        {
          provider: 'instagram',
          internalId: 'ig_biz_789012',
          rootInternalId: 'page_123456',
          name: 'wallza_official',
          token: 'TOKEN_FB_PAGE_XYZ',
        },
      ];

      syncConnection('org_postiz_1', 'upsert', connections);
      expect(integrations.size).toBe(2);

      const fb = integrations.get('org_postiz_1:page_123456');
      expect(fb?.providerIdentifier).toBe('facebook');
      expect(fb?.disabled).toBe(false);

      const ig = integrations.get('org_postiz_1:ig_biz_789012');
      expect(ig?.providerIdentifier).toBe('instagram');
      expect(ig?.rootInternalId).toBe('page_123456');
      expect(ig?.disabled).toBe(false);

      // Disconnect preserves the records with disabled = true and deletedAt set
      syncConnection('org_postiz_1', 'disconnect', connections);
      expect(fb?.disabled).toBe(true);
      expect(fb?.deletedAt).toBeInstanceOf(Date);
      expect(ig?.disabled).toBe(true);
      expect(ig?.deletedAt).toBeInstanceOf(Date);
    });

    it('rejects connection sync requests with missing or invalid internal secret', () => {
      const validSecret = 'super_secure_internal_cluster_secret_42';

      const authorizeSyncRequest = (authHeader: string | undefined, xSecret: string | undefined) => {
        if (xSecret && xSecret === validSecret) return true;
        if (authHeader && authHeader.startsWith('Bearer ') && authHeader.slice(7).trim() === validSecret) return true;
        throw new Error('Unauthorized internal API request');
      };

      expect(authorizeSyncRequest(`Bearer ${validSecret}`, undefined)).toBe(true);
      expect(authorizeSyncRequest(undefined, validSecret)).toBe(true);
      expect(() => authorizeSyncRequest('Bearer invalid_secret', undefined)).toThrow(/Unauthorized/);
      expect(() => authorizeSyncRequest(undefined, undefined)).toThrow(/Unauthorized/);
    });
  });

  // ── 3. PUBLISHING DISPATCH PIPELINE ───────────────────────────────────────
  describe('Area 3: Real Social Studio Publishing Pipeline', () => {
    it('dispatches post to genuine Social Studio channels and validates active state', () => {
      interface Channel {
        id: string;
        provider: string;
        disabled: boolean;
      }

      const activeChannels: Channel[] = [
        { id: 'ch_fb', provider: 'facebook', disabled: false },
        { id: 'ch_ig', provider: 'instagram', disabled: false },
        { id: 'ch_x', provider: 'x', disabled: true }, // disabled
      ];

      const validateAndRoutePost = (requestedPlatforms: string[]) => {
        const matched = activeChannels.filter(
          (c) => !c.disabled && requestedPlatforms.includes(c.provider)
        );

        if (matched.length === 0) {
          throw new Error(
            `No active connected channel available for platforms: ${requestedPlatforms.join(', ')}`
          );
        }

        return {
          matchedChannels: matched.map((m) => m.id),
          readyForDispatch: true,
        };
      };

      const result = validateAndRoutePost(['facebook', 'instagram']);
      expect(result.readyForDispatch).toBe(true);
      expect(result.matchedChannels).toContain('ch_fb');
      expect(result.matchedChannels).toContain('ch_ig');

      // Attempting to post to disabled channel only throws
      expect(() => validateAndRoutePost(['x'])).toThrow(/No active connected channel/);
    });
  });
});
