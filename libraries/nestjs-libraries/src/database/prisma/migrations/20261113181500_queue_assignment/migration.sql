-- Allow posts to belong to a tenant-owned publishing queue.
ALTER TABLE "Post" ADD COLUMN "queueId" TEXT;

CREATE UNIQUE INDEX "PublishingQueue_id_organizationId_key"
  ON "PublishingQueue"("id", "organizationId");

CREATE INDEX "Post_queueId_organizationId_state_publishDate_idx"
  ON "Post"("queueId", "organizationId", "state", "publishDate");

ALTER TABLE "Post"
  ADD CONSTRAINT "Post_queueId_organizationId_fkey"
  FOREIGN KEY ("queueId", "organizationId")
  REFERENCES "PublishingQueue"("id", "organizationId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
