import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PublishingWorkflowOutboxService } from './publishing-workflow-outbox.service';

describe('PublishingWorkflowOutboxService — Durable Temporal Workflow Outbox', () => {
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
              const matchesPending = where.OR?.some((cond: any) => {
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
              if (matchesPending || where.status === v.status) {
                outboxStore.set(k, { ...v, ...data, updatedAt: new Date() });
                count++;
              }
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
    // 1. Transaction inserts outbox event
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

    // 2. Simulate Temporal network outage during initial dispatch
    mockTemporal.client.getRawClient.mockReturnValueOnce({
      workflow: {
        start: vi.fn().mockRejectedValue(new Error('Temporal connection refused: 7233')),
      },
    });

    // 3. Deliver attempt fails gracefully
    const claim = await outboxService.claimPendingEvents('worker_1');
    expect(claim.length).toBe(1);

    const delivery = await outboxService.deliverEvent(claim[0]);
    expect(delivery.success).toBe(false);
    expect(delivery.error).toContain('Temporal connection refused');

    // 4. Verify outbox state in DB: status reverted to pending, lease released, error recorded, retryCount=1
    const stored = await mockPrisma.publishingWorkflowOutbox.findUnique({
      where: { postId_integrationId: { postId: 'post_1', integrationId: 'int_twitter' } },
    });
    expect(stored.status).toBe('pending');
    expect(stored.retryCount).toBe(1);
    expect(stored.leaseOwner).toBeNull();
    expect(stored.lastError).toContain('Temporal connection refused');
  });

  it('2. Database committed but worker crashes before starting Temporal: recovered on worker restart', async () => {
    // 1. Outbox event was committed in DB during post creation
    await outboxService.insertEventsInTransaction(mockPrisma, [
      {
        organizationId: 'org_1',
        postId: 'post_2',
        integrationId: 'int_linkedin',
        provider: 'linkedin',
        state: 'QUEUE',
      },
    ]);

    // 2. Worker crashed immediately after DB commit (startWorkflow never invoked)
    expect(temporalWorkflows.has('post_post_2_int_linkedin')).toBe(false);

    // 3. Background worker starts up and processes outbox queue
    const result = await outboxService.processOutboxQueue('recovery_worker_1');
    expect(result.delivered).toBe(1);
    expect(result.failed).toBe(0);

    // 4. Temporal workflow is now running and outbox is marked delivered
    expect(temporalWorkflows.get('post_post_2_int_linkedin')?.status).toBe('RUNNING');
    const stored = await mockPrisma.publishingWorkflowOutbox.findUnique({
      where: { postId_integrationId: { postId: 'post_2', integrationId: 'int_linkedin' } },
    });
    expect(stored.status).toBe('delivered');
    expect(stored.deliveredAt).toBeDefined();
    expect(stored.leaseOwner).toBeNull();
  });

  it('3. Temporal accepts workflow but worker crashes before acknowledging: idempotent recovery', async () => {
    // 1. Outbox event was claimed by worker_A
    const [event] = await outboxService.insertEventsInTransaction(mockPrisma, [
      {
        organizationId: 'org_1',
        postId: 'post_3',
        integrationId: 'int_facebook',
        provider: 'facebook',
        state: 'QUEUE',
      },
    ]);

    // Temporal accepted workflow
    temporalWorkflows.set('post_post_3_int_facebook', { status: 'RUNNING', startCount: 1 });

    // Worker crashed before updating outbox to 'delivered'; lease expired 10 minutes ago
    event.status = 'processing';
    event.leaseOwner = 'crashed_worker';
    event.leaseExpiresAt = new Date(Date.now() - 600000);
    outboxStore.set('post_3_int_facebook', event);

    // 2. Recovery worker claims the expired event
    const claimed = await outboxService.claimPendingEvents('recovery_worker_2');
    expect(claimed.length).toBe(1);
    expect(claimed[0].id).toBe(event.id);

    // 3. Deliver checks Temporal: sees workflow already running, avoids duplicate start, marks delivered
    const delivery = await outboxService.deliverEvent(claimed[0]);
    expect(delivery.success).toBe(true);

    // Verify Temporal workflow was NOT restarted (startCount remains 1)
    expect(temporalWorkflows.get('post_post_3_int_facebook')?.startCount).toBe(1);

    const stored = await mockPrisma.publishingWorkflowOutbox.findUnique({
      where: { postId_integrationId: { postId: 'post_3', integrationId: 'int_facebook' } },
    });
    expect(stored.status).toBe('delivered');
  });

  it('4. Duplicate outbox delivery does not duplicate publishing workflows', async () => {
    // Start workflow initially
    await outboxService.startTemporalWorkflowIdempotent('twitter', 'post_dup', 'org_1', 'QUEUE');
    expect(temporalWorkflows.get('post_post_dup')?.startCount).toBe(1);

    // Repeated delivery call
    const secondCall = await outboxService.startTemporalWorkflowIdempotent(
      'twitter',
      'post_dup',
      'org_1',
      'QUEUE'
    );
    expect(secondCall.status).toBe('RUNNING');
    expect(temporalWorkflows.get('post_post_dup')?.startCount).toBe(1);
  });

  it('5. One platform workflow fails while another succeeds: independent recovery per integration', async () => {
    // Multi-platform post for Twitter and LinkedIn
    await outboxService.insertEventsInTransaction(mockPrisma, [
      {
        organizationId: 'org_1',
        postId: 'post_multi',
        integrationId: 'int_platform_A',
        provider: 'twitter',
        state: 'QUEUE',
      },
      {
        organizationId: 'org_1',
        postId: 'post_multi',
        integrationId: 'int_platform_B',
        provider: 'linkedin',
        state: 'QUEUE',
      },
    ]);

    // Claim both
    const claimed = await outboxService.claimPendingEvents('worker_multi');
    expect(claimed.length).toBe(2);

    const eventA = claimed.find((e) => e.integrationId === 'int_platform_A');
    const eventB = claimed.find((e) => e.integrationId === 'int_platform_B');

    // Deliver Platform A successfully
    const resA = await outboxService.deliverEvent(eventA);
    expect(resA.success).toBe(true);

    // Deliver Platform B with simulated Temporal failure
    mockTemporal.client.getRawClient.mockReturnValueOnce({
      workflow: {
        start: vi.fn().mockRejectedValue(new Error('Rate limit exceeded on Temporal namespace')),
      },
    });
    const resB = await outboxService.deliverEvent(eventB);
    expect(resB.success).toBe(false);

    // Verify Platform A is delivered and Platform B is pending retry
    const storedA = await mockPrisma.publishingWorkflowOutbox.findUnique({
      where: { postId_integrationId: { postId: 'post_multi', integrationId: 'int_platform_A' } },
    });
    const storedB = await mockPrisma.publishingWorkflowOutbox.findUnique({
      where: { postId_integrationId: { postId: 'post_multi', integrationId: 'int_platform_B' } },
    });

    expect(storedA.status).toBe('delivered');
    expect(storedB.status).toBe('pending');
    expect(storedB.retryCount).toBe(1);
    expect(storedB.lastError).toContain('Rate limit exceeded');
  });
});
