import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Req,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request } from 'express';
import * as crypto from 'crypto';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { verifyInternalRequestAsync } from '../auth/internal-hmac.util';
import { validateMediaUrlComprehensive } from '@gitroom/nestjs-libraries/upload/ssrf-media-validator';
import { SsrfMediaIngestionService } from '@gitroom/nestjs-libraries/upload/ssrf-media-ingestion.service';

function validatePostContent(caption: string, mediaUrls: string[], platforms: string[]): void {
  const trimmed = (caption || '').trim();
  if (!trimmed && mediaUrls.length === 0) {
    throw new HttpException(
      'Post must contain either text content or at least one media attachment.',
      HttpStatus.BAD_REQUEST
    );
  }

  for (const p of platforms) {
    const platform = p.toLowerCase();
    if ((platform === 'twitter' || platform === 'x') && trimmed.length > 280 && mediaUrls.length === 0) {
      throw new HttpException(
        `Post exceeds Twitter character limit (280 characters). Length: ${trimmed.length}`,
        HttpStatus.BAD_REQUEST
      );
    }
    if (platform === 'instagram') {
      if (trimmed.length > 2200) {
        throw new HttpException(
          `Post exceeds Instagram character limit (2200 characters). Length: ${trimmed.length}`,
          HttpStatus.BAD_REQUEST
        );
      }
      if (mediaUrls.length === 0) {
        throw new HttpException(
          'Instagram posts require at least one image or video attachment.',
          HttpStatus.BAD_REQUEST
        );
      }
    }
    if (platform === 'facebook' && trimmed.length > 63206) {
      throw new HttpException(
        `Post exceeds Facebook character limit. Length: ${trimmed.length}`,
        HttpStatus.BAD_REQUEST
      );
    }
  }
}

function validateScheduleParameters(type: 'now' | 'schedule', scheduledAt?: string): void {
  if (type === 'schedule') {
    if (!scheduledAt) {
      throw new HttpException('scheduledAt parameter is required for scheduled posts', HttpStatus.BAD_REQUEST);
    }
    const schedTime = new Date(scheduledAt).getTime();
    if (isNaN(schedTime)) {
      throw new HttpException('Invalid scheduledAt timestamp format. Expected ISO-8601.', HttpStatus.BAD_REQUEST);
    }
    const now = Date.now();
    if (schedTime < now + 60_000) {
      throw new HttpException(
        'Scheduled publishing time must be at least 1 minute in the future.',
        HttpStatus.BAD_REQUEST
      );
    }
    if (schedTime > now + 365 * 24 * 60 * 60 * 1000) {
      throw new HttpException(
        'Scheduled publishing time cannot be more than 1 year in advance.',
        HttpStatus.BAD_REQUEST
      );
    }
  }
}

@Controller('/integrations')
export class WallzaSyncController {
  constructor(
    private _prisma: PrismaService,
    private _integrationService: IntegrationService,
    private _postsService: PostsService,
    private _mediaIngestionService: SsrfMediaIngestionService
  ) {}

  @Get('/wallza-status')
  async getStatus(@Req() req: Request, @Query('organizationId') organizationId: string) {
    const auth = await verifyInternalRequestAsync(req, {
      expectedAudience: 'social-studio',
      prisma: this._prisma,
    });
    if (!auth.valid) {
      throw new HttpException(auth.error || 'Unauthorized internal request', HttpStatus.UNAUTHORIZED);
    }
    if (!organizationId) {
      throw new HttpException('organizationId query parameter required', HttpStatus.BAD_REQUEST);
    }

    const org = await this._prisma.organization.findUnique({
      where: { supabaseOrgId: organizationId },
      include: {
        Integration: {
          where: { deletedAt: null },
          select: {
            id: true,
            internalId: true,
            providerIdentifier: true,
            name: true,
            picture: true,
            disabled: true,
            tokenExpiration: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
    });

    if (!org) {
      return { organizationId, exists: false, integrations: [] };
    }

    return {
      organizationId,
      socialStudioOrgId: org.id,
      exists: true,
      integrations: org.Integration.map((i) => ({
        id: i.id,
        platform: i.providerIdentifier,
        internalId: i.internalId,
        accountName: i.name,
        avatarUrl: i.picture,
        isConnected: !i.disabled,
        tokenExpiresAt: i.tokenExpiration,
      })),
    };
  }

  @Post('/sync-from-wallza')
  async syncFromWallza(
    @Req() req: Request,
    @Body()
    body: {
      organizationId: string;
      userId: string;
      action: 'upsert' | 'disconnect';
      idempotencyKey?: string;
      connections: Array<{
        provider: string;
        internalId: string;
        rootInternalId?: string | null;
        name: string;
        picture?: string;
        token: string;
        type?: 'social' | 'article';
        scopes?: string[];
        expiresIn?: number;
      }>;
    }
  ) {
    const auth = await verifyInternalRequestAsync(req, {
      expectedAudience: 'social-studio',
      prisma: this._prisma,
    });
    if (!auth.valid) {
      throw new HttpException(auth.error || 'Unauthorized internal request', HttpStatus.UNAUTHORIZED);
    }

    const { organizationId, action, connections } = body || {};
    if (!organizationId || !action || !Array.isArray(connections)) {
      throw new HttpException(
        'Missing required sync parameters: organizationId, action, connections',
        HttpStatus.BAD_REQUEST
      );
    }

    // 1. Resolve or create Social Studio Organization
    const org = await this._prisma.organization.upsert({
      where: { supabaseOrgId: organizationId },
      create: {
        name: 'Wallza Workspace',
        supabaseOrgId: organizationId,
      },
      update: {},
    });

    const syncedResults: any[] = [];

    // 2. Process connections (per-account granularity, Requirement 10)
    for (const conn of connections) {
      if (action === 'upsert') {
        const expirationDate =
          typeof conn.expiresIn === 'number' && conn.expiresIn > 0
            ? new Date(Date.now() + conn.expiresIn * 1000)
            : null;

        const upserted = await this._prisma.integration.upsert({
          where: {
            organizationId_internalId: {
              organizationId: org.id,
              internalId: conn.internalId,
            },
          },
          create: {
            organizationId: org.id,
            internalId: conn.internalId,
            rootInternalId: conn.rootInternalId || null,
            name: conn.name,
            picture: conn.picture || null,
            providerIdentifier: conn.provider.toLowerCase(),
            type: conn.type || 'social',
            token: conn.token,
            disabled: false,
            deletedAt: null,
            tokenExpiration: expirationDate,
          },
          update: {
            name: conn.name,
            picture: conn.picture || undefined,
            rootInternalId: conn.rootInternalId || undefined,
            token: conn.token,
            disabled: false,
            deletedAt: null,
            tokenExpiration: expirationDate,
            updatedAt: new Date(),
          },
        });
        syncedResults.push({ id: upserted.id, provider: upserted.providerIdentifier, status: 'synced' });
      } else if (action === 'disconnect') {
        // Requirement 10: Specific per-account disconnect. Never disconnect other Pages!
        if (conn.internalId && conn.internalId !== 'all') {
          await this._prisma.integration.updateMany({
            where: {
              organizationId: org.id,
              providerIdentifier: conn.provider.toLowerCase(),
              internalId: conn.internalId,
            },
            data: {
              disabled: true,
              deletedAt: new Date(),
            },
          });
          syncedResults.push({ provider: conn.provider, internalId: conn.internalId, status: 'disconnected' });
        } else if (conn.internalId === 'all') {
          await this._prisma.integration.updateMany({
            where: {
              organizationId: org.id,
              providerIdentifier: conn.provider.toLowerCase(),
            },
            data: {
              disabled: true,
              deletedAt: new Date(),
            },
          });
          syncedResults.push({ provider: conn.provider, internalId: 'all', status: 'all_disconnected' });
        }
      }
    }

    return {
      success: true,
      action,
      organizationId,
      socialStudioOrgId: org.id,
      count: connections.length,
      results: syncedResults,
    };
  }

  @Post('/publishing/dispatch-from-wallza')
  async dispatchFromWallza(
    @Req() req: Request,
    @Body()
    body: {
      organizationId: string;
      caption: string;
      mediaUrls?: string[];
      platforms: string[];
      type: 'now' | 'schedule';
      scheduledAt?: string;
      idempotencyKey?: string;
      wallzaPostId?: string;
    }
  ) {
    const auth = await verifyInternalRequestAsync(req, {
      expectedAudience: 'social-studio',
      prisma: this._prisma,
    });
    if (!auth.valid) {
      throw new HttpException(auth.error || 'Unauthorized internal request', HttpStatus.UNAUTHORIZED);
    }

    const {
      organizationId,
      caption,
      mediaUrls = [],
      platforms = [],
      type = 'now',
      scheduledAt,
      idempotencyKey,
      wallzaPostId,
    } = body || {};

    if (!organizationId) {
      throw new HttpException('Missing organizationId', HttpStatus.BAD_REQUEST);
    }

    // 1. Dedicated SSRF-Protected Media Ingestion into Controlled Private Storage
    const isProduction = process.env.NODE_ENV === 'production';
    const ingestedMedia: { url: string; path: string }[] = [];
    for (const url of mediaUrls) {
      const validated = await validateMediaUrlComprehensive(url, {
        isProduction,
        checkHead: false, // Ingestion performs socket-level pinned download & verification
        timeoutMs: 5000,
      });

      const ingested = await this._mediaIngestionService.ingestMedia(validated.finalUrl, {
        isProduction,
        maxSizeBytes: 50 * 1024 * 1024,
        timeoutMs: 15000,
        connectTimeoutMs: 5000,
        maxRedirects: 3,
      });
      ingestedMedia.push({ url: ingested.url, path: ingested.path });
    }
    validatePostContent(caption, ingestedMedia.map((m) => m.url), platforms);
    validateScheduleParameters(type, scheduledAt);

    // 2. Organization and Integration Verification (Requirement 11)
    const org = await this._prisma.organization.findUnique({
      where: { supabaseOrgId: organizationId },
      include: {
        Integration: {
          where: { disabled: false, deletedAt: null },
        },
      },
    });

    if (!org) {
      throw new HttpException('Organization not found in Social Studio', HttpStatus.NOT_FOUND);
    }

    // Match integrations for requested platforms
    let targetIntegrations = org.Integration.filter((i) =>
      platforms.some(
        (p) =>
          p.toLowerCase() === i.providerIdentifier.toLowerCase() ||
          p.toLowerCase() === i.id.toLowerCase() ||
          p.toLowerCase() === i.internalId.toLowerCase()
      )
    );

    if (targetIntegrations.length === 0) {
      throw new HttpException(
        `No connected and active channels found for platforms: ${platforms.join(', ')}`,
        HttpStatus.BAD_REQUEST
      );
    }

    // Check token expiration for target integrations
    const now = Date.now();
    for (const integration of targetIntegrations) {
      if (integration.tokenExpiration && new Date(integration.tokenExpiration).getTime() < now) {
        throw new HttpException(
          `Channel '${integration.name}' (${integration.providerIdentifier}) access token has expired. Please re-authenticate.`,
          HttpStatus.BAD_REQUEST
        );
      }
    }

    // 3. Durable Post Level Check & Atomic Database-Backed Idempotency Reservation with Fencing
    const trackingKey = (idempotencyKey || wallzaPostId || '').trim();
    if (!trackingKey) {
      throw new HttpException(
        'Missing required idempotencyKey for publishing request. All internal publishing must be idempotent.',
        HttpStatus.BAD_REQUEST
      );
    }

    // Check if posts were already created in Postiz with this durable idempotencyKey
    const existingDurablePosts = await this._prisma.post.findMany({
      where: {
        organizationId: org.id,
        OR: [
          { idempotencyKey: trackingKey },
          { releaseId: trackingKey },
        ],
        deletedAt: null,
      },
    });

    if (existingDurablePosts.length > 0) {
      const existingIntegrationIds = new Set(existingDurablePosts.map((p) => p.integrationId));
      const missingIntegrations = targetIntegrations.filter(
        (ti) => !existingIntegrationIds.has(ti.id)
      );

      // If all requested channels already have posts created, return immediately!
      if (missingIntegrations.length === 0) {
        await this._prisma.publishingIdempotency.updateMany({
          where: {
            organizationId: org.id,
            idempotencyKey: trackingKey,
          },
          data: {
            postId: existingDurablePosts.map((p) => p.id).join(','),
            status: 'completed',
          },
        });

        return {
          success: true,
          message: 'Post already created in publishing engine (durable idempotency replay)',
          post: existingDurablePosts[0],
          posts: existingDurablePosts,
          channels: targetIntegrations.map((i) => ({
            id: i.id,
            name: i.name,
            platform: i.providerIdentifier,
          })),
          idempotent: true,
        };
      }

      // Partial multi-platform failure recovery: only dispatch missing integrations!
      targetIntegrations = missingIntegrations;
    }

    let fencingToken = crypto.randomUUID();
    let isReservationOwner = false;

    try {
      await this._prisma.publishingIdempotency.create({
        data: {
          organizationId: org.id,
          idempotencyKey: trackingKey,
          fencingToken,
          status: 'pending',
        },
      });
      isReservationOwner = true;
    } catch (err: any) {
      if (err?.code === 'P2002') {
        // Unique violation: another request created the record first.
        isReservationOwner = false;
      } else {
        // Database connection error, missing table, or DB unavailable: FAIL CLOSED!
        throw new HttpException(
          `Idempotency reservation failed: ${err.message || 'Database unavailable'}. Publishing aborted to prevent duplicate execution.`,
          HttpStatus.INTERNAL_SERVER_ERROR
        );
      }
    }

    if (!isReservationOwner) {
      // Lease and recovery mechanism:
      // Allow recovery ONLY after confirmed lease expiration (45 seconds) or explicit failure
      const LEASE_ABANDON_MS = 45_000;
      const expiredBefore = new Date(Date.now() - LEASE_ABANDON_MS);
      const newFencingToken = crypto.randomUUID();

      const takeover = await this._prisma.publishingIdempotency.updateMany({
        where: {
          organizationId: org.id,
          idempotencyKey: trackingKey,
          OR: [
            { status: 'failed' },
            { status: 'pending', updatedAt: { lt: expiredBefore } },
          ],
        },
        data: {
          status: 'pending',
          fencingToken: newFencingToken,
          updatedAt: new Date(),
        },
      });

      if (takeover.count > 0) {
        // Ownership recovered safely with new fencing token!
        isReservationOwner = true;
        fencingToken = newFencingToken;
      } else {
        // Another request actively owns the reservation. Poll for completion up to 5 seconds (10 * 500ms).
        let attempts = 0;
        let existingRecord = await this._prisma.publishingIdempotency.findUnique({
          where: {
            organizationId_idempotencyKey: {
              organizationId: org.id,
              idempotencyKey: trackingKey,
            },
          },
        });

        while (existingRecord && existingRecord.status === 'pending' && attempts < 10) {
          await new Promise((r) => setTimeout(r, 500));
          existingRecord = await this._prisma.publishingIdempotency.findUnique({
            where: {
              organizationId_idempotencyKey: {
                organizationId: org.id,
                idempotencyKey: trackingKey,
              },
            },
          });
          attempts++;
        }

        if (existingRecord?.status === 'completed' && existingRecord?.postId) {
          const completedIds = existingRecord.postId.split(',').filter(Boolean);
          const existingCompletedPosts = await this._prisma.post.findMany({
            where: { id: { in: completedIds } },
          });
          if (existingCompletedPosts.length > 0) {
            return {
              success: true,
              message: 'Post already dispatched/scheduled (atomic idempotent replay)',
              post: existingCompletedPosts[0],
              posts: existingCompletedPosts,
              channels: targetIntegrations.map((i) => ({
                id: i.id,
                name: i.name,
                platform: i.providerIdentifier,
              })),
              idempotent: true,
            };
          }
        }

        const fallbackPosts = await this._prisma.post.findMany({
          where: {
            organizationId: org.id,
            OR: [
              { idempotencyKey: trackingKey },
              { releaseId: trackingKey },
            ],
            deletedAt: null,
          },
        });
        if (fallbackPosts.length > 0) {
          return {
            success: true,
            message: 'Post already dispatched/scheduled (atomic idempotent replay)',
            post: fallbackPosts[0],
            posts: fallbackPosts,
            channels: targetIntegrations.map((i) => ({
              id: i.id,
              name: i.name,
              platform: i.providerIdentifier,
            })),
            idempotent: true,
          };
        }

        // When another request owns a pending reservation, DO NOT create another post!
        // Return a pending/retry response safely.
        if (existingRecord?.status === 'pending') {
          return {
            success: true,
            pending: true,
            message: 'Publishing operation is currently in progress by another request. Please retry shortly.',
            idempotent: true,
          };
        }

        if (existingRecord?.status === 'failed') {
          throw new HttpException(
            `Previous publishing attempt failed: ${existingRecord.response || 'Unknown error'}. Please retry to recover.`,
            HttpStatus.BAD_GATEWAY
          );
        }

        return {
          success: true,
          pending: true,
          message: 'Publishing operation in progress. Please retry shortly.',
          idempotent: true,
        };
      }
    }

    // 4. Dispatch via Postiz native PostsService with Heartbeat Lease Renewal & Fencing Verification
    let isLeaseLost = false;
    let heartbeat: NodeJS.Timeout | null = null;
    if (isReservationOwner) {
      heartbeat = setInterval(async () => {
        try {
          const hbResult = await this._prisma.publishingIdempotency.updateMany({
            where: {
              organizationId: org.id,
              idempotencyKey: trackingKey,
              fencingToken,
              status: 'pending',
            },
            data: {
              updatedAt: new Date(),
            },
          });
          if (hbResult.count === 0) {
            isLeaseLost = true;
            console.warn(`[WallzaSync] Heartbeat detected lost lease for key ${trackingKey}.`);
          }
        } catch (hbErr) {
          // Database error / connection outage: treat as lost lease ownership!
          isLeaseLost = true;
          console.error(`[WallzaSync] Heartbeat DB failure for key ${trackingKey}:`, hbErr);
        }
      }, 5000);
    }

    try {
      // PRE-DISPATCH FENCING VERIFICATION:
      // Verify reservation ownership immediately before beginning publishing work.
      if (isLeaseLost) {
        throw new HttpException(
          'Publishing lease lost during heartbeat renewal. Aborting before dispatch to prevent duplicate publishing.',
          HttpStatus.CONFLICT
        );
      }

      const activeLease = await this._prisma.publishingIdempotency.findFirst({
        where: {
          organizationId: org.id,
          idempotencyKey: trackingKey,
          fencingToken,
          status: 'pending',
        },
      });

      if (!activeLease || isLeaseLost) {
        throw new HttpException(
          'Publishing reservation lease expired or was superseded before dispatch. Aborting to prevent duplicate post.',
          HttpStatus.CONFLICT
        );
      }

      const postPayload = {
        type: type === 'now' ? 'now' : 'schedule',
        date: scheduledAt || new Date().toISOString(),
        posts: targetIntegrations.map((integration) => ({
          integration: { id: integration.id },
          value: [
            {
              content: caption || '',
              image: ingestedMedia.map((m) => ({ url: m.url, path: m.path })),
            },
          ],
          settings: {},
        })),
      };

      const mapped = await this._postsService.mapTypeToPost(postPayload as any, org.id);

      // Verify lease once more right before createPost side-effect
      if (isLeaseLost) {
        throw new HttpException(
          'Publishing lease lost before post creation. Aborting to prevent duplicate post.',
          HttpStatus.CONFLICT
        );
      }

      // Execute createPost with in-transaction fencing and initial idempotency key persistence
      const created = await this._postsService.createPost(
        org.id,
        mapped,
        'API',
        false,
        {
          fencingToken,
          idempotencyKey: trackingKey,
        }
      );

      const postIds = (created || []).map((c: any) => c.postId).filter(Boolean);
      const createdPosts = await this._prisma.post.findMany({
        where: { id: { in: postIds } },
      });

      return {
        success: true,
        message: type === 'now' ? 'Post dispatched to provider pipeline' : 'Post scheduled',
        post: createdPosts[0] || null,
        posts: createdPosts,
        channels: targetIntegrations.map((i) => ({
          id: i.id,
          name: i.name,
          platform: i.providerIdentifier,
        })),
        idempotent: false,
      };
    } catch (err: any) {
      if (trackingKey && isReservationOwner && !isLeaseLost) {
        try {
          await this._prisma.publishingIdempotency.updateMany({
            where: {
              organizationId: org.id,
              idempotencyKey: trackingKey,
              fencingToken,
              status: 'pending',
            },
            data: {
              status: 'failed',
              response: err.message || 'Dispatch failure',
            },
          });
        } catch (failErr: any) {
          console.error('[WallzaSync] Error marking idempotency record as failed:', failErr);
        }
      }
      throw new HttpException(
        err.message || 'Failed to dispatch post through publishing service',
        err.status || HttpStatus.INTERNAL_SERVER_ERROR
      );
    } finally {
      if (heartbeat) {
        clearInterval(heartbeat);
      }
    }
  }
}
