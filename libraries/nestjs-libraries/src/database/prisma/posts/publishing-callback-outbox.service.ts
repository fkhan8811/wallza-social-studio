import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { signInternalRequest } from '@gitroom/nestjs-libraries/auth/internal-hmac.util';
import { v4 as uuidv4 } from 'uuid';

export interface CallbackOutboxEvent {
  id: string;
  organizationId: string;
  postId: string;
  integrationId: string;
  wallzaPostId: string;
  wallzaOrgId?: string | null;
  platform: string;
  platformPostId?: string | null;
  status: string; // 'published' | 'failed'
  attemptId?: string | null;
  error?: string | null;
  releaseUrl?: string | null;
  deliveryStatus: string; // 'pending' | 'processing' | 'delivered' | 'failed'
  leaseOwner?: string | null;
  claimToken?: string | null;
  leaseExpiresAt?: Date | null;
  retryCount: number;
  maxRetries: number;
  lastError?: string | null;
  deliveredAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class PublishingCallbackOutboxService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PublishingCallbackOutboxService.name);
  private readonly workerId = `cb_worker_${uuidv4()}`;
  private isShuttingDown = false;
  private isProcessing = false;
  private intervalTimer: any = null;

  constructor(private _post: PrismaRepository<'post'>) {}

  get prisma(): any {
    return (this._post as any).model;
  }

  onModuleInit() {
    this.logger.log(`[CallbackOutbox] Initializing callback background worker: ${this.workerId}`);

    // Initial drain after short startup delay (5s)
    setTimeout(() => {
      if (!this.isShuttingDown) {
        this.processCallbackQueue().catch((err) => {
          this.logger.error(`[CallbackOutbox] Error during initial callback drain: ${err.message}`);
        });
      }
    }, 5000);

    // Fallback interval (every 15s)
    this.intervalTimer = setInterval(() => {
      if (!this.isShuttingDown && !this.isProcessing) {
        this.processCallbackQueue().catch((err) => {
          this.logger.error(`[CallbackOutbox] Error in background interval run: ${err.message}`);
        });
      }
    }, 15000);

    if (this.intervalTimer.unref) {
      this.intervalTimer.unref();
    }
  }

  async onModuleDestroy() {
    this.logger.log(`[CallbackOutbox] Gracefully shutting down worker ${this.workerId}`);
    this.isShuttingDown = true;
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }

    try {
      if (this.prisma?.publishingCallbackOutbox?.updateMany) {
        const res = await this.prisma.publishingCallbackOutbox.updateMany({
          where: {
            leaseOwner: this.workerId,
            deliveryStatus: 'processing',
          },
          data: {
            deliveryStatus: 'pending',
            leaseOwner: null,
            claimToken: null,
            leaseExpiresAt: null,
            updatedAt: new Date(),
          },
        });
        if (res.count > 0) {
          this.logger.log(`[CallbackOutbox] Released ${res.count} processing callback events on shutdown.`);
        }
      }
    } catch (err: any) {
      this.logger.warn(`[CallbackOutbox] Error releasing callback worker leases during shutdown: ${err.message}`);
    }
  }

  @Cron(CronExpression.EVERY_30_SECONDS)
  async handleCronProcessing() {
    if (this.isShuttingDown || this.isProcessing) {
      return;
    }
    await this.processCallbackQueue();
  }

  /**
   * Enqueues a durable status callback event into PostgreSQL.
   * If an active tx is provided, inserts atomically inside that transaction.
   */
  async enqueueCallback(
    data: {
      organizationId: string;
      postId: string;
      integrationId: string;
      wallzaPostId: string;
      wallzaOrgId?: string | null;
      platform: string;
      platformPostId?: string | null;
      status: 'published' | 'failed';
      attemptId?: string | null;
      error?: string | null;
      releaseUrl?: string | null;
    },
    tx?: any
  ): Promise<any> {
    const client = tx || this.prisma;
    if (!client?.publishingCallbackOutbox) {
      throw new Error(
        '[CallbackOutbox] publishingCallbackOutbox model is not available in Prisma client. Status callback cannot be persisted.'
      );
    }

    const attemptId = data.attemptId || 'attempt_1';

    return client.publishingCallbackOutbox.upsert({
      where: {
        postId_integrationId_status_attemptId: {
          postId: data.postId,
          integrationId: data.integrationId,
          status: data.status,
          attemptId,
        },
      },
      create: {
        organizationId: data.organizationId,
        postId: data.postId,
        integrationId: data.integrationId,
        wallzaPostId: data.wallzaPostId,
        wallzaOrgId: data.wallzaOrgId || null,
        platform: data.platform,
        platformPostId: data.platformPostId || null,
        status: data.status,
        attemptId,
        error: data.error || null,
        releaseUrl: data.releaseUrl || null,
        deliveryStatus: 'pending',
        retryCount: 0,
        maxRetries: 10,
      },
      update: {
        deliveryStatus: 'pending',
        error: data.error || null,
        releaseUrl: data.releaseUrl || null,
        updatedAt: new Date(),
      },
    });
  }

  /**
   * Atomically claims pending or expired-lease callback events.
   */
  async claimPendingCallbacks(
    workerId: string = this.workerId,
    limit: number = 20,
    leaseDurationMs: number = 30000
  ): Promise<any[]> {
    const client = this.prisma;
    if (!client?.publishingCallbackOutbox) return [];

    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);

    const candidates = await client.publishingCallbackOutbox.findMany({
      where: {
        OR: [
          { deliveryStatus: 'pending' },
          {
            deliveryStatus: 'processing',
            leaseExpiresAt: { lt: now },
          },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });

    const claimed: any[] = [];
    for (const candidate of candidates) {
      if (candidate.retryCount >= candidate.maxRetries) {
        await client.publishingCallbackOutbox.update({
          where: { id: candidate.id },
          data: { deliveryStatus: 'failed', updatedAt: now },
        });
        continue;
      }

      const claimToken = uuidv4();
      const result = await client.publishingCallbackOutbox.updateMany({
        where: {
          id: candidate.id,
          OR: [
            { deliveryStatus: 'pending' },
            {
              deliveryStatus: 'processing',
              leaseExpiresAt: { lt: now },
            },
          ],
        },
        data: {
          deliveryStatus: 'processing',
          leaseOwner: workerId,
          claimToken,
          leaseExpiresAt,
          updatedAt: now,
        },
      });

      if (result.count === 1) {
        claimed.push({
          ...candidate,
          deliveryStatus: 'processing',
          leaseOwner: workerId,
          claimToken,
          leaseExpiresAt,
        });
      }
    }

    return claimed;
  }

  /**
   * Delivers a single claimed callback event to WallzaOS with HMAC signature.
   */
  async deliverCallback(event: any, claimToken: string): Promise<boolean> {
    if (!claimToken || typeof claimToken !== 'string') {
      throw new Error(`claimToken is mandatory for delivery of callback event ${event.id}`);
    }

    const client = this.prisma;
    const wallzaUrl =
      process.env.WALLZAOS_INTERNAL_API_URL ||
      process.env.WALLZAOS_API_URL ||
      process.env.MAIN_URL ||
      'http://localhost:5011';

    const payload = {
      organizationId: event.wallzaOrgId || event.organizationId,
      wallzaPostId: event.wallzaPostId,
      socialPostId: event.postId,
      integrationId: event.integrationId,
      platform: event.platform,
      platformPostId: event.platformPostId || null,
      status: event.status, // 'published' | 'failed'
      attemptId: event.attemptId || 'attempt_1',
      error: event.error || null,
      releaseUrl: event.releaseUrl || null,
      timestamp: new Date().toISOString(),
    };

    let signedHeaders: Record<string, string>;
    try {
      signedHeaders = signInternalRequest({
        method: 'POST',
        path: '/api/social/status-callback',
        audience: 'wallzaos',
        body: payload,
      });
    } catch (signErr: any) {
      this.logger.error(`[CallbackOutbox] HMAC signing failure for event ${event.id}: ${signErr.message}`);
      await this.recordDeliveryFailure(event, claimToken, `Signing error: ${signErr.message}`);
      return false;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const res = await fetch(`${wallzaUrl}/api/social/status-callback`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...signedHeaders,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (res.ok) {
        await this.acknowledgeDelivery(event.id, claimToken);
        this.logger.log(
          `[CallbackOutbox] Successfully delivered callback for event ${event.id} (wallzaPostId: ${event.wallzaPostId}, platform: ${event.platform}, status: ${event.status})`
        );
        return true;
      } else {
        const errorBody = await res.text().catch(() => res.statusText);
        throw new Error(`WallzaOS rejected status callback (HTTP ${res.status}): ${errorBody}`);
      }
    } catch (deliveryErr: any) {
      this.logger.warn(`[CallbackOutbox] Delivery failed for event ${event.id}: ${deliveryErr.message}`);
      await this.recordDeliveryFailure(event, claimToken, deliveryErr.message);
      return false;
    }
  }

  /**
   * Acknowledges delivery with claim token fencing check.
   */
  async acknowledgeDelivery(eventId: string, claimToken: string): Promise<boolean> {
    const client = this.prisma;
    const now = new Date();

    const result = await client.publishingCallbackOutbox.updateMany({
      where: {
        id: eventId,
        claimToken,
        deliveryStatus: 'processing',
      },
      data: {
        deliveryStatus: 'delivered',
        deliveredAt: now,
        lastError: null,
        leaseOwner: null,
        claimToken: null,
        leaseExpiresAt: null,
        updatedAt: now,
      },
    });

    return result.count === 1;
  }

  /**
   * Records delivery failure and schedules exponential retry or dead-letter fail.
   */
  async recordDeliveryFailure(event: any, claimToken: string, errorMsg: string): Promise<void> {
    const client = this.prisma;
    const now = new Date();
    const newRetryCount = (event.retryCount || 0) + 1;
    const isPermanent = newRetryCount >= (event.maxRetries || 10);

    const backoffSeconds = Math.min(Math.pow(2, newRetryCount) * 5, 3600);
    const nextLeaseExpiry = new Date(now.getTime() + backoffSeconds * 1000);

    await client.publishingCallbackOutbox.updateMany({
      where: {
        id: event.id,
        claimToken,
        deliveryStatus: 'processing',
      },
      data: {
        deliveryStatus: isPermanent ? 'failed' : 'pending',
        retryCount: newRetryCount,
        lastError: errorMsg,
        leaseOwner: null,
        claimToken: null,
        leaseExpiresAt: isPermanent ? null : nextLeaseExpiry,
        updatedAt: now,
      },
    });
  }

  /**
   * Process all pending callback events in queue.
   */
  async processCallbackQueue(): Promise<number> {
    if (this.isProcessing || this.isShuttingDown) return 0;
    this.isProcessing = true;
    let deliveredCount = 0;

    try {
      const claimed = await this.claimPendingCallbacks();
      for (const event of claimed) {
        if (this.isShuttingDown) break;
        const success = await this.deliverCallback(event, event.claimToken);
        if (success) deliveredCount++;
      }
    } catch (err: any) {
      this.logger.error(`[CallbackOutbox] Error during queue processing: ${err.message}`);
    } finally {
      this.isProcessing = false;
    }

    return deliveredCount;
  }
}
