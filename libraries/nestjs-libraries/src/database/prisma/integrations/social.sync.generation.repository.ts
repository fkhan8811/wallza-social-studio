import { Injectable } from '@nestjs/common';
import { PrismaRepository, PrismaTransaction } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

export interface GenerationCheckResult {
  allowed: boolean;
  currentGeneration: number;
  reason?: 'superseded' | 'replayed' | 'conflict' | 'invalid_generation';
}

@Injectable()
export class SocialSyncGenerationRepository {
  constructor(
    private _prisma: PrismaRepository<'socialSyncGeneration'>,
    private _transaction: PrismaTransaction
  ) {}

  /**
   * Durably records and checks generation in Postgres using atomic transactional concurrency.
   * - Generation must be a positive safe integer (> 0).
   * - If incomingGeneration < currentGeneration, rejects as 'superseded'.
   * - If incomingGeneration === currentGeneration and lastAction === incomingAction, permits as idempotent replay.
   * - If incomingGeneration === currentGeneration and lastAction !== incomingAction, rejects as conflicting same-gen action.
   * - If incomingGeneration > currentGeneration, advances generation and lastAction atomically.
   */
  async checkAndAdvanceGeneration(
    organizationId: string,
    provider: string,
    internalId: string,
    incomingGeneration: number,
    action: 'upsert' | 'disconnect'
  ): Promise<GenerationCheckResult> {
    if (
      !Number.isSafeInteger(incomingGeneration) ||
      incomingGeneration <= 0
    ) {
      return {
        allowed: false,
        currentGeneration: 0,
        reason: 'invalid_generation',
      };
    }

    const normProvider = provider.toLowerCase().trim();
    const safeGen = incomingGeneration;

    // Retry loop for serialization failures or concurrent conflicts
    const maxRetries = 3;
    let attempt = 0;

    while (attempt < maxRetries) {
      attempt++;
      try {
        return await this._transaction.model.$transaction(async (tx) => {
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
            try {
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
            } catch (createErr: any) {
              // Unique constraint race condition: let outer retry loop re-read
              throw createErr;
            }
          }

          if (safeGen < existing.generation) {
            return {
              allowed: false,
              currentGeneration: existing.generation,
              reason: 'superseded',
            };
          }

          if (safeGen === existing.generation) {
            if (existing.lastAction === action) {
              // Idempotent retry of identical terminal state
              return {
                allowed: true,
                currentGeneration: existing.generation,
                reason: 'replayed',
              };
            }
            // Same generation conflict: action mismatch at identical version is forbidden
            return {
              allowed: false,
              currentGeneration: existing.generation,
              reason: 'conflict',
            };
          }

          // safeGen > existing.generation: Advance to strictly higher generation
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
        }, {
          isolationLevel: 'Serializable',
        });
      } catch (txErr: any) {
        if (attempt >= maxRetries) {
          throw txErr;
        }
        // Small exponential jitter delay on serialization collision
        await new Promise((r) => setTimeout(r, Math.random() * 20 + 10));
      }
    }

    return {
      allowed: false,
      currentGeneration: 0,
      reason: 'conflict',
    };
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

