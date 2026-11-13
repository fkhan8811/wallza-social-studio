-- Add tenant-scoped notification read tracking to UserOrganization
ALTER TABLE "UserOrganization" ADD COLUMN "lastReadNotifications" TIMESTAMP(3);

-- Add configurable approval requirements to Organization
ALTER TABLE "Organization" ADD COLUMN "requireApprovalForPublish" BOOLEAN NOT NULL DEFAULT false;

-- Add approval tracking and gate columns to Post
ALTER TABLE "Post" ADD COLUMN "requiresApproval" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Post" ADD COLUMN "approvalStatus" TEXT DEFAULT 'none';
ALTER TABLE "Post" ADD COLUMN "approvedById" TEXT;
ALTER TABLE "Post" ADD COLUMN "approvedAt" TIMESTAMP(3);

-- Create composite index for efficient approval-status and organization queries
CREATE INDEX "Post_organizationId_requiresApproval_approvalStatus_idx"
  ON "Post"("organizationId", "requiresApproval", "approvalStatus");
