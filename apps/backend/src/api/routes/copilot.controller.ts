import {
  Logger,
  Controller,
  Get,
  Post,
  Req,
  Res,
  Query,
  Param,
  Body,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import {
  CopilotRuntime,
  OpenAIAdapter,
  copilotRuntimeNodeHttpEndpoint,
} from '@copilotkit/runtime';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { Organization } from '@prisma/client';
import { SubscriptionService } from '@gitroom/nestjs-libraries/database/prisma/subscriptions/subscription.service';
import { MastraAgent } from '@ag-ui/mastra';
import { MastraService } from '@gitroom/nestjs-libraries/chat/mastra.service';
import { Request, Response } from 'express';
import { RequestContext } from '@mastra/core/di';
import { CheckPolicies } from '@gitroom/backend/services/auth/permissions/permissions.ability';
import { AuthorizationActions, Sections } from '@gitroom/backend/services/auth/permissions/permission.exception.class';

export type ChannelsContext = {
  integrations: string;
  organization: string;
  ui: string;
};

// the copilot runtime writes its own CORS headers on the response, keep them aligned with main.ts
const copilotCors = () => ({
  origin: [
    process.env.FRONTEND_URL,
    'http://localhost:6274',
    ...(process.env.MAIN_URL ? [process.env.MAIN_URL] : []),
  ],
  credentials: !process.env.NOT_SECURED,
});

@Controller('/copilot')
export class CopilotController {
  constructor(
    private _subscriptionService: SubscriptionService,
    private _mastraService: MastraService,
    private _prisma: PrismaService
  ) {}
  @Post('/chat')
  chatAgent(@Req() req: Request, @Res() res: Response) {
    if (
      process.env.OPENAI_API_KEY === undefined ||
      process.env.OPENAI_API_KEY === ''
    ) {
      Logger.warn('OpenAI API key not set, chat functionality will not work');
      return;
    }

    const copilotRuntimeHandler = copilotRuntimeNodeHttpEndpoint({
      endpoint: '/copilot/chat',
      cors: copilotCors(),
      runtime: new CopilotRuntime(),
      serviceAdapter: new OpenAIAdapter({
        model: 'gpt-4.1',
      }),
    });

    return copilotRuntimeHandler(req, res);
  }

  @Post('/agent')
  @CheckPolicies([AuthorizationActions.Create, Sections.AI])
  async agent(
    @Req() req: Request,
    @Res() res: Response,
    @GetOrgFromRequest() organization: Organization
  ) {
    if (
      process.env.OPENAI_API_KEY === undefined ||
      process.env.OPENAI_API_KEY === ''
    ) {
      Logger.warn('OpenAI API key not set, chat functionality will not work');
      return;
    }
    const mastra = await this._mastraService.mastra();
    const requestContext = new RequestContext<ChannelsContext>();
    requestContext.set(
      'integrations',
      req?.body?.body?.forwardedProps?.integrations || []
    );

    requestContext.set('organization', JSON.stringify(organization));
    requestContext.set('ui', 'true');

    const agents = MastraAgent.getLocalAgents({
      resourceId: organization.id,
      mastra,
      requestContext: requestContext as any,
    });

    const runtime = new CopilotRuntime({
      agents,
    });

    const copilotRuntimeHandler = copilotRuntimeNodeHttpEndpoint({
      endpoint: '/copilot/agent',
      cors: copilotCors(),
      runtime,
      serviceAdapter: new OpenAIAdapter({
        model: 'gpt-4.1',
      }),
    });

    return copilotRuntimeHandler(req, res);
  }

  @Get('/credits')
  calculateCredits(
    @GetOrgFromRequest() organization: Organization,
    @Query('type')
    type: 'ai_images' | 'ai_videos' | 'clipping_minutes'
  ) {
    return this._subscriptionService.checkCredits(
      organization,
      type || 'ai_images'
    );
  }

  @Get('/:thread/list')
  @CheckPolicies([AuthorizationActions.Create, Sections.AI])
  async getMessagesList(
    @GetOrgFromRequest() organization: Organization,
    @Param('thread') threadId: string
  ): Promise<any> {
    const mastra = await this._mastraService.mastra();
    const memory = await mastra.getAgent('postiz').getMemory();
    try {
      return await memory.recall({
        resourceId: organization.id,
        threadId,
      });
    } catch (err) {
      Logger.warn(`Could not recall messages for thread ${threadId}: ${err}`);
      return { messages: [] };
    }
  }

  @Get('/list')
  @CheckPolicies([AuthorizationActions.Create, Sections.AI])
  async getList(@GetOrgFromRequest() organization: Organization) {
    const mastra = await this._mastraService.mastra();
    const memory = await mastra.getAgent('postiz').getMemory();
    const list = await memory.listThreads({
      filter: { resourceId: organization.id },
      perPage: 100000,
      page: 0,
      orderBy: { field: 'createdAt', direction: 'DESC' },
    });

    return {
      threads: list.threads.map((p) => ({
        id: p.id,
        title: p.title,
      })),
    };
  }

  // ── DETERMINISTIC AI & MCP WORKFLOW OPERATIONS ─────────────────────────────

  @Post('/operations/generate-ideas')
  async generateIdeas(
    @GetOrgFromRequest() organization: Organization,
    @Body()
    body: {
      topic: string;
      platforms?: string[];
      count?: number;
      autoSave?: boolean;
    }
  ) {
    if (!body.topic || !body.topic.trim()) {
      throw new BadRequestException('A topic is required to generate ideas.');
    }

    const count = Math.min(10, Math.max(1, body.count || 3));
    const platforms = Array.isArray(body.platforms) && body.platforms.length > 0
      ? body.platforms
      : ['linkedin', 'x', 'instagram'];

    const ideas = [];
    const templates = [
      {
        angle: 'Tactical Breakdown',
        title: `How to master ${body.topic} in 5 steps`,
        desc: `Actionable framework for teams scaling ${body.topic}. Focus on common pitfalls, real metrics, and immediate wins.`,
        tags: [body.topic.toLowerCase().replace(/\s+/g, ''), 'productivity', 'tactics'],
      },
      {
        angle: 'Contrarian Perspective',
        title: `Why everyone is wrong about ${body.topic}`,
        desc: `Debunking standard industry assumptions regarding ${body.topic}. What the data actually proves and why conventional wisdom fails.`,
        tags: [body.topic.toLowerCase().replace(/\s+/g, ''), 'hot-take', 'insights'],
      },
      {
        angle: 'Case Study & Results',
        title: `What happened when we completely revamped ${body.topic}`,
        desc: `Behind-the-scenes metrics, before/after numbers, and key takeaways from optimizing ${body.topic}.`,
        tags: [body.topic.toLowerCase().replace(/\s+/g, ''), 'casestudy', 'growth'],
      },
      {
        angle: 'Curated Resource Kit',
        title: `The ultimate checklist for ${body.topic}`,
        desc: `Comprehensive swipe-file and operational checklist for anyone executing ${body.topic} this quarter.`,
        tags: [body.topic.toLowerCase().replace(/\s+/g, ''), 'cheatsheet', 'resources'],
      },
      {
        angle: 'Future Trends & Predictions',
        title: `The future of ${body.topic} over the next 18 months`,
        desc: `Emerging trends, technology shifts, and strategic positioning to stay ahead in ${body.topic}.`,
        tags: [body.topic.toLowerCase().replace(/\s+/g, ''), 'trends', 'future'],
      },
    ];

    for (let i = 0; i < count; i++) {
      const template = templates[i % templates.length];
      const platform = platforms[i % platforms.length];
      ideas.push({
        id: `idea_${randomUUID().slice(0, 8)}`,
        title: `${template.title} [${platform.toUpperCase()}]`,
        description: template.desc,
        angle: template.angle,
        platform,
        tags: template.tags,
      });
    }

    if (body.autoSave) {
      const defaultStage = await (this._prisma as any).contentIdeaStage.findFirst({
        where: { organizationId: organization.id },
        orderBy: { position: 'asc' },
      });
      if (defaultStage) {
        for (const idea of ideas) {
          await (this._prisma as any).contentIdea.create({
            data: {
              organizationId: organization.id,
              stageId: defaultStage.id,
              title: idea.title,
              description: idea.description,
              tags: idea.tags,
            },
          }).catch(() => null);
        }
      }
    }

    return {
      topic: body.topic,
      generatedCount: ideas.length,
      ideas,
      savedToInbox: !!body.autoSave,
    };
  }

  @Post('/operations/convert-idea-to-draft')
  async convertIdeaToDraft(
    @GetOrgFromRequest() organization: Organization,
    @Body() body: { ideaId: string; integrationId?: string }
  ) {
    if (!body.ideaId) throw new BadRequestException('ideaId is required.');

    const idea = await (this._prisma as any).contentIdea.findFirst({
      where: { id: body.ideaId, organizationId: organization.id },
    });
    if (!idea) throw new NotFoundException('Idea not found in this organization.');

    let targetIntegrationId = body.integrationId;
    if (!targetIntegrationId) {
      const firstIntegration = await this._prisma.integration.findFirst({
        where: { organizationId: organization.id, disabled: false },
      });
      targetIntegrationId = firstIntegration?.id;
    }
    if (!targetIntegrationId) {
      throw new BadRequestException('No connected channel found. Connect a channel first.');
    }

    const postGroup = randomUUID();
    const draftPost = await this._prisma.post.create({
      data: {
        organizationId: organization.id,
        integrationId: targetIntegrationId,
        content: idea.description ? `${idea.title}\n\n${idea.description}` : idea.title,
        title: idea.title,
        group: postGroup,
        state: 'DRAFT',
        publishDate: new Date(Date.now() + 24 * 3600 * 1000), // Default 24h out
      },
    });

    return {
      success: true,
      draftPostId: draftPost.id,
      postGroup,
      title: draftPost.title,
      state: draftPost.state,
      message: 'Idea successfully converted into draft post.',
    };
  }

  @Post('/operations/generate-platform-variants')
  async generatePlatformVariants(
    @GetOrgFromRequest() organization: Organization,
    @Body() body: { baseContent: string; platforms?: string[] }
  ) {
    if (!body.baseContent || !body.baseContent.trim()) {
      throw new BadRequestException('baseContent is required.');
    }

    const cleanBase = body.baseContent.trim();
    const platforms = Array.isArray(body.platforms) && body.platforms.length > 0
      ? body.platforms
      : ['x', 'linkedin', 'instagram', 'facebook'];

    const variants: Record<string, { content: string; characterCount: number; maxRecommended: number; note: string }> = {};

    for (const p of platforms) {
      const lower = p.toLowerCase();
      if (lower.includes('x') || lower.includes('twitter') || lower.includes('bluesky')) {
        const truncated = cleanBase.length > 270 ? `${cleanBase.slice(0, 267)}...` : cleanBase;
        variants[p] = {
          content: truncated,
          characterCount: truncated.length,
          maxRecommended: 280,
          note: 'Optimized for high-impact hook and scannability within short character limit.',
        };
      } else if (lower.includes('linkedin')) {
        const linkedInFormatted = `${cleanBase}\n\nWhat are your thoughts on this?\n\n#Leadership #Innovation #Growth`;
        variants[p] = {
          content: linkedInFormatted,
          characterCount: linkedInFormatted.length,
          maxRecommended: 3000,
          note: 'Formatted with professional pacing, conversational question, and thought leadership tags.',
        };
      } else if (lower.includes('instagram') || lower.includes('threads')) {
        const instaFormatted = `${cleanBase}\n.\n.\n👉 Double tap if this helped.\n📌 Save for later reference.`;
        variants[p] = {
          content: instaFormatted,
          characterCount: instaFormatted.length,
          maxRecommended: 2200,
          note: 'Visual caption layout with engagement CTA and clean line break spacing.',
        };
      } else {
        variants[p] = {
          content: cleanBase,
          characterCount: cleanBase.length,
          maxRecommended: 5000,
          note: 'Full-length omnichannel post copy.',
        };
      }
    }

    return {
      originalContent: cleanBase,
      variants,
    };
  }

  @Post('/operations/check-approval-status')
  async checkApprovalStatus(
    @GetOrgFromRequest() organization: Organization,
    @Body() body: { postGroup: string }
  ) {
    if (!body.postGroup) throw new BadRequestException('postGroup is required.');

    const posts = await this.prisma.post.findMany({
      where: { group: body.postGroup, organizationId: organization.id, deletedAt: null },
      select: {
        id: true,
        title: true,
        state: true,
        requiresApproval: true,
        approvalStatus: true,
        approvedById: true,
        approvedAt: true,
      },
    });

    if (!posts.length) throw new NotFoundException('Post group not found.');

    const root = posts[0];
    return {
      postGroup: body.postGroup,
      postsCount: posts.length,
      requiresApproval: !!root.requiresApproval,
      approvalStatus: root.approvalStatus || 'none',
      isApproved: !root.requiresApproval || root.approvalStatus === 'approved',
      approvedById: root.approvedById,
      approvedAt: root.approvedAt,
    };
  }

  @Post('/operations/retry-failed-post')
  async retryFailedPost(
    @GetOrgFromRequest() organization: Organization,
    @Body() body: { postId: string }
  ) {
    if (!body.postId) throw new BadRequestException('postId is required.');

    const post = await this.prisma.post.findFirst({
      where: { id: body.postId, organizationId: organization.id, deletedAt: null },
    });
    if (!post) throw new NotFoundException('Post not found in this organization.');
    if (post.state !== 'ERROR') {
      throw new BadRequestException(`Post state is ${post.state}, only ERROR posts can be retried.`);
    }

    const resetPost = await this.prisma.post.update({
      where: { id: body.postId },
      data: {
        state: 'QUEUE',
        error: null,
      },
    });

    return {
      success: true,
      postId: resetPost.id,
      state: resetPost.state,
      message: 'Post state reset to QUEUE for retry.',
    };
  }

  // Alias getter for PrismaService in this controller
  private get prisma() {
    return this._prisma;
  }
}
