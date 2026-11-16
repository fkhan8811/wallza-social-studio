-- Create recoverable, tenant-scoped Creative Studio project history.
CREATE UNIQUE INDEX "CreativeProject_id_organizationId_key"
  ON "CreativeProject"("id", "organizationId");

CREATE TABLE "CreativeProjectVersion" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "data" JSONB NOT NULL,
  "dimensions" JSONB NOT NULL,
  "thumbnailUrl" TEXT,
  "assetReferences" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdById" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreativeProjectVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CreativeProjectVersion_projectId_organizationId_version_key"
  ON "CreativeProjectVersion"("projectId", "organizationId", "version");

CREATE INDEX "CreativeProjectVersion_organizationId_projectId_createdAt_idx"
  ON "CreativeProjectVersion"("organizationId", "projectId", "createdAt");

ALTER TABLE "CreativeProjectVersion"
  ADD CONSTRAINT "CreativeProjectVersion_projectId_organizationId_fkey"
  FOREIGN KEY ("projectId", "organizationId")
  REFERENCES "CreativeProject"("id", "organizationId")
  ON DELETE CASCADE ON UPDATE CASCADE;
