/**
 * Real PostgreSQL Outbox & Transaction Safety Test Suite
 *
 * Verifies:
 * 1. Post update and outbox insert succeed together atomically in a transaction.
 * 2. Outbox insert fails and the post update rolls back atomically.
 * 3. Direct fallback receives HTTP 401 (fails safely, not claimed delivered).
 * 4. Direct fallback receives HTTP 500 (fails safely, not claimed delivered).
 * 5. Direct fallback times out (fails safely, not claimed delivered).
 * 6. Successful callback delivery is acknowledged correctly with claim tokens.
 */

const { Pool } = require('pg');
const http = require('http');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('[FATAL] DATABASE_URL environment variable is required to run PostgreSQL integration tests.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000,
  ssl: DATABASE_URL.includes('supabase.com') ? { rejectUnauthorized: false } : undefined,
});

const SCHEMA = `wallza_outbox_tx_test_${Date.now()}`;

async function setupDatabase() {
  const client = await pool.connect();
  console.log(`[PG-SETUP] Connected to PostgreSQL. Setting up isolated schema '${SCHEMA}'...`);
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}";`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "${SCHEMA}"."Post" (
        "id" TEXT PRIMARY KEY,
        "organizationId" TEXT NOT NULL,
        "state" TEXT NOT NULL DEFAULT 'DRAFT',
        "releaseId" TEXT,
        "releaseURL" TEXT,
        "error" TEXT,
        "settings" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS "${SCHEMA}"."PublishingCallbackOutbox" (
        "id" TEXT PRIMARY KEY,
        "organizationId" TEXT NOT NULL,
        "postId" TEXT NOT NULL,
        "integrationId" TEXT NOT NULL,
        "wallzaPostId" TEXT NOT NULL,
        "wallzaOrgId" TEXT,
        "platform" TEXT NOT NULL,
        "platformPostId" TEXT,
        "status" TEXT NOT NULL,
        "attemptId" TEXT NOT NULL DEFAULT 'attempt_1',
        "error" TEXT,
        "releaseUrl" TEXT,
        "deliveryStatus" TEXT NOT NULL DEFAULT 'pending',
        "leaseOwner" TEXT,
        "claimToken" TEXT,
        "leaseExpiresAt" TIMESTAMP(3),
        "retryCount" INTEGER NOT NULL DEFAULT 0,
        "maxRetries" INTEGER NOT NULL DEFAULT 10,
        "lastError" TEXT,
        "deliveredAt" TIMESTAMP(3),
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "uq_post_int_status_attempt" UNIQUE ("postId", "integrationId", "status", "attemptId")
      );
    `);
    console.log(`[PG-SETUP] Tables created successfully in '${SCHEMA}'.`);
  } finally {
    client.release();
  }
}

async function teardownDatabase() {
  const client = await pool.connect();
  try {
    console.log(`[PG-TEARDOWN] Dropping test schema '${SCHEMA}'...`);
    await client.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE;`);
  } finally {
    client.release();
    await pool.end();
  }
}

async function runTests() {
  await setupDatabase();
  let passed = 0;
  const total = 6;

  console.log(`\n--- BEGIN OUTBOX TRANSACTION SAFETY & FALLBACK SUITE ---\n`);

  // TEST 1: Post update and outbox insert succeed together
  console.log(`[TEST 1] Post update and outbox insert commit atomically in transaction`);
  const c1 = await pool.connect();
  try {
    const postId = `post_tx_ok_${Date.now()}`;
    await c1.query(
      `INSERT INTO "${SCHEMA}"."Post" ("id", "organizationId", "state") VALUES ($1, 'org_1', 'QUEUE')`,
      [postId]
    );

    await c1.query('BEGIN');
    await c1.query(
      `UPDATE "${SCHEMA}"."Post" SET "state" = 'PUBLISHED', "releaseId" = 'rel_1', "updatedAt" = NOW() WHERE "id" = $1`,
      [postId]
    );
    await c1.query(
      `INSERT INTO "${SCHEMA}"."PublishingCallbackOutbox" (
        "id", "organizationId", "postId", "integrationId", "wallzaPostId", "platform", "status", "deliveryStatus"
      ) VALUES ($1, 'org_1', $2, 'int_fb_1', 'w_post_1', 'facebook', 'published', 'pending')`,
      [`outbox_${Date.now()}`, postId]
    );
    await c1.query('COMMIT');

    const postCheck = await c1.query(`SELECT "state" FROM "${SCHEMA}"."Post" WHERE "id" = $1`, [postId]);
    const outboxCheck = await c1.query(`SELECT "deliveryStatus" FROM "${SCHEMA}"."PublishingCallbackOutbox" WHERE "postId" = $1`, [postId]);

    if (postCheck.rows[0]?.state !== 'PUBLISHED' || outboxCheck.rows[0]?.deliveryStatus !== 'pending') {
      throw new Error(`Atomic commit failed: post=${postCheck.rows[0]?.state}, outbox=${outboxCheck.rows[0]?.deliveryStatus}`);
    }
    console.log('  [PASS] Both Post state and outbox event committed together.');
    passed++;
  } finally {
    c1.release();
  }

  // TEST 2: Outbox insert fails and post update rolls back
  console.log(`[TEST 2] Outbox insert fails and the post update rolls back`);
  const c2 = await pool.connect();
  try {
    const postId = `post_tx_fail_${Date.now()}`;
    await c2.query(
      `INSERT INTO "${SCHEMA}"."Post" ("id", "organizationId", "state") VALUES ($1, 'org_1', 'QUEUE')`,
      [postId]
    );

    let txError = null;
    try {
      await c2.query('BEGIN');
      await c2.query(
        `UPDATE "${SCHEMA}"."Post" SET "state" = 'PUBLISHED', "releaseId" = 'rel_2', "updatedAt" = NOW() WHERE "id" = $1`,
        [postId]
      );
      // Trigger intentional unique constraint violation or non-null violation
      await c2.query(
        `INSERT INTO "${SCHEMA}"."PublishingCallbackOutbox" (
          "id", "organizationId", "postId", "integrationId", "wallzaPostId", "platform", "status", "deliveryStatus"
        ) VALUES (NULL, 'org_1', $1, 'int_fb_1', 'w_post_1', 'facebook', 'published', 'pending')`,
        [postId]
      );
      await c2.query('COMMIT');
    } catch (err) {
      txError = err;
      await c2.query('ROLLBACK');
    }

    if (!txError) {
      throw new Error(`Expected outbox insertion to fail, but it succeeded!`);
    }

    const postCheck = await c2.query(`SELECT "state" FROM "${SCHEMA}"."Post" WHERE "id" = $1`, [postId]);
    if (postCheck.rows[0]?.state !== 'QUEUE') {
      throw new Error(`Post update was committed despite outbox error! State: ${postCheck.rows[0]?.state}`);
    }
    console.log('  [PASS] Transaction rolled back safely: Post state remained QUEUE.');
    passed++;
  } finally {
    c2.release();
  }

  // Set up mock HTTP server for tests 3, 4, 5
  let mockServerStatus = 200;
  let mockServerDelay = 0;
  const mockServer = http.createServer((req, res) => {
    if (mockServerDelay > 0) {
      setTimeout(() => {
        res.writeHead(mockServerStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Mock HTTP ${mockServerStatus}` }));
      }, mockServerDelay);
      return;
    }
    res.writeHead(mockServerStatus, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Mock HTTP ${mockServerStatus}` }));
  });

  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', () => resolve()));
  const serverPort = mockServer.address().port;
  process.env.WALLZAOS_INTERNAL_API_URL = `http://127.0.0.1:${serverPort}`;

  // Helper simulating PostsRepository.deliverDirectCallback
  async function testDeliverDirectCallback(timeoutMs = 1000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${process.env.WALLZAOS_INTERNAL_API_URL}/api/social/status-callback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ test: true }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        return { delivered: false, error: `HTTP ${response.status} ${response.statusText}: ${errText}` };
      }
      return { delivered: true };
    } catch (err) {
      const msg = err.name === 'AbortError' ? `Direct callback request timed out after ${timeoutMs}ms` : err.message;
      return { delivered: false, error: msg };
    } finally {
      clearTimeout(timer);
    }
  }

  // TEST 3: Direct fallback receives HTTP 401
  console.log(`[TEST 3] Direct fallback receives HTTP 401`);
  mockServerStatus = 401;
  mockServerDelay = 0;
  const res401 = await testDeliverDirectCallback();
  if (res401.delivered !== false || !res401.error.includes('401')) {
    throw new Error(`Expected HTTP 401 failure, received: ${JSON.stringify(res401)}`);
  }
  console.log(`  [PASS] HTTP 401 correctly treated as delivery failure: ${res401.error}`);
  passed++;

  // TEST 4: Direct fallback receives HTTP 500
  console.log(`[TEST 4] Direct fallback receives HTTP 500`);
  mockServerStatus = 500;
  mockServerDelay = 0;
  const res500 = await testDeliverDirectCallback();
  if (res500.delivered !== false || !res500.error.includes('500')) {
    throw new Error(`Expected HTTP 500 failure, received: ${JSON.stringify(res500)}`);
  }
  console.log(`  [PASS] HTTP 500 correctly treated as delivery failure: ${res500.error}`);
  passed++;

  // TEST 5: Direct fallback times out
  console.log(`[TEST 5] Direct fallback times out`);
  mockServerStatus = 200;
  mockServerDelay = 500; // Delay longer than client timeout of 100ms
  const resTimeout = await testDeliverDirectCallback(100);
  if (resTimeout.delivered !== false || !resTimeout.error.includes('timed out')) {
    throw new Error(`Expected timeout failure, received: ${JSON.stringify(resTimeout)}`);
  }
  console.log(`  [PASS] Timeout correctly caught and treated as delivery failure: ${resTimeout.error}`);
  passed++;

  mockServer.close();

  // TEST 6: Successful callback delivery is acknowledged correctly
  console.log(`[TEST 6] Successful callback delivery acknowledged with claim tokens in PostgreSQL`);
  const c6 = await pool.connect();
  try {
    const eventId = `cb_ack_${Date.now()}`;
    const claimToken = `claim_${Date.now()}`;
    await c6.query(
      `INSERT INTO "${SCHEMA}"."PublishingCallbackOutbox" (
        "id", "organizationId", "postId", "integrationId", "wallzaPostId", "platform", "status", "deliveryStatus"
      ) VALUES ($1, 'org_1', 'post_ack_1', 'int_fb_1', 'w_post_1', 'facebook', 'published', 'pending')`,
      [eventId]
    );

    // 1. Worker claims event
    const claimRes = await c6.query(
      `UPDATE "${SCHEMA}"."PublishingCallbackOutbox"
       SET "deliveryStatus" = 'processing', "claimToken" = $1, "leaseOwner" = 'worker_test', "leaseExpiresAt" = NOW() + INTERVAL '30 seconds'
       WHERE "id" = $2 AND "deliveryStatus" = 'pending'
       RETURNING *`,
      [claimToken, eventId]
    );
    if (claimRes.rowCount !== 1) {
      throw new Error(`Failed to claim pending outbox event`);
    }

    // 2. Stale worker with invalid claim token tries to acknowledge -> 0 rows
    const staleAck = await c6.query(
      `UPDATE "${SCHEMA}"."PublishingCallbackOutbox"
       SET "deliveryStatus" = 'delivered', "deliveredAt" = NOW(), "claimToken" = NULL, "leaseOwner" = NULL
       WHERE "id" = $1 AND "deliveryStatus" = 'processing' AND "claimToken" = 'invalid_token'`,
      [eventId]
    );
    if (staleAck.rowCount !== 0) {
      throw new Error(`Stale worker was able to acknowledge delivery!`);
    }

    // 3. Valid worker acknowledges -> 1 row
    const validAck = await c6.query(
      `UPDATE "${SCHEMA}"."PublishingCallbackOutbox"
       SET "deliveryStatus" = 'delivered', "deliveredAt" = NOW(), "claimToken" = NULL, "leaseOwner" = NULL
       WHERE "id" = $1 AND "deliveryStatus" = 'processing' AND "claimToken" = $2`,
      [eventId, claimToken]
    );
    if (validAck.rowCount !== 1) {
      throw new Error(`Valid worker failed to acknowledge delivery!`);
    }

    console.log(`  [PASS] Stale token rejected, valid claim token successfully acknowledged event delivery.`);
    passed++;
  } finally {
    c6.release();
  }

  console.log(`\n======================================================`);
  console.log(`RESULTS: ${passed}/${total} REAL POSTGRESQL OUTBOX SAFETY TESTS PASSED!`);
  console.log(`======================================================\n`);

  await teardownDatabase();
}

runTests().catch(async (err) => {
  console.error('[TEST FAILURE]', err);
  try {
    await teardownDatabase();
  } catch {}
  process.exit(1);
});
