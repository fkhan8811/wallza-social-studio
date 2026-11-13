-- CreateTable SocialLeadOutbox
CREATE TABLE "public"."SocialLeadOutbox" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "postId" TEXT,
    "commentId" TEXT,
    "authorName" TEXT NOT NULL,
    "authorHandle" TEXT,
    "content" TEXT NOT NULL,
    "permalink" TEXT,
    "leadNotes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "dispatchedAt" TIMESTAMP(3),
    "dispatchAttempts" INTEGER NOT NULL DEFAULT 0,
    "targetResponse" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialLeadOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SocialLeadOutbox_idempotencyKey_key" ON "public"."SocialLeadOutbox"("idempotencyKey");

-- CreateIndex
CREATE INDEX "SocialLeadOutbox_organizationId_status_idx" ON "public"."SocialLeadOutbox"("organizationId", "status");

-- CreateIndex
CREATE INDEX "SocialLeadOutbox_organizationId_platform_commentId_idx" ON "public"."SocialLeadOutbox"("organizationId", "platform", "commentId");

-- AddForeignKey
ALTER TABLE "public"."SocialLeadOutbox" ADD CONSTRAINT "SocialLeadOutbox_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

