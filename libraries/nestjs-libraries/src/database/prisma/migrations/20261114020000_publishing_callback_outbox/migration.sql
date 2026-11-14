-- CreateTable
CREATE TABLE IF NOT EXISTS "PublishingCallbackOutbox" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "wallzaPostId" TEXT NOT NULL,
    "wallzaOrgId" TEXT,
    "platform" TEXT NOT NULL,
    "platformPostId" TEXT,
    "status" TEXT NOT NULL,
    "attemptId" TEXT,
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
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PublishingCallbackOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "PublishingCallbackOutbox_postId_integrationId_status_attemptId_key" 
ON "PublishingCallbackOutbox"("postId", "integrationId", "status", "attemptId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PublishingCallbackOutbox_deliveryStatus_leaseExpiresAt_idx" 
ON "PublishingCallbackOutbox"("deliveryStatus", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PublishingCallbackOutbox_organizationId_deliveryStatus_idx" 
ON "PublishingCallbackOutbox"("organizationId", "deliveryStatus");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PublishingCallbackOutbox_wallzaPostId_idx" 
ON "PublishingCallbackOutbox"("wallzaPostId");

-- AddForeignKey
ALTER TABLE "PublishingCallbackOutbox" ADD CONSTRAINT "PublishingCallbackOutbox_organizationId_fkey" 
FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishingCallbackOutbox" ADD CONSTRAINT "PublishingCallbackOutbox_postId_fkey" 
FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishingCallbackOutbox" ADD CONSTRAINT "PublishingCallbackOutbox_integrationId_fkey" 
FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
