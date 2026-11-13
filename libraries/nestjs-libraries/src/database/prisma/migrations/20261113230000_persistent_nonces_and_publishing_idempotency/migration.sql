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

-- Explicitly lock down permissions on InternalRequestNonce
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON "InternalRequestNonce" FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON "InternalRequestNonce" FROM authenticated;
    END IF;
END $$;

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


