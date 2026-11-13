import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PublishingWorkflowOutboxService } from './publishing-workflow-outbox.service';

describe('PublishingWorkflowOutboxService — Durable Temporal Workflow Outbox & Fencing Claims', () => {
  let outboxService: PublishingWorkflowOutboxService;
  let mockPrisma: any;
  let mockTemporal: any;
  let outboxStore: Map<string, any>;
  let temporalWorkflows: Map<string, { status: string; startCount: number }>;

  beforeEach(() => {
    outboxStore = new Map();
    temporalWorkflows = new Map();

    mockPrisma = {
      publishingWorkflowOutbox: {
        findMany: vi.fn(async ({ where, take }: any) => {
          const all = Array.from(outboxStore.values());
          const filtered = all.filter((ev) => {
            if (where?.OR) {
              return where.OR.some((cond: any) => {
                if (cond.status === 'pending') return ev.status === 'pending';
                if (cond.status === 'processing' && cond.leaseExpiresAt?.lt) {
                  return (
                    ev.status === 'processing' &&
                    ev.leaseExpiresAt &&
                    ev.leaseExpiresAt < cond.leaseExpiresAt.lt
                  );
                }
                return false;
              });
            }
            return true;
          });
          return filtered.slice(0, take || 100);
        }),

        findUnique: vi.fn(async ({ where }: any) => {
          if (where?.postId_integrationId) {
            const key = `${where.postId_integrationId.postId}_${where.postId_integrationId.integrationId}`;
            return outboxStore.get(key) || null;
          }
          if (where?.id) {
            for (const v of outboxStore.values()) {
              if (v.id === where.id) return v;
            }
          }
          return null;
        }),

        update: vi.fn(async ({ where, data }: any) => {
          for (const [k, v] of outboxStore.entries()) {
            if (v.id === where.id) {
              const updated = { ...v, ...data, updatedAt: new Date() };
              outboxStore.set(k, updated);
              return updated;
            }
          }
          throw new Error(`Record ${where.id} not found`);
        }),

        updateMany: vi.fn(async ({ where, data }: any) => {
          let count = 0;
          for (const [k, v] of outboxStore.entries()) {
            if (v.id === where.id) {
              // Conditional check for status
              if (where.status && v.status !== where.status) {
                continue;
              }
              // Conditional check for claimToken
              if (where.claimToken && v.claimToken !== where.claimToken) {
                continue;
              }
              // Conditional check for leaseOwner
              if (where.leaseOwner && v.leaseOwner !== where.leaseOwner) {
                continue;
              }
              // Conditional check for OR (pending or expired processing)
              if (where.OR) {
                const matches = where.OR.some((cond: any) => {
                  if (cond.status === 'pending') return v.status === 'pending';
                  if (cond.status === 'processing') {
                    return (
                      v.status === 'processing' &&
                      v.leaseExpiresAt &&
                      v.leaseExpiresAt < cond.leaseExpiresAt?.lt
                    );
                  }
                  return false;
                });
                if (!matches) continue;
              }

              outboxStore.set(k, { ...v, ...data, updatedAt: new Date() });
              count++;
            }
          }
          return { count };
        }),

        upsert: vi.fn(async ({ where, create, update }: any) => {
          const key = `${where.postId_integrationId.postId}_${where.postId_integrationId.integrationId}`;
          const existing = outboxStore.get(key);
          if (existing) {
            const updated = { ...existing, ...update, updatedAt: new Date() };
            outboxStore.set(key, updated);
            return updated;
          }
          const created = {
            id: `outbox_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            ...create,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          outboxStore.set(key, created);
          return created;
        }),
      },
    };

    mockTemporal = {
      client: {
        getRawClient: vi.fn(() => ({
          workflow: {
            start: vi.fn(async (name: string, options: any) => {
              const wfId = options.workflowId;
              const existing = temporalWorkflows.get(wfId);
              if (existing && existing.status === 'RUNNING') {
                const err: any = new Error(
                  `Workflow execution already started: ${wfId}`
                );
                err.name = 'WorkflowExecutionAlreadyStartedError';
                throw err;
              }
              if (existing && existing.status === 'COMPLETED') {
                if (options.workflowIdReusePolicy === 'REJECT_DUPLICATE') {
                  const err: any = new Error(
                    `Workflow execution already completed and reuse policy rejects duplicates: ${wfId}`
                  );
                  err.name = 'WorkflowExecutionAlreadyStartedError';
                  throw err;
                }
              }
              temporalWorkflows.set(wfId, {
                status: 'RUNNING',
                startCount: (existing?.startCount || 0) + 1,
              });
              return { workflowId: wfId };
            }),
          },
        })),
        getWorkflowHandle: vi.fn(async (wfId: string) => {
          const existing = temporalWorkflows.get(wfId);
          if (!existing) {
            throw new Error('Workflow not found');
          }
          return {
            describe: vi.fn(async () => ({
              status: { name: existing.status },
            })),
          };
        }),
      },
    };

    outboxService = new PublishingWorkflowOutboxService(
      { model: mockPrisma } as any,
      mockTemporal as any
    );
  });

  it('1. Temporal unavailable during initial dispatch: outbox event created and preserved for retry', async () => {
    const events = await outboxService.insertEventsInTransaction(mockPrisma, [
      {
        organizationId: 'org_1',
        postId: 'post_1',
        integrationId: 'int_twitter',
        provider: 'twitter',
        state: 'QUEUE',
      },
    ]);
    expect(events.length).toBe(1);
    expect(events[0].status).toBe('pending');
    expect(events[0].retryCount).toBe(0);

    mockTemporal.client.getRawClient.mockReturnValueOnce({
      workflow: {
        start: vi.fn().mockRejectedValue(new Error('Temporal connection refused: 7233')),
      },
    });

    const claim = await outboxService.claimPendingEvents('worker_1');
    expect(claim.length).toBe(1);
    expect(claim[0].claimToken).toBeDefined();

    const delivery = await outboxService.deliverEvent(claim[0], claim[0].claimToken);
    expect(delivery.success).toBe(false);
    expect(delivery.error).toContain('Temporal connection refused');

    const stored = await mockPrisma.publishingWorkflowOutbox.findUnique({
      where: { postId_integrationId: { postId: 'post_1', integrationId: 'int_twitter' } },
    });
    expect(stored.status).toBe('pending');
    expect(stored.retryCount).toBe(1);
    expect(stored.leaseOwner).toBeNull();
    expect(stored.claimToken).toBeNull();
    expect(stored.lastError).toContain('Temporal connection refused');
  });

  it('2. Database committed but worker crashes before starting Temporal: recovered on worker restart', async () => {
    await outboxService.insertEventsInTransaction(mockPrisma, [
      {
        organizationId: 'org_1',
        postId: 'post_2',
        integrationId: 'int_linkedin',
        provider: 'linkedin',
        state: 'QUEUE',
      },
    ]);

    expect(temporalWorkflows.has('post_post_2_int_linkedin')).toBe(false);

    const result = await outboxService.processOutboxQueue('recovery_worker_1');
    expect(result.delivered).toBe(1);
    expect(result.failed).toBe(0);

    expect(temporalWorkflows.get('post_post_2_int_linkedin')?.status).toBe('RUNNING');
    const stored = await mockPrisma.publishingWorkflowOutbox.findUnique({
      where: { postId_integrationId: { postId: 'post_2', integrationId: 'int_linkedin' } },
    });
    expect(stored.status).toBe('delivered');
    expect(stored.deliveredAt).toBeDefined();
    expect(stored.leaseOwner).toBeNull();
  });

  it('3. Temporal accepts and completes workflow, then worker crashes before acknowledging: completed workflow is not restarted', async () => {
    const [event] = await outboxService.insertEventsInTransaction(mockPrisma, [
      {
        organizationId: 'org_1',
        postId: 'post_3',
        integrationId: 'int_facebook',
        provider: 'facebook',
        state: 'QUEUE',
      },
    ]);

    // Temporal accepted and COMPLETED workflow
    temporalWorkflows.set('post_post_3_int_facebook', { status: 'COMPLETED', startCount: 1 });

    // Worker crashed before updating outbox to 'delivered'; lease expired
    event.status = 'processing';
    event.leaseOwner = 'crashed_worker';
    event.claimToken = 'crashed_token_123';
    event.leaseExpiresAt = new Date(Date.now() - 600000);
    outboxStore.set('post_3_int_facebook', event);

    // Recovery worker claims the expired event
    const claimed = await outboxService.claimPendingEvents('recovery_worker_2');
    expect(claimed.length).toBe(1);
    expect(claimed[0].id).toBe(event.id);
    expect(claimed[0].claimToken).not.toBe('crashed_token_123'); // Brand new claim token!

    // Deliver checks Temporal describe(): status is COMPLETED -> safely acknowledges delivered without starting new workflow
    const delivery = await outboxService.deliverEvent(claimed[0], claimed[0].claimToken);
    expect(delivery.success).toBe(true);
    expect(delivery.acknowledged).toBe(true);

    // Crucial: Temporal workflow startCount was NOT incremented (remains 1, 0 duplicate publishes)
    expect(temporalWorkflows.get('post_post_3_int_facebook')?.startCount).toBe(1);

    const stored = await mockPrisma.publishingWorkflowOutbox.findUnique({
      where: { postId_integrationId: { postId: 'post_3', integrationId: 'int_facebook' } },
    });
    expect(stored.status).toBe('delivered');
  });

  it('4. Stale worker delivery attempt after lease takeover: acknowledgement is strictly rejected', async () => {
    const [event] = await outboxService.insertEventsInTransaction(mockPrisma, [
      {
        organizationId: 'org_1',
        postId: 'post_stale',
        integrationId: 'int_twitter',
        provider: 'twitter',
        state: 'QUEUE',
      },
    ]);

    // Worker 1 claims event
    const [claimedByWorker1] = await outboxService.claimPendingEvents('worker_1', 1, 1000);
    const worker1Token = claimedByWorker1.claimToken;
    expect(worker1Token).toBeDefined();

    // Worker 1 stalls; lease expires
    event.leaseExpiresAt = new Date(Date.now() - 5000);
    outboxStore.set('post_stale_int_twitter', {
      ...event,
      leaseOwner: 'worker_1',
      claimToken: worker1Token,
      leaseExpiresAt: new Date(Date.now() - 5000),
    });

    // Worker 2 takes over lease
    const [claimedByWorker2] = await outboxService.claimPendingEvents('worker_2', 1, 60000);
    expect(claimedByWorker2.claimToken).not.toBe(worker1Token);

    // Stale Worker 1 attempts to deliver and acknowledge using stale claim token
    const staleDelivery = await outboxService.deliverEvent(claimedByWorker1, worker1Token);
    expect(staleDelivery.acknowledged).toBe(false);
    expect(staleDelivery.error).toContain('Stale claim token');

    // Verify Worker 2 still owns the lease
    const stored = await mockPrisma.publishingWorkflowOutbox.findUnique({
      where: { postId_integrationId: { postId: 'post_stale', integrationId: 'int_twitter' } },
    });
    expect(stored.status).toBe('processing');
    expect(stored.leaseOwner).toBe('worker_2');
    expect(stored.claimToken).toBe(claimedByWorker2.claimToken);

    // Worker 2 delivers successfully
    const validDelivery = await outboxService.deliverEvent(claimedByWorker2, claimedByWorker2.claimToken);
    expect(validDelivery.acknowledged).toBe(true);

    const finalStored = await mockPrisma.publishingWorkflowOutbox.findUnique({
      where: { postId_integrationId: { postId: 'post_stale', integrationId: 'int_twitter' } },
    });
    expect(finalStored.status).toBe('delivered');
  });

  it('5. Intentional user-requested republish: uses distinct publishing attempt identity', async () => {
    // 1. Initial post completed
    const initial = await outboxService.startTemporalWorkflowIdempotent(
      'twitter',
      'post_repub',
      'org_1',
      'QUEUE',
      'int_twitter'
    );
    expect(initial.workflowId).toBe('post_post_repub_int_twitter');
    expect(temporalWorkflows.get(initial.workflowId)?.startCount).toBe(1);

    // 2. Mark initial as completed
    temporalWorkflows.set(initial.workflowId, { status: 'COMPLETED', startCount: 1 });

    // 3. User requests intentional republish with explicit attempt ID
    const republishAttemptId = 'attempt_2_user_opt_in';
    const repub = await outboxService.startTemporalWorkflowIdempotent(
      'twitter',
      'post_repub',
      'org_1',
      'QUEUE',
      'int_twitter',
      republishAttemptId
    );
    expect(repub.workflowId).toBe(`post_post_repub_int_twitter_repub_${republishAttemptId}`);
    expect(temporalWorkflows.get(repub.workflowId)?.startCount).toBe(1);
    expect(temporalWorkflows.get(initial.workflowId)?.startCount).toBe(1);
  });

  it('6. Multiple workers claiming concurrently: only 1 worker wins each event', async () => {
    await outboxService.insertEventsInTransaction(mockPrisma, [
      {
        organizationId: 'org_1',
        postId: 'post_concurrent',
        integrationId: 'int_tw',
        provider: 'twitter',
        state: 'QUEUE',
      },
    ]);

    // 5 concurrent workers try to claim the same pending event
    const claims = await Promise.all([
      outboxService.claimPendingEvents('worker_A', 1),
      outboxService.claimPendingEvents('worker_B', 1),
      outboxService.claimPendingEvents('worker_C', 1),
      outboxService.claimPendingEvents('worker_D', 1),
      outboxService.claimPendingEvents('worker_E', 1),
    ]);

    const winners = claims.filter((c) => c.length > 0);
    expect(winners.length).toBe(1);
    expect(winners[0][0].claimToken).toBeDefined();
  });
});
