export const MEDIA_RETENTION_HOURS = 72;
export const MEDIA_RETENTION_MS = MEDIA_RETENTION_HOURS * 60 * 60 * 1000;

export interface MediaRetentionPostReference {
  state: string;
  publishDate: Date;
  updatedAt: Date;
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

  // Drafts and scheduled/queued posts still need their media to be edited or
  // published. Keep them until the post is removed or reaches a terminal state.
  if (posts.some((post) => post.state === 'DRAFT' || post.state === 'QUEUE')) {
    return false;
  }

  // Unknown states fail closed. Published media gets 72 hours after the latest
  // publish date; failed media gets 72 hours after the latest retry/update.
  if (posts.some((post) => !['PUBLISHED', 'ERROR'].includes(post.state))) {
    return false;
  }

  const lastUse = posts.reduce((latest, post) => {
    const referenceTime =
      post.state === 'PUBLISHED'
        ? post.publishDate.getTime()
        : post.updatedAt.getTime();
    return Math.max(latest, referenceTime);
  }, createdAt.getTime());

  return now.getTime() >= lastUse + retentionMs;
}
