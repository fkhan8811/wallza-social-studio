-- WallzaOS / Postiz OAuth bridge, tenant mapping, generation fencing and durable callback retry queue.
-- This migration is additive; it preserves the existing Social Studio schema and migrations.

ALTER TABLE "Organization"
  ADD COLUMN "wallzaOrgId" TEXT;

CREATE UNIQUE INDEX "Organization_wallzaOrgId_key"
  ON "Organization"("wallzaOrgId");

CREATE TABLE "SocialSyncGeneration" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "internalId" TEXT NOT NULL,
  "generation" INTEGER NOT NULL DEFAULT 1,
  "lastAction" TEXT NOT NULL DEFAULT 'upsert',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SocialSyncGeneration_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SocialSyncGeneration_organizationId_provider_internalId_key"
  ON "SocialSyncGeneration"("organizationId", "provider", "internalId");

CREATE INDEX "SocialSyncGeneration_organizationId_provider_internalId_idx"
  ON "SocialSyncGeneration"("organizationId", "provider", "internalId");

ALTER TABLE "SocialSyncGeneration"
  ADD CONSTRAINT "SocialSyncGeneration_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "OAuthCallbackRetry" (
  "id" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "wallzaOrgId" TEXT NOT NULL,
  "platform" TEXT NOT NULL,
  "accountName" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "avatarUrl" TEXT,
  "socialStudioIntegrationId" TEXT NOT NULL,
  "grantedScopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "tokenExpiresAt" TIMESTAMP(3),
  "category" TEXT NOT NULL DEFAULT 'major',
  "status" TEXT NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastError" TEXT,
  "lockedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OAuthCallbackRetry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OAuthCallbackRetry_state_key"
  ON "OAuthCallbackRetry"("state");

CREATE INDEX "OAuthCallbackRetry_status_nextAttemptAt_lockedAt_idx"
  ON "OAuthCallbackRetry"("status", "nextAttemptAt", "lockedAt");

CREATE INDEX "OAuthCallbackRetry_wallzaOrgId_platform_accountId_idx"
  ON "OAuthCallbackRetry"("wallzaOrgId", "platform", "accountId");

ALTER TABLE "OAuthCallbackRetry"
  ADD CONSTRAINT "OAuthCallbackRetry_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
