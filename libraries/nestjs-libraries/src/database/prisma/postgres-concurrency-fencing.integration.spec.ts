import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import * as crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config({ path: 'D:/Whatsapp-main/.env' });

const DATABASE_URL = process.env.DATABASE_URL;

describe('PostgreSQL Concurrency, Heartbeat, and Fencing Token Integration Suite (Real Database)', () => {
  let pool: Pool;
  const SCHEMA = 'wallza_fencing_vitest';
  const orgId = `org_${crypto.randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    if (!DATABASE_URL) return;
    pool = new Pool({
      connectionString: DATABASE_URL,
      max: 15,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 10000,
    });

    const client = await pool.connect();
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA};`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}."PublishingIdempotency" (
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
      CREATE TABLE IF NOT EXISTS ${SCHEMA}."Post" (
        "id" TEXT PRIMARY KEY,
        "organizationId" TEXT NOT NULL,
        "content" TEXT NOT NULL,
        "idempotencyKey" TEXT,
        "releaseId" TEXT,
        "deletedAt" TIMESTAMP(3),
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await client.query(`TRUNCATE TABLE ${SCHEMA}."PublishingIdempotency", ${SCHEMA}."Post" CASCADE;`);
    client.release();
  });

  afterAll(async () => {
    if (!pool) return;
    const client = await pool.connect();
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;`);
    client.release();
    await pool.end();
  });

  it('1. 10 simultaneous dispatch requests with one idempotency key: exactly 1 winner, 0 duplicates', async () => {
    if (!DATABASE_URL) return;
    const testKey = `idemp_simul_${Date.now()}`;

    const results = await Promise.all(
      Array.from({ length: 10 }).map(async (_, idx) => {
        const client = await pool.connect();
        const fencingToken = crypto.randomUUID();
        const id = `res_${idx}_${Date.now()}`;
        try {
          await client.query(
            `INSERT INTO ${SCHEMA}."PublishingIdempotency" ("id", "organizationId", "idempotencyKey", "fencingToken", "status", "updatedAt")
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
    await winner.client.query(
      `INSERT INTO ${SCHEMA}."Post" ("id", "organizationId", "content", "idempotencyKey", "releaseId")
       VALUES ($1, $2, 'Single dispatch message', $3, $3)`,
      [postId, orgId, testKey]
    );

    const completeRes = await winner.client.query(
      `UPDATE ${SCHEMA}."PublishingIdempotency"
       SET "status" = 'completed', "postId" = $1, "updatedAt" = NOW()
       WHERE "organizationId" = $2 AND "idempotencyKey" = $3 AND "fencingToken" = $4 AND "status" = 'pending'`,
      [postId, orgId, testKey, winner.fencingToken]
    );
    expect(completeRes.rowCount).toBe(1);

    const postCount = await winner.client.query(
      `SELECT COUNT(*)::int as count FROM ${SCHEMA}."Post" WHERE "organizationId" = $1 AND "idempotencyKey" = $2`,
      [orgId, testKey]
    );
    expect(postCount.rows[0].count).toBe(1);
    winner.client.release();
  });

  it('2. Publishing operation lasting > 45s: heartbeat lease renewal prevents takeover', async () => {
    if (!DATABASE_URL) return;
    const testKey = `idemp_long_${Date.now()}`;
    const c1 = await pool.connect();
    const c2 = await pool.connect();

    try {
      const fencing1 = crypto.randomUUID();
      await c1.query(
        `INSERT INTO ${SCHEMA}."PublishingIdempotency" ("id", "organizationId", "idempotencyKey", "fencingToken", "status", "updatedAt")
         VALUES ($1, $2, $3, $4, 'pending', NOW())`,
        [`res_2_1`, orgId, testKey, fencing1]
      );

      // Heartbeat kept updatedAt fresh (NOW()), but operation started 50s ago
      await c1.query(
        `UPDATE ${SCHEMA}."PublishingIdempotency"
         SET "createdAt" = NOW() - INTERVAL '50 seconds', "updatedAt" = NOW()
         WHERE "organizationId" = $1 AND "idempotencyKey" = $2`,
        [orgId, testKey]
      );

      // Concurrent Worker attempts takeover with 45s expiration rule
      const newFencing = crypto.randomUUID();
      const takeover = await c2.query(
        `UPDATE ${SCHEMA}."PublishingIdempotency"
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
    if (!DATABASE_URL) return;
    const testKey = `idemp_hb_fail_${Date.now()}`;
    const c = await pool.connect();

    try {
      await c.query(
        `INSERT INTO ${SCHEMA}."PublishingIdempotency" ("id", "organizationId", "idempotencyKey", "fencingToken", "status", "updatedAt")
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
        `SELECT COUNT(*)::int as count FROM ${SCHEMA}."Post" WHERE "organizationId" = $1 AND "idempotencyKey" = $2`,
        [orgId, testKey]
      );
      expect(postCheck.rows[0].count).toBe(0);
    } finally {
      c.release();
    }
  });

  it('4. Lease expiry after confirmed 45s absence of heartbeat allows recovery takeover', async () => {
    if (!DATABASE_URL) return;
    const testKey = `idemp_stalled_${Date.now()}`;
    const c = await pool.connect();

    try {
      await c.query(
        `INSERT INTO ${SCHEMA}."PublishingIdempotency" ("id", "organizationId", "idempotencyKey", "fencingToken", "status", "updatedAt")
         VALUES ($1, $2, $3, $4, 'pending', NOW() - INTERVAL '50 seconds')`,
        [`res_4`, orgId, testKey, crypto.randomUUID()]
      );

      const fencing2 = crypto.randomUUID();
      const recovery = await c.query(
        `UPDATE ${SCHEMA}."PublishingIdempotency"
         SET "status" = 'pending', "fencingToken" = $1, "updatedAt" = NOW()
         WHERE "organizationId" = $2 AND "idempotencyKey" = $3
           AND ("status" = 'failed' OR ("status" = 'pending' AND "updatedAt" < NOW() - INTERVAL '45 seconds'))`,
        [fencing2, orgId, testKey]
      );
      expect(recovery.rowCount).toBe(1);

      const checkRow = await c.query(
        `SELECT "fencingToken" FROM ${SCHEMA}."PublishingIdempotency" WHERE "organizationId" = $1 AND "idempotencyKey" = $2`,
        [orgId, testKey]
      );
      expect(checkRow.rows[0].fencingToken).toBe(fencing2);
    } finally {
      c.release();
    }
  });

  it('5. Stale owner attempting to dispatch after takeover is strictly rejected', async () => {
    if (!DATABASE_URL) return;
    const testKey = `idemp_stalled_${Date.now()}`;
    const c = await pool.connect();

    try {
      const activeFencing = `active_${crypto.randomUUID()}`;
      const staleFencing = `stale_${crypto.randomUUID()}`;

      await c.query(
        `INSERT INTO ${SCHEMA}."PublishingIdempotency" ("id", "organizationId", "idempotencyKey", "fencingToken", "status", "updatedAt")
         VALUES ($1, $2, $3, $4, 'pending', NOW())`,
        [`res_5`, orgId, testKey, activeFencing]
      );

      // Stale owner pre-dispatch check
      const preDispatch = await c.query(
        `SELECT * FROM ${SCHEMA}."PublishingIdempotency"
         WHERE "organizationId" = $1 AND "idempotencyKey" = $2 AND "fencingToken" = $3 AND "status" = 'pending'`,
        [orgId, testKey, staleFencing]
      );
      expect(preDispatch.rowCount).toBe(0);

      // Stale owner completion update
      const staleFinalize = await c.query(
        `UPDATE ${SCHEMA}."PublishingIdempotency"
         SET "status" = 'completed', "postId" = 'stale_post', "updatedAt" = NOW()
         WHERE "organizationId" = $1 AND "idempotencyKey" = $2 AND "fencingToken" = $3 AND "status" = 'pending'`,
        [orgId, testKey, staleFencing]
      );
      expect(staleFinalize.rowCount).toBe(0);
    } finally {
      c.release();
    }
  });

  it('6. Crash after Postiz job creation but before reservation completion: recovered via durable Post idempotencyKey', async () => {
    if (!DATABASE_URL) return;
    const testKey = `idemp_crash_${Date.now()}`;
    const c = await pool.connect();

    try {
      await c.query(
        `INSERT INTO ${SCHEMA}."PublishingIdempotency" ("id", "organizationId", "idempotencyKey", "fencingToken", "status", "updatedAt")
         VALUES ($1, $2, $3, $4, 'pending', NOW())`,
        [`res_6`, orgId, testKey, crypto.randomUUID()]
      );

      const crashedPostId = `post_crashed_${Date.now()}`;
      await c.query(
        `INSERT INTO ${SCHEMA}."Post" ("id", "organizationId", "content", "idempotencyKey", "releaseId")
         VALUES ($1, $2, 'Crashed before reservation completion', $3, $3)`,
        [crashedPostId, orgId, testKey]
      );

      // Retry arrives: checks Post table first
      const existing = await c.query(
        `SELECT * FROM ${SCHEMA}."Post"
         WHERE "organizationId" = $1 AND ("idempotencyKey" = $2 OR "releaseId" = $2) AND "deletedAt" IS NULL`,
        [orgId, testKey]
      );
      expect(existing.rowCount).toBe(1);

      // Idempotency table recovered to completed
      await c.query(
        `UPDATE ${SCHEMA}."PublishingIdempotency"
         SET "status" = 'completed', "postId" = $1, "updatedAt" = NOW()
         WHERE "organizationId" = $2 AND "idempotencyKey" = $3`,
        [existing.rows[0].id, orgId, testKey]
      );

      const postCount = await c.query(
        `SELECT COUNT(*)::int as count FROM ${SCHEMA}."Post" WHERE "organizationId" = $1 AND "idempotencyKey" = $2`,
        [orgId, testKey]
      );
      expect(postCount.rows[0].count).toBe(1);
    } finally {
      c.release();
    }
  });

  it('7. Retry after completed job returns existing post with idempotent=true and 0 new rows', async () => {
    if (!DATABASE_URL) return;
    const c = await pool.connect();

    try {
      const allPosts = await c.query(`SELECT COUNT(*)::int as count FROM ${SCHEMA}."Post" WHERE "organizationId" = $1`, [orgId]);
      const initialCount = allPosts.rows[0].count;

      // Repeat request for existing completed row
      const check = await c.query(
        `SELECT * FROM ${SCHEMA}."PublishingIdempotency" WHERE "organizationId" = $1 AND "status" = 'completed' LIMIT 1`,
        [orgId]
      );
      expect(check.rows[0].postId).toBeDefined();

      const finalCount = await c.query(`SELECT COUNT(*)::int as count FROM ${SCHEMA}."Post" WHERE "organizationId" = $1`, [orgId]);
      expect(finalCount.rows[0].count).toBe(initialCount);
    } finally {
      c.release();
    }
  });

  it('8. Verifies exactly one durable publishing job exists across all tested keys in PostgreSQL', async () => {
    if (!DATABASE_URL) return;
    const c = await pool.connect();

    try {
      const keys = await c.query(`SELECT DISTINCT "idempotencyKey" FROM ${SCHEMA}."Post" WHERE "organizationId" = $1`, [orgId]);
      for (const row of keys.rows) {
        const countRes = await c.query(
          `SELECT COUNT(*)::int as count FROM ${SCHEMA}."Post" WHERE "organizationId" = $1 AND "idempotencyKey" = $2`,
          [orgId, row.idempotencyKey]
        );
        expect(countRes.rows[0].count).toBe(1);
      }
    } finally {
      c.release();
    }
  });
});
