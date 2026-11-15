import { Injectable } from '@nestjs/common';
import { PrismaRepository, PrismaTransaction } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

export interface GenerationCheckResult {
  allowed: boolean;
  currentGeneration: number;
  reason?: 'superseded' | 'replayed';
}

@Injectable()
export class SocialSyncGenerationRepository {
  constructor(
    private _prisma: PrismaRepository<'socialSyncGeneration'>,
    private _transaction: PrismaTransaction
  ) {}

  /**
   * Durably records and checks generation in Postgres using atomic upsert / transaction.
   * If incomingGeneration < currentGeneration, rejects as 'superseded'.
   * If incomingGeneration === currentGeneration and lastAction === incomingAction, permits as idempotent replay.
   * If incomingGeneration >= currentGeneration, advances generation and lastAction atomically.
   */
  async checkAndAdvanceGeneration(
    organizationId: string,
    provider: string,
    internalId: string,
    incomingGeneration: number,
    action: 'upsert' | 'disconnect'
  ): Promise<GenerationCheckResult> {
    const normProvider = provider.toLowerCase().trim();
    const safeGen = Math.max(1, Math.floor(incomingGeneration));

    // Run within transaction to serialize concurrent requests per account
    return this._transaction.model.$transaction(async (tx) => {
      const existing = await tx.socialSyncGeneration.findUnique({
        where: {
          organizationId_provider_internalId: {
            organizationId,
            provider: normProvider,
            internalId,
          },
        },
      });

      if (!existing) {
        await tx.socialSyncGeneration.create({
          data: {
            organizationId,
            provider: normProvider,
            internalId,
            generation: safeGen,
            lastAction: action,
          },
        });
        return { allowed: true, currentGeneration: safeGen };
      }

      if (safeGen < existing.generation) {
        return {
          allowed: false,
          currentGeneration: existing.generation,
          reason: 'superseded',
        };
      }

      if (safeGen === existing.generation && existing.lastAction === action) {
        // Idempotent retry of identical terminal state
        return {
          allowed: true,
          currentGeneration: existing.generation,
          reason: 'replayed',
        };
      }

      // Advance to newer generation or change action
      await tx.socialSyncGeneration.update({
        where: {
          id: existing.id,
        },
        data: {
          generation: safeGen,
          lastAction: action,
        },
      });

      return { allowed: true, currentGeneration: safeGen };
    });
  }

  async getGeneration(
    organizationId: string,
    provider: string,
    internalId: string
  ): Promise<number> {
    const record = await this._prisma.model.socialSyncGeneration.findUnique({
      where: {
        organizationId_provider_internalId: {
          organizationId,
          provider: provider.toLowerCase().trim(),
          internalId,
        },
      },
      select: { generation: true },
    });
    return record?.generation ?? 0;
  }
}

