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

  // ── GENUINE AI & MCP WORKFLOW OPERATIONS ─────────────────────────────────

  private async callAiEngine(messages: any[], maxTokens = 1200): Promise<{ content: string; provider: string; model: string } | null> {
    const apiKey = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) return null;

    const isRouter = !!process.env.OPENROUTER_API_KEY;
    const url = isRouter
      ? 'https://openrouter.ai/api/v1/chat/completions'
      : 'https://api.openai.com/v1/chat/completions';
    const model = isRouter
      ? (process.env.AI_MODEL || 'meta-llama/llama-3-8b-instruct')
      : 'gpt-4o-mini';

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          ...(isRouter ? { 'HTTP-Referer': 'https://app.wallza.in', 'X-Title': 'Wallza Social Studio' } : {}),
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: maxTokens,
          temperature: 0.7,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) return null;
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      return content ? { content, provider: isRouter ? 'openrouter' : 'openai', model } : null;
    } catch {
      clearTimeout(timeout);
      return null;
    }
  }

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

    let generatedIdeas: Array<{
      id: string;
      title: string;
      description: string;
      angle: string;
      platform: string;
      tags: string[];
    }> = [];
    let source: 'ai' | 'fallback' = 'fallback';
    let aiMeta: any = null;

    // 1. Attempt genuine AI generation via configured OpenRouter / OpenAI provider
    const aiResult = await this.callAiEngine([
      {
        role: 'system',
        content: `You are Wallza Social Studio's Senior Content Strategist. Generate exactly ${count} distinct, high-performing content angles for topic "${body.topic}" tailored across platforms: ${platforms.join(', ')}.
Return ONLY valid JSON matching this schema:
{"ideas": [{"title": "Short punchy headline", "description": "2-3 sentences with hook, value points, and CTA", "angle": "Tactical/Contrarian/Case Study/Framework", "platform": "x/linkedin/instagram", "tags": ["tag1", "tag2"]}]}`,
      },
      {
        role: 'user',
        content: `Generate ${count} ideas for topic: ${body.topic}`,
      },
    ]);

    if (aiResult?.content) {
      try {
        const cleanedJson = aiResult.content
          .replace(/```json/gi, '')
          .replace(/```/g, '')
          .trim();
        const parsed = JSON.parse(cleanedJson);
        if (Array.isArray(parsed?.ideas) && parsed.ideas.length > 0) {
          generatedIdeas = parsed.ideas.slice(0, count).map((item: any) => ({
            id: `idea_${randomUUID().slice(0, 8)}`,
            title: String(item.title || body.topic).slice(0, 140),
            description: String(item.description || '').slice(0, 500),
            angle: String(item.angle || 'Strategic Angle'),
            platform: String(item.platform || platforms[0]).toLowerCase(),
            tags: Array.isArray(item.tags)
              ? item.tags.map((t: string) => String(t).replace(/^#/, '').toLowerCase()).slice(0, 5)
              : [body.topic.toLowerCase().replace(/\s+/g, '')],
          }));
          source = 'ai';
          aiMeta = { provider: aiResult.provider, model: aiResult.model };
        }
      } catch {
        // Fallback on JSON parse error
      }
    }

    // 2. Deterministic calibrated templates as robust offline fallback
    if (generatedIdeas.length === 0) {
      const templates = [
        {
          angle: 'Tactical Breakdown',
          title: `How to master ${body.topic} in 5 steps`,
          desc: `Actionable framework for teams scaling ${body.topic}. Focus on common pitfalls, real metrics, and immediate wins.`,
          tags: [body.topic.toLowerCase().replace(/\s+/g, ''), 'productivity', 'tactics'],
        },
        {
          angle: 'Contrarian Perspective',
          title: `Why conventional wisdom fails around ${body.topic}`,
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
        generatedIdeas.push({
          id: `idea_${randomUUID().slice(0, 8)}`,
          title: `${template.title} [${platform.toUpperCase()}]`,
          description: template.desc,
          angle: template.angle,
          platform,
          tags: template.tags,
        });
      }
      source = 'fallback';
    }

    // 3. Optional persistence to ContentIdea pipeline
    if (body.autoSave) {
      const defaultStage = await (this._prisma as any).contentIdeaStage.findFirst({
        where: { organizationId: organization.id },
        orderBy: { position: 'asc' },
      });
      if (defaultStage) {
        for (const idea of generatedIdeas) {
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
      source,
      aiMeta: aiMeta || { note: 'Generated using calibrated content strategist templates (AI key not set or unreachable).' },
      topic: body.topic,
      generatedCount: generatedIdeas.length,
      ideas: generatedIdeas,
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

    const platformLimits: Record<string, number> = {
      x: 280,
      twitter: 280,
      bluesky: 300,
      threads: 500,
      instagram: 2200,
      linkedin: 3000,
      facebook: 5000,
    };

    let variants: Record<string, {
      content: string;
      characterCount: number;
      maxRecommended: number;
      isTruncated: boolean;
      truncationReason?: string | null;
      note: string;
    }> = {};
    let source: 'ai' | 'fallback' = 'fallback';

    // 1. Attempt genuine AI variant generation
    const aiResult = await this.callAiEngine([
      {
        role: 'system',
        content: `You are an expert social media copywriter. Adapt the given base content for each platform respecting their native formatting conventions:
- x / twitter: Under 270 chars, strong hook, bulleted takeaways, max 1 hashtag.
- linkedin: Professional narrative, double spacing between thoughts, thought-provoking question, 3-5 tags.
- instagram: Visual-first caption, structured emojis, CTA, followed by clean line-breaks and 5-8 relevant hashtags.
- facebook: Engaging community-first storytelling with discussion question.
- threads: Informal, conversational, authentic tone.

Return ONLY valid JSON:
{"variants": {"x": {"content": "...", "note": "..."}, "linkedin": {"content": "...", "note": "..."}, "instagram": {"content": "...", "note": "..."}, "facebook": {"content": "...", "note": "..."}}}`,
      },
      {
        role: 'user',
        content: `Base Content:\n${cleanBase}\n\nPlatforms: ${platforms.join(', ')}`,
      },
    ]);

    if (aiResult?.content) {
      try {
        const cleanedJson = aiResult.content
          .replace(/```json/gi, '')
          .replace(/```/g, '')
          .trim();
        const parsed = JSON.parse(cleanedJson);
        if (parsed?.variants && typeof parsed.variants === 'object') {
          for (const p of platforms) {
            const lower = p.toLowerCase();
            const rawItem = parsed.variants[lower] || parsed.variants[p];
            if (rawItem && typeof rawItem.content === 'string') {
              const max = platformLimits[lower] || 3000;
              const content = rawItem.content.trim();
              const isTruncated = content.length > max;
              const finalContent = isTruncated ? `${content.slice(0, max - 3)}...` : content;
              variants[p] = {
                content: finalContent,
                characterCount: finalContent.length,
                maxRecommended: max,
                isTruncated,
                truncationReason: isTruncated ? `Exceeded platform limit of ${max} characters.` : null,
                note: rawItem.note || `Adapted with native ${p.toUpperCase()} formatting.`,
              };
            }
          }
          if (Object.keys(variants).length > 0) {
            source = 'ai';
          }
        }
      } catch {
        // Fallback to rules on error
      }
    }

    // 2. Fallback rule-based adapter when AI is unavailable
    if (Object.keys(variants).length === 0) {
      for (const p of platforms) {
        const lower = p.toLowerCase();
        const max = platformLimits[lower] || 3000;
        if (lower.includes('x') || lower.includes('twitter') || lower.includes('bluesky')) {
          const isTruncated = cleanBase.length > (max - 10);
          const formatted = isTruncated ? `${cleanBase.slice(0, max - 13)}...` : cleanBase;
          variants[p] = {
            content: formatted,
            characterCount: formatted.length,
            maxRecommended: max,
            isTruncated,
            truncationReason: isTruncated ? `Content exceeded ${max} characters and was trimmed to retain hook.` : null,
            note: 'Optimized for high-impact hook and scannability within short character limit.',
          };
        } else if (lower.includes('linkedin')) {
          const linkedInFormatted = `${cleanBase}\n\nWhat are your thoughts on this?\n\n#Leadership #Innovation #Growth`;
          variants[p] = {
            content: linkedInFormatted,
            characterCount: linkedInFormatted.length,
            maxRecommended: max,
            isTruncated: false,
            truncationReason: null,
            note: 'Formatted with professional pacing, conversational question, and thought leadership tags.',
          };
        } else if (lower.includes('instagram') || lower.includes('threads')) {
          const instaFormatted = `${cleanBase}\n.\n.\n👉 Double tap if this helped.\n📌 Save for later reference.`;
          variants[p] = {
            content: instaFormatted,
            characterCount: instaFormatted.length,
            maxRecommended: max,
            isTruncated: false,
            truncationReason: null,
            note: 'Visual caption layout with engagement CTA and clean line break spacing.',
          };
        } else {
          variants[p] = {
            content: cleanBase,
            characterCount: cleanBase.length,
            maxRecommended: max,
            isTruncated: false,
            truncationReason: null,
            note: 'Full-length omnichannel post copy.',
          };
        }
      }
      source = 'fallback';
    }

    return {
      source,
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
