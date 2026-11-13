-- 20261113220000_wallza_sso_and_sync
-- AlterTable User to add supabaseUserId unique mapping
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "supabaseUserId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "User_supabaseUserId_key" ON "User"("supabaseUserId");

-- AlterTable Organization to add supabaseOrgId unique mapping
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "supabaseOrgId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Organization_supabaseOrgId_key" ON "Organization"("supabaseOrgId");

