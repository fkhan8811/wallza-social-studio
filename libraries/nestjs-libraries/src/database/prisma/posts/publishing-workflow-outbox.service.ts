import {
  Injectable,
  Logger,
  HttpException,
  HttpStatus,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { TemporalService } from 'nestjs-temporal-core';
import {
  organizationId as orgIdSearchParam,
  postId as postIdSearchParam,
} from '@gitroom/nestjs-libraries/temporal/temporal.search.attribute';
import { TypedSearchAttributes } from '@temporalio/common';
import { v4 as uuidv4 } from 'uuid';

export interface WorkflowOutboxEvent {
  id: string;
  organizationId: string;
  postId: string;
  integrationId: string;
  provider: string;
  workflowId: string;
  status: string; // 'pending' | 'processing' | 'delivered' | 'failed'
  leaseOwner?: string | null;
  claimToken?: string | null;
  leaseExpiresAt?: Date | null;
  retryCount: number;
  maxRetries: number;
  lastError?: string | null;
  state?: string | null;
  deliveredAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class PublishingWorkflowOutboxService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PublishingWorkflowOutboxService.name);
  private readonly workerId = `worker_${uuidv4()}`;
  private isShuttingDown = false;
  private isProcessing = false;
  private intervalTimer: any = null;

  constructor(
    private _post: PrismaRepository<'post'>,
    private _temporalService: TemporalService
  ) {}

  get prisma(): any {
    return (this._post as any).model;
  }

  onModuleInit() {
    this.logger.log(`[WorkflowOutbox] Initializing outbox background worker: ${this.workerId}`);

    // Initial drain after short startup delay (5s)
    setTimeout(() => {
      if (!this.isShuttingDown) {
        this.processOutboxQueue().catch((err) => {
          this.logger.error(`[WorkflowOutbox] Error during initial outbox drain: ${err.message}`);
        });
      }
    }, 5000);

    // Fallback interval to guarantee background recovery even if ScheduleModule is inactive (every 30s)
    this.intervalTimer = setInterval(() => {
      if (!this.isShuttingDown && !this.isProcessing) {
        this.processOutboxQueue().catch((err) => {
          this.logger.error(`[WorkflowOutbox] Error in background interval run: ${err.message}`);
        });
      }
    }, 30000);
    if (this.intervalTimer.unref) {
      this.intervalTimer.unref();
    }
  }

  async onModuleDestroy() {
    this.logger.log(`[WorkflowOutbox] Gracefully shutting down worker ${this.workerId}`);
    this.isShuttingDown = true;
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }

    // Release any active leases owned by this worker back to pending so events don't get stuck
    try {
      const res = await this.prisma.publishingWorkflowOutbox.updateMany({
        where: {
          leaseOwner: this.workerId,
          status: 'processing',
        },
        data: {
          status: 'pending',
          leaseOwner: null,
          claimToken: null,
          leaseExpiresAt: null,
          updatedAt: new Date(),
        },
      });
      if (res.count > 0) {
        this.logger.log(`[WorkflowOutbox] Released ${res.count} processing events on graceful shutdown.`);
      }
    } catch (err: any) {
      this.logger.warn(`[WorkflowOutbox] Error releasing worker leases during shutdown: ${err.message}`);
    }
  }

  /**
   * Periodic cron trigger (every 30 seconds) to recover pending or expired processing events.
   */
  @Cron(CronExpression.EVERY_30_SECONDS)
  async handleCronProcessing() {
    if (this.isShuttingDown || this.isProcessing) {
      return;
    }
    await this.processOutboxQueue();
  }

  /**
   * Inserts workflow outbox events inside an active Prisma database transaction.
   * Guarantees that Post rows and outbox events are committed atomically.
   */
  async insertEventsInTransaction(
    tx: any,
    events: Array<{
      organizationId: string;
      postId: string;
      integrationId: string;
      provider: string;
      state?: string;
    }>
  ): Promise<any[]> {
    const inserted: any[] = [];
    for (const ev of events) {
      const workflowId = `post_${ev.postId}_${ev.integrationId}`;
      const record = await tx.publishingWorkflowOutbox.upsert({
        where: {
          postId_integrationId: {
            postId: ev.postId,
            integrationId: ev.integrationId,
          },
        },
        create: {
          organizationId: ev.organizationId,
          postId: ev.postId,
          integrationId: ev.integrationId,
          provider: ev.provider,
          workflowId,
          status: 'pending',
          state: ev.state || 'QUEUE',
          retryCount: 0,
          maxRetries: 10,
        },
        update: {
          status: 'pending',
          leaseOwner: null,
          claimToken: null,
          leaseExpiresAt: null,
          state: ev.state || 'QUEUE',
          updatedAt: new Date(),
        },
      });
      inserted.push(record);
    }
    return inserted;
  }

  /**
   * Claims pending or expired-lease outbox events atomically.
   * Produces a unique claimToken per claim and sets status to 'processing' with a lease duration.
   */
  async claimPendingEvents(
    workerId: string = this.workerId,
    limit: number = 20,
    leaseDurationMs: number = 60000
  ): Promise<any[]> {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);

    // Find candidates eligible for claiming
    const candidates = await this.prisma.publishingWorkflowOutbox.findMany({
      where: {
        OR: [
          { status: 'pending' },
          {
            status: 'processing',
            leaseExpiresAt: { lt: now },
          },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });

    const claimed: any[] = [];
    for (const candidate of candidates) {
      // Don't claim if retries exhausted
      if (candidate.retryCount >= candidate.maxRetries) {
        await this.prisma.publishingWorkflowOutbox.update({
          where: { id: candidate.id },
          data: { status: 'failed', updatedAt: now },
        });
        continue;
      }

      const claimToken = uuidv4();

      // Atomically claim candidate with conditional updateMany
      const result = await this.prisma.publishingWorkflowOutbox.updateMany({
        where: {
          id: candidate.id,
          OR: [
            { status: 'pending' },
            {
              status: 'processing',
              leaseExpiresAt: { lt: now },
            },
          ],
        },
        data: {
          status: 'processing',
          leaseOwner: workerId,
          claimToken,
          leaseExpiresAt,
          updatedAt: now,
        },
      });

      if (result.count === 1) {
        claimed.push({
          ...candidate,
          status: 'processing',
          leaseOwner: workerId,
          claimToken,
          leaseExpiresAt,
        });
      }
    }

    return claimed;
  }

  /**
   * Atomically claims a specific outbox event by ID for immediate delivery.
   * Guarantees immediate delivery follows the exact same lease ownership and claim token protocol.
   */
  async claimEventById(
    eventId: string,
    workerId: string = this.workerId,
    leaseDurationMs: number = 60000
  ): Promise<any | null> {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);
    const claimToken = uuidv4();

    const result = await this.prisma.publishingWorkflowOutbox.updateMany({
      where: {
        id: eventId,
        OR: [
          { status: 'pending' },
          {
            status: 'processing',
            leaseExpiresAt: { lt: now },
          },
        ],
      },
      data: {
        status: 'processing',
        leaseOwner: workerId,
        claimToken,
        leaseExpiresAt,
        updatedAt: now,
      },
    });

    if (result.count === 1) {
      return this.prisma.publishingWorkflowOutbox.findUnique({
        where: { id: eventId },
      });
    }

    return null;
  }

  /**
   * Idempotently starts the Temporal workflow for an outbox event.
   * Configures workflowIdConflictPolicy: 'FAIL' and workflowIdReusePolicy: 'REJECT_DUPLICATE'.
   * Reconciles completed, running, failed, cancelled, and terminated executions separately.
   */
  async startTemporalWorkflowIdempotent(
    provider: string,
    postId: string,
    organizationId: string,
    state: string,
    integrationId?: string,
    republishAttemptId?: string
  ): Promise<{ workflowId: string; status: string }> {
    if (state === 'DRAFT') {
      return { workflowId: `post_${postId}`, status: 'DRAFT_SKIPPED' };
    }

    // Explicit publishing attempt identity used ONLY when intentional user-requested republish
    const baseWfId = integrationId ? `post_${postId}_${integrationId}` : `post_${postId}`;
    const workflowId = republishAttemptId ? `${baseWfId}_repub_${republishAttemptId}` : baseWfId;

    const rawClient = this._temporalService?.client?.getRawClient?.();

    // 1. Reconcile existing workflow execution status in Temporal
    try {
      if (rawClient && this._temporalService?.client?.getWorkflowHandle) {
        try {
          const handle = await this._temporalService.client.getWorkflowHandle(workflowId);
          if (handle) {
            const desc = await handle.describe();
            const statusName = desc?.status?.name;

            const statusStr = String(statusName || '');
            if (statusStr === 'COMPLETED') {
              this.logger.log(`[WorkflowOutbox] Workflow ${workflowId} already COMPLETED successfully. Deduplicating without republishing.`);
              return { workflowId, status: 'COMPLETED' };
            }

            if (statusStr === 'RUNNING') {
              this.logger.log(`[WorkflowOutbox] Workflow ${workflowId} is currently RUNNING. Preserving active workflow.`);
              return { workflowId, status: 'RUNNING' };
            }

            if (
              statusStr === 'FAILED' ||
              statusStr === 'TIMED_OUT' ||
              statusStr === 'CANCELLED' ||
              statusStr === 'CANCELED' ||
              statusStr === 'TERMINATED'
            ) {
              this.logger.warn(`[WorkflowOutbox] Workflow ${workflowId} exists with terminal state ${statusStr}.`);
              // Let Temporal start or conflict policy handle terminal retries if allowed, otherwise throw
            }
          }
        } catch {
          // Handle does not exist or workflow not yet created, proceed to start
        }
      }
    } catch {
      // Describe check error, proceed to start with conflict check
    }

    // 2. Start the workflow with strict duplicate rejection
    try {
      if (!rawClient?.workflow?.start) {
        throw new Error('Temporal client is not initialized or unavailable');
      }

      await rawClient.workflow.start('postWorkflowV112', {
        workflowId,
        taskQueue: 'main',
        workflowIdConflictPolicy: 'FAIL', // Never terminate active running workflows
        workflowIdReusePolicy: 'REJECT_DUPLICATE', // Strictly reject restarting duplicate completed workflows
        args: [
          {
            taskQueue: provider,
            postId,
            organizationId,
          },
        ],
        typedSearchAttributes: new TypedSearchAttributes([
          {
            key: postIdSearchParam,
            value: postId,
          },
          {
            key: orgIdSearchParam,
            value: organizationId,
          },
        ]),
      });

      this.logger.log(`[WorkflowOutbox] Started Temporal workflow ${workflowId} for post ${postId}`);
      return { workflowId, status: 'STARTED' };
    } catch (err: any) {
      // 3. Handle duplicate/already-started as idempotent success
      const msg = err?.message || String(err);
      if (
        err?.name === 'WorkflowExecutionAlreadyStartedError' ||
        msg.includes('already started') ||
        msg.includes('Workflow execution already started') ||
        msg.includes('ALREADY_EXISTS') ||
        msg.includes('Workflow execution already completed') ||
        msg.includes('WorkflowIdReusePolicy')
      ) {
        this.logger.log(`[WorkflowOutbox] Workflow ${workflowId} already exists in Temporal (${msg}). Idempotent acknowledgment.`);
        return { workflowId, status: 'RUNNING' };
      }

      // Re-throw genuine network/service/connection failures!
      throw err;
    }
  }

  /**
   * Delivers a single claimed outbox event.
   * Enforces that the claimToken matches the database state via conditional updateMany.
   * If claimToken is stale or lost, acknowledgment is strictly rejected.
   */
  async deliverEvent(
    event: any,
    claimToken?: string
  ): Promise<{ success: boolean; acknowledged: boolean; error?: string }> {
    const token = claimToken || event.claimToken;

    try {
      const dispatchRes = await this.startTemporalWorkflowIdempotent(
        event.provider,
        event.postId,
        event.organizationId,
        event.state || 'QUEUE',
        event.integrationId,
        event.republishAttemptId
      );

      // Acknowledge delivery conditionally based on matching id, status='processing', and claimToken
      const updateRes = await this.prisma.publishingWorkflowOutbox.updateMany({
        where: {
          id: event.id,
          status: 'processing',
          ...(token ? { claimToken: token } : {}),
        },
        data: {
          status: 'delivered',
          deliveredAt: new Date(),
          leaseOwner: null,
          claimToken: null,
          leaseExpiresAt: null,
          lastError: null,
          updatedAt: new Date(),
        },
      });

      if (updateRes.count === 0) {
        this.logger.warn(
          `[WorkflowOutbox] Stale worker acknowledgment rejected for event ${event.id}: lease lost or superseded.`
        );
        return { success: true, acknowledged: false, error: 'Stale claim token or lease lost' };
      }

      return { success: true, acknowledged: true };
    } catch (err: any) {
      const errorMsg = err?.message || String(err);
      const nextRetry = (event.retryCount || 0) + 1;
      const isExhausted = nextRetry >= (event.maxRetries || 10);

      this.logger.error(
        `[WorkflowOutbox] Delivery failed for event ${event.id} (postId: ${event.postId}, try: ${nextRetry}): ${errorMsg}`
      );

      // Record failure conditionally based on claimToken
      const updateRes = await this.prisma.publishingWorkflowOutbox.updateMany({
        where: {
          id: event.id,
          status: 'processing',
          ...(token ? { claimToken: token } : {}),
        },
        data: {
          status: isExhausted ? 'failed' : 'pending',
          retryCount: nextRetry,
          lastError: errorMsg,
          leaseOwner: null,
          claimToken: null,
          leaseExpiresAt: null,
          updatedAt: new Date(),
        },
      });

      return {
        success: false,
        acknowledged: updateRes.count > 0,
        error: errorMsg,
      };
    }
  }

  /**
   * Batch process to claim and deliver pending outbox events.
   * Can be triggered immediately post-commit or periodically by background workers.
   */
  async processOutboxQueue(
    workerId: string = this.workerId,
    limit: number = 20
  ): Promise<{ delivered: number; failed: number }> {
    if (this.isShuttingDown) {
      return { delivered: 0, failed: 0 };
    }

    this.isProcessing = true;
    try {
      const events = await this.claimPendingEvents(workerId, limit);
      let delivered = 0;
      let failed = 0;

      for (const event of events) {
        if (this.isShuttingDown) break;
        const res = await this.deliverEvent(event, event.claimToken);
        if (res.success && res.acknowledged) {
          delivered++;
        } else if (!res.success) {
          failed++;
        }
      }

      return { delivered, failed };
    } finally {
      this.isProcessing = false;
    }
  }
}
