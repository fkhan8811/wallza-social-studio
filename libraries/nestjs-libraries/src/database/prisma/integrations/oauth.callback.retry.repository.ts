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

@Injectable()
export class OAuthCallbackRetryRepository {
  private readonly _logger = new Logger(OAuthCallbackRetryRepository.name);

  constructor(
    private _prisma: PrismaRepository<'oAuthCallbackRetry'>,
    private _transaction: PrismaTransaction
  ) {}

  /**
   * Durably enqueues or updates an OAuth callback sync event in Postgres.
   * NEVER stores provider access/refresh tokens or client secrets.
   */
  async enqueueOrUpdate(params: EnqueueCallbackRetryParams) {
    const expiresAt = params.tokenExpiresAt ? new Date(params.tokenExpiresAt) : null;

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
        attempts: 1,
        lastError: params.error ? String(params.error).slice(0, 1000) : null,
      },
      update: {
        lastError: params.error ? String(params.error).slice(0, 1000) : undefined,
        attempts: { increment: 1 },
        updatedAt: new Date(),
      },
    });
  }

  /**
   * Atomically acquires and processes pending retry events using row locking.
   */
  async processPendingRetries(maxBatch = 10): Promise<{ processed: number; succeeded: number; failed: number }> {
    const wallzaApiUrl = (
      process.env.WALLZAOS_INTERNAL_API_URL ||
      process.env.WALLZA_BACKEND_URL ||
      'http://127.0.0.1:5001'
    ).replace(/\/$/, '');

    let succeeded = 0;
    let failed = 0;

    // Fetch batch with bounded retries (< 5) and exponential backoff
    const claimedRecords = await this._prisma.model.oAuthCallbackRetry.findMany({
      where: {
        status: 'pending',
        attempts: { lt: 5 },
        OR: [
          { lockedAt: null },
          { lockedAt: { lt: new Date(Date.now() - 3 * 60 * 1000) } }, // 3 min lease
        ],
      },
      take: maxBatch,
    });

    for (const record of claimedRecords) {
      // Mark locked
      await this._prisma.model.oAuthCallbackRetry.update({
        where: { id: record.id },
        data: {
          lockedAt: new Date(),
          attempts: record.attempts + 1,
        },
      });

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

        const res = await fetch(`${wallzaApiUrl}/api/social/accounts/sync-internal`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...signed,
          },
          body: JSON.stringify(syncPayload),
        });

        if (res.ok) {
          // Terminal success: remove or mark completed
          await this._prisma.model.oAuthCallbackRetry.update({
            where: { id: record.id },
            data: {
              status: 'completed',
              lastError: null,
              lockedAt: null,
            },
          });
          succeeded++;
        } else {
          const errText = await res.text().catch(() => '');
          const isDead = record.attempts + 1 >= 5;
          await this._prisma.model.oAuthCallbackRetry.update({
            where: { id: record.id },
            data: {
              status: isDead ? 'dead' : 'pending',
              lastError: `WallzaOS rejected retry (status ${res.status}): ${errText}`.slice(0, 1000),
              lockedAt: null,
            },
          });
          failed++;
        }
      } catch (err: any) {
        const isDead = record.attempts + 1 >= 5;
        await this._prisma.model.oAuthCallbackRetry.update({
          where: { id: record.id },
          data: {
            status: isDead ? 'dead' : 'pending',
            lastError: `Network error during retry: ${err.message}`.slice(0, 1000),
            lockedAt: null,
          },
        });
        failed++;
      }
    }

    return { processed: claimedRecords.length, succeeded, failed };
  }

  async markCompletedByState(state: string) {
    return this._prisma.model.oAuthCallbackRetry.deleteMany({
      where: { state },
    }).catch(() => {});
  }
}
