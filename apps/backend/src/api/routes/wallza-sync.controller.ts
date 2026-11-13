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

function verifyInternalAuth(req: Request): boolean {
  const secret =
    process.env.WALLZAOS_INTERNAL_SECRET ||
    process.env.WALLZA_INTERNAL_SECRET ||
    'dev_wallza_internal_secret';
  const authHeader = req.headers.authorization || '';
  const directHeader = req.headers['x-wallza-internal-secret'] as string;

  if (directHeader && directHeader === secret) return true;
  if (authHeader.startsWith('Bearer ') && authHeader.slice(7).trim() === secret) return true;

  if (process.env.NODE_ENV !== 'production' && (!secret || secret === 'dev_wallza_internal_secret')) {
    return true;
  }

  return false;
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
    if (!verifyInternalAuth(req)) {
      throw new HttpException('Unauthorized internal request', HttpStatus.UNAUTHORIZED);
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
    if (!verifyInternalAuth(req)) {
      throw new HttpException('Unauthorized internal request', HttpStatus.UNAUTHORIZED);
    }

    const { organizationId, action, connections } = body || {};
    if (!organizationId || !action || !Array.isArray(connections)) {
      throw new HttpException(
        'Missing required sync parameters: organizationId, action, connections',
        HttpStatus.BAD_REQUEST
      );
    }

    // 1. Resolve or create Social Studio Organization
    let org = await this._prisma.organization.findUnique({
      where: { supabaseOrgId: organizationId },
    });

    if (!org) {
      org = await this._prisma.organization.create({
        data: {
          name: 'Wallza Workspace',
          supabaseOrgId: organizationId,
        },
      });
    }

    const syncedResults: any[] = [];

    // 2. Process connections
    for (const conn of connections) {
      if (action === 'upsert') {
        const expirationDate = conn.expiresIn
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
        if (conn.internalId === 'all') {
          // Disconnect all channels for this provider
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
        } else {
          await this._prisma.integration.updateMany({
            where: {
              organizationId: org.id,
              internalId: conn.internalId,
            },
            data: {
              disabled: true,
              deletedAt: new Date(),
            },
          });
        }
        syncedResults.push({ provider: conn.provider, internalId: conn.internalId, status: 'disconnected' });
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
    }
  ) {
    if (!verifyInternalAuth(req)) {
      throw new HttpException('Unauthorized internal request', HttpStatus.UNAUTHORIZED);
    }

    const { organizationId, caption, mediaUrls = [], platforms = [], type, scheduledAt } = body || {};
    if (!organizationId || (!caption && mediaUrls.length === 0)) {
      throw new HttpException('Missing organizationId or content', HttpStatus.BAD_REQUEST);
    }

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

    // Format post payload for Postiz PostsService
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

      return {
        success: true,
        message: type === 'now' ? 'Post dispatched to provider pipeline' : 'Post scheduled',
        post: created,
        channels: targetIntegrations.map((i) => ({ id: i.id, name: i.name, platform: i.providerIdentifier })),
      };
    } catch (err: any) {
      throw new HttpException(
        err.message || 'Failed to dispatch post through publishing service',
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }
}

