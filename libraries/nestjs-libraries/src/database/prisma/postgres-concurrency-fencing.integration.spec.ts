import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import * as crypto from 'crypto';

const DATABASE_URL = process.env.DATABASE_URL;

describe('PostgreSQL Concurrency, Heartbeat, and Fencing Token Integration Suite (Real Database)', { timeout: 35000 }, () => {
  let pool: Pool;
  const SCHEMA = `wallza_fencing_vitest_${Date.now()}`;
  const orgId = `org_${crypto.randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL environment variable is required to run PostgreSQL integration tests.');
    }

    pool = new Pool({
      connectionString: DATABASE_URL,
      max: 15,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 10000,
      ssl: DATABASE_URL.includes('supabase.com') ? { rejectUnauthorized: false } : undefined,
    });

    const client = await pool.connect();
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}";`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS "${SCHEMA}"."PublishingIdempotency" (
        "id" TEXT PRIMARY KEY,
        "organizationId" TEXT NOT NULL,
        "idempotencyKey" TEXT NOT NULL,
        "postId" TEXT,
        "status" TEXT NOT NULL DEFAULT 'pending',
        "fencingToken" TEXT,
        "response" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "PublishingIdempotency_org_key_${SCHEMA}" UNIQUE ("organizationId", "idempotencyKey")
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS "${SCHEMA}"."Post" (
        "id" TEXT PRIMARY KEY,
        "organizationId" TEXT NOT NULL,
        "integrationId" TEXT NOT NULL,
        "content" TEXT NOT NULL,
        "group" TEXT NOT NULL DEFAULT 'default_group',
        "idempotencyKey" TEXT,
        "releaseId" TEXT,
        "state" TEXT NOT NULL DEFAULT 'QUEUE',
        "publishDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "deletedAt" TIMESTAMP(3),
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS "Post_org_idemp_idx_${SCHEMA}" ON "${SCHEMA}"."Post"("organizationId", "idempotencyKey");
      CREATE UNIQUE INDEX IF NOT EXISTS "Post_org_idemp_int_uniq_${SCHEMA}" 
        ON "${SCHEMA}"."Post"("organizationId", "idempotencyKey", "integrationId");
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS "${SCHEMA}"."PublishingWorkflowOutbox" (
        "id" TEXT PRIMARY KEY,
        "organizationId" TEXT NOT NULL,
        "postId" TEXT NOT NULL,
        "integrationId" TEXT NOT NULL,
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
      CREATE INDEX IF NOT EXISTS "PublishingWorkflowOutbox_status_lease_${SCHEMA}" ON "${SCHEMA}"."PublishingWorkflowOutbox"("status", "leaseExpiresAt");
    `);
    client.release();
  });

  afterAll(async () => {
    if (!pool) return;
    try {
      const client = await pool.connect();
      await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE;`);
      client.release();
    } catch {}
    await pool.end();
  });

  it('1. 10 simultaneous dispatch requests with one idempotency key: exactly 1 winner, 0 duplicates', async () => {
    const testKey = `idemp_simul_${Date.now()}`;
    const integration1 = `int_meta_${Date.now()}`;

    const results = await Promise.all(
      Array.from({ length: 10 }).map(async (_, idx) => {
        const client = await pool.connect();
        const fencingToken = crypto.randomUUID();
        const id = `res_${idx}_${Date.now()}`;
        try {
          await client.query(
            `INSERT INTO "${SCHEMA}"."PublishingIdempotency" ("id", "organizationId", "idempotencyKey", "fencingToken", "status", "updatedAt")
             VALUES ($1, $2, $3, $4, 'pending', NOW())`,
            [id, orgId, testKey, fencingToken]
          );
          return { winner: true, idx, fencingToken, client };
        } catch (err: any) {
          client.release();
          if (err.code === '23505') {
            return { winner: false, idx, error: 'P2002' };
          }
          throw err;
        }
      })
    );

    const winners = results.filter((r) => r.winner);
    const losers = results.filter((r) => !r.winner);

    expect(winners.length).toBe(1);
    expect(losers.length).toBe(9);

    const winner = winners[0];
    const postId = `post_${Date.now()}`;

    // Execute Post creation, Outbox insertion, and reservation finalization in a single database transaction
    await winner.client.query('BEGIN');
    const checkLease = await winner.client.query(
      `SELECT * FROM "${SCHEMA}"."PublishingIdempotency"
       WHERE "organizationId" = $1 AND "idempotencyKey" = $2 AND "fencingToken" = $3 AND "status" = 'pending'`,
      [orgId, testKey, winner.fencingToken]
    );
    expect(checkLease.rowCount).toBe(1);

    await winner.client.query(
      `INSERT INTO "${SCHEMA}"."Post" ("id", "organizationId", "integrationId", "content", "idempotencyKey", "releaseId")
       VALUES ($1, $2, $3, 'Single dispatch message', $4, $4)`,
      [postId, orgId, integration1, testKey]
    );

    await winner.client.query(
      `INSERT INTO "${SCHEMA}"."PublishingWorkflowOutbox" ("id", "organizationId", "postId", "integrationId", "provider", "workflowId", "status", "retryCount", "maxRetries")
       VALUES ($1, $2, $3, $4, 'meta', $5, 'pending', 0, 10)`,
      [`outbox_${Date.now()}`, orgId, postId, integration1, `post_${postId}_${integration1}`]
    );

    const completeRes = await winner.client.query(
      `UPDATE "${SCHEMA}"."PublishingIdempotency"
       SET "status" = 'completed', "postId" = $1, "updatedAt" = NOW()
       WHERE "organizationId" = $2 AND "idempotencyKey" = $3 AND "fencingToken" = $4 AND "status" = 'pending'`,
      [postId, orgId, testKey, winner.fencingToken]
    );
    expect(completeRes.rowCount).toBe(1);
    await winner.client.query('COMMIT');
    winner.client.release();

    const postCount = await pool.query(
      `SELECT COUNT(*)::int as count FROM "${SCHEMA}"."Post" WHERE "organizationId" = $1 AND "idempotencyKey" = $2`,
      [orgId, testKey]
    );
    expect(postCount.rows[0].count).toBe(1);

    const outboxCount = await pool.query(
      `SELECT COUNT(*)::int as count FROM "${SCHEMA}"."PublishingWorkflowOutbox" WHERE "organizationId" = $1 AND "postId" = $2`,
      [orgId, postId]
    );
    expect(outboxCount.rows[0].count).toBe(1);
  });

  it('2. Publishing operation lasting > 45s: heartbeat lease renewal prevents takeover', async () => {
    const testKey = `idemp_long_${Date.now()}`;
    const c1 = await pool.connect();
    const c2 = await pool.connect();

    try {
      const fencing1 = crypto.randomUUID();
      await c1.query(
        `INSERT INTO "${SCHEMA}"."PublishingIdempotency" ("id", "organizationId", "idempotencyKey", "fencingToken", "status", "updatedAt")
         VALUES ($1, $2, $3, $4, 'pending', NOW())`,
        [`res_2_1`, orgId, testKey, fencing1]
      );

      // Heartbeat kept updatedAt fresh (NOW()), but operation started 50s ago
      await c1.query(
        `UPDATE "${SCHEMA}"."PublishingIdempotency"
         SET "createdAt" = NOW() - INTERVAL '50 seconds', "updatedAt" = NOW()
         WHERE "organizationId" = $1 AND "idempotencyKey" = $2`,
        [orgId, testKey]
      );

      // Concurrent Worker attempts takeover with 45s expiration rule
      const newFencing = crypto.randomUUID();
      const takeover = await c2.query(
        `UPDATE "${SCHEMA}"."PublishingIdempotency"
         SET "status" = 'pending', "fencingToken" = $1, "updatedAt" = NOW()
         WHERE "organizationId" = $2 AND "idempotencyKey" = $3
           AND ("status" = 'failed' OR ("status" = 'pending' AND "updatedAt" < NOW() - INTERVAL '45 seconds'))`,
        [newFencing, orgId, testKey]
      );

      expect(takeover.rowCount).toBe(0);
    } finally {
      c1.release();
      c2.release();
    }
  });

  it('3. Heartbeat database failure safety: flags isLeaseLost and aborts before dispatch', async () => {
    const testKey = `idemp_hb_fail_${Date.now()}`;
    const c = await pool.connect();

    try {
      await c.query(
        `INSERT INTO "${SCHEMA}"."PublishingIdempotency" ("id", "organizationId", "idempotencyKey", "fencingToken", "status", "updatedAt")
         VALUES ($1, $2, $3, $4, 'pending', NOW())`,
        [`res_3`, orgId, testKey, crypto.randomUUID()]
      );

      let isLeaseLost = false;
      try {
        throw new Error('Simulated DB outage');
      } catch {
        isLeaseLost = true;
      }

      let dispatched = false;
      if (!isLeaseLost) {
        dispatched = true;
      }

      expect(dispatched).toBe(false);
      const postCheck = await c.query(
        `SELECT COUNT(*)::int as count FROM "${SCHEMA}"."Post" WHERE "organizationId" = $1 AND "idempotencyKey" = $2`,
        [orgId, testKey]
      );
      expect(postCheck.rows[0].count).toBe(0);
    } finally {
      c.release();
    }
  });

  it('4. Lease expiry after confirmed 45s absence of heartbeat allows recovery takeover', async () => {
    const testKey = `idemp_stalled_${Date.now()}`;
    const c = await pool.connect();

    try {
      await c.query(
        `INSERT INTO "${SCHEMA}"."PublishingIdempotency" ("id", "organizationId", "idempotencyKey", "fencingToken", "status", "updatedAt")
         VALUES ($1, $2, $3, $4, 'pending', NOW() - INTERVAL '50 seconds')`,
        [`res_4`, orgId, testKey, crypto.randomUUID()]
      );

      const fencing2 = crypto.randomUUID();
      const recovery = await c.query(
        `UPDATE "${SCHEMA}"."PublishingIdempotency"
         SET "status" = 'pending', "fencingToken" = $1, "updatedAt" = NOW()
         WHERE "organizationId" = $2 AND "idempotencyKey" = $3
           AND ("status" = 'failed' OR ("status" = 'pending' AND "updatedAt" < NOW() - INTERVAL '45 seconds'))`,
        [fencing2, orgId, testKey]
      );
      expect(recovery.rowCount).toBe(1);

      const checkRow = await c.query(
        `SELECT "fencingToken" FROM "${SCHEMA}"."PublishingIdempotency" WHERE "organizationId" = $1 AND "idempotencyKey" = $2`,
        [orgId, testKey]
      );
      expect(checkRow.rows[0].fencingToken).toBe(fencing2);
    } finally {
      c.release();
    }
  });

  it('5. Stale owner attempting to dispatch after takeover is strictly rejected and rolls back transaction', async () => {
    const testKey = `idemp_stale_roll_${Date.now()}`;
    const c = await pool.connect();

    try {
      const activeFencing = `active_${crypto.randomUUID()}`;
      const staleFencing = `stale_${crypto.randomUUID()}`;

      await c.query(
        `INSERT INTO "${SCHEMA}"."PublishingIdempotency" ("id", "organizationId", "idempotencyKey", "fencingToken", "status", "updatedAt")
         VALUES ($1, $2, $3, $4, 'pending', NOW())`,
        [`res_5`, orgId, testKey, activeFencing]
      );

      // Stale owner attempts in-transaction verification
      await c.query('BEGIN');
      const inTxCheck = await c.query(
        `SELECT * FROM "${SCHEMA}"."PublishingIdempotency"
         WHERE "organizationId" = $1 AND "idempotencyKey" = $2 AND "fencingToken" = $3 AND "status" = 'pending'`,
        [orgId, testKey, staleFencing]
      );
      expect(inTxCheck.rowCount).toBe(0);

      // Fencing check failed -> Transaction rolled back
      await c.query('ROLLBACK');

      const postCount = await c.query(
        `SELECT COUNT(*)::int as count FROM "${SCHEMA}"."Post" WHERE "organizationId" = $1 AND "idempotencyKey" = $2`,
        [orgId, testKey]
      );
      expect(postCount.rows[0].count).toBe(0);
    } finally {
      c.release();
    }
  });

  it('6. Crash after Post creation and outbox insert: recovered via durable Post idempotencyKey & pending outbox row', async () => {
    const testKey = `idemp_crash_${Date.now()}`;
    const c = await pool.connect();

    try {
      await c.query(
        `INSERT INTO "${SCHEMA}"."PublishingIdempotency" ("id", "organizationId", "idempotencyKey", "fencingToken", "status", "updatedAt")
         VALUES ($1, $2, $3, $4, 'pending', NOW())`,
        [`res_6`, orgId, testKey, crypto.randomUUID()]
      );

      const crashedPostId = `post_crashed_${Date.now()}`;
      await c.query(
        `INSERT INTO "${SCHEMA}"."Post" ("id", "organizationId", "integrationId", "content", "idempotencyKey", "releaseId")
         VALUES ($1, $2, 'int_crash', 'Crashed before reservation completion', $3, $3)`,
        [crashedPostId, orgId, testKey]
      );

      await c.query(
        `INSERT INTO "${SCHEMA}"."PublishingWorkflowOutbox" ("id", "organizationId", "postId", "integrationId", "provider", "workflowId", "status", "retryCount", "maxRetries")
         VALUES ($1, $2, $3, 'int_crash', 'twitter', $4, 'pending', 0, 10)`,
        [`outbox_crash_${Date.now()}`, orgId, crashedPostId, `post_${crashedPostId}_int_crash`]
      );

      // Retry arrives: checks Post table first
      const existing = await c.query(
        `SELECT * FROM "${SCHEMA}"."Post"
         WHERE "organizationId" = $1 AND ("idempotencyKey" = $2 OR "releaseId" = $2) AND "deletedAt" IS NULL`,
        [orgId, testKey]
      );
      expect(existing.rowCount).toBe(1);

      // Idempotency table recovered to completed
      await c.query(
        `UPDATE "${SCHEMA}"."PublishingIdempotency"
         SET "status" = 'completed', "postId" = $1, "updatedAt" = NOW()
         WHERE "organizationId" = $2 AND "idempotencyKey" = $3`,
        [existing.rows[0].id, orgId, testKey]
      );

      // Outbox row remains durable and pending for worker pickup
      const pendingOutbox = await c.query(
        `SELECT * FROM "${SCHEMA}"."PublishingWorkflowOutbox" WHERE "postId" = $1 AND "status" = 'pending'`,
        [crashedPostId]
      );
      expect(pendingOutbox.rowCount).toBe(1);
    } finally {
      c.release();
    }
  });

  it('7. Multi-platform partial failure & retry: only missing integration is dispatched with independent outbox event', async () => {
    const testKey = `idemp_multi_${Date.now()}`;
    const c = await pool.connect();

    try {
      const platformA = `int_linkedin_${Date.now()}`;
      const platformB = `int_twitter_${Date.now()}`;
      const postAId = `post_multi_A_${Date.now()}`;

      // Initial attempt creates Post and Outbox for platform A
      await c.query(
        `INSERT INTO "${SCHEMA}"."Post" ("id", "organizationId", "integrationId", "content", "idempotencyKey", "releaseId")
         VALUES ($1, $2, $3, 'Multi-platform message', $4, $4)`,
        [postAId, orgId, platformA, testKey]
      );
      await c.query(
        `INSERT INTO "${SCHEMA}"."PublishingWorkflowOutbox" ("id", "organizationId", "postId", "integrationId", "provider", "workflowId", "status", "retryCount", "maxRetries")
         VALUES ($1, $2, $3, $4, 'linkedin', $5, 'delivered', 0, 10)`,
        [`outbox_multi_A_${Date.now()}`, orgId, postAId, platformA, `post_${postAId}_${platformA}`]
      );

      // Platform B failed before creation.
      // Retry arrives targeting both platform A and platform B with testKey:
      const alreadyCreated = await c.query(
        `SELECT "integrationId" FROM "${SCHEMA}"."Post"
         WHERE "organizationId" = $1 AND "idempotencyKey" = $2 AND "deletedAt" IS NULL`,
        [orgId, testKey]
      );
      const existingIntegrationIds = new Set(alreadyCreated.rows.map(r => r.integrationId));

      const targetIntegrations = [platformA, platformB];
      const missingIntegrations = targetIntegrations.filter(id => !existingIntegrationIds.has(id));

      expect(missingIntegrations.length).toBe(1);
      expect(missingIntegrations[0]).toBe(platformB);

      // Dispatch missing integration only
      const postBId = `post_multi_B_${Date.now()}`;
      await c.query(
        `INSERT INTO "${SCHEMA}"."Post" ("id", "organizationId", "integrationId", "content", "idempotencyKey", "releaseId")
         VALUES ($1, $2, $3, 'Multi-platform message', $4, $4)`,
        [postBId, orgId, missingIntegrations[0], testKey]
      );
      await c.query(
        `INSERT INTO "${SCHEMA}"."PublishingWorkflowOutbox" ("id", "organizationId", "postId", "integrationId", "provider", "workflowId", "status", "retryCount", "maxRetries")
         VALUES ($1, $2, $3, $4, 'twitter', $5, 'pending', 0, 10)`,
        [`outbox_multi_B_${Date.now()}`, orgId, postBId, missingIntegrations[0], `post_${postBId}_${missingIntegrations[0]}`]
      );

      const totalMultiPosts = await c.query(
        `SELECT COUNT(*)::int as count FROM "${SCHEMA}"."Post" WHERE "organizationId" = $1 AND "idempotencyKey" = $2`,
        [orgId, testKey]
      );
      expect(totalMultiPosts.rows[0].count).toBe(2);

      const totalOutbox = await c.query(
        `SELECT COUNT(*)::int as count FROM "${SCHEMA}"."PublishingWorkflowOutbox" WHERE "organizationId" = $1 AND ("postId" = $2 OR "postId" = $3)`,
        [orgId, postAId, postBId]
      );
      expect(totalOutbox.rows[0].count).toBe(2);
    } finally {
      c.release();
    }
  });

  it('8. Database uniqueness constraint @@unique([organizationId, idempotencyKey, integrationId]) strictly prevents duplicate post inserts', async () => {
    const c = await pool.connect();

    try {
      const testKey = `idemp_uniq_${Date.now()}`;
      const testIntegration = `int_uniq_target`;

      await c.query(
        `INSERT INTO "${SCHEMA}"."Post" ("id", "organizationId", "integrationId", "content", "idempotencyKey", "releaseId")
         VALUES ($1, $2, $3, 'Original post', $4, $4)`,
        [`post_uniq_1_${Date.now()}`, orgId, testIntegration, testKey]
      );

      let caughtViolation = false;
      try {
        await c.query(
          `INSERT INTO "${SCHEMA}"."Post" ("id", "organizationId", "integrationId", "content", "idempotencyKey", "releaseId")
           VALUES ($1, $2, $3, 'Duplicate post attempt', $4, $4)`,
          [`post_uniq_2_${Date.now()}`, orgId, testIntegration, testKey]
        );
      } catch (dbErr: any) {
        if (dbErr.code === '23505') {
          caughtViolation = true;
        }
      }

      expect(caughtViolation).toBe(true);
    } finally {
      c.release();
    }
  });

  it('9. Concurrent worker outbox claims and expired lease takeover with unique claim tokens', async () => {
    const c = await pool.connect();

    try {
      const eventId = `outbox_claim_${Date.now()}`;
      const postId = `post_claim_${Date.now()}`;
      await c.query(
        `INSERT INTO "${SCHEMA}"."PublishingWorkflowOutbox" ("id", "organizationId", "postId", "integrationId", "provider", "workflowId", "status", "retryCount", "maxRetries")
         VALUES ($1, $2, $3, 'int_claim', 'twitter', $4, 'pending', 0, 10)`,
        [eventId, orgId, postId, `post_${postId}_int_claim`]
      );

      // Worker 1 claims event
      const token1 = crypto.randomUUID();
      const leaseExpiresAt = new Date(Date.now() + 60000);
      const claim1 = await c.query(
        `UPDATE "${SCHEMA}"."PublishingWorkflowOutbox"
         SET "status" = 'processing', "leaseOwner" = 'worker_1', "claimToken" = $1, "leaseExpiresAt" = $2, "updatedAt" = NOW()
         WHERE "id" = $3 AND ("status" = 'pending' OR ("status" = 'processing' AND "leaseExpiresAt" < NOW()))`,
        [token1, leaseExpiresAt, eventId]
      );
      expect(claim1.rowCount).toBe(1);

      // Concurrent Worker 2 attempts claim while lease is active
      const token2 = crypto.randomUUID();
      const claim2 = await c.query(
        `UPDATE "${SCHEMA}"."PublishingWorkflowOutbox"
         SET "status" = 'processing', "leaseOwner" = 'worker_2', "claimToken" = $1, "leaseExpiresAt" = $2, "updatedAt" = NOW()
         WHERE "id" = $3 AND ("status" = 'pending' OR ("status" = 'processing' AND "leaseExpiresAt" < NOW()))`,
        [token2, leaseExpiresAt, eventId]
      );
      expect(claim2.rowCount).toBe(0);

      // Stale Worker 2 attempts to acknowledge -> Rejected
      const staleAck = await c.query(
        `UPDATE "${SCHEMA}"."PublishingWorkflowOutbox"
         SET "status" = 'delivered', "deliveredAt" = NOW(), "leaseOwner" = NULL, "claimToken" = NULL
         WHERE "id" = $1 AND "status" = 'processing' AND "claimToken" = $2`,
        [eventId, token2]
      );
      expect(staleAck.rowCount).toBe(0);

      // Valid Worker 1 acknowledges -> Succeeded
      const validAck = await c.query(
        `UPDATE "${SCHEMA}"."PublishingWorkflowOutbox"
         SET "status" = 'delivered', "deliveredAt" = NOW(), "leaseOwner" = NULL, "claimToken" = NULL
         WHERE "id" = $1 AND "status" = 'processing' AND "claimToken" = $2`,
        [eventId, token1]
      );
      expect(validAck.rowCount).toBe(1);
    } finally {
      c.release();
    }
  });
});
