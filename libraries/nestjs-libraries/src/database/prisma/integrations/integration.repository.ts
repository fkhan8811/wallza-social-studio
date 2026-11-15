import { PrismaRepository, PrismaTransaction } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import dayjs from 'dayjs';
import { Integration, Prisma } from '@prisma/client';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import { IntegrationTimeDto } from '@gitroom/nestjs-libraries/dtos/integrations/integration.time.dto';
import { UploadFactory } from '@gitroom/nestjs-libraries/upload/upload.factory';
import { PlugDto } from '@gitroom/nestjs-libraries/dtos/plugs/plug.dto';

@Injectable()
export class IntegrationRepository {
  private storage = UploadFactory.createStorage();
  constructor(
    private _integration: PrismaRepository<'integration'>,
    private _posts: PrismaRepository<'post'>,
    private _plugs: PrismaRepository<'plugs'>,
    private _exisingPlugData: PrismaRepository<'exisingPlugData'>,
    private _customers: PrismaRepository<'customer'>,
    private _mentions: PrismaRepository<'mentions'>,
    private _transaction: PrismaTransaction
  ) {}

  getMentions(platform: string, q: string) {
    return this._mentions.model.mentions.findMany({
      where: {
        platform,
        OR: [
          {
            name: {
              contains: q,
              mode: 'insensitive',
            },
          },
          {
            username: {
              contains: q,
              mode: 'insensitive',
            },
          },
        ],
      },
      orderBy: {
        name: 'asc',
      },
      take: 100,
      select: {
        name: true,
        username: true,
        image: true,
      },
    });
  }

  insertMentions(
    platform: string,
    mentions: { name: string; username: string; image: string }[]
  ) {
    if (mentions.length === 0) {
      return [] as any[];
    }
    return this._mentions.model.mentions.createMany({
      data: mentions.map((mention) => ({
        platform,
        name: mention.name,
        username: mention.username,
        image: mention.image,
      })),
      skipDuplicates: true,
    });
  }

  async checkPreviousConnections(org: string, id: string) {
    // Deleted accounts keep their integrations with an md5 hashed
    // rootInternalId, so match both the raw id and its hash to still catch
    // channels that were connected by a deleted account.
    const findIt = await this._integration.model.integration.findMany({
      where: {
        rootInternalId: {
          in: [id, createHash('md5').update(id).digest('hex')],
        },
      },
      select: {
        organizationId: true,
        id: true,
      },
    });

    if (findIt.some((f) => f.organizationId === org)) {
      return false;
    }

    return findIt.length > 0;
  }

  updateProviderSettings(org: string, id: string, settings: string) {
    return this._integration.model.integration.update({
      where: {
        id,
        organizationId: org,
      },
      data: {
        additionalSettings: settings,
      },
    });
  }

  updateCustomName(org: string, id: string, name: string) {
    return this._integration.model.integration.update({
      select: {
        id: true,
      },
      where: {
        id,
        organizationId: org,
      },
      data: {
        customName: name.trim() || null,
      },
    });
  }

  async setTimes(org: string, id: string, times: IntegrationTimeDto) {
    return this._integration.model.integration.update({
      select: {
        id: true,
      },
      where: {
        id,
        organizationId: org,
      },
      data: {
        postingTimes: JSON.stringify(times.time),
      },
    });
  }

  getPlug(plugId: string) {
    return this._plugs.model.plugs.findFirst({
      where: {
        id: plugId,
      },
      include: {
        integration: true,
      },
    });
  }

  async getPlugs(orgId: string, integrationId: string) {
    return this._plugs.model.plugs.findMany({
      where: {
        integrationId,
        organizationId: orgId,
        activated: true,
      },
      include: {
        integration: {
          select: {
            id: true,
            providerIdentifier: true,
          },
        },
      },
    });
  }

  async updateIntegration(id: string, params: Partial<Integration>) {
    if (
      params.picture &&
      (params.picture.indexOf(process.env.CLOUDFLARE_BUCKET_URL!) === -1 ||
        params.picture.indexOf(process.env.FRONTEND_URL!) === -1)
    ) {
      params.picture = await this.storage.uploadSimple(params.picture);
    }

    const existing = await this._integration.model.integration.findUnique({
      where: {
        organizationId_internalId: {
          organizationId: params.organizationId!,
          internalId: params.internalId,
        },
      },
    });

    // The page was picked through a fresh login: the row that keeps living
    // must also take that login's identity and refresh token, otherwise the
    // next refresh runs as the old identity and cannot find the page.
    const fresh = existing
      ? await this._integration.model.integration.findUnique({
          where: { id },
          select: {
            rootInternalId: true,
            refreshToken: true,
            tokenExpiration: true,
          },
        })
      : null;

    if (existing) {
      await this._posts.model.post.updateMany({
        where: {
          integrationId: id,
        },
        data: {
          deletedAt: new Date(),
        },
      });

      await this._integration.model.integration.update({
        where: {
          id,
        },
        data: {
          internalId: `deleted_${params.internalId}_${makeId(10)}`,
          deletedAt: new Date(),
        },
      });
    }

    return this._integration.model.integration.update({
      where: {
        ...(existing ? { id: existing.id } : { id }),
      },
      data: {
        ...params,
        ...(fresh?.rootInternalId
          ? { rootInternalId: fresh.rootInternalId }
          : {}),
        ...(fresh?.refreshToken ? { refreshToken: fresh.refreshToken } : {}),
        ...(fresh?.tokenExpiration
          ? { tokenExpiration: fresh.tokenExpiration }
          : {}),
        disabled: false,
        deletedAt: null,
        refreshNeeded: false,
      },
    });
  }

  disconnectChannel(org: string, id: string) {
    return this._integration.model.integration.update({
      where: {
        id,
        organizationId: org,
      },
      data: {
        refreshNeeded: true,
      },
    });
  }

  getIntegrationByInternalId(org: string, internalId: string) {
    return this._integration.model.integration.findFirst({
      where: {
        organizationId: org,
        internalId,
        deletedAt: null,
      },
    });
  }

  // Moves a channel to another provider in place (MIGRATE_PROVIDERS): only the
  // provider and the app-scoped ids change, so the integration id - and with it
  // scheduled posts, settings and customers - survives the migration. The
  // follow-up createOrUpdateIntegration upsert matches the new internalId and
  // stores the fresh tokens.
  async migrateIntegration(
    org: string,
    id: string,
    internalId: string,
    providerIdentifier: string,
    rootInternalId: string
  ) {
    // A soft-deleted channel can still hold the target internalId
    // (deleteChannel keeps it): rename it out of the way like updateIntegration
    // does, otherwise the organizationId_internalId unique constraint rejects
    // the migration. Live channels are rejected by the service before this.
    const existing = await this._integration.model.integration.findUnique({
      where: {
        organizationId_internalId: {
          organizationId: org,
          internalId,
        },
      },
    });

    if (existing && existing.deletedAt) {
      await this._integration.model.integration.update({
        where: {
          id: existing.id,
        },
        data: {
          internalId: `deleted_${internalId}_${makeId(10)}`,
        },
      });
    }

    return this._integration.model.integration.update({
      where: {
        id,
        organizationId: org,
      },
      data: {
        internalId,
        providerIdentifier,
        rootInternalId,
      },
    });
  }

  /**
   * Serializes the generation decision and the Integration row mutation in
   * the SAME PostgreSQL transaction. This is the actual stale-write fence:
   * a lower generation cannot pass a check and then mutate after a newer
   * disconnect/reconnect has committed.
   */
  private async withGenerationFence<T>(
    organizationId: string,
    provider: string,
    internalId: string,
    generation: number,
    action: 'upsert' | 'disconnect',
    operation: (tx: Prisma.TransactionClient) => Promise<T>
  ): Promise<{
    allowed: boolean;
    currentGeneration: number;
    reason?: 'superseded' | 'replayed' | 'conflict' | 'invalid_generation';
    result?: T;
  }> {
    if (!Number.isSafeInteger(generation) || generation <= 0) {
      return { allowed: false, currentGeneration: 0, reason: 'invalid_generation' };
    }

    const normalizedProvider = provider.trim().toLowerCase();
    if (!normalizedProvider || !internalId.trim()) {
      throw new Error('A provider and internal account ID are required for generation fencing');
    }

    const maxAttempts = 5;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await this._transaction.model.$transaction(async (tx) => {
          const key = {
            organizationId_provider_internalId: {
              organizationId,
              provider: normalizedProvider,
              internalId,
            },
          };
          const current = await tx.socialSyncGeneration.findUnique({ where: key });

          if (current && generation < current.generation) {
            return {
              allowed: false,
              currentGeneration: current.generation,
              reason: 'superseded' as const,
            };
          }

          if (current && generation === current.generation && current.lastAction !== action) {
            return {
              allowed: false,
              currentGeneration: current.generation,
              reason: 'conflict' as const,
            };
          }

          if (!current) {
            await tx.socialSyncGeneration.create({
              data: {
                organizationId,
                provider: normalizedProvider,
                internalId,
                generation,
                lastAction: action,
              },
            });
          } else if (generation > current.generation) {
            await tx.socialSyncGeneration.update({
              where: { id: current.id },
              data: { generation, lastAction: action },
            });
          }

          // Same-generation/same-action replays run the operation again. This
          // makes failed writes retryable without allowing an opposite action.
          const result = await operation(tx);
          return {
            allowed: true,
            currentGeneration: generation,
            ...(current && generation === current.generation
              ? { reason: 'replayed' as const }
              : {}),
            result,
          };
        }, { isolationLevel: 'Serializable' });
      } catch (error: any) {
        const retryable = error?.code === 'P2034' || error?.code === 'P2002';
        if (!retryable || attempt === maxAttempts - 1) {
          throw error;
        }
        const delay = Math.min(400, 25 * (2 ** attempt)) + Math.floor(Math.random() * 30);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw new Error('Generation-fenced operation exhausted its transaction retries');
  }

  async deleteChannelWithGeneration(
    organizationId: string,
    provider: string,
    internalId: string,
    generation: number
  ) {
    return this.withGenerationFence(
      organizationId,
      provider,
      internalId,
      generation,
      'disconnect',
      (tx) => tx.integration.updateMany({
        where: { organizationId, internalId, deletedAt: null },
        data: { deletedAt: new Date() },
      })
    );
  }

  async createOrUpdateIntegration(
    additionalSettings:
      | {
          title: string;
          description: string;
          type: 'checkbox' | 'text' | 'textarea';
          value: any;
          regex?: string;
        }[]
      | undefined,
    oneTimeToken: boolean,
    org: string,
    name: string,
    picture: string | undefined,
    type: 'article' | 'social',
    internalId: string,
    provider: string,
    token: string,
    refreshToken = '',
    expiresIn = 999999999,
    username?: string,
    isBetweenSteps = false,
    refresh?: string,
    timezone?: number,
    customInstanceDetails?: string,
    generation?: number
  ) {
    const persist = async (db: any) => {
      const postTimes = timezone
        ? {
            postingTimes: JSON.stringify([
              { time: 560 - timezone },
              { time: 850 - timezone },
              { time: 1140 - timezone },
            ]),
          }
        : {};
      const upsert = await db.integration.upsert({
        where: {
          organizationId_internalId: {
            internalId,
            organizationId: org,
          },
        },
        create: {
          type: type as any,
          name,
          providerIdentifier: provider,
          token,
          profile: username,
          ...(picture ? { picture } : {}),
          inBetweenSteps: isBetweenSteps,
          refreshToken,
          ...(expiresIn
            ? { tokenExpiration: new Date(Date.now() + expiresIn * 1000) }
            : {}),
          internalId,
          ...postTimes,
          organizationId: org,
          refreshNeeded: false,
          rootInternalId: internalId,
          ...(customInstanceDetails ? { customInstanceDetails } : {}),
          additionalSettings: additionalSettings
            ? JSON.stringify(additionalSettings)
            : '[]',
        },
        update: {
          ...(additionalSettings
            ? { additionalSettings: JSON.stringify(additionalSettings) }
            : {}),
          ...(customInstanceDetails ? { customInstanceDetails } : {}),
          type: type as any,
          ...(!refresh
            ? {
                inBetweenSteps: isBetweenSteps,
              }
            : {}),
          ...(picture ? { picture } : {}),
          profile: username,
          providerIdentifier: provider,
          token,
          // never wipe a stored refresh token with an empty one
          ...(refreshToken ? { refreshToken } : {}),
          ...(expiresIn
            ? { tokenExpiration: new Date(Date.now() + expiresIn * 1000) }
            : {}),
          internalId,
          organizationId: org,
          deletedAt: null,
          refreshNeeded: false,
        },
      });

      if (oneTimeToken) {
        const rootId =
          (
            await db.integration.findFirst({
              where: {
                organizationId: org,
                internalId: internalId,
              },
            })
          )?.rootInternalId || internalId;

        await db.integration.updateMany({
          where: {
            id: {
              not: upsert.id,
            },
            rootInternalId: rootId,
          },
          data: {
            token,
            refreshToken,
            refreshNeeded: false,
            ...(expiresIn
              ? { tokenExpiration: new Date(Date.now() + expiresIn * 1000) }
              : {}),
          },
        });
      }

      return upsert;
    };

    if (generation !== undefined) {
      return this.withGenerationFence(
        org,
        provider,
        internalId,
        generation,
        'upsert',
        (tx) => persist(tx)
      );
    }

    return persist(this._integration.model);
  }
}
