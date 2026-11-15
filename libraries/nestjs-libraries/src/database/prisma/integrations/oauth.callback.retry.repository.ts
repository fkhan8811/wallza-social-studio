import { Injectable, Logger } from '@nestjs/common';
import { PrismaRepository, PrismaTransaction } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { signInternalRequest } from '@gitroom/nestjs-libraries/auth/wallza.hmac';

export interface EnqueueCallbackRetryParams {
  state: string;
  organizationId: string;
  wallzaOrgId: string;
  platform: string;
  accountName: string;
  accountId: string;
  avatarUrl?: string | null;
  socialStudioIntegrationId: string;
  grantedScopes?: string[];
  tokenExpiresAt?: string | null;
  category?: string;
  error?: string;
}

const MAX_ATTEMPTS = 5;
const LEASE_MS = 3 * 60 * 1000;
const MAX_BATCH_SIZE = 50;

@Injectable()
export class OAuthCallbackRetryRepository {
  private readonly _logger = new Logger(OAuthCallbackRetryRepository.name);

  constructor(
    private _prisma: PrismaRepository<'oAuthCallbackRetry'>,
    private _transaction: PrismaTransaction
  ) {}

  private sanitizeError(value: unknown): string | null {
    if (!value) return null;
    return String(value)
      .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
      .replace(/(access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|password|authorization)\s*[:=]\s*["']?[^\s,"']+/gi, '$1=[REDACTED]')
      .replace(/https?:\/\/[^\s"'<>]+/gi, '[remote-url]')
      .replace(/[\r\n\t]+/g, ' ')
      .slice(0, 500);
  }

  /**
   * Stores only account identity and integration metadata. Provider secrets
   * and raw callback credentials must never be written to this table.
   */
  async enqueueOrUpdate(params: EnqueueCallbackRetryParams) {
    const parsedExpiry = params.tokenExpiresAt ? new Date(params.tokenExpiresAt) : null;
    const expiresAt = parsedExpiry && !Number.isNaN(parsedExpiry.getTime())
      ? parsedExpiry
      : null;

    return this._prisma.model.oAuthCallbackRetry.upsert({
      where: { state: params.state },
      create: {
        state: params.state,
        organizationId: params.organizationId,
        wallzaOrgId: params.wallzaOrgId,
        platform: params.platform,
        accountName: params.accountName,
        accountId: params.accountId,
        avatarUrl: params.avatarUrl || null,
        socialStudioIntegrationId: params.socialStudioIntegrationId,
        grantedScopes: params.grantedScopes || [],
        tokenExpiresAt: expiresAt,
        category: params.category || 'major',
        status: 'pending',
        attempts: 0,
        nextAttemptAt: new Date(),
        lockedAt: null,
        lastError: this.sanitizeError(params.error),
      },
      update: {
        accountName: params.accountName,
        accountId: params.accountId,
        avatarUrl: params.avatarUrl || null,
        socialStudioIntegrationId: params.socialStudioIntegrationId,
        grantedScopes: params.grantedScopes || [],
        tokenExpiresAt: expiresAt,
        category: params.category || 'major',
        lastError: this.sanitizeError(params.error),
        updatedAt: new Date(),
      },
    });
  }

  /**
   * Claims due events with FOR UPDATE SKIP LOCKED. The row lock and transition
   * to processing happen in one transaction, so multiple backend replicas
   * cannot deliver the same retry concurrently.
   */
  async processPendingRetries(maxBatch = 10): Promise<{ processed: number; succeeded: number; failed: number }> {
    const batchSize = Math.min(MAX_BATCH_SIZE, Math.max(1, Math.floor(maxBatch) || 1));
    const now = new Date();
    const leaseExpiredAt = new Date(now.getTime() - LEASE_MS);

    const claimedRecords = await this._transaction.model.$transaction(async (tx) => {
      // Recover attempts whose worker died after consuming the final attempt.
      await tx.oAuthCallbackRetry.updateMany({
        where: {
          attempts: { gte: MAX_ATTEMPTS },
          status: { in: ['pending', 'processing'] },
          OR: [
            { status: 'pending' },
            { lockedAt: null },
            { lockedAt: { lt: leaseExpiredAt } },
          ],
        },
        data: { status: 'dead', lockedAt: null },
      });

      const candidates = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "OAuthCallbackRetry"
        WHERE "attempts" < ${MAX_ATTEMPTS}
          AND (
            ("status" = 'pending' AND "nextAttemptAt" <= ${now})
            OR
            ("status" = 'processing' AND ("lockedAt" IS NULL OR "lockedAt" < ${leaseExpiredAt}))
          )
        ORDER BY "nextAttemptAt" ASC, "createdAt" ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      `;

      const ids = candidates.map((candidate) => candidate.id);
      if (!ids.length) return [];

      await tx.oAuthCallbackRetry.updateMany({
        where: { id: { in: ids } },
        data: {
          status: 'processing',
          lockedAt: now,
          attempts: { increment: 1 },
        },
      });

      return tx.oAuthCallbackRetry.findMany({
        where: { id: { in: ids }, status: 'processing', lockedAt: now },
      });
    });

    const wallzaApiUrl = (
      process.env.WALLZAOS_INTERNAL_API_URL ||
      process.env.WALLZA_BACKEND_URL ||
      'http://127.0.0.1:5001'
    ).replace(/\/$/, '');

    let succeeded = 0;
    let failed = 0;

    for (const record of claimedRecords) {
      const syncPayload = {
        organizationId: record.wallzaOrgId,
        platform: record.platform,
        accountName: record.accountName,
        accountId: record.accountId,
        avatarUrl: record.avatarUrl,
        socialStudioIntegrationId: record.socialStudioIntegrationId,
        grantedScopes: record.grantedScopes,
        tokenExpiresAt: record.tokenExpiresAt ? record.tokenExpiresAt.toISOString() : null,
        category: record.category,
      };

      try {
        const signed = signInternalRequest({
          method: 'POST',
          path: '/api/social/accounts/sync-internal',
          audience: 'wallzaos',
          body: syncPayload,
        });

        const response = await fetch(`${wallzaApiUrl}/api/social/accounts/sync-internal`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...signed,
          },
          body: JSON.stringify(syncPayload),
          signal: AbortSignal.timeout(15000),
        });

        if (response.ok) {
          await this._prisma.model.oAuthCallbackRetry.update({
            where: { id: record.id },
            data: {
              status: 'completed',
              lastError: null,
              lockedAt: null,
            },
          });
          succeeded++;
          continue;
        }

        // Do not persist arbitrary response bodies; they may contain secrets.
        await this.scheduleFailure(record.id, record.attempts, `WallzaOS returned HTTP ${response.status}`);
        failed++;
      } catch (error: any) {
        await this.scheduleFailure(record.id, record.attempts, error?.message || 'Network error');
        failed++;
      }
    }

    return { processed: claimedRecords.length, succeeded, failed };
  }

  private async scheduleFailure(id: string, attempts: number, reason: unknown) {
    const terminal = attempts >= MAX_ATTEMPTS;
    const exponentialDelay = Math.min(30 * 60 * 1000, 5000 * (2 ** Math.max(0, attempts - 1)));
    const jitter = Math.floor(Math.random() * Math.max(1, exponentialDelay * 0.2));

    await this._prisma.model.oAuthCallbackRetry.update({
      where: { id },
      data: {
        status: terminal ? 'dead' : 'pending',
        lockedAt: null,
        nextAttemptAt: new Date(Date.now() + exponentialDelay + jitter),
        lastError: this.sanitizeError(reason),
      },
    });

    if (terminal) {
      this._logger.warn(`OAuth callback retry exhausted for event ${id}`);
    }
  }

  async markCompletedByState(state: string) {
    return this._prisma.model.oAuthCallbackRetry.updateMany({
      where: { state },
      data: {
        status: 'completed',
        lockedAt: null,
        lastError: null,
      },
    });
  }
}
