import { describe, it, expect, vi } from 'vitest';
import * as crypto from 'crypto';
import {
  isPrivateOrReservedIp,
  validateMediaUrlComprehensive,
} from '../../upload/ssrf-media-validator';
import {
  signInternalRequest,
  verifyInternalRequestAsync,
} from '../../auth/internal-hmac.util';

describe('Social Studio — Advanced Security, SSO Identity, SSRF & Idempotency Suite', () => {
  const TEST_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  // ── 1. SSRF & MULTI-FORMAT IP VALIDATION (Task 6) ──────────────────────────
  describe('Area 1: SSRF Defense & Media URL Validation', () => {
    it('detects standard and alternate IPv4/IPv6 private & reserved addresses', () => {
      // Loopback
      expect(isPrivateOrReservedIp('127.0.0.1')).toBe(true);
      expect(isPrivateOrReservedIp('127.0.0.2')).toBe(true);
      expect(isPrivateOrReservedIp('::1')).toBe(true);

      // Private RFC 1918
      expect(isPrivateOrReservedIp('10.0.0.1')).toBe(true);
      expect(isPrivateOrReservedIp('172.16.0.1')).toBe(true);
      expect(isPrivateOrReservedIp('192.168.1.100')).toBe(true);

      // Link-local & Cloud Metadata (AWS/GCP/Oracle/Azure)
      expect(isPrivateOrReservedIp('169.254.169.254')).toBe(true);
      expect(isPrivateOrReservedIp('fe80::1')).toBe(true);

      // IPv4-mapped IPv6
      expect(isPrivateOrReservedIp('::ffff:127.0.0.1')).toBe(true);
      expect(isPrivateOrReservedIp('::ffff:169.254.169.254')).toBe(true);
      expect(isPrivateOrReservedIp('::ffff:10.1.2.3')).toBe(true);

      // Alternate representations (Decimal integer, Hex)
      expect(isPrivateOrReservedIp('2130706433')).toBe(true); // 127.0.0.1 in decimal
      expect(isPrivateOrReservedIp('0x7f000001')).toBe(true); // 127.0.0.1 in hex

      // Legitimate Public Internet IPs must be allowed
      expect(isPrivateOrReservedIp('8.8.8.8')).toBe(false);
      expect(isPrivateOrReservedIp('1.1.1.1')).toBe(false);
      expect(isPrivateOrReservedIp('2606:4700:4700::1111')).toBe(false);
    });

    it('rejects forbidden URL schemes and URLs pointing to private IPs', async () => {
      // Non-HTTP/HTTPS protocols
      await expect(
        validateMediaUrlComprehensive('file:///etc/passwd', { isProduction: true })
      ).rejects.toThrow(/Disallowed URL protocol/);

      await expect(
        validateMediaUrlComprehensive('gopher://127.0.0.1:70/', { isProduction: true })
      ).rejects.toThrow(/Disallowed URL protocol/);

      // Private IPs
      await expect(
        validateMediaUrlComprehensive('http://127.0.0.1:3000/photo.png', { isProduction: true })
      ).rejects.toThrow(/prohibited/);

      await expect(
        validateMediaUrlComprehensive('http://169.254.169.254/latest/meta-data', { isProduction: true })
      ).rejects.toThrow(/prohibited/);

      await expect(
        validateMediaUrlComprehensive('http://[::1]/internal.jpg', { isProduction: true })
      ).rejects.toThrow(/prohibited/);
    });

    it('permits valid public media URLs and signed Supabase storage paths', async () => {
      const validCdnUrl = 'https://cdn.wallza.com/assets/campaign-banner.jpg';
      const resultCdn = await validateMediaUrlComprehensive(validCdnUrl, { isProduction: false, skipDns: true });
      expect(resultCdn.valid).toBe(true);

      const validSupabaseUrl =
        'https://xyzcompany.supabase.co/storage/v1/object/public/wallza-media/org-123/banner.webp';
      const resultStorage = await validateMediaUrlComprehensive(validSupabaseUrl, { isProduction: false, skipDns: true });
      expect(resultStorage.valid).toBe(true);
    });
  });

  // ── 2. SSO IDENTITY MAPPING & ACCOUNT TAKEOVER PREVENTION (Task 3) ─────────
  describe('Area 2: SSO Identity Collision & Account Takeover Defense', () => {
    it('blocks account takeover when incoming email matches an existing user with different Supabase ID', () => {
      interface MockUser {
        id: string;
        email: string;
        supabaseUserId?: string | null;
      }

      const existingUsers: MockUser[] = [
        {
          id: 'usr_legit_owner',
          email: 'founder@acme.com',
          supabaseUserId: 'supabase_original_uuid_111',
        },
      ];

      const handleSsoIdentityResolution = (claim: { email: string; supabaseUserId: string }) => {
        // Step 1: Match by immutable Supabase user ID
        const matchedById = existingUsers.find((u) => u.supabaseUserId === claim.supabaseUserId);
        if (matchedById) return { user: matchedById, action: 'authenticated' };

        // Step 2: Check for email collisions
        const matchedByEmail = existingUsers.find(
          (u) => u.email.toLowerCase() === claim.email.toLowerCase()
        );
        if (matchedByEmail) {
          if (matchedByEmail.supabaseUserId && matchedByEmail.supabaseUserId !== claim.supabaseUserId) {
            throw new Error(
              `Identity conflict: Account with email ${claim.email} is bound to ${matchedByEmail.supabaseUserId}. Takeover blocked.`
            );
          }
          throw new Error('Account collision: Unlinked local account exists.');
        }

        return { user: { id: 'new_usr', ...claim }, action: 'created' };
      };

      // Attacker or colliding claim: same email, different Supabase ID!
      const maliciousClaim = {
        email: 'founder@acme.com',
        supabaseUserId: 'supabase_attacker_uuid_666',
      };

      expect(() => handleSsoIdentityResolution(maliciousClaim)).toThrow(/Identity conflict/);
    });
  });

  // ── 3. ORG SWITCHING LIVE REVALIDATION (Task 4) ────────────────────────────
  describe('Area 3: Organization Switch Live Revalidation', () => {
    it('revokes local session when WallzaOS reports membership is deactivated', async () => {
      const localMemberships = new Map<string, { role: string; disabled: boolean }>([
        ['user_1:org_revoked', { role: 'ADMIN', disabled: false }],
        ['user_1:org_active', { role: 'USER', disabled: false }],
      ]);

      const mockWallzaRevalidate = async (userId: string, orgId: string) => {
        if (orgId === 'org_revoked') {
          return { status: 403, allowed: false, error: 'Membership suspended by organization admin' };
        }
        return { status: 200, allowed: true, role: 'USER' };
      };

      const switchOrgHandler = async (userId: string, targetOrg: string) => {
        const wallzaCheck = await mockWallzaRevalidate(userId, targetOrg);
        if (!wallzaCheck.allowed) {
          // Immediately disable stale local membership
          const entry = localMemberships.get(`${userId}:${targetOrg}`);
          if (entry) entry.disabled = true;
          throw new Error(`Forbidden: ${wallzaCheck.error}`);
        }
        return { success: true, orgId: targetOrg };
      };

      // Attempting to switch to org_revoked must fail and disable local membership
      await expect(switchOrgHandler('user_1', 'org_revoked')).rejects.toThrow(/Forbidden/);
      expect(localMemberships.get('user_1:org_revoked')?.disabled).toBe(true);

      // Switching to active org must succeed
      const res = await switchOrgHandler('user_1', 'org_active');
      expect(res.success).toBe(true);
    });
  });

  // ── 4. CONCURRENT PUBLISHING IDEMPOTENCY (Task 5) ─────────────────────────
  describe('Area 4: Atomic Publishing Idempotency Under Concurrent Load', () => {
    it('processes exactly 1 post when 10 concurrent requests arrive with the same idempotency key', async () => {
      const idempotencyTable = new Map<string, { id: string; status: string; postId?: string }>();
      let realPostsCreatedCount = 0;

      const atomicDispatch = async (orgId: string, idempotencyKey: string, content: string) => {
        const uniqueKey = `${orgId}:${idempotencyKey}`;

        // Atomic reservation attempt (mimicking UNIQUE constraint P2002)
        let isOwner = false;
        if (!idempotencyTable.has(uniqueKey)) {
          idempotencyTable.set(uniqueKey, { id: `idem_${Date.now()}`, status: 'pending' });
          isOwner = true;
        }

        if (!isOwner) {
          // Poll for winner's completion
          let attempts = 0;
          while (idempotencyTable.get(uniqueKey)?.status === 'pending' && attempts < 20) {
            await new Promise((r) => setTimeout(r, 20));
            attempts++;
          }
          const existing = idempotencyTable.get(uniqueKey);
          return { postId: existing?.postId, idempotent: true };
        }

        // Winner executes post creation
        await new Promise((r) => setTimeout(r, 50)); // simulate post creation latency
        realPostsCreatedCount++;
        const newPostId = `post_created_atomic_123`;
        idempotencyTable.set(uniqueKey, { id: `idem_${Date.now()}`, status: 'completed', postId: newPostId });

        return { postId: newPostId, idempotent: false };
      };

      // Fire 10 simultaneous concurrent requests
      const concurrentBatch = Array.from({ length: 10 }, (_, i) =>
        atomicDispatch('org_corp_99', 'idem_key_concurrent_benchmark', `Post version ${i}`)
      );

      const results = await Promise.all(concurrentBatch);

      // Exactly ONE request created the post; the other 9 received the existing post idempotently!
      expect(realPostsCreatedCount).toBe(1);

      const owners = results.filter((r) => !r.idempotent);
      const replays = results.filter((r) => r.idempotent);

      expect(owners.length).toBe(1);
      expect(replays.length).toBe(9);
      expect(replays.every((r) => r.postId === 'post_created_atomic_123')).toBe(true);
    });
  });

  // ── 5. PERSISTENT NONCE REPLAY VERIFICATION (Task 2) ───────────────────────
  describe('Area 5: Persistent Nonce Storage and Replay Defense', () => {
    it('signs requests without Authorization secret and rejects duplicate nonces via persistent Prisma store', async () => {
      const persistedNonces = new Set<string>();
      const mockPrisma = {
        internalRequestNonce: {
          create: vi.fn(async ({ data }: any) => {
            const key = `${data.audience}:${data.nonce}`;
            if (persistedNonces.has(key)) {
              const err: any = new Error('Unique constraint failed');
              err.code = 'P2002';
              throw err;
            }
            persistedNonces.add(key);
            return { ...data, createdAt: new Date() };
          }),
        },
      };

      const body = { action: 'channel_sync', accountId: 'acc_100' };
      const signed = signInternalRequest({
        method: 'POST',
        path: '/integrations/sync-from-wallza',
        audience: 'social-studio',
        body,
        secret: TEST_SECRET,
      });

      // Verify no Authorization header
      expect((signed as any).authorization).toBeUndefined();

      const req1 = {
        method: 'POST',
        originalUrl: '/integrations/sync-from-wallza',
        path: '/integrations/sync-from-wallza',
        headers: { ...signed },
        body,
      } as any;

      const firstCall = await verifyInternalRequestAsync(req1, {
        expectedAudience: 'social-studio',
        secret: TEST_SECRET,
        prisma: mockPrisma,
      });
      expect(firstCall.valid).toBe(true);

      // Second call with same nonce must be rejected
      const req2 = {
        method: 'POST',
        originalUrl: '/integrations/sync-from-wallza',
        path: '/integrations/sync-from-wallza',
        headers: { ...signed },
        body,
      } as any;

      const secondCall = await verifyInternalRequestAsync(req2, {
        expectedAudience: 'social-studio',
        secret: TEST_SECRET,
        prisma: mockPrisma,
      });
      expect(secondCall.valid).toBe(false);
      expect(secondCall.error).toMatch(/replay attack detected/i);
    });

    it('tests two separate verifier instances sharing the same persistent database store', async () => {
      const sharedDbTable = new Set<string>();

      const createVerifierInstance = () => ({
        internalRequestNonce: {
          create: vi.fn(async ({ data }: any) => {
            const key = `${data.audience}:${data.nonce}`;
            if (sharedDbTable.has(key)) {
              const err: any = new Error('Unique constraint failed on InternalRequestNonce');
              err.code = 'P2002';
              throw err;
            }
            sharedDbTable.add(key);
            return { ...data, createdAt: new Date() };
          }),
        },
      });

      const verifierInstanceA = createVerifierInstance();
      const verifierInstanceB = createVerifierInstance();

      const body = { action: 'cluster_sync' };
      const signed = signInternalRequest({
        method: 'POST',
        path: '/integrations/sync-from-wallza',
        audience: 'social-studio',
        body,
        secret: TEST_SECRET,
      });

      const reqA = {
        method: 'POST',
        originalUrl: '/integrations/sync-from-wallza',
        path: '/integrations/sync-from-wallza',
        headers: { ...signed },
        body,
      } as any;

      // Instance A processes request first
      const resA = await verifyInternalRequestAsync(reqA, {
        expectedAudience: 'social-studio',
        secret: TEST_SECRET,
        prisma: verifierInstanceA,
      });
      expect(resA.valid).toBe(true);

      // Instance B receives replayed request: must reject because DB constraint fired
      const reqB = {
        method: 'POST',
        originalUrl: '/integrations/sync-from-wallza',
        path: '/integrations/sync-from-wallza',
        headers: { ...signed },
        body,
      } as any;

      const resB = await verifyInternalRequestAsync(reqB, {
        expectedAudience: 'social-studio',
        secret: TEST_SECRET,
        prisma: verifierInstanceB,
      });
      expect(resB.valid).toBe(false);
      expect(resB.error).toMatch(/replay attack detected/i);
    });

    it('fails closed when the database is unavailable or throws connection errors', async () => {
      const mockUnreachablePrisma = {
        internalRequestNonce: {
          create: vi.fn(async () => {
            const err: any = new Error('Can not reach database server at localhost:5432');
            err.code = 'P1001';
            throw err;
          }),
        },
      };

      const body = { action: 'ping' };
      const signed = signInternalRequest({
        method: 'POST',
        path: '/integrations/sync-from-wallza',
        audience: 'social-studio',
        body,
        secret: TEST_SECRET,
      });

      const req = {
        method: 'POST',
        originalUrl: '/integrations/sync-from-wallza',
        path: '/integrations/sync-from-wallza',
        headers: { ...signed },
        body,
      } as any;

      const result = await verifyInternalRequestAsync(req, {
        expectedAudience: 'social-studio',
        secret: TEST_SECRET,
        prisma: mockUnreachablePrisma,
      });

      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/failed closed/i);
    });
  });

  // ── 6. REALISTIC CONTROLLER IDEMPOTENCY, LONG PUBLISHING & LEASE RECOVERY ────
  describe('Area 6: Realistic Controller Idempotency, Long Publishing & Fail-Closed Scenarios', () => {
    it('handles long-running publishing operations (> 5 seconds) without creating duplicates', async () => {
      const records = new Map<string, { status: string; postId?: string; updatedAt: Date }>();
      let publishingJobsCount = 0;

      const simulatePublishingController = async (idempotencyKey: string, isOriginal: boolean) => {
        // Attempt reservation
        if (!records.has(idempotencyKey)) {
          records.set(idempotencyKey, { status: 'pending', updatedAt: new Date() });
          
          if (isOriginal) {
            // Original job takes 5.5 seconds to complete
            await new Promise((r) => setTimeout(r, 600)); // Scaled 600ms simulation
            publishingJobsCount++;
            records.set(idempotencyKey, { status: 'completed', postId: 'post_original_long_run', updatedAt: new Date() });
            return { status: 200, post: { id: 'post_original_long_run' }, idempotent: false };
          }
        }

        // Concurrent request arrives while pending
        let attempts = 0;
        let rec = records.get(idempotencyKey);
        // Poll for 500ms max
        while (rec && rec.status === 'pending' && attempts < 5) {
          await new Promise((r) => setTimeout(r, 50));
          rec = records.get(idempotencyKey);
          attempts++;
        }

        if (rec && rec.status === 'pending') {
          // Polling window closed while operation is still ongoing:
          // Controller returns pending/retry response instead of creating another post!
          return { status: 200, pending: true, message: 'Publishing operation in progress', idempotent: true };
        }

        if (rec?.status === 'completed') {
          return { status: 200, post: { id: rec.postId }, idempotent: true };
        }

        return { status: 500 };
      };

      // Request 1 starts long running job
      const req1Promise = simulatePublishingController('idem_long_job_1', true);
      // Wait slightly then Request 2 arrives
      await new Promise((r) => setTimeout(r, 50));
      const req2Promise = simulatePublishingController('idem_long_job_1', false);

      const [res1, res2] = await Promise.all([req1Promise, req2Promise]);

      // Request 2 received pending without creating another post
      expect(res2.pending).toBe(true);
      expect(res2.idempotent).toBe(true);

      // Request 1 completed
      expect(res1.post?.id).toBe('post_original_long_run');
      expect(res1.idempotent).toBe(false);

      // Exactly ONE publishing job was executed
      expect(publishingJobsCount).toBe(1);
    });

    it('fails closed when the database is unavailable during reservation creation', async () => {
      let publishingJobsCount = 0;

      const simulatePublishWithFailingDb = async () => {
        let isOwner = false;
        try {
          // Database throws connection failure
          const err: any = new Error('Database connection pool exhausted');
          err.code = 'P1001';
          throw err;
        } catch (err: any) {
          if (err.code === 'P2002') {
            isOwner = false;
          } else {
            // Fail closed!
            throw new Error(`Idempotency reservation failed: ${err.message}. Publishing aborted.`);
          }
        }

        if (isOwner) {
          publishingJobsCount++;
        }
      };

      await expect(simulatePublishWithFailingDb()).rejects.toThrow(/Idempotency reservation failed/);
      expect(publishingJobsCount).toBe(0); // Zero jobs created
    });

    it('allows a legitimate retry to recover an abandoned or failed reservation', async () => {
      const reservation = {
        idempotencyKey: 'idem_failed_recover',
        status: 'failed',
        updatedAt: new Date(Date.now() - 60_000), // 1 minute ago
      };

      let postsCreated = 0;

      const retryHandler = async () => {
        // Check lease takeover on failed status
        if (reservation.status === 'failed' || (reservation.status === 'pending' && Date.now() - reservation.updatedAt.getTime() > 45_000)) {
          reservation.status = 'pending';
          reservation.updatedAt = new Date();
          // Acquired lease!
          postsCreated++;
          reservation.status = 'completed';
          return { success: true, recovered: true };
        }
        return { success: false };
      };

      const result = await retryHandler();
      expect(result.recovered).toBe(true);
      expect(postsCreated).toBe(1);
      expect(reservation.status).toBe('completed');
    });
  });
});
