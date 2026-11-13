import { Controller, Get, Param, Query, Res, Header } from '@nestjs/common';
import { Organization } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { ApiTags } from '@nestjs/swagger';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

@ApiTags('Analytics')
@Controller('/analytics')
export class AnalyticsController {
  constructor(
    private _integrationService: IntegrationService,
    private _postsService: PostsService,
    private _prisma: PrismaService
  ) {}

  @Get('/overview')
  async getOverview(
    @GetOrgFromRequest() org: Organization,
    @Query('days') daysRaw?: string
  ) {
    const days = Math.min(365, Math.max(1, parseInt(daysRaw || '30', 10) || 30));
    const sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const posts = await this._prisma.post.findMany({
      where: {
        organizationId: org.id,
        createdAt: { gte: sinceDate },
        deletedAt: null,
      },
      select: {
        id: true,
        state: true,
        requiresApproval: true,
        approvalStatus: true,
        publishDate: true,
        createdAt: true,
        integration: {
          select: {
            id: true,
            name: true,
            providerIdentifier: true,
          },
        },
      },
    });

    const counts = {
      total: posts.length,
      published: 0,
      queue: 0,
      draft: 0,
      error: 0,
      pendingApproval: 0,
    };

    const byProvider: Record<string, { published: number; error: number; scheduled: number }> = {};

    for (const p of posts) {
      if (p.state === 'PUBLISHED') counts.published++;
      else if (p.state === 'QUEUE') counts.queue++;
      else if (p.state === 'DRAFT') counts.draft++;
      else if (p.state === 'ERROR') counts.error++;

      if (p.requiresApproval && p.approvalStatus === 'pending') {
        counts.pendingApproval++;
      }

      const provider = p.integration?.providerIdentifier || 'unknown';
      if (!byProvider[provider]) {
        byProvider[provider] = { published: 0, error: 0, scheduled: 0 };
      }
      if (p.state === 'PUBLISHED') byProvider[provider].published++;
      else if (p.state === 'ERROR') byProvider[provider].error++;
      else if (p.state === 'QUEUE') byProvider[provider].scheduled++;
    }

    const attempts = counts.published + counts.error;
    const successRate = attempts > 0 ? ((counts.published / attempts) * 100).toFixed(1) : '100.0';

    return {
      periodDays: days,
      since: sinceDate.toISOString(),
      counts,
      successRate: parseFloat(successRate),
      channelPerformance: byProvider,
    };
  }

  @Get('/platform-comparison')
  async getPlatformComparison(
    @GetOrgFromRequest() org: Organization,
    @Query('days') daysRaw?: string
  ) {
    const days = Math.min(365, Math.max(1, parseInt(daysRaw || '30', 10) || 30));
    const sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const integrations = await this._prisma.integration.findMany({
      where: { organizationId: org.id, disabled: false },
      select: {
        id: true,
        name: true,
        providerIdentifier: true,
        picture: true,
      },
    });

    const posts = await this._prisma.post.findMany({
      where: {
        organizationId: org.id,
        createdAt: { gte: sinceDate },
        deletedAt: null,
      },
      select: {
        integrationId: true,
        state: true,
      },
    });

    const metricsByIntegration = new Map<string, { published: number; errors: number; queued: number }>();
    for (const post of posts) {
      if (!post.integrationId) continue;
      const current = metricsByIntegration.get(post.integrationId) || { published: 0, errors: 0, queued: 0 };
      if (post.state === 'PUBLISHED') current.published++;
      else if (post.state === 'ERROR') current.errors++;
      else if (post.state === 'QUEUE') current.queued++;
      metricsByIntegration.set(post.integrationId, current);
    }

    const comparison = integrations.map((int) => {
      const stats = metricsByIntegration.get(int.id) || { published: 0, errors: 0, queued: 0 };
      const totalAttempts = stats.published + stats.errors;
      const reliabilityRate = totalAttempts > 0 ? ((stats.published / totalAttempts) * 100).toFixed(1) : '100.0';
      return {
        integrationId: int.id,
        name: int.name,
        providerIdentifier: int.providerIdentifier,
        picture: int.picture,
        publishedCount: stats.published,
        queuedCount: stats.queued,
        errorCount: stats.errors,
        reliabilityRate: parseFloat(reliabilityRate),
      };
    });

    return {
      periodDays: days,
      platforms: comparison,
    };
  }

  @Get('/export')
  async exportAnalytics(
    @GetOrgFromRequest() org: Organization,
    @Query('format') formatRaw?: string,
    @Query('days') daysRaw?: string
  ) {
    const format = (formatRaw || 'json').toLowerCase();
    const days = Math.min(365, Math.max(1, parseInt(daysRaw || '30', 10) || 30));
    const sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const posts = await this._prisma.post.findMany({
      where: {
        organizationId: org.id,
        createdAt: { gte: sinceDate },
        deletedAt: null,
      },
      orderBy: { createdAt: 'desc' },
      take: 1000,
      select: {
        id: true,
        group: true,
        title: true,
        state: true,
        requiresApproval: true,
        approvalStatus: true,
        publishDate: true,
        createdAt: true,
        content: true,
        integration: {
          select: {
            name: true,
            providerIdentifier: true,
          },
        },
      },
    });

    if (format === 'csv') {
      const header = 'id,group,title,channel,provider,state,approvalStatus,publishDate,createdAt,charCount\n';
      const rows = posts.map((p) => {
        const safeTitle = `"${(p.title || '').replace(/"/g, '""')}"`;
        const channelName = `"${(p.integration?.name || '').replace(/"/g, '""')}"`;
        const provider = p.integration?.providerIdentifier || 'unknown';
        const approval = p.approvalStatus || 'none';
        const pubDate = p.publishDate ? p.publishDate.toISOString() : '';
        const created = p.createdAt ? p.createdAt.toISOString() : '';
        const charCount = p.content ? p.content.length : 0;
        return `${p.id},${p.group},${safeTitle},${channelName},${provider},${p.state},${approval},${pubDate},${created},${charCount}`;
      }).join('\n');

      return {
        format: 'csv',
        filename: `social_analytics_export_${new Date().toISOString().slice(0, 10)}.csv`,
        content: header + rows,
      };
    }

    return {
      format: 'json',
      exportedAt: new Date().toISOString(),
      periodDays: days,
      totalCount: posts.length,
      posts,
    };
  }

  @Get('/:integration')
  async getIntegration(
    @GetOrgFromRequest() org: Organization,
    @Param('integration') integration: string,
    @Query('date') date: string
  ) {
    return this._integrationService.checkAnalytics(org, integration, date);
  }

  @Get('/post/:postId')
  async getPostAnalytics(
    @GetOrgFromRequest() org: Organization,
    @Param('postId') postId: string,
    @Query('date') date: string
  ) {
    return this._postsService.checkPostAnalytics(org.id, postId, +date);
  }
}
