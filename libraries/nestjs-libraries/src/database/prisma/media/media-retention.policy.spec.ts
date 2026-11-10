import {
  isMediaEligibleForDeletion,
  MEDIA_RETENTION_MS,
} from './media-retention.policy';

describe('media retention policy', () => {
  const createdAt = new Date('2026-01-01T00:00:00.000Z');
  const after72Hours = new Date(createdAt.getTime() + MEDIA_RETENTION_MS + 1);

  it('expires an unused upload after 72 hours', () => {
    expect(isMediaEligibleForDeletion(createdAt, [], 0, after72Hours)).toBe(true);
  });

  it('keeps media before its 72-hour expiry', () => {
    expect(
      isMediaEligibleForDeletion(
        createdAt,
        [],
        0,
        new Date(createdAt.getTime() + MEDIA_RETENTION_MS - 1)
      )
    ).toBe(false);
  });

  it('keeps media referenced by drafts, queued posts, or failed posts', () => {
    for (const state of ['DRAFT', 'QUEUE', 'ERROR']) {
      expect(
        isMediaEligibleForDeletion(
          createdAt,
          [{ state, publishDate: createdAt }],
          0,
          after72Hours
        )
      ).toBe(false);
    }
  });

  it('keeps published media for 72 hours after its latest scheduled publish date', () => {
    const publishedAt = new Date('2026-01-05T00:00:00.000Z');
    expect(
      isMediaEligibleForDeletion(
        createdAt,
        [{ state: 'PUBLISHED', publishDate: publishedAt }],
        0,
        new Date(publishedAt.getTime() + MEDIA_RETENTION_MS - 1)
      )
    ).toBe(false);
    expect(
      isMediaEligibleForDeletion(
        createdAt,
        [{ state: 'PUBLISHED', publishDate: publishedAt }],
        0,
        new Date(publishedAt.getTime() + MEDIA_RETENTION_MS + 1)
      )
    ).toBe(true);
  });

  it('keeps media referenced by profile, integration, or idea records', () => {
    expect(isMediaEligibleForDeletion(createdAt, [], 1, after72Hours)).toBe(false);
  });
});
