-- CreateUniqueIndex on Post(organizationId, idempotencyKey, integrationId)
CREATE UNIQUE INDEX IF NOT EXISTS "Post_organizationId_idempotencyKey_integrationId_key" ON "Post"("organizationId", "idempotencyKey", "integrationId");

-- CreateTable
CREATE TABLE IF NOT EXISTS "PublishingWorkflowOutbox" (
    "id" TEXT NOT NULL,
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
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PublishingWorkflowOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "PublishingWorkflowOutbox_postId_integrationId_key" ON "PublishingWorkflowOutbox"("postId", "integrationId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PublishingWorkflowOutbox_status_leaseExpiresAt_idx" ON "PublishingWorkflowOutbox"("status", "leaseExpiresAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PublishingWorkflowOutbox_organizationId_status_idx" ON "PublishingWorkflowOutbox"("organizationId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PublishingWorkflowOutbox_workflowId_idx" ON "PublishingWorkflowOutbox"("workflowId");

-- AddForeignKey
ALTER TABLE "PublishingWorkflowOutbox" ADD CONSTRAINT "PublishingWorkflowOutbox_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishingWorkflowOutbox" ADD CONSTRAINT "PublishingWorkflowOutbox_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishingWorkflowOutbox" ADD CONSTRAINT "PublishingWorkflowOutbox_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

