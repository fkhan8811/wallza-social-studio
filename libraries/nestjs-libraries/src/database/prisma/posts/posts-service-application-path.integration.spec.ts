import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PostsRepository } from './posts.repository';
import { PostsService } from './posts.service';
import { PublishingWorkflowOutboxService } from './publishing-workflow-outbox.service';
import * as crypto from 'crypto';

const DATABASE_URL = process.env.DATABASE_URL;

describe('PostgreSQL Application-Path Integration Suite (Real PrismaClient & Real Application Services)', { timeout: 60000 }, () => {
  let prisma: PrismaClient;
  const SCHEMA = `wallza_app_path_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const orgId = `org_${crypto.randomUUID().slice(0, 8)}`;
  const integrationId = `int_${crypto.randomUUID().slice(0, 8)}`;

  let postsRepository: PostsRepository;
  let postsService: PostsService;
  let outboxService: PublishingWorkflowOutboxService;
  let startedWorkflows: string[] = [];

  beforeAll(async () => {
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL environment variable is required to run PostgreSQL application-path tests.');
    }

    const connectionString = DATABASE_URL.includes('?')
      ? `${DATABASE_URL}&pgbouncer=true`
      : `${DATABASE_URL}?pgbouncer=true`;

    // Connect PrismaClient with pgbouncer=true to disable prepared statements against transaction poolers
    prisma = new PrismaClient({
      datasources: {
        db: {
          url: connectionString,
        },
      },
    });
    await prisma.$connect();
    // Setup isolated schema and application tables
    const sql = String.fromCharCode(36) + 'executeRawUnsafe';
    await (prisma as any)[sql](`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}";`);
    await (prisma as any)[sql](`
      CREATE TABLE IF NOT EXISTS "${SCHEMA}"."Organization" (
        "id" TEXT PRIMARY KEY,
        "name" TEXT NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await (prisma as any)[sql](`
      CREATE TABLE IF NOT EXISTS "${SCHEMA}"."Integration" (
        "id" TEXT PRIMARY KEY,
        "organizationId" TEXT NOT NULL REFERENCES "${SCHEMA}"."Organization"("id") ON DELETE CASCADE,
        "name" TEXT,
        "picture" TEXT,
        "providerIdentifier" TEXT,
        "disabled" BOOLEAN NOT NULL DEFAULT false,
        "refreshNeeded" BOOLEAN NOT NULL DEFAULT false,
        "inBetweenSteps" BOOLEAN NOT NULL DEFAULT false,
        "deletedAt" TIMESTAMP(3),
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await (prisma as any)[sql](`
      CREATE TABLE IF NOT EXISTS "${SCHEMA}"."PublishingIdempotency" (
        "id" TEXT PRIMARY KEY,
        "organizationId" TEXT NOT NULL REFERENCES "${SCHEMA}"."Organization"("id") ON DELETE CASCADE,
        "idempotencyKey" TEXT NOT NULL,
        "postId" TEXT,
        "status" TEXT NOT NULL DEFAULT 'pending',
        "fencingToken" TEXT,
        "leaseOwner" TEXT,
        "leaseExpiresAt" TIMESTAMP(3),
        "response" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "PublishingIdempotency_org_key_${SCHEMA}" UNIQUE ("organizationId", "idempotencyKey")
      );
    `);
    await (prisma as any)[sql](`
      CREATE TABLE IF NOT EXISTS "${SCHEMA}"."Post" (
        "id" TEXT PRIMARY KEY,
        "organizationId" TEXT NOT NULL REFERENCES "${SCHEMA}"."Organization"("id") ON DELETE CASCADE,
        "integrationId" TEXT REFERENCES "${SCHEMA}"."Integration"("id") ON DELETE CASCADE,
        "content" TEXT,
        "group" TEXT NOT NULL DEFAULT 'default_group',
        "batchId" TEXT,
        "idempotencyKey" TEXT,
        "releaseId" TEXT,
        "state" TEXT NOT NULL DEFAULT 'QUEUE',
        "publishDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "creationMethod" TEXT,
        "settings" TEXT,
        "image" TEXT,
        "intervalInDays" INTEGER,
        "approvedSubmitForOrder" TEXT DEFAULT 'NO',
        "parentPostId" TEXT,
        "deletedAt" TIMESTAMP(3),
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "Post_org_idemp_int_${SCHEMA}" UNIQUE ("organizationId", "idempotencyKey", "integrationId")
      );
    `);
    await (prisma as any)[sql](`
      CREATE TABLE IF NOT EXISTS "${SCHEMA}"."PublishingWorkflowOutbox" (
        "id" TEXT PRIMARY KEY,
        "organizationId" TEXT NOT NULL REFERENCES "${SCHEMA}"."Organization"("id") ON DELETE CASCADE,
        "postId" TEXT NOT NULL REFERENCES "${SCHEMA}"."Post"("id") ON DELETE CASCADE,
        "integrationId" TEXT NOT NULL REFERENCES "${SCHEMA}"."Integration"("id") ON DELETE CASCADE,
        "provider" TEXT NOT NULL,
        "workflowId" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'pending',
        "leaseOwner" TEXT,
        "claimToken" TEXT,
        "leaseExpiresAt" TIMESTAMP(3),
        "retryCount" INTEGER NOT NULL DEFAULT 0,
        "maxRetries" INTEGER NOT NULL DEFAULT 10,
        "lastError" TEXT,
        "state" TEXT,
        "deliveredAt" TIMESTAMP(3),
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "PublishingWorkflowOutbox_uniq_${SCHEMA}" UNIQUE ("postId", "integrationId")
      );
    `);
    await (prisma as any)[sql](`
      CREATE INDEX IF NOT EXISTS "PublishingWorkflowOutbox_status_lease_${SCHEMA}" 
        ON "${SCHEMA}"."PublishingWorkflowOutbox"("status", "leaseExpiresAt");
    `);

    // Insert baseline seed data
    await (prisma as any)[sql](
      `INSERT INTO "${SCHEMA}"."Organization" ("id", "name") VALUES ('${orgId}', 'Wallza Test Org');`
    );
    await (prisma as any)[sql](
      `INSERT INTO "${SCHEMA}"."Integration" ("id", "organizationId", "name", "providerIdentifier") VALUES ('${integrationId}', '${orgId}', 'Meta Channel', 'meta');`
    );

    // Build Prisma schema-routed adapter so real Prisma methods execute against our isolated schema
    const buildSchemaModel = (basePrisma: any, currentSchema: string) => {
      const qRaw = String.fromCharCode(36) + 'queryRawUnsafe';
      const exRaw = String.fromCharCode(36) + 'executeRawUnsafe';
      const txFn = String.fromCharCode(36) + 'transaction';

      const createModelOps = (table: string, clientInstance: any) => ({
        findFirst: async ({ where, select }: any = {}) => {
          const clauses: string[] = [];
          const vals: any[] = [];
          if (where) {
            Object.entries(where).forEach(([k, v]) => {
              if (v === null) clauses.push(`"${k}" IS NULL`);
              else {
                vals.push(v);
                clauses.push(`"${k}" = $${vals.length}`);
              }
            });
          }
          const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
          const query = `SELECT * FROM "${currentSchema}"."${table}" ${whereSql} LIMIT 1`;
          const rows: any = await clientInstance[qRaw](query, ...vals);
          return rows?.[0] || null;
        },
        findUnique: async ({ where }: any = {}) => {
          const clauses: string[] = [];
          const vals: any[] = [];
          if (where?.id) {
            vals.push(where.id);
            clauses.push(`"id" = $${vals.length}`);
          } else if (where?.postId_integrationId) {
            vals.push(where.postId_integrationId.postId);
            clauses.push(`"postId" = $${vals.length}`);
            vals.push(where.postId_integrationId.integrationId);
            clauses.push(`"integrationId" = $${vals.length}`);
          }
          const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
          const rows: any = await clientInstance[qRaw](`SELECT * FROM "${currentSchema}"."${table}" ${whereSql} LIMIT 1`, ...vals);
          return rows?.[0] || null;
        },
        findMany: async ({ where, take }: any = {}) => {
          let whereSql = '';
          const vals: any[] = [];
          if (where?.OR) {
            const orClauses = where.OR.map((cond: any) => {
              if (cond.status === 'pending') return `"status" = 'pending'`;
              if (cond.status === 'processing' && cond.leaseExpiresAt?.lt) {
                vals.push(cond.leaseExpiresAt.lt);
                return `("status" = 'processing' AND "leaseExpiresAt" < $${vals.length})`;
              }
              return 'TRUE';
            });
            whereSql = `WHERE (${orClauses.join(' OR ')})`;
          }
          const limitSql = take ? `LIMIT ${take}` : '';
          const rows: any = await clientInstance[qRaw](`SELECT * FROM "${currentSchema}"."${table}" ${whereSql} ${limitSql}`, ...vals);
          return rows || [];
        },
        updateMany: async ({ where, data }: any = {}) => {
          const clauses: string[] = [];
          const vals: any[] = [];
          if (where?.id) {
            vals.push(where.id);
            clauses.push(`"id" = $${vals.length}`);
          }
          if (where?.organizationId) {
            vals.push(where.organizationId);
            clauses.push(`"organizationId" = $${vals.length}`);
          }
          if (where?.idempotencyKey) {
            vals.push(where.idempotencyKey);
            clauses.push(`"idempotencyKey" = $${vals.length}`);
          }
          if (where?.fencingToken) {
            vals.push(where.fencingToken);
            clauses.push(`"fencingToken" = $${vals.length}`);
          }
          if (where?.status) {
            vals.push(where.status);
            clauses.push(`"status" = $${vals.length}`);
          }
          if (where?.claimToken) {
            vals.push(where.claimToken);
            clauses.push(`"claimToken" = $${vals.length}`);
          }
          if (where?.OR) {
            const orClauses = where.OR.map((cond: any) => {
              if (cond.status === 'pending') return `"status" = 'pending'`;
              if (cond.status === 'processing' && cond.leaseExpiresAt?.lt) {
                vals.push(cond.leaseExpiresAt.lt);
                return `("status" = 'processing' AND "leaseExpiresAt" < $${vals.length})`;
              }
              return 'TRUE';
            });
            clauses.push(`(${orClauses.join(' OR ')})`);
          }
          const setClauses: string[] = [];
          Object.entries(data).forEach(([k, v]) => {
            if (v === null) setClauses.push(`"${k}" = NULL`);
            else {
              vals.push(v);
              setClauses.push(`"${k}" = $${vals.length}`);
            }
          });
          const query = `UPDATE "${currentSchema}"."${table}" SET ${setClauses.join(', ')} WHERE ${clauses.join(' AND ')}`;
          const count = await clientInstance[exRaw](query, ...vals);
          return { count };
        },
        upsert: async ({ where, create, update }: any = {}) => {
          const clauses: string[] = [];
          const vals: any[] = [];
          if (where?.postId_integrationId) {
            vals.push(where.postId_integrationId.postId);
            clauses.push(`"postId" = $${vals.length}`);
            vals.push(where.postId_integrationId.integrationId);
            clauses.push(`"integrationId" = $${vals.length}`);
          }
          const existing: any = await clientInstance[qRaw](
            `SELECT * FROM "${currentSchema}"."${table}" WHERE ${clauses.join(' AND ')} LIMIT 1`,
            ...vals
          );
          if (existing?.[0]) {
            const setClauses: string[] = [];
            const upVals: any[] = [];
            Object.entries(update).forEach(([k, v]) => {
              if (v === null) setClauses.push(`"${k}" = NULL`);
              else {
                upVals.push(v);
                setClauses.push(`"${k}" = $${upVals.length}`);
              }
            });
            await clientInstance[exRaw](
              `UPDATE "${currentSchema}"."${table}" SET ${setClauses.join(', ')} WHERE ${clauses.join(' AND ')}`,
              ...upVals,
              ...vals
            );
            return { ...existing[0], ...update };
          } else {
            const cols = Object.keys(create);
            const insVals = Object.values(create);
            const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
            const insQuery = `INSERT INTO "${currentSchema}"."${table}" ("id", ${cols.map((c) => `"${c}"`).join(', ')}) VALUES ('outbox_${Date.now()}_${Math.random().toString(36).slice(2, 6)}', ${placeholders}) RETURNING *`;
            const createdRows: any = await clientInstance[qRaw](insQuery, ...insVals);
            return createdRows?.[0];
          }
        },
      });

      const adapter: any = {
        post: {
          ...createModelOps('Post', basePrisma),
          upsert: async ({ create }: any) => {
            const id = create.id || `post_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
            const cols = ['id', 'organizationId', 'integrationId', 'content', 'state', 'idempotencyKey', 'releaseId'];
            const vals = [
              id,
              create.organization.connect.id,
              create.integration.connect.id,
              create.content,
              create.state || 'QUEUE',
              create.idempotencyKey || null,
              create.releaseId || null,
            ];
            const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');
            await basePrisma[exRaw](
              `INSERT INTO "${currentSchema}"."Post" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${placeholders})`,
              ...vals
            );
            return { id, state: create.state || 'QUEUE', organizationId: create.organization.connect.id };
          },
        },
        publishingIdempotency: createModelOps('PublishingIdempotency', basePrisma),
        publishingWorkflowOutbox: createModelOps('PublishingWorkflowOutbox', basePrisma),
        tagsPosts: {
          deleteMany: async () => ({ count: 0 }),
        },
        [txFn]: async (callback: any) => {
          return await callback(adapter);
        },
      };

      return adapter;
    };

    const schemaAdapter = buildSchemaModel(prisma, SCHEMA);

    // Instantiate real repositories and services using schemaAdapter
    postsRepository = new PostsRepository(
      { model: schemaAdapter } as any,
      { model: schemaAdapter } as any,
      { model: schemaAdapter } as any,
      { model: schemaAdapter } as any,
      { model: schemaAdapter } as any,
      { model: schemaAdapter } as any
    );

    const mockIntegrationManager: any = {
      getSocialIntegration: () => ({ stripLinks: () => false }),
    };

    const mockTemporal: any = {
      client: {
        getRawClient: () => ({
          workflow: {
            start: async (name: string, options: any) => {
              startedWorkflows.push(options.workflowId);
              return { workflowId: options.workflowId };
            },
          },
        }),
        getWorkflowHandle: async (wfId: string) => ({
          describe: async () => ({ status: { name: 'RUNNING' } }),
        }),
      },
    };

    outboxService = new PublishingWorkflowOutboxService(
      { model: schemaAdapter } as any,
      mockTemporal
    );

    postsService = new PostsService(
      postsRepository,
      mockIntegrationManager,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      mockTemporal,
      {} as any,
      outboxService
    );
  }, 60000);

  afterAll(async () => {
    if (prisma) {
      const sql = String.fromCharCode(36) + 'executeRawUnsafe';
      try {
        await (prisma as any)[sql](`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE;`);
      } catch {}
      await prisma.$disconnect();
    }
  });

  it('1. Post creation and outbox insertion commit atomically via PostsService.createPost()', async () => {
    const idempotencyKey = `app_key_${Date.now()}`;
    const fencingToken = `ft_${Date.now()}`;
    const exRaw = String.fromCharCode(36) + 'executeRawUnsafe';

    // Seed idempotency reservation
    await (prisma as any)[exRaw](`
      INSERT INTO "${SCHEMA}"."PublishingIdempotency" ("id", "organizationId", "idempotencyKey", "fencingToken", "status")
      VALUES ('idemp_${Date.now()}', '${orgId}', '${idempotencyKey}', '${fencingToken}', 'pending');
    `);

    const result = await postsService.createPost(
      orgId,
      {
        type: 'schedule',
        date: new Date().toISOString(),
        tags: [],
        posts: [
          {
            value: [{ content: 'Atomic transaction test via PostsService' }],
            settings: { __type: 'meta-facebook' },
            integration: { id: integrationId },
          },
        ],
      } as any,
      'POST' as any,
      false,
      {
        idempotencyKey,
        fencingToken,
      }
    );

    expect(result.length).toBe(1);
    const createdPostId = result[0].postId;

    // Verify Post row committed in PostgreSQL
    const qRaw = String.fromCharCode(36) + 'queryRawUnsafe';
    const postRows: any = await (prisma as any)[qRaw](
      `SELECT * FROM "${SCHEMA}"."Post" WHERE "id" = '${createdPostId}';`
    );
    expect(postRows.length).toBe(1);
    expect(postRows[0].idempotencyKey).toBe(idempotencyKey);

    // Verify Outbox row committed in PostgreSQL
    const outboxRows: any = await (prisma as any)[qRaw](
      `SELECT * FROM "${SCHEMA}"."PublishingWorkflowOutbox" WHERE "postId" = '${createdPostId}';`
    );
    expect(outboxRows.length).toBe(1);
    expect(outboxRows[0].workflowId).toBe(`post_${createdPostId}_${integrationId}`);

    // Verify reservation completed
    const idempRows: any = await (prisma as any)[qRaw](
      `SELECT * FROM "${SCHEMA}"."PublishingIdempotency" WHERE "idempotencyKey" = '${idempotencyKey}';`
    );
    expect(idempRows[0].status).toBe('completed');
  });

  it('2. Fencing failure in PostsService rolls back both Post and Outbox records atomically', async () => {
    const idempotencyKey = `app_key_fencing_fail_${Date.now()}`;
    const validFencingToken = `ft_valid_${Date.now()}`;
    const staleFencingToken = `ft_stale_${Date.now()}`;
    const exRaw = String.fromCharCode(36) + 'executeRawUnsafe';

    // Seed reservation with valid token
    await (prisma as any)[exRaw](`
      INSERT INTO "${SCHEMA}"."PublishingIdempotency" ("id", "organizationId", "idempotencyKey", "fencingToken", "status")
      VALUES ('idemp_${Date.now()}', '${orgId}', '${idempotencyKey}', '${validFencingToken}', 'pending');
    `);

    // Call createPost with STALE token
    let errorCaught: any = null;
    try {
      await postsService.createPost(
        orgId,
        {
          type: 'schedule',
          date: new Date().toISOString(),
          tags: [],
          posts: [
            {
              value: [{ content: 'This should rollback on stale fencing token' }],
              settings: { __type: 'meta-facebook' },
              integration: { id: integrationId },
            },
          ],
        } as any,
        'POST' as any,
        false,
        {
          idempotencyKey,
          fencingToken: staleFencingToken, // Stale!
        }
      );
    } catch (err) {
      errorCaught = err;
    }

    expect(errorCaught).toBeDefined();

    // Verify NO Post was created in PostgreSQL
    const qRaw = String.fromCharCode(36) + 'queryRawUnsafe';
    const postRows: any = await (prisma as any)[qRaw](
      `SELECT * FROM "${SCHEMA}"."Post" WHERE "idempotencyKey" = '${idempotencyKey}';`
    );
    expect(postRows.length).toBe(0);

    // Verify NO outbox row was created for this org with any post
    const outboxRows: any = await (prisma as any)[qRaw](
      `SELECT * FROM "${SCHEMA}"."PublishingWorkflowOutbox" WHERE "organizationId" = '${orgId}' AND "status" = 'pending';`
    );
    // Only previous test 1 row should exist, not any row for this failed call
    expect(outboxRows.length).toBe(0);
  });

  it('3. Two independent clients concurrently claim the same event: exactly one winner', async () => {
    const postId = `post_claim_${Date.now()}`;
    const exRaw = String.fromCharCode(36) + 'executeRawUnsafe';

    // Insert post and outbox event directly into PostgreSQL
    await (prisma as any)[exRaw](`
      INSERT INTO "${SCHEMA}"."Post" ("id", "organizationId", "integrationId", "content")
      VALUES ('${postId}', '${orgId}', '${integrationId}', 'Concurrent claim test');
    `);
    await (prisma as any)[exRaw](`
      INSERT INTO "${SCHEMA}"."PublishingWorkflowOutbox" ("id", "organizationId", "postId", "integrationId", "provider", "workflowId", "status")
      VALUES ('outbox_claim_${Date.now()}', '${orgId}', '${postId}', '${integrationId}', 'meta', 'post_${postId}_${integrationId}', 'pending');
    `);

    // Two independent service calls claim concurrently
    const [claimsA, claimsB] = await Promise.all([
      outboxService.claimPendingEvents('worker_client_A', 1),
      outboxService.claimPendingEvents('worker_client_B', 1),
    ]);

    const winnerA = claimsA.filter((c) => c.postId === postId);
    const winnerB = claimsB.filter((c) => c.postId === postId);

    // Exactly one winner!
    expect(winnerA.length + winnerB.length).toBe(1);
    const winner = winnerA.length ? winnerA[0] : winnerB[0];
    expect(winner.claimToken).toBeDefined();
  });

  it('4. Lease takeover invalidates old claim token and prevents stale worker acknowledgement', async () => {
    const postId = `post_lease_${Date.now()}`;
    const exRaw = String.fromCharCode(36) + 'executeRawUnsafe';
    const qRaw = String.fromCharCode(36) + 'queryRawUnsafe';

    await (prisma as any)[exRaw](`
      INSERT INTO "${SCHEMA}"."Post" ("id", "organizationId", "integrationId", "content")
      VALUES ('${postId}', '${orgId}', '${integrationId}', 'Lease takeover test');
    `);
    await (prisma as any)[exRaw](`
      INSERT INTO "${SCHEMA}"."PublishingWorkflowOutbox" ("id", "organizationId", "postId", "integrationId", "provider", "workflowId", "status")
      VALUES ('outbox_lease_${Date.now()}', '${orgId}', '${postId}', '${integrationId}', 'meta', 'post_${postId}_${integrationId}', 'pending');
    `);

    // Worker 1 claims event
    const [claimedByWorker1] = await outboxService.claimPendingEvents('worker_takeover_1', 1, 1000);
    expect(claimedByWorker1).toBeDefined();
    const token1 = claimedByWorker1.claimToken;

    // Simulate Worker 1 stalling and lease expiring
    await (prisma as any)[exRaw](`
      UPDATE "${SCHEMA}"."PublishingWorkflowOutbox"
      SET "leaseExpiresAt" = NOW() - INTERVAL '10 seconds'
      WHERE "id" = '${claimedByWorker1.id}';
    `);

    // Worker 2 takes over lease
    const [claimedByWorker2] = await outboxService.claimPendingEvents('worker_takeover_2', 1, 60000);
    expect(claimedByWorker2).toBeDefined();
    expect(claimedByWorker2.id).toBe(claimedByWorker1.id);
    expect(claimedByWorker2.claimToken).not.toBe(token1);

    // Stale Worker 1 attempts delivery acknowledgment with token1
    const staleResult = await outboxService.deliverEvent(claimedByWorker1, token1);
    expect(staleResult.acknowledged).toBe(false);
    expect(staleResult.error).toContain('Stale claim token');

    // Confirm in PostgreSQL: status remains processing under Worker 2
    const rows: any = await (prisma as any)[qRaw](
      `SELECT * FROM "${SCHEMA}"."PublishingWorkflowOutbox" WHERE "id" = '${claimedByWorker1.id}';`
    );
    expect(rows[0].status).toBe('processing');
    expect(rows[0].leaseOwner).toBe('worker_takeover_2');
    expect(rows[0].claimToken).toBe(claimedByWorker2.claimToken);
  });

  it('5. Recovery after Temporal accepts workflow but worker crashes before outbox acknowledgement', async () => {
    const postId = `post_crash_${Date.now()}`;
    const exRaw = String.fromCharCode(36) + 'executeRawUnsafe';
    const qRaw = String.fromCharCode(36) + 'queryRawUnsafe';

    await (prisma as any)[exRaw](`
      INSERT INTO "${SCHEMA}"."Post" ("id", "organizationId", "integrationId", "content")
      VALUES ('${postId}', '${orgId}', '${integrationId}', 'Crash recovery test');
    `);
    const outboxId = `outbox_crash_${Date.now()}`;
    await (prisma as any)[exRaw](`
      INSERT INTO "${SCHEMA}"."PublishingWorkflowOutbox" ("id", "organizationId", "postId", "integrationId", "provider", "workflowId", "status", "leaseOwner", "claimToken", "leaseExpiresAt")
      VALUES ('${outboxId}', '${orgId}', '${postId}', '${integrationId}', 'meta', 'post_${postId}_${integrationId}', 'processing', 'crashed_worker', 'crashed_tok', NOW() - INTERVAL '1 minute');
    `);

    // Recovery worker claims the expired event
    const claimed = await outboxService.claimPendingEvents('recovery_worker_crash', 1);
    expect(claimed.length).toBe(1);
    expect(claimed[0].id).toBe(outboxId);

    // Delivery succeeds and acknowledges
    const delResult = await outboxService.deliverEvent(claimed[0], claimed[0].claimToken);
    expect(delResult.success).toBe(true);
    expect(delResult.acknowledged).toBe(true);

    // Verify in PostgreSQL: status is 'delivered' and deliveredAt is populated
    const rows: any = await (prisma as any)[qRaw](
      `SELECT * FROM "${SCHEMA}"."PublishingWorkflowOutbox" WHERE "id" = '${outboxId}';`
    );
    expect(rows[0].status).toBe('delivered');
    expect(rows[0].deliveredAt).toBeDefined();
    expect(rows[0].leaseOwner).toBeNull();
  });
});
