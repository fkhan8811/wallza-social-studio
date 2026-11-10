import {
  isMediaEligibleForDeletion,
  MEDIA_RETENTION_MS,
} from './media-retention.policy';

describe('media retention policy', () => {
  const createdAt = new Date('2026-01-01T00:00:00.000Z');
  const after72Hours = new Date(createdAt.getTime() + MEDIA_RETENTION_MS + 1);
  const reference = (state: string, publishDate = createdAt, updatedAt = createdAt) => ({
    state,
    publishDate,
    updatedAt,
  });

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

  it('keeps media referenced by drafts and queued posts', () => {
    for (const state of ['DRAFT', 'QUEUE']) {
      expect(
        isMediaEligibleForDeletion(createdAt, [reference(state)], 0, after72Hours)
      ).toBe(false);
    }
  });

  it('keeps failed-post media for 72 hours after the latest retry/update', () => {
    const failedAt = new Date('2026-01-05T00:00:00.000Z');
    expect(
      isMediaEligibleForDeletion(
        createdAt,
        [reference('ERROR', createdAt, failedAt)],
        0,
        new Date(failedAt.getTime() + MEDIA_RETENTION_MS - 1)
      )
    ).toBe(false);
    expect(
      isMediaEligibleForDeletion(
        createdAt,
        [reference('ERROR', createdAt, failedAt)],
        0,
        new Date(failedAt.getTime() + MEDIA_RETENTION_MS + 1)
      )
    ).toBe(true);
  });

  it('keeps published media for 72 hours after its latest scheduled publish date', () => {
    const publishedAt = new Date('2026-01-05T00:00:00.000Z');
    expect(
      isMediaEligibleForDeletion(
        createdAt,
        [reference('PUBLISHED', publishedAt)],
        0,
        new Date(publishedAt.getTime() + MEDIA_RETENTION_MS - 1)
      )
    ).toBe(false);
    expect(
      isMediaEligibleForDeletion(
        createdAt,
        [reference('PUBLISHED', publishedAt)],
        0,
        new Date(publishedAt.getTime() + MEDIA_RETENTION_MS + 1)
      )
    ).toBe(true);
  });

  it('keeps media with permanent profile, integration, or idea references', () => {
    expect(isMediaEligibleForDeletion(createdAt, [], 1, after72Hours)).toBe(false);
  });

  it('fails closed for an unknown post state', () => {
    expect(
      isMediaEligibleForDeletion(createdAt, [reference('UNKNOWN')], 0, after72Hours)
    ).toBe(false);
  });
});
