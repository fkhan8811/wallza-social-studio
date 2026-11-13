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
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { verifyInternalRequest } from '../auth/internal-hmac.util';

const PRIVATE_IP_REGEX =
  /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.|169\.254\.|localhost|::1)/i;

const VALID_MEDIA_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.mp4',
  '.mov',
  '.webm',
]);

function validateMediaUrl(url: string, isProduction: boolean): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new HttpException(`Invalid media URL format: ${url}`, HttpStatus.BAD_REQUEST);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new HttpException(`Invalid media URL protocol: ${parsed.protocol}`, HttpStatus.BAD_REQUEST);
  }

  if (isProduction && PRIVATE_IP_REGEX.test(parsed.hostname)) {
    throw new HttpException(
      `Media URL points to private/internal network: ${parsed.hostname}`,
      HttpStatus.BAD_REQUEST
    );
  }

  const pathname = parsed.pathname.toLowerCase();
  const hasValidExt = Array.from(VALID_MEDIA_EXTENSIONS).some((ext) => pathname.endsWith(ext));
  // Allow unsigned storage/CDN URLs with queries as long as path or query has recognizable asset format
  if (!hasValidExt && !pathname.includes('/uploads/') && !pathname.includes('/storage/')) {
    throw new HttpException(
      `Unsupported media format for URL: ${pathname}. Allowed: JPG, PNG, WEBP, GIF, MP4, MOV`,
      HttpStatus.BAD_REQUEST
    );
  }
}

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
    private _postsService: PostsService
  ) {}

  @Get('/wallza-status')
  async getStatus(@Req() req: Request, @Query('organizationId') organizationId: string) {
    const auth = verifyInternalRequest(req, { expectedAudience: 'social-studio' });
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
    const auth = verifyInternalRequest(req, { expectedAudience: 'social-studio' });
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
    const auth = verifyInternalRequest(req, { expectedAudience: 'social-studio' });
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

    // 1. Validation (Requirement 11)
    const isProduction = process.env.NODE_ENV === 'production';
    for (const url of mediaUrls) {
      validateMediaUrl(url, isProduction);
    }
    validatePostContent(caption, mediaUrls, platforms);
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
    const targetIntegrations = org.Integration.filter((i) =>
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

    // 3. Duplicate Prevention & Idempotency (Requirement 12)
    const postTrackingId = idempotencyKey || wallzaPostId;
    if (postTrackingId) {
      const existingPost = await this._prisma.post.findFirst({
        where: {
          organizationId: org.id,
          releaseId: postTrackingId,
          deletedAt: null,
        },
      });

      if (existingPost) {
        return {
          success: true,
          message: 'Post already dispatched/scheduled (idempotent replay)',
          post: existingPost,
          channels: targetIntegrations.map((i) => ({
            id: i.id,
            name: i.name,
            platform: i.providerIdentifier,
          })),
          idempotent: true,
        };
      }
    }

    // 4. Dispatch via Postiz native PostsService
    const postPayload = {
      type: type === 'now' ? 'now' : 'schedule',
      date: scheduledAt || new Date().toISOString(),
      posts: targetIntegrations.map((integration) => ({
        integration: { id: integration.id },
        value: [
          {
            content: caption || '',
            image: mediaUrls.map((url) => ({ url, path: url })),
          },
        ],
        settings: {},
      })),
    };

    try {
      const mapped = await this._postsService.mapTypeToPost(postPayload as any, org.id);
      const created = await this._postsService.createPost(org.id, mapped, 'API');

      // Tag with releaseId for idempotency during retries
      if (postTrackingId && created) {
        const createdId = Array.isArray(created) ? created[0]?.id : (created as any)?.id;
        if (createdId) {
          await this._prisma.post.update({
            where: { id: createdId },
            data: { releaseId: postTrackingId },
          }).catch(() => {});
        }
      }

      return {
        success: true,
        message: type === 'now' ? 'Post dispatched to provider pipeline' : 'Post scheduled',
        post: created,
        channels: targetIntegrations.map((i) => ({
          id: i.id,
          name: i.name,
          platform: i.providerIdentifier,
        })),
        idempotent: false,
      };
    } catch (err: any) {
      throw new HttpException(
        err.message || 'Failed to dispatch post through publishing service',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }
}
