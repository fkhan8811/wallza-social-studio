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
import { createHash } from 'crypto';
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
  firstCommentPublishing: 'available' | 'unsupported';
  inboundCommentSync: 'unsupported' | 'permission_required' | 'available';
  commentModeration: 'unsupported' | 'permission_required';
  crmLeadBridge: 'available';
  authTier: string;
  notes: string;
}

const PROVIDER_CAPABILITIES: Record<string, EngagementCapability> = {
  facebook: {
    provider: 'facebook',
    name: 'Facebook Pages',
    firstCommentPublishing: 'available',
    inboundCommentSync: 'permission_required',
    commentModeration: 'unsupported',
    crmLeadBridge: 'available',
    authTier: 'Standard OAuth (pages_manage_posts)',
    notes: 'Outbound publishing and first-comments supported. Inbound feed sync requires Meta Webhooks configured in WallzaOS core.',
  },
  instagram: {
    provider: 'instagram',
    name: 'Instagram Professional',
    firstCommentPublishing: 'available',
    inboundCommentSync: 'permission_required',
    commentModeration: 'unsupported',
    crmLeadBridge: 'available',
    authTier: 'Meta Graph API (instagram_content_publish)',
    notes: 'Outbound publishing and first-comments supported. Inbound customer communication is managed via WallzaOS Unified Inbox.',
  },
  youtube: {
    provider: 'youtube',
    name: 'YouTube',
    firstCommentPublishing: 'available',
    inboundCommentSync: 'unsupported',
    commentModeration: 'unsupported',
    crmLeadBridge: 'available',
    authTier: 'Google OAuth (youtube.upload)',
    notes: 'Publishing and first-comment response supported. Inbound sync not available on publisher scope.',
  },
  threads: {
    provider: 'threads',
    name: 'Threads',
    firstCommentPublishing: 'available',
    inboundCommentSync: 'unsupported',
    commentModeration: 'unsupported',
    crmLeadBridge: 'available',
    authTier: 'Threads API (threads_content_publish)',
    notes: 'Outbound publishing supported. Inbound comments not supported by standard publishing token.',
  },
  bluesky: {
    provider: 'bluesky',
    name: 'Bluesky',
    firstCommentPublishing: 'available',
    inboundCommentSync: 'unsupported',
    commentModeration: 'unsupported',
    crmLeadBridge: 'available',
    authTier: 'AT Protocol App Password',
    notes: 'Outbound posts and replies supported. Inbound stream ingestion handled outside publisher.',
  },
  mastodon: {
    provider: 'mastodon',
    name: 'Mastodon',
    firstCommentPublishing: 'available',
    inboundCommentSync: 'unsupported',
    commentModeration: 'unsupported',
    crmLeadBridge: 'available',
    authTier: 'Instance Access Token (write:statuses)',
    notes: 'Outbound posts and replies supported. Inbound notifications require streaming socket.',
  },
  linkedin: {
    provider: 'linkedin',
    name: 'LinkedIn',
    firstCommentPublishing: 'available',
    inboundCommentSync: 'unsupported',
    commentModeration: 'unsupported',
    crmLeadBridge: 'available',
    authTier: 'Community Management API / w_member_social',
    notes: 'Outbound company updates and first comments supported.',
  },
  x: {
    provider: 'x',
    name: 'X (Twitter)',
    firstCommentPublishing: 'available',
    inboundCommentSync: 'unsupported',
    commentModeration: 'unsupported',
    crmLeadBridge: 'available',
    authTier: 'X API v2 (tweet.write, tweet.read)',
    notes: 'Outbound posts and first replies supported. User stream/mention ingestion not configured.',
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

    // Tenant-isolated read tracking: strictly read from UserOrganization for the active organization
    const userOrg = await (this.prisma as any).userOrganization.findUnique({
      where: {
        userId_organizationId: {
          userId: user.id,
          organizationId: org.id,
        },
      },
      select: { lastReadNotifications: true },
    });

    const lastRead = userOrg?.lastReadNotifications ?? new Date(0);

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

    // Scoped update strictly on UserOrganization for active organization
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
   * Converts an engagement comment or mention into a sales/CRM lead
   * formatted for WallzaOS Unified Inbox without duplicating customer conversation threads.
   * Uses durable SocialLeadOutbox with idempotency and target acceptance verification.
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

    const contentHash = createHash('sha256').update(body.content.trim()).digest('hex').slice(0, 16);
    const identifier = (body.commentId?.trim() || body.postId?.trim() || contentHash).replace(/[^a-zA-Z0-9_-]/g, '_');
    const idempotencyKey = `lead_${org.id}_${body.platform.toLowerCase()}_${identifier}`;

    // 1. Idempotency Check: Prevent duplicate lead creation for the same social interaction
    const existing = await (this.prisma as any).socialLeadOutbox.findUnique({
      where: { idempotencyKey },
    });

    if (existing && existing.status === 'dispatched') {
      return {
        success: true,
        alreadyExists: true,
        outboxId: existing.id,
        status: 'dispatched',
        message: 'This social interaction was already converted and confirmed by Wallza CRM.',
        lead: {
          id: existing.id,
          source: `social_${existing.platform}`,
          platform: existing.platform,
          authorName: existing.authorName,
          content: existing.content,
          permalink: existing.permalink,
          dispatchedAt: existing.dispatchedAt,
        },
      };
    }

    // 2. Persist to Durable Outbox
    const outboxEntry = existing || await (this.prisma as any).socialLeadOutbox.create({
      data: {
        organizationId: org.id,
        idempotencyKey,
        platform: body.platform.toLowerCase(),
        channel: body.channel || body.platform,
        postId: body.postId || null,
        commentId: body.commentId || null,
        authorName: body.authorName.trim(),
        authorHandle: body.authorHandle?.trim() || null,
        content: body.content.trim(),
        permalink: body.permalink || null,
        leadNotes: body.leadNotes || null,
        status: 'pending',
      },
    });

    // 3. Dispatch to WallzaOS Unified Inbox API
    const wallzaUrl = process.env.WALLZAOS_API_URL || process.env.MAIN_URL || 'http://localhost:5001';
    const dispatchPayload = {
      org_id: org.id,
      name: body.authorName.trim(),
      to_number: body.authorHandle?.trim() || '',
      email: '',
      source: `social_${body.platform.toLowerCase()}`,
      source_id: identifier,
      notes: `[Social Studio Inbound Lead]\nPlatform: ${body.platform}\nChannel: ${body.channel || body.platform}\nPost URL: ${body.permalink || body.postId || 'N/A'}\nComment ID: ${body.commentId || 'N/A'}\nContent: "${body.content.trim()}"\nNotes: ${body.leadNotes || 'None'}`,
    };

    let dispatchSuccess = false;
    let responseData: any = null;
    let errorMessage: string | null = null;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);
      const response = await fetch(`${wallzaUrl}/api/leads`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-organization-id': org.id,
          ...(process.env.INTERNAL_SERVICE_SECRET ? { 'x-service-token': process.env.INTERNAL_SERVICE_SECRET } : {}),
        },
        body: JSON.stringify(dispatchPayload),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        responseData = await response.json();
        dispatchSuccess = true;
      } else {
        const errText = await response.text().catch(() => '');
        errorMessage = `Target returned HTTP ${response.status}: ${errText.slice(0, 300)}`;
      }
    } catch (dispatchErr: any) {
      errorMessage = dispatchErr.name === 'AbortError' ? 'Target request timed out after 6000ms' : dispatchErr.message;
    }

    // 4. Update Outbox Record & Verify Acceptance
    if (dispatchSuccess) {
      await (this.prisma as any).socialLeadOutbox.update({
        where: { id: outboxEntry.id },
        data: {
          status: 'dispatched',
          dispatchedAt: new Date(),
          dispatchAttempts: { increment: 1 },
          targetResponse: JSON.stringify(responseData),
        },
      });

      await this.prisma.notifications.create({
        data: {
          organizationId: org.id,
          content: `Social lead created from ${body.platform} by ${body.authorName} and confirmed by Wallza CRM.`,
          link: body.permalink || `/launches?postGroup=${body.postGroup || ''}`,
        },
      });

      return {
        success: true,
        status: 'dispatched',
        outboxId: outboxEntry.id,
        lead: responseData || dispatchPayload,
        message: 'Lead confirmed and ingested by WallzaOS Unified Inbox.',
      };
    }

    // Mark failed in outbox and report block
    await (this.prisma as any).socialLeadOutbox.update({
      where: { id: outboxEntry.id },
      data: {
        status: 'failed',
        dispatchAttempts: { increment: 1 },
        targetResponse: errorMessage,
      },
    });

    throw new BadRequestException(
      `Lead ingestion could not be confirmed by target CRM (${errorMessage}). Lead preserved in durable outbox (ID: ${outboxEntry.id}) for retry.`
    );
  }

  /**
   * Retry dispatching a pending or failed lead from the outbox.
   */
  @Post('/leads/:outboxId/retry')
  async retryLeadDispatch(
    @GetOrgFromRequest() org: Organization,
    @Param('outboxId') outboxId: string
  ) {
    const entry = await (this.prisma as any).socialLeadOutbox.findFirst({
      where: { id: outboxId, organizationId: org.id },
    });
    if (!entry) throw new NotFoundException('Outbox lead not found.');
    if (entry.status === 'dispatched') {
      return { success: true, message: 'Lead already confirmed by CRM.', entry };
    }

    const wallzaUrl = process.env.WALLZAOS_API_URL || process.env.MAIN_URL || 'http://localhost:5001';
    const dispatchPayload = {
      org_id: org.id,
      name: entry.authorName,
      to_number: entry.authorHandle || '',
      email: '',
      source: `social_${entry.platform.toLowerCase()}`,
      source_id: entry.commentId || entry.postId || entry.id,
      notes: `[Social Studio Inbound Lead - Retried]\nPlatform: ${entry.platform}\nChannel: ${entry.channel}\nPost: ${entry.permalink || entry.postId || 'N/A'}\nComment ID: ${entry.commentId || 'N/A'}\nContent: "${entry.content}"\nNotes: ${entry.leadNotes || 'None'}`,
    };

    try {
      const response = await fetch(`${wallzaUrl}/api/leads`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-organization-id': org.id,
          ...(process.env.INTERNAL_SERVICE_SECRET ? { 'x-service-token': process.env.INTERNAL_SERVICE_SECRET } : {}),
        },
        body: JSON.stringify(dispatchPayload),
      });

      if (response.ok) {
        const data = await response.json();
        const updated = await (this.prisma as any).socialLeadOutbox.update({
          where: { id: outboxId },
          data: {
            status: 'dispatched',
            dispatchedAt: new Date(),
            dispatchAttempts: { increment: 1 },
            targetResponse: JSON.stringify(data),
          },
        });
        return { success: true, status: 'dispatched', lead: data, outbox: updated };
      }

      const errText = await response.text().catch(() => '');
      await (this.prisma as any).socialLeadOutbox.update({
        where: { id: outboxId },
        data: {
          dispatchAttempts: { increment: 1 },
          targetResponse: `HTTP ${response.status}: ${errText.slice(0, 300)}`,
        },
      });
      throw new BadRequestException(`Target CRM rejected lead retry (HTTP ${response.status}): ${errText}`);
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException(`Retry connection failed: ${err.message}`);
    }
  }

  /**
   * List durable outbox leads for the organization.
   */
  @Get('/leads')
  async listOutboxLeads(
    @GetOrgFromRequest() org: Organization,
    @Query('status') status?: string
  ) {
    const where: any = { organizationId: org.id };
    if (status && status !== 'all') {
      where.status = status;
    }
    return (this.prisma as any).socialLeadOutbox.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
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
        firstCommentPublishing: 'unsupported' as const,
        inboundCommentSync: 'unsupported' as const,
        commentModeration: 'unsupported' as const,
        crmLeadBridge: 'available' as const,
        authTier: 'Standard Publishing Only',
        notes: 'Engagement/comment API not supported by this provider.',
      };
      return {
        integrationId: int.id,
        channelName: int.name,
        channelStatus: 'connected',
        ...cap,
      };
    });

    return {
      connectedChannels: results,
      totalChannels: results.length,
      supportedOutboundCommentChannels: results.filter((c) => c.firstCommentPublishing === 'available').length,
      crmLeadBridgeAvailable: true,
    };
  }
}
