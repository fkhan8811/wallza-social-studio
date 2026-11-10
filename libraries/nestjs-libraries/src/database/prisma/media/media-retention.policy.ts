export const MEDIA_RETENTION_HOURS = 72;
export const MEDIA_RETENTION_MS = MEDIA_RETENTION_HOURS * 60 * 60 * 1000;

export interface MediaRetentionPostReference {
  state: string;
  publishDate: Date;
}

export function isMediaEligibleForDeletion(
  createdAt: Date,
  posts: MediaRetentionPostReference[],
  permanentReferenceCount: number,
  now: Date,
  retentionMs = MEDIA_RETENTION_MS
): boolean {
  if (permanentReferenceCount > 0) {
    return false;
  }

  // Draft, queued, and failed posts may still need the original media to be
  // edited or retried. Never expire media while one of those posts references it.
  if (posts.some((post) => post.state !== 'PUBLISHED')) {
    return false;
  }

  const lastUse = posts.reduce(
    (latest, post) => Math.max(latest, post.publishDate.getTime()),
    createdAt.getTime()
  );

  return now.getTime() >= lastUse + retentionMs;
}
