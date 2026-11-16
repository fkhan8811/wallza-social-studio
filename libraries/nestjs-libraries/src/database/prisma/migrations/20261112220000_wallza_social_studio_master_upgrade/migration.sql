-- Wallza Social Studio — Master Upgrade Migration
-- Modules: Creative Studio Projects, Publishing Queues, Automation Rules, Post Templates, Dynamic Variables, Hashtag Groups

-- 1. Creative Studio Projects
CREATE TABLE IF NOT EXISTS "CreativeProject" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "dimensions" JSONB NOT NULL,
    "thumbnailUrl" TEXT,
    "assetReferences" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreativeProject_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "CreativeProject_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CreativeProject_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "CreativeProject_organizationId_updatedAt_idx" ON "CreativeProject"("organizationId", "updatedAt");
CREATE INDEX IF NOT EXISTS "CreativeProject_organizationId_type_idx" ON "CreativeProject"("organizationId", "type");

-- 2. Advanced Publishing Queues
CREATE TABLE IF NOT EXISTS "PublishingQueue" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "scheduleSlots" JSONB NOT NULL,
    "minSpacingMinutes" INTEGER NOT NULL DEFAULT 30,
    "capacityLimit" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PublishingQueue_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PublishingQueue_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "PublishingQueue_organizationId_isActive_idx" ON "PublishingQueue"("organizationId", "isActive");
CREATE INDEX IF NOT EXISTS "PublishingQueue_organizationId_isDefault_idx" ON "PublishingQueue"("organizationId", "isDefault");

-- 3. Automation Rules Engine
CREATE TABLE IF NOT EXISTS "AutomationRule" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "trigger" TEXT NOT NULL,
    "conditions" JSONB NOT NULL,
    "actions" JSONB NOT NULL,
    "executionCount" INTEGER NOT NULL DEFAULT 0,
    "lastExecutedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationRule_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AutomationRule_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "AutomationRule_organizationId_isActive_idx" ON "AutomationRule"("organizationId", "isActive");
CREATE INDEX IF NOT EXISTS "AutomationRule_organizationId_trigger_idx" ON "AutomationRule"("organizationId", "trigger");

-- 4. Post Templates
CREATE TABLE IF NOT EXISTS "PostTemplate" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'General',
    "content" TEXT NOT NULL,
    "platformVersions" JSONB,
    "mediaIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostTemplate_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PostTemplate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "PostTemplate_organizationId_category_idx" ON "PostTemplate"("organizationId", "category");
CREATE INDEX IF NOT EXISTS "PostTemplate_organizationId_updatedAt_idx" ON "PostTemplate"("organizationId", "updatedAt");

-- 5. Dynamic Variables
CREATE TABLE IF NOT EXISTS "DynamicVariable" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fallbackValue" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DynamicVariable_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DynamicVariable_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "DynamicVariable_organizationId_name_key" ON "DynamicVariable"("organizationId", "name");
CREATE INDEX IF NOT EXISTS "DynamicVariable_organizationId_idx" ON "DynamicVariable"("organizationId");

-- 6. Hashtag Groups
CREATE TABLE IF NOT EXISTS "HashtagGroup" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'General',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HashtagGroup_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "HashtagGroup_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "HashtagGroup_organizationId_category_idx" ON "HashtagGroup"("organizationId", "category");
CREATE INDEX IF NOT EXISTS "HashtagGroup_organizationId_updatedAt_idx" ON "HashtagGroup"("organizationId", "updatedAt");

