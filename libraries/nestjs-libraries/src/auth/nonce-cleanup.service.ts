import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

@Injectable()
export class NonceCleanupService implements OnModuleInit {
  private readonly _logger = new Logger(NonceCleanupService.name);

  constructor(private readonly _prisma: PrismaService) {}

  onModuleInit() {
    // Run initial cleanup with brief delay on startup, and set recurring maintenance
    setTimeout(() => {
      this.cleanupExpiredNonces().catch(() => {});
    }, 5000);

    // Fallback interval to guarantee cleanup execution even if ScheduleModule is inactive
    setInterval(() => {
      this.cleanupExpiredNonces().catch(() => {});
    }, 30 * 60 * 1000).unref();
  }

  /**
   * Cleans up expired internal request nonces from persistent database store.
   * Keeps at least the full replay window (5-minute max clock skew) plus a 1-hour
   * safety retention buffer, guaranteeing that no nonce that could still be accepted
   * is ever deleted prematurely.
   */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async cleanupExpiredNonces(): Promise<number> {
    try {
      // 1-hour cutoff guarantees nonces within the 5-minute replay window are protected
      const cutoff = new Date(Date.now() - 60 * 60 * 1000);
      const res = await this._prisma.internalRequestNonce.deleteMany({
        where: {
          createdAt: {
            lt: cutoff,
          },
        },
      });

      if (res.count > 0) {
        this._logger.log(`[NonceCleanup] Removed ${res.count} expired HMAC nonces older than 1 hour.`);
      }
      return res.count;
    } catch (err: any) {
      this._logger.warn(`[NonceCleanup] Failed to prune expired nonces: ${err.message}`);
      return 0;
    }
  }
}
