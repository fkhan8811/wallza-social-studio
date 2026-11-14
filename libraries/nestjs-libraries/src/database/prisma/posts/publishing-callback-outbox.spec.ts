import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PublishingCallbackOutboxService } from './publishing-callback-outbox.service';

describe('PublishingCallbackOutboxService — Durable Status Callback Outbox & Fencing Claims', () => {
  let callbackOutboxService: PublishingCallbackOutboxService;
  let mockPrisma: any;
  let callbackEvents: Map<string, any>;

  beforeEach(() => {
    callbackEvents = new Map();

    mockPrisma = {
      publishingCallbackOutbox: {
        upsert: vi.fn().mockImplementation(({ where, create, update }: any) => {
          const key = `${create.postId}_${create.integrationId}_${create.status}_${create.attemptId}`;
          const existing = callbackEvents.get(key);
          if (existing) {
            const updated = { ...existing, ...update, updatedAt: new Date() };
            callbackEvents.set(key, updated);
            return Promise.resolve(updated);
          }
          const created = {
            id: `cb_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            ...create,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          callbackEvents.set(key, created);
          return Promise.resolve(created);
        }),
        findMany: vi.fn().mockImplementation(({ where }: any) => {
          const results: any[] = [];
          for (const ev of callbackEvents.values()) {
            if (ev.deliveryStatus === 'pending') {
              results.push(ev);
            } else if (
              ev.deliveryStatus === 'processing' &&
              ev.leaseExpiresAt &&
              new Date(ev.leaseExpiresAt).getTime() < Date.now()
            ) {
              results.push(ev);
            }
          }
          return Promise.resolve(results);
        }),
        updateMany: vi.fn().mockImplementation(({ where, data }: any) => {
          let count = 0;
          for (const [key, ev] of callbackEvents.entries()) {
            if (ev.id === where.id) {
              if (where.claimToken && ev.claimToken !== where.claimToken) {
                continue;
              }
              const updated = { ...ev, ...data };
              callbackEvents.set(key, updated);
              count++;
            }
          }
          return Promise.resolve({ count });
        }),
        update: vi.fn().mockImplementation(({ where, data }: any) => {
          for (const [key, ev] of callbackEvents.entries()) {
            if (ev.id === where.id) {
              const updated = { ...ev, ...data };
              callbackEvents.set(key, updated);
              return Promise.resolve(updated);
            }
          }
          return Promise.resolve(null);
        }),
      },
    };

    const mockPostRepo = {
      model: mockPrisma,
    } as any;

    callbackOutboxService = new PublishingCallbackOutboxService(mockPostRepo);
  });

  it('1. Atomically enqueues a status callback into PostgreSQL outbox with unique compound key', async () => {
    const enqueued = await callbackOutboxService.enqueueCallback({
      organizationId: 'org_1',
      postId: 'post_1',
      integrationId: 'int_facebook',
      wallzaPostId: 'wallza_uuid_100',
      platform: 'facebook',
      status: 'published',
      attemptId: 'attempt_1',
      releaseUrl: 'https://facebook.com/post/100',
    });

    expect(enqueued).toBeDefined();
    expect(enqueued.wallzaPostId).toBe('wallza_uuid_100');
    expect(enqueued.deliveryStatus).toBe('pending');
    expect(mockPrisma.publishingCallbackOutbox.upsert).toHaveBeenCalledTimes(1);
  });

  it('2. Claims pending events atomically with unique claim token and lease', async () => {
    await callbackOutboxService.enqueueCallback({
      organizationId: 'org_1',
      postId: 'post_2',
      integrationId: 'int_instagram',
      wallzaPostId: 'wallza_uuid_200',
      platform: 'instagram',
      status: 'failed',
      attemptId: 'attempt_1',
      error: 'Token expired',
    });

    const claimed = await callbackOutboxService.claimPendingCallbacks('worker_test', 10, 30000);
    expect(claimed.length).toBe(1);
    expect(claimed[0].deliveryStatus).toBe('processing');
    expect(claimed[0].claimToken).toBeDefined();
    expect(claimed[0].leaseOwner).toBe('worker_test');
  });

  it('3. Rejects delivery acknowledgment if lease or claimToken was superseded', async () => {
    const enqueued = await callbackOutboxService.enqueueCallback({
      organizationId: 'org_1',
      postId: 'post_3',
      integrationId: 'int_twitter',
      wallzaPostId: 'wallza_uuid_300',
      platform: 'twitter',
      status: 'published',
      attemptId: 'attempt_1',
    });

    const claimed = await callbackOutboxService.claimPendingCallbacks('worker_1', 10, 30000);
    const validClaimToken = claimed[0].claimToken;

    // Simulate stale acknowledgement with invalid/superseded claim token
    const ackResult = await callbackOutboxService.acknowledgeDelivery(enqueued.id, 'superseded_token');
    expect(ackResult).toBe(false);

    // Valid acknowledgment succeeds
    const validAck = await callbackOutboxService.acknowledgeDelivery(enqueued.id, validClaimToken);
    expect(validAck).toBe(true);
  });

  it('4. Schedules exponential backoff retry on delivery failure', async () => {
    await callbackOutboxService.enqueueCallback({
      organizationId: 'org_1',
      postId: 'post_4',
      integrationId: 'int_linkedin',
      wallzaPostId: 'wallza_uuid_400',
      platform: 'linkedin',
      status: 'failed',
      attemptId: 'attempt_1',
    });

    const claimed = await callbackOutboxService.claimPendingCallbacks('worker_1', 10, 30000);
    const event = claimed[0];

    await callbackOutboxService.recordDeliveryFailure(event, event.claimToken, 'Network timeout');

    const key = `${event.postId}_${event.integrationId}_${event.status}_${event.attemptId}`;
    const stored = callbackEvents.get(key);

    expect(stored.deliveryStatus).toBe('pending');
    expect(stored.retryCount).toBe(1);
    expect(stored.lastError).toBe('Network timeout');
  });
});
