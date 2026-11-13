import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { Organization, User } from '@prisma/client';
import { ApiTags } from '@nestjs/swagger';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';

type ActivityKind = 'notification' | 'comment' | 'review';

type ActivityItem = {
  id: string;
  kind: ActivityKind;
  title: string;
  message: string;
  createdAt: Date;
  href: string;
  unread: boolean;
  resolved?: boolean;
  channel?: string | null;
  postGroup?: string | null;
  actor?: string | null;
};

const safeInternalLink = (value: string | null): string => {
  if (!value) return '/launches';
  if (value.startsWith('/') && !value.startsWith('//')) return value;
  if (/^https:\/\//i.test(value)) return value;
  return '/launches';
};

@ApiTags('Activity Inbox')
@Controller('/activity-inbox')
export class ActivityInboxController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * This is a publishing-workspace activity feed, not a customer messaging inbox.
   * It deliberately aggregates Postiz notifications, internal post discussion
   * comments and client review audit events. It does not fetch DMs or lead chats.
   */
  @Get('/')
  async list(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Query('kind') kind = 'all',
    @Query('limit') limitRaw = '80'
  ) {
    const take = Math.min(100, Math.max(10, Number.parseInt(limitRaw, 10) || 80));
    const includeNotifications = kind === 'all' || kind === 'notification';
    const includeComments = kind === 'all' || kind === 'comment';
    const includeReviews = kind === 'all' || kind === 'review';

    const [readState, notifications, comments, reviewEvents] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: user.id },
        select: { lastReadNotifications: true },
      }),
      includeNotifications
        ? this.prisma.notifications.findMany({
            where: { organizationId: org.id, deletedAt: null },
            orderBy: { createdAt: 'desc' },
            take,
            select: { id: true, content: true, link: true, createdAt: true },
          })
        : Promise.resolve([]),
      includeComments
        ? this.prisma.comments.findMany({
            where: {
              organizationId: org.id,
              deletedAt: null,
              post: { deletedAt: null },
            },
            orderBy: { createdAt: 'desc' },
            take,
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
                  group: true,
                  title: true,
                  state: true,
                  releaseURL: true,
                  integration: { select: { name: true } },
                },
              },
            },
          })
        : Promise.resolve([]),
      includeReviews
        ? this.prisma.contentReviewEvent.findMany({
            where: { organizationId: org.id },
            orderBy: { createdAt: 'desc' },
            take,
            select: {
              id: true,
              action: true,
              actorEmail: true,
              actorName: true,
              comment: true,
              createdAt: true,
              review: {
                select: {
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

    const lastRead = readState?.lastReadNotifications ?? new Date(0);
    const items: ActivityItem[] = [
      ...notifications.map((item) => ({
        id: `notification:${item.id}`,
        kind: 'notification' as const,
        title: 'Publishing notification',
        message: item.content,
        createdAt: item.createdAt,
        href: safeInternalLink(item.link),
        unread: item.createdAt > lastRead,
      })),
      ...comments.map((item) => ({
        id: `comment:${item.id}`,
        kind: 'comment' as const,
        title: item.parentId ? 'Post discussion reply' : 'Post discussion comment',
        message: item.content,
        createdAt: item.createdAt,
        href: '/launches',
        unread: false,
        resolved: Boolean(item.resolvedAt),
        channel: item.post.integration?.name ?? null,
        postGroup: item.post.group,
        actor: item.displayName || item.user?.name || item.user?.email || 'Team member',
      })),
      ...reviewEvents.map((item) => {
        const actionTitles: Record<string, string> = {
          created: 'Client review requested',
          approved: 'Client approved a post',
          changes_requested: 'Client requested changes',
          revoked: 'Client review link revoked',
        };
        return {
          id: `review:${item.id}`,
          kind: 'review' as const,
          title: actionTitles[item.action] || 'Client review updated',
          message: item.comment || item.actorName || item.actorEmail || item.review.reviewerEmail,
          createdAt: item.createdAt,
          href: '/reviews',
          unread: false,
          postGroup: item.review.postGroup,
          actor: item.actorName || item.actorEmail || item.review.reviewerName || item.review.reviewerEmail,
        };
      }),
    ];

    items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const visible = items.slice(0, take);

    return {
      items: visible,
      total: items.length,
      lastReadAt: lastRead,
      counts: {
        notifications: notifications.length,
        comments: comments.length,
        reviews: reviewEvents.length,
        unreadNotifications: visible.filter((item) => item.kind === 'notification' && item.unread).length,
      },
      scope: 'publishing_activity',
    };
  }

  @Post('/mark-read')
  async markNotificationsRead(@GetUserFromRequest() user: User) {
    const updatedAt = new Date();
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastReadNotifications: updatedAt },
    });
    return { success: true, lastReadAt: updatedAt };
  }
}
