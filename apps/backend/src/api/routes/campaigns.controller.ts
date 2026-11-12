import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { Organization } from '@prisma/client';
import { ApiTags } from '@nestjs/swagger';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';

const CAMPAIGN_STATUSES = ['planning', 'active', 'paused', 'completed', 'archived'] as const;

const optionalDate = (value: unknown, label: string): Date | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string') throw new BadRequestException(`${label} must be an ISO date.`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new BadRequestException(`${label} must be a valid date.`);
  return date;
};

@ApiTags('Campaigns')
@Controller('/campaigns')
export class CampaignsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('/available-post-groups')
  async availablePostGroups(@GetOrgFromRequest() org: Organization) {
    const posts = await this.prisma.post.findMany({
      where: { organizationId: org.id, deletedAt: null },
      orderBy: { publishDate: 'desc' },
      take: 1000,
      select: {
        group: true,
        title: true,
        publishDate: true,
        state: true,
        integration: { select: { name: true } },
      },
    });
    const groups = new Map<string, {
      group: string;
      title: string | null;
      publishDate: Date;
      channels: string[];
      postCount: number;
    }>();
    for (const post of posts) {
      const current = groups.get(post.group);
      if (current) {
        current.postCount += 1;
        if (post.integration?.name && !current.channels.includes(post.integration.name)) {
          current.channels.push(post.integration.name);
        }
      } else {
        groups.set(post.group, {
          group: post.group,
          title: post.title,
          publishDate: post.publishDate,
          channels: post.integration?.name ? [post.integration.name] : [],
          postCount: 1,
        });
      }
    }
    return [...groups.values()];
  }

  @Get('/')
  async list(@GetOrgFromRequest() org: Organization) {
    return this.prisma.contentCampaign.findMany({
      where: { organizationId: org.id },
      orderBy: [{ updatedAt: 'desc' }],
      include: {
        _count: { select: { ideas: true, postGroups: true } },
      },
    });
  }

  @Post('/')
  async create(
    @GetOrgFromRequest() org: Organization,
    @Body() body: {
      name?: string;
      description?: string;
      goal?: string;
      status?: string;
      startAt?: string | null;
      endAt?: string | null;
    }
  ) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 120) {
      throw new BadRequestException('Campaign name must be between 1 and 120 characters.');
    }
    const status = body.status ?? 'planning';
    if (!CAMPAIGN_STATUSES.includes(status as (typeof CAMPAIGN_STATUSES)[number])) {
      throw new BadRequestException('Choose a valid campaign status.');
    }
    const startAt = optionalDate(body.startAt, 'Start date');
    const endAt = optionalDate(body.endAt, 'End date');
    if (startAt && endAt && startAt > endAt) {
      throw new BadRequestException('End date cannot be before start date.');
    }
    return this.prisma.contentCampaign.create({
      data: {
        name,
        description: typeof body.description === 'string' ? body.description.trim().slice(0, 4000) : '',
        goal: typeof body.goal === 'string' ? body.goal.trim().slice(0, 1000) : '',
        status,
        startAt: startAt ?? null,
        endAt: endAt ?? null,
        organizationId: org.id,
      },
    });
  }

  @Put('/:id')
  async update(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: {
      name?: string;
      description?: string;
      goal?: string;
      status?: string;
      startAt?: string | null;
      endAt?: string | null;
    }
  ) {
    const existing = await this.prisma.contentCampaign.findFirst({
      where: { id, organizationId: org.id },
    });
    if (!existing) throw new NotFoundException('Campaign not found.');

    const data: {
      name?: string;
      description?: string;
      goal?: string;
      status?: string;
      startAt?: Date | null;
      endAt?: Date | null;
    } = {};

    if (body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > 120) {
        throw new BadRequestException('Campaign name must be between 1 and 120 characters.');
      }
      data.name = name;
    }
    if (body.description !== undefined) {
      data.description = typeof body.description === 'string' ? body.description.trim().slice(0, 4000) : '';
    }
    if (body.goal !== undefined) {
      data.goal = typeof body.goal === 'string' ? body.goal.trim().slice(0, 1000) : '';
    }
    if (body.status !== undefined) {
      if (!CAMPAIGN_STATUSES.includes(body.status as (typeof CAMPAIGN_STATUSES)[number])) {
        throw new BadRequestException('Choose a valid campaign status.');
      }
      data.status = body.status;
    }
    const startAt = optionalDate(body.startAt, 'Start date');
    const endAt = optionalDate(body.endAt, 'End date');
    if (startAt !== undefined) data.startAt = startAt;
    if (endAt !== undefined) data.endAt = endAt;
    const effectiveStart = data.startAt !== undefined ? data.startAt : existing.startAt;
    const effectiveEnd = data.endAt !== undefined ? data.endAt : existing.endAt;
    if (effectiveStart && effectiveEnd && effectiveStart > effectiveEnd) {
      throw new BadRequestException('End date cannot be before start date.');
    }

    return this.prisma.contentCampaign.update({ where: { id }, data });
  }

  @Post('/:id/post-groups')
  async attachPostGroup(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: { postGroup?: string }
  ) {
    const campaign = await this.prisma.contentCampaign.findFirst({
      where: { id, organizationId: org.id },
      select: { id: true },
    });
    if (!campaign) throw new NotFoundException('Campaign not found.');

    const postGroup = typeof body.postGroup === 'string' ? body.postGroup.trim() : '';
    if (!postGroup || postGroup.length > 160) {
      throw new BadRequestException('Choose a valid post group.');
    }
    const posts = await this.prisma.post.findMany({
      where: { group: postGroup, organizationId: org.id, deletedAt: null },
      select: { id: true },
      take: 1,
    });
    if (!posts.length) throw new NotFoundException('Post group not found in this organization.');

    // One post group belongs to at most one campaign in an organization.
    // Re-attaching it moves the group rather than creating duplicates.
    return this.prisma.contentCampaignPost.upsert({
      where: {
        organizationId_postGroup: {
          organizationId: org.id,
          postGroup,
        },
      },
      create: {
        organizationId: org.id,
        campaignId: campaign.id,
        postGroup,
      },
      update: { campaignId: campaign.id },
    });
  }

  @Delete('/:id/post-groups/:postGroup')
  async detachPostGroup(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Param('postGroup') postGroup: string
  ) {
    const result = await this.prisma.contentCampaignPost.deleteMany({
      where: { campaignId: id, organizationId: org.id, postGroup },
    });
    if (result.count === 0) throw new NotFoundException('Campaign post group not found.');
    return { success: true };
  }

  @Get('/:id/post-groups')
  async campaignPostGroups(@GetOrgFromRequest() org: Organization, @Param('id') id: string) {
    const campaign = await this.prisma.contentCampaign.findFirst({
      where: { id, organizationId: org.id },
      select: { id: true },
    });
    if (!campaign) throw new NotFoundException('Campaign not found.');

    const links = await this.prisma.contentCampaignPost.findMany({
      where: { campaignId: id, organizationId: org.id },
      orderBy: { createdAt: 'desc' },
      select: { postGroup: true, createdAt: true },
    });
    if (!links.length) return [];

    const posts = await this.prisma.post.findMany({
      where: {
        organizationId: org.id,
        deletedAt: null,
        group: { in: links.map((link) => link.postGroup) },
      },
      orderBy: { publishDate: 'asc' },
      select: {
        group: true,
        title: true,
        content: true,
        state: true,
        publishDate: true,
        releaseURL: true,
        integration: { select: { name: true, providerIdentifier: true } },
      },
    });
    const grouped = new Map<string, {
      group: string;
      createdAt: Date;
      title: string | null;
      channels: string[];
      postCount: number;
      states: Record<string, number>;
      posts: Array<Record<string, unknown>>;
    }>();
    for (const link of links) {
      grouped.set(link.postGroup, {
        group: link.postGroup,
        createdAt: link.createdAt,
        title: null,
        channels: [],
        postCount: 0,
        states: {},
        posts: [],
      });
    }
    for (const post of posts) {
      const item = grouped.get(post.group);
      if (!item) continue;
      item.title ||= post.title;
      item.postCount += 1;
      item.states[String(post.state)] = (item.states[String(post.state)] || 0) + 1;
      if (post.integration?.name && !item.channels.includes(post.integration.name)) {
        item.channels.push(post.integration.name);
      }
      item.posts.push({
        title: post.title,
        state: post.state,
        publishDate: post.publishDate,
        releaseURL: post.releaseURL,
        channel: post.integration?.name || post.integration?.providerIdentifier || 'Channel',
        content: post.content,
      });
    }
    return [...grouped.values()];
  }

  @Delete('/:id')
  async remove(@GetOrgFromRequest() org: Organization, @Param('id') id: string) {
    const existing = await this.prisma.contentCampaign.findFirst({
      where: { id, organizationId: org.id },
    });
    if (!existing) throw new NotFoundException('Campaign not found.');
    await this.prisma.$transaction([
      this.prisma.contentIdea.updateMany({
        where: { organizationId: org.id, campaignId: id },
        data: { campaignId: null },
      }),
      this.prisma.contentCampaign.delete({ where: { id } }),
    ]);
    return { success: true };
  }

  @Get('/:id/analytics')
  async getCampaignAnalytics(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    const campaign = await this.prisma.contentCampaign.findFirst({
      where: { id, organizationId: org.id },
    });
    if (!campaign) throw new NotFoundException('Campaign not found.');

    const links = await this.prisma.contentCampaignPost.findMany({
      where: { campaignId: id, organizationId: org.id },
    });
    const postGroups = links.map((l) => l.postGroup);

    const posts = await this.prisma.post.findMany({
      where: { organizationId: org.id, group: { in: postGroups }, deletedAt: null },
      include: {
        integration: { select: { name: true, providerIdentifier: true } },
      },
    });

    const statesSummary: Record<string, number> = {
      PUBLISHED: 0,
      SCHEDULED: 0,
      DRAFT: 0,
      ERROR: 0,
    };
    const platformBreakdown: Record<string, { posts: number; published: number }> = {};

    posts.forEach((post) => {
      const stateStr = String(post.state);
      statesSummary[stateStr] = (statesSummary[stateStr] || 0) + 1;

      const plat = post.integration?.providerIdentifier || 'unknown';
      if (!platformBreakdown[plat]) platformBreakdown[plat] = { posts: 0, published: 0 };
      platformBreakdown[plat].posts += 1;
      if (stateStr === 'PUBLISHED') platformBreakdown[plat].published += 1;
    });

    // Count linked ideas
    const ideaCount = await this.prisma.contentIdea.count({
      where: { organizationId: org.id, campaignId: id },
    });

    return {
      campaignId: campaign.id,
      campaignName: campaign.name,
      status: campaign.status,
      startDate: campaign.startDate,
      endDate: campaign.endDate,
      totalPostGroups: postGroups.length,
      totalPosts: posts.length,
      statesSummary,
      platformBreakdown,
      linkedIdeasCount: ideaCount,
      metricsSupported: {
        reach: false,
        impressions: false,
        note: 'Live provider impressions will stream when connected account tokens provide read_insights permissions.',
      },
      topPosts: posts.slice(0, 10).map((p) => ({
        id: p.id,
        title: p.title,
        platform: p.integration?.name || p.integration?.providerIdentifier,
        state: p.state,
        publishDate: p.publishDate,
        releaseURL: p.releaseURL,
      })),
    };
  }

  @Get('/:id/report')
  async exportCampaignReport(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    const analytics = await this.getCampaignAnalytics(org, id);

    const csvRows = [
      ['Campaign Report', analytics.campaignName],
      ['Status', analytics.status],
      ['Total Posts', String(analytics.totalPosts)],
      ['Total Post Groups', String(analytics.totalPostGroups)],
      ['Linked Ideas', String(analytics.linkedIdeasCount)],
      [],
      ['Post Title', 'Platform', 'State', 'Publish Date', 'URL'],
      ...analytics.topPosts.map((p) => [
        p.title || 'Untitled',
        p.platform || '',
        String(p.state),
        p.publishDate ? new Date(p.publishDate).toISOString() : '',
        p.releaseURL || '',
      ]),
    ];

    const csvContent = csvRows.map((r) => r.map((c) => `"${(c || '').replace(/"/g, '""')}"`).join(',')).join('\n');

    return {
      campaignName: analytics.campaignName,
      analytics,
      csvContent,
    };
  }
}
