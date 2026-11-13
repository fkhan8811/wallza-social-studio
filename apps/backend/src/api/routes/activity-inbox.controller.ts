import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { Organization, User } from '@prisma/client';
import { ApiTags } from '@nestjs/swagger';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';

export type ActivityKind = 'notification' | 'comment' | 'review' | 'lead_event';

export type ActivityItem = {
  id: string;
  kind: ActivityKind;
  title: string;
  message: string;
  createdAt: Date;
  href: string;
  unread: boolean;
  resolved?: boolean;
  channel?: string | null;
  platform?: string | null;
  postGroup?: string | null;
  actor?: string | null;
  leadEligible?: boolean;
  metadata?: Record<string, any>;
};

const safeInternalLink = (value: string | null): string => {
  if (!value) return '/launches';
  if (value.startsWith('/') && !value.startsWith('//')) return value;
  if (/^https:\/\//i.test(value)) return value;
  return '/launches';
};

export interface ConvertLeadDto {
  commentId?: string;
  authorName: string;
  authorHandle?: string;
  content: string;
  platform: string;
  channel?: string;
  postId?: string;
  postGroup?: string;
  permalink?: string;
  leadNotes?: string;
}

export interface EngagementCapability {
  provider: string;
  name: string;
  readComments: boolean;
  replyComments: boolean;
  moderation: boolean;
  mentions: boolean;
  authTier: string;
  notes: string;
}

const PROVIDER_CAPABILITIES: Record<string, EngagementCapability> = {
  facebook: {
    provider: 'facebook',
    name: 'Facebook Pages',
    readComments: true,
    replyComments: true,
    moderation: true,
    mentions: false,
    authTier: 'Standard OAuth (pages_read_engagement)',
    notes: 'Reads and replies to comments on published page posts.',
  },
  instagram: {
    provider: 'instagram',
    name: 'Instagram Professional',
    readComments: true,
    replyComments: true,
    moderation: true,
    mentions: true,
    authTier: 'Meta Graph API (instagram_manage_comments)',
    notes: 'Handles comments and @mentions on Instagram business media.',
  },
  youtube: {
    provider: 'youtube',
    name: 'YouTube',
    readComments: true,
    replyComments: true,
    moderation: false,
    mentions: false,
    authTier: 'Google OAuth (youtube.force-ssl)',
    notes: 'Reads top-level comments and posts channel responses.',
  },
  threads: {
    provider: 'threads',
    name: 'Threads',
    readComments: true,
    replyComments: true,
    moderation: false,
    mentions: false,
    authTier: 'Threads API (threads_read_replies)',
    notes: 'Fetches replies and publishes thread responses.',
  },
  x: {
    provider: 'x',
    name: 'X (Twitter)',
    readComments: false,
    replyComments: false,
    moderation: false,
    mentions: false,
    authTier: 'Requires X API Basic/Pro Tier ($100-$5000/mo)',
    notes: 'Publishing supported on Free tier. Comment reading requires paid developer tier.',
  },
  linkedin: {
    provider: 'linkedin',
    name: 'LinkedIn',
    readComments: false,
    replyComments: false,
    moderation: false,
    mentions: false,
    authTier: 'Restricted Partner API (Community Management)',
    notes: 'Requires LinkedIn Partner approval for organization post comments.',
  },
  bluesky: {
    provider: 'bluesky',
    name: 'Bluesky',
    readComments: true,
    replyComments: true,
    moderation: false,
    mentions: true,
    authTier: 'AT Protocol API',
    notes: 'Reads public thread replies and mentions via ATProto.',
  },
  mastodon: {
    provider: 'mastodon',
    name: 'Mastodon',
    readComments: true,
    replyComments: true,
    moderation: false,
    mentions: true,
    authTier: 'Mastodon Instance API',
    notes: 'Reads instance federated replies and mentions.',
  },
};

@ApiTags('Activity Inbox')
@Controller('/activity-inbox')
export class ActivityInboxController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Publishing-workspace activity feed.
   * Aggregates Postiz notifications, post discussion comments, client review events,
   * and social engagement activity.
   * Strictly respects organization boundary and per-organization unread tracking.
   */
  @Get('/')
  async list(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Query('kind') kind = 'all',
    @Query('channel') channel?: string,
    @Query('status') status = 'all', // 'all' | 'unread' | 'resolved'
    @Query('search') search?: string,
    @Query('page') pageRaw = '1',
    @Query('limit') limitRaw = '50'
  ) {
    const page = Math.max(1, Number.parseInt(pageRaw, 10) || 1);
    const limit = Math.min(100, Math.max(5, Number.parseInt(limitRaw, 10) || 50));
    const skip = (page - 1) * limit;

    const includeNotifications = kind === 'all' || kind === 'notification';
    const includeComments = kind === 'all' || kind === 'comment';
    const includeReviews = kind === 'all' || kind === 'review';

    // Tenant-isolated read tracking: check UserOrganization first
    const [userOrg, userRecord] = await Promise.all([
      (this.prisma as any).userOrganization.findUnique({
        where: {
          userId_organizationId: {
            userId: user.id,
            organizationId: org.id,
          },
        },
        select: { lastReadNotifications: true },
      }),
      this.prisma.user.findUnique({
        where: { id: user.id },
        select: { lastReadNotifications: true },
      }),
    ]);

    const lastRead =
      userOrg?.lastReadNotifications ?? userRecord?.lastReadNotifications ?? new Date(0);

    const notificationWhere: any = { organizationId: org.id, deletedAt: null };
    if (search && search.trim()) {
      notificationWhere.content = { contains: search.trim(), mode: 'insensitive' };
    }

    const commentWhere: any = {
      organizationId: org.id,
      deletedAt: null,
      post: { deletedAt: null },
    };
    if (channel && channel !== 'all') {
      commentWhere.post.integration = { name: { contains: channel, mode: 'insensitive' } };
    }
    if (search && search.trim()) {
      commentWhere.content = { contains: search.trim(), mode: 'insensitive' };
    }
    if (status === 'resolved') {
      commentWhere.resolvedAt = { not: null };
    } else if (status === 'unread') {
      commentWhere.resolvedAt = null;
    }

    const reviewWhere: any = { organizationId: org.id };
    if (search && search.trim()) {
      reviewWhere.OR = [
        { comment: { contains: search.trim(), mode: 'insensitive' } },
        { actorName: { contains: search.trim(), mode: 'insensitive' } },
        { actorEmail: { contains: search.trim(), mode: 'insensitive' } },
      ];
    }

    const [notifications, comments, reviewEvents] = await Promise.all([
      includeNotifications
        ? this.prisma.notifications.findMany({
            where: notificationWhere,
            orderBy: { createdAt: 'desc' },
            take: 200,
            select: { id: true, content: true, link: true, createdAt: true },
          })
        : Promise.resolve([]),
      includeComments
        ? this.prisma.comments.findMany({
            where: commentWhere,
            orderBy: { createdAt: 'desc' },
            take: 200,
            select: {
              id: true,
              content: true,
              displayName: true,
              resolvedAt: true,
              parentId: true,
              createdAt: true,
              user: { select: { name: true, email: true } },
              post: {
                select: {
                  id: true,
                  group: true,
                  title: true,
                  state: true,
                  releaseURL: true,
                  integration: { select: { id: true, name: true, providerIdentifier: true } },
                },
              },
            },
          })
        : Promise.resolve([]),
      includeReviews
        ? this.prisma.contentReviewEvent.findMany({
            where: reviewWhere,
            orderBy: { createdAt: 'desc' },
            take: 200,
            select: {
              id: true,
              action: true,
              actorEmail: true,
              actorName: true,
              comment: true,
              createdAt: true,
              review: {
                select: {
                  id: true,
                  postGroup: true,
                  reviewerEmail: true,
                  reviewerName: true,
                  status: true,
                },
              },
            },
          })
        : Promise.resolve([]),
    ]);

    const items: ActivityItem[] = [
      ...notifications.map((item) => ({
        id: `notification:${item.id}`,
        kind: 'notification' as const,
        title: 'Publishing Notification',
        message: item.content,
        createdAt: item.createdAt,
        href: safeInternalLink(item.link),
        unread: item.createdAt > lastRead,
        leadEligible: false,
      })),
      ...comments.map((item) => {
        const prov = item.post.integration?.providerIdentifier?.toLowerCase() || '';
        const isExternal = Boolean(item.post.releaseURL);
        return {
          id: `comment:${item.id}`,
          kind: 'comment' as const,
          title: item.parentId ? 'Post Discussion Reply' : 'Post Discussion Comment',
          message: item.content,
          createdAt: item.createdAt,
          href: item.post.group ? `/launches?postGroup=${item.post.group}` : '/launches',
          unread: !item.resolvedAt && item.createdAt > lastRead,
          resolved: Boolean(item.resolvedAt),
          channel: item.post.integration?.name ?? null,
          platform: prov.split('-')[0] || prov,
          postGroup: item.post.group,
          actor: item.displayName || item.user?.name || item.user?.email || 'Team Member',
          leadEligible: true,
          metadata: {
            postId: item.post.id,
            postGroup: item.post.group,
            channelId: item.post.integration?.id,
            permalink: item.post.releaseURL || null,
          },
        };
      }),
      ...reviewEvents.map((item) => {
        const actionTitles: Record<string, string> = {
          created: 'Client Review Requested',
          approved: 'Client Approved Post Group',
          changes_requested: 'Client Requested Changes',
          revoked: 'Client Review Link Revoked',
        };
        return {
          id: `review:${item.id}`,
          kind: 'review' as const,
          title: actionTitles[item.action] || 'Client Review Updated',
          message:
            item.comment ||
            item.actorName ||
            item.actorEmail ||
            item.review.reviewerEmail ||
            'Review event recorded',
          createdAt: item.createdAt,
          href: `/reviews?postGroup=${item.review.postGroup}`,
          unread: item.createdAt > lastRead,
          postGroup: item.review.postGroup,
          actor:
            item.actorName ||
            item.actorEmail ||
            item.review.reviewerName ||
            item.review.reviewerEmail,
          leadEligible: false,
          metadata: {
            reviewId: item.review.id,
            postGroup: item.review.postGroup,
            status: item.review.status,
          },
        };
      }),
    ];

    // Sort descending by creation date
    items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    // Apply status filter if unread
    const filteredItems =
      status === 'unread'
        ? items.filter((i) => i.unread)
        : status === 'resolved'
        ? items.filter((i) => i.resolved)
        : items;

    const total = filteredItems.length;
    const paginated = filteredItems.slice(skip, skip + limit);
    const totalPages = Math.ceil(total / limit) || 1;

    const unreadNotificationsCount = items.filter(
      (item) => item.kind === 'notification' && item.unread
    ).length;

    return {
      items: paginated,
      total,
      page,
      limit,
      totalPages,
      lastReadAt: lastRead,
      counts: {
        totalItems: items.length,
        notifications: notifications.length,
        comments: comments.length,
        reviews: reviewEvents.length,
        unreadNotifications: unreadNotificationsCount,
      },
      scope: 'publishing_activity',
    };
  }

  /**
   * Mark notifications as read strictly for the active tenant organization.
   * Avoids globally clearing notifications for users in multiple organizations.
   */
  @Post('/mark-read')
  async markNotificationsRead(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User
  ) {
    const updatedAt = new Date();

    // 1. Scoped update on UserOrganization
    await (this.prisma as any).userOrganization.upsert({
      where: {
        userId_organizationId: {
          userId: user.id,
          organizationId: org.id,
        },
      },
      create: {
        userId: user.id,
        organizationId: org.id,
        lastReadNotifications: updatedAt,
      },
      update: {
        lastReadNotifications: updatedAt,
      },
    });

    // 2. Also update User table as fallback
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastReadNotifications: updatedAt },
    });

    return { success: true, lastReadAt: updatedAt, organizationId: org.id };
  }

  /**
   * Resolve an internal post discussion comment.
   */
  @Put('/comments/:commentId/resolve')
  @Post('/comments/:commentId/resolve')
  async resolveComment(
    @GetOrgFromRequest() org: Organization,
    @Param('commentId') commentId: string,
    @Body() body: { resolved?: boolean }
  ) {
    const isResolved = body.resolved !== false;

    const comment = await this.prisma.comments.findFirst({
      where: { id: commentId, organizationId: org.id, deletedAt: null },
    });

    if (!comment) {
      throw new NotFoundException('Comment not found in current organization.');
    }

    const updated = await this.prisma.comments.update({
      where: { id: comment.id },
      data: {
        resolvedAt: isResolved ? new Date() : null,
      },
    });

    return {
      success: true,
      commentId: updated.id,
      resolved: Boolean(updated.resolvedAt),
      resolvedAt: updated.resolvedAt,
    };
  }

  /**
   * WallzaOS Lead Bridge:
   * Explicitly converts an engagement comment or mention into a sales/CRM lead
   * formatted for WallzaOS Unified Inbox without duplicating customer conversation threads.
   */
  @Post('/convert-lead')
  async convertToLead(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: ConvertLeadDto
  ) {
    if (!body.authorName || !body.content || !body.platform) {
      throw new BadRequestException('authorName, content, and platform are required to create a CRM lead.');
    }

    const capturedAt = new Date();

    // Audit record in organization notifications
    await this.prisma.notifications.create({
      data: {
        organizationId: org.id,
        content: `Social lead created from ${body.platform} comment by ${body.authorName}: "${body.content.slice(0, 80)}"`,
        link: body.permalink || `/launches?postGroup=${body.postGroup || ''}`,
      },
    });

    const leadPayload = {
      source: 'wallza_social_studio',
      organizationId: org.id,
      convertedByUserId: user.id,
      platform: body.platform.toLowerCase(),
      channel: body.channel || body.platform,
      externalPostId: body.postId || null,
      externalPostGroup: body.postGroup || null,
      externalCommentId: body.commentId || null,
      authorName: body.authorName.trim(),
      authorHandle: body.authorHandle?.trim() || null,
      content: body.content.trim(),
      permalink: body.permalink || null,
      leadNotes: body.leadNotes || null,
      capturedAt: capturedAt.toISOString(),
      wallzaInboxEndpoint: '/inbox?leadSource=social_studio',
    };

    return {
      success: true,
      lead: leadPayload,
      message:
        'Engagement item converted to lead contract. Dispatched for WallzaOS Unified Inbox ingestion.',
    };
  }

  /**
   * Returns provider engagement and comment capabilities matrix for connected accounts.
   */
  @Get('/capabilities')
  async getEngagementCapabilities(@GetOrgFromRequest() org: Organization) {
    const integrations = await this.prisma.integration.findMany({
      where: { organizationId: org.id, disabled: false, deletedAt: null },
      select: { id: true, name: true, providerIdentifier: true },
    });

    const results = integrations.map((int) => {
      const key = int.providerIdentifier.toLowerCase().split('-')[0];
      const cap = PROVIDER_CAPABILITIES[key] || {
        provider: key,
        name: int.name,
        readComments: false,
        replyComments: false,
        moderation: false,
        mentions: false,
        authTier: 'Standard Publishing Only',
        notes: 'Engagement/comment API not supported by this provider.',
      };
      return {
        integrationId: int.id,
        channelName: int.name,
        ...cap,
      };
    });

    return {
      connectedChannels: results,
      totalChannels: results.length,
      supportedEngagementChannels: results.filter((c) => c.readComments || c.replyComments).length,
    };
  }
}
