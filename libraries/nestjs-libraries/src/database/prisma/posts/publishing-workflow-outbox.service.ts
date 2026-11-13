import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
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
export class PublishingWorkflowOutboxService {
  private readonly logger = new Logger(PublishingWorkflowOutboxService.name);

  constructor(
    private _post: PrismaRepository<'post'>,
    private _temporalService: TemporalService
  ) {}

  get prisma(): any {
    return (this._post as any).model;
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
   * Sets status to 'processing' with lease duration to prevent competing workers.
   */
  async claimPendingEvents(
    workerId: string = uuidv4(),
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

      // Atomically claim the candidate
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
          leaseExpiresAt,
          updatedAt: now,
        },
      });

      if (result.count === 1) {
        claimed.push({
          ...candidate,
          status: 'processing',
          leaseOwner: workerId,
          leaseExpiresAt,
        });
      }
    }

    return claimed;
  }

  /**
   * Idempotently starts the Temporal workflow for an outbox event.
   * Never terminates or restarts an already-running publishing workflow.
   */
  async startTemporalWorkflowIdempotent(
    provider: string,
    postId: string,
    organizationId: string,
    state: string,
    integrationId?: string
  ): Promise<{ workflowId: string; status: string }> {
    if (state === 'DRAFT') {
      return { workflowId: `post_${postId}`, status: 'DRAFT_SKIPPED' };
    }

    const workflowId = integrationId ? `post_${postId}_${integrationId}` : `post_${postId}`;

    // 1. Check if workflow is already running in Temporal
    const rawClient = this._temporalService?.client?.getRawClient?.();
    try {
      if (rawClient && this._temporalService?.client?.getWorkflowHandle) {
        try {
          const handle = await this._temporalService.client.getWorkflowHandle(workflowId);
          if (handle) {
            const desc = await handle.describe();
            if (desc?.status?.name === 'RUNNING') {
              this.logger.log(`[WorkflowOutbox] Workflow ${workflowId} is already RUNNING. Preserving active workflow.`);
              return { workflowId, status: 'RUNNING' };
            }
          }
        } catch {
          // Handle does not exist or workflow not yet created, proceed to start
        }
      }
    } catch {
      // Temporal describe error, proceed to start with conflict check
    }

    // 2. Start the workflow
    try {
      if (!rawClient?.workflow?.start) {
        throw new Error('Temporal client is not initialized or unavailable');
      }

      await rawClient.workflow.start('postWorkflowV112', {
        workflowId,
        taskQueue: 'main',
        workflowIdConflictPolicy: 'FAIL', // Strictly fail rather than terminate existing running workflow
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
      // 3. Handle already-started conflict as idempotent success
      const msg = err?.message || String(err);
      if (
        err?.name === 'WorkflowExecutionAlreadyStartedError' ||
        msg.includes('already started') ||
        msg.includes('Workflow execution already started') ||
        msg.includes('ALREADY_EXISTS')
      ) {
        this.logger.log(`[WorkflowOutbox] Workflow ${workflowId} already exists in Temporal. Idempotent delivery acknowledged.`);
        return { workflowId, status: 'RUNNING' };
      }

      // Re-throw genuine connection/network/service failures! Do NOT swallow!
      throw err;
    }
  }

  /**
   * Delivers a single claimed outbox event.
   * On success, marks status='delivered' with deliveredAt.
   * On failure, records the error, increments retry count, releases lease, and preserves event for retry.
   */
  async deliverEvent(event: any): Promise<{ success: boolean; error?: string }> {
    try {
      await this.startTemporalWorkflowIdempotent(
        event.provider,
        event.postId,
        event.organizationId,
        event.state || 'QUEUE',
        event.integrationId
      );

      // Acknowledge delivery in database
      await this.prisma.publishingWorkflowOutbox.update({
        where: { id: event.id },
        data: {
          status: 'delivered',
          deliveredAt: new Date(),
          leaseOwner: null,
          leaseExpiresAt: null,
          lastError: null,
          updatedAt: new Date(),
        },
      });

      return { success: true };
    } catch (err: any) {
      const errorMsg = err?.message || String(err);
      const nextRetry = (event.retryCount || 0) + 1;
      const isExhausted = nextRetry >= (event.maxRetries || 10);

      this.logger.error(
        `[WorkflowOutbox] Delivery failed for event ${event.id} (postId: ${event.postId}, try: ${nextRetry}): ${errorMsg}`
      );

      // Record failure, release lease, retain for retry
      await this.prisma.publishingWorkflowOutbox.update({
        where: { id: event.id },
        data: {
          status: isExhausted ? 'failed' : 'pending',
          retryCount: nextRetry,
          lastError: errorMsg,
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: new Date(),
        },
      });

      return { success: false, error: errorMsg };
    }
  }

  /**
   * Batch process to claim and deliver pending outbox events.
   * Can be triggered immediately post-commit or periodically by background workers.
   */
  async processOutboxQueue(
    workerId: string = uuidv4(),
    limit: number = 20
  ): Promise<{ delivered: number; failed: number }> {
    const events = await this.claimPendingEvents(workerId, limit);
    let delivered = 0;
    let failed = 0;

    for (const event of events) {
      const res = await this.deliverEvent(event);
      if (res.success) {
        delivered++;
      } else {
        failed++;
      }
    }

    return { delivered, failed };
  }
}
