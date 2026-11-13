-- CreateTable
CREATE TABLE "InternalRequestNonce" (
    "audience" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "timestamp" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InternalRequestNonce_pkey" PRIMARY KEY ("audience","nonce")
);

-- CreateIndex
CREATE INDEX "InternalRequestNonce_createdAt_idx" ON "InternalRequestNonce"("createdAt");

-- CreateTable
CREATE TABLE "PublishingIdempotency" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "postId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "fencingToken" TEXT,
    "response" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PublishingIdempotency_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PublishingIdempotency_organizationId_idempotencyKey_key" ON "PublishingIdempotency"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "PublishingIdempotency_organizationId_status_idx" ON "PublishingIdempotency"("organizationId", "status");

-- AddForeignKey
ALTER TABLE "PublishingIdempotency" ADD CONSTRAINT "PublishingIdempotency_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Add idempotencyKey column and indices to Post
ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;
CREATE INDEX IF NOT EXISTS "Post_organizationId_idempotencyKey_idx" ON "Post"("organizationId", "idempotencyKey");
CREATE UNIQUE INDEX IF NOT EXISTS "Post_organizationId_idempotencyKey_integrationId_key" ON "Post"("organizationId", "idempotencyKey", "integrationId");

-- Enable Row Level Security
ALTER TABLE "InternalRequestNonce" ENABLE ROW LEVEL SECURITY;

-- Explicitly revoke all permissions on InternalRequestNonce from PUBLIC, anon, and authenticated
REVOKE ALL ON TABLE "InternalRequestNonce" FROM PUBLIC;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON TABLE "InternalRequestNonce" FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON TABLE "InternalRequestNonce" FROM authenticated;
    END IF;
END $$;

-- Grant strictly to backend/service roles and postgres
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        GRANT ALL ON TABLE "InternalRequestNonce" TO service_role;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
        GRANT ALL ON TABLE "InternalRequestNonce" TO postgres;
    END IF;
END $$;

-- Restrictive RLS policy for service_role
DROP POLICY IF EXISTS "service_role_internal_nonces" ON "InternalRequestNonce";
CREATE POLICY "service_role_internal_nonces" ON "InternalRequestNonce"
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

-- Safe retention cleanup function for expired nonces (1-hour retention buffer safely covering 5-minute replay window)
CREATE OR REPLACE FUNCTION "cleanup_expired_internal_nonces"()
RETURNS integer AS $$
DECLARE
    deleted_count integer;
BEGIN
    DELETE FROM "InternalRequestNonce"
    WHERE "createdAt" < NOW() - INTERVAL '1 hour';
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Explicitly restrict execution of cleanup function
REVOKE ALL ON FUNCTION "cleanup_expired_internal_nonces"() FROM PUBLIC;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON FUNCTION "cleanup_expired_internal_nonces"() FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON FUNCTION "cleanup_expired_internal_nonces"() FROM authenticated;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        GRANT EXECUTE ON FUNCTION "cleanup_expired_internal_nonces"() TO service_role;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
        GRANT EXECUTE ON FUNCTION "cleanup_expired_internal_nonces"() TO postgres;
    END IF;
END $$;


