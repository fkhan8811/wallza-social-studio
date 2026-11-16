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
  Query,
} from '@nestjs/common';
import { Organization } from '@prisma/client';
import { ApiTags } from '@nestjs/swagger';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';

const DEFAULT_HASHTAG_GROUPS = [
  {
    name: 'Tech & Marketing',
    category: 'Growth & Business',
    tags: ['#Tech', '#B2BMarketing', '#Growth', '#Productivity', '#Automation'],
  },
  {
    name: 'Social Media Strategy',
    category: 'Social Media',
    tags: ['#SocialMediaMarketing', '#ContentCreator', '#ContentStrategy', '#SocialMediaTips', '#DigitalMarketing'],
  },
  {
    name: 'Creative & Design',
    category: 'Creative Design',
    tags: ['#DesignInspiration', '#VisualContent', '#BrandIdentity', '#CreativeStudio', '#GraphicDesign'],
  },
];

@ApiTags('Content Efficiency')
@Controller('/content')
export class ContentEfficiencyController {
  constructor(private readonly prisma: PrismaService) {}

  private async ensureDefaults(org: Organization) {
    const varCount = await (this.prisma as any).dynamicVariable.count({
      where: { organizationId: org.id },
    });
    if (varCount === 0) {
      const orgDefaults = [
        { name: 'brand_name', fallbackValue: org.name || 'Your Brand', description: 'Primary brand display name' },
        { name: 'website', fallbackValue: 'https://example.com', description: 'Main organization website' },
        { name: 'support_email', fallbackValue: 'support@example.com', description: 'Customer support email' },
        { name: 'call_to_action', fallbackValue: 'Learn more at the link in bio', description: 'Standard CTA closing line' },
      ];
      await (this.prisma as any).dynamicVariable.createMany({
        data: orgDefaults.map((v) => ({ ...v, organizationId: org.id })),
        skipDuplicates: true,
      }).catch(() => null);
    }

    const tagCount = await (this.prisma as any).hashtagGroup.count({
      where: { organizationId: org.id },
    });
    if (tagCount === 0) {
      await (this.prisma as any).hashtagGroup.createMany({
        data: DEFAULT_HASHTAG_GROUPS.map((g) => ({ ...g, organizationId: org.id })),
        skipDuplicates: true,
      }).catch(() => null);
    }
  }

  // ── 1. POST TEMPLATES ──────────────────────────────────────────────────────

  @Get('/templates')
  async listTemplates(
    @GetOrgFromRequest() org: Organization,
    @Query('category') category?: string,
    @Query('search') search?: string
  ) {
    const where: any = { organizationId: org.id };
    if (category && category !== 'all') {
      where.category = category;
    }
    if (search && search.trim()) {
      where.name = { contains: search.trim(), mode: 'insensitive' };
    }

    return (this.prisma as any).postTemplate.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
    });
  }

  @Post('/templates')
  async createTemplate(
    @GetOrgFromRequest() org: Organization,
    @Body() body: {
      name: string;
      category?: string;
      content: string;
      platformVersions?: Record<string, { content: string; mediaIds?: string[]; firstComment?: string }>;
      mediaIds?: string[];
      tags?: string[];
    }
  ) {
    if (!body.name || !body.name.trim()) throw new BadRequestException('Template name is required.');
    if (!body.content || !body.content.trim()) throw new BadRequestException('Template content is required.');

    return (this.prisma as any).postTemplate.create({
      data: {
        organizationId: org.id,
        name: body.name.trim(),
        category: body.category?.trim() || 'General',
        content: body.content.trim(),
        platformVersions: body.platformVersions || {},
        mediaIds: Array.isArray(body.mediaIds) ? body.mediaIds : [],
        tags: Array.isArray(body.tags) ? body.tags : [],
      },
    });
  }

  @Put('/templates/:id')
  async updateTemplate(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: {
      name?: string;
      category?: string;
      content?: string;
      platformVersions?: any;
      mediaIds?: string[];
      tags?: string[];
    }
  ) {
    const existing = await (this.prisma as any).postTemplate.findFirst({
      where: { id, organizationId: org.id },
    });
    if (!existing) throw new NotFoundException('Template not found.');

    const updateData: any = {};
    if (body.name && body.name.trim()) updateData.name = body.name.trim();
    if (body.category !== undefined) updateData.category = body.category.trim();
    if (body.content && body.content.trim()) updateData.content = body.content.trim();
    if (body.platformVersions !== undefined) updateData.platformVersions = body.platformVersions;
    if (Array.isArray(body.mediaIds)) updateData.mediaIds = body.mediaIds;
    if (Array.isArray(body.tags)) updateData.tags = body.tags;

    return (this.prisma as any).postTemplate.update({
      where: { id },
      data: updateData,
    });
  }

  @Delete('/templates/:id')
  async deleteTemplate(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    const existing = await (this.prisma as any).postTemplate.findFirst({
      where: { id, organizationId: org.id },
    });
    if (!existing) throw new NotFoundException('Template not found.');

    await (this.prisma as any).postTemplate.delete({ where: { id } });
    return { success: true, deletedId: id };
  }

  @Post('/templates/:id/duplicate')
  async duplicateTemplate(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    const existing = await (this.prisma as any).postTemplate.findFirst({
      where: { id, organizationId: org.id },
    });
    if (!existing) throw new NotFoundException('Template not found.');

    return (this.prisma as any).postTemplate.create({
      data: {
        organizationId: org.id,
        name: `${existing.name} (Copy)`,
        category: existing.category,
        content: existing.content,
        platformVersions: existing.platformVersions,
        mediaIds: existing.mediaIds,
        tags: existing.tags,
      },
    });
  }

  @Post('/templates/from-post/:postId')
  async createTemplateFromPost(
    @GetOrgFromRequest() org: Organization,
    @Param('postId') postId: string,
    @Body() body: { name?: string; category?: string }
  ) {
    const post = await this.prisma.post.findFirst({
      where: { id: postId, organizationId: org.id, deletedAt: null },
      include: { integration: { select: { providerIdentifier: true } } },
    });
    if (!post) throw new NotFoundException('Post not found in this organization.');

    // Fetch sibling variants in the same post group
    const siblingPosts = await this.prisma.post.findMany({
      where: { group: post.group, organizationId: org.id, deletedAt: null },
      include: { integration: { select: { providerIdentifier: true } } },
    });

    const platformVersions: Record<string, { content: string }> = {};
    for (const p of siblingPosts) {
      if (p.integration?.providerIdentifier) {
        platformVersions[p.integration.providerIdentifier] = {
          content: p.content,
        };
      }
    }

    let mediaIds: string[] = [];
    if (post.image) {
      try {
        const parsed = JSON.parse(post.image);
        if (Array.isArray(parsed)) {
          mediaIds = parsed.map((m: any) => m.id || m.url).filter(Boolean);
        }
      } catch {
        // ignore JSON parse error
      }
    }

    const templateName =
      (body.name && body.name.trim()) ||
      post.title ||
      `Template from ${post.integration?.providerIdentifier || 'Post'} (${new Date().toLocaleDateString()})`;

    return (this.prisma as any).postTemplate.create({
      data: {
        organizationId: org.id,
        name: templateName,
        category: body.category?.trim() || 'Post Snapshots',
        content: post.content,
        platformVersions,
        mediaIds,
        tags: [],
      },
    });
  }

  // ── 2. DYNAMIC VARIABLES ───────────────────────────────────────────────────

  @Get('/variables')
  async listVariables(@GetOrgFromRequest() org: Organization) {
    await this.ensureDefaults(org);
    return (this.prisma as any).dynamicVariable.findMany({
      where: { organizationId: org.id },
      orderBy: { name: 'asc' },
    });
  }

  @Post('/variables')
  async upsertVariable(
    @GetOrgFromRequest() org: Organization,
    @Body() body: { name: string; fallbackValue: string; description?: string }
  ) {
    if (!body.name || !body.name.trim()) throw new BadRequestException('Variable name is required.');
    const sanitizedName = body.name.toLowerCase().replace(/[^a-z0-9_]/g, '_');

    return (this.prisma as any).dynamicVariable.upsert({
      where: {
        organizationId_name: {
          organizationId: org.id,
          name: sanitizedName,
        },
      },
      create: {
        organizationId: org.id,
        name: sanitizedName,
        fallbackValue: body.fallbackValue ?? '',
        description: body.description?.trim() || null,
      },
      update: {
        fallbackValue: body.fallbackValue ?? '',
        description: body.description?.trim() || null,
      },
    });
  }

  @Delete('/variables/:id')
  async deleteVariable(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    const existing = await (this.prisma as any).dynamicVariable.findFirst({
      where: { id, organizationId: org.id },
    });
    if (!existing) throw new NotFoundException('Variable not found.');

    await (this.prisma as any).dynamicVariable.delete({ where: { id } });
    return { success: true, deletedId: id };
  }

  @Post('/variables/resolve')
  async resolveVariables(
    @GetOrgFromRequest() org: Organization,
    @Body() body: { text: string; overrides?: Record<string, string> }
  ) {
    if (typeof body.text !== 'string') throw new BadRequestException('Text string required.');

    const variables = await (this.prisma as any).dynamicVariable.findMany({
      where: { organizationId: org.id },
    });
    const varMap = new Map<string, string>();
    variables.forEach((v: any) => varMap.set(v.name, v.fallbackValue));

    // Apply explicit overrides
    if (body.overrides) {
      Object.entries(body.overrides).forEach(([k, val]) => varMap.set(k, val));
    }

    const regex = /\{([a-zA-Z0-9_]+)\}/g;
    const variablesUsed: string[] = [];
    const unresolvedVariables: string[] = [];

    const resolvedText = body.text.replace(regex, (match, varName) => {
      if (varMap.has(varName)) {
        variablesUsed.push(varName);
        return varMap.get(varName)!;
      }
      unresolvedVariables.push(varName);
      return match; // Leave unresolved in preview
    });

    return {
      originalText: body.text,
      resolvedText,
      variablesUsed: [...new Set(variablesUsed)],
      unresolvedVariables: [...new Set(unresolvedVariables)],
      isPublishSafe: unresolvedVariables.length === 0,
    };
  }

  @Post('/substitute-variables')
  async substituteVariables(
    @GetOrgFromRequest() org: Organization,
    @Body() body: { text: string; overrides?: Record<string, string> }
  ) {
    return this.resolveVariables(org, body);
  }

  // ── 3. HASHTAG GROUPS ──────────────────────────────────────────────────────

  @Get('/hashtag-groups')
  async listHashtagGroups(
    @GetOrgFromRequest() org: Organization,
    @Query('category') category?: string
  ) {
    await this.ensureDefaults(org);
    const where: any = { organizationId: org.id };
    if (category && category !== 'all') {
      where.category = category;
    }

    return (this.prisma as any).hashtagGroup.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
    });
  }

  @Post('/hashtag-groups')
  async createHashtagGroup(
    @GetOrgFromRequest() org: Organization,
    @Body() body: { name: string; category?: string; tags: string[] }
  ) {
    if (!body.name || !body.name.trim()) throw new BadRequestException('Group name is required.');
    if (!Array.isArray(body.tags) || body.tags.length === 0) {
      throw new BadRequestException('At least one hashtag is required.');
    }

    const cleanTags = body.tags
      .map((t) => (t.startsWith('#') ? t.trim() : `#${t.trim()}`))
      .filter((t) => t.length > 1);

    return (this.prisma as any).hashtagGroup.create({
      data: {
        organizationId: org.id,
        name: body.name.trim(),
        category: body.category?.trim() || 'General',
        tags: [...new Set(cleanTags)],
      },
    });
  }

  @Put('/hashtag-groups/:id')
  async updateHashtagGroup(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: { name?: string; category?: string; tags?: string[] }
  ) {
    const existing = await (this.prisma as any).hashtagGroup.findFirst({
      where: { id, organizationId: org.id },
    });
    if (!existing) throw new NotFoundException('Hashtag group not found.');

    const updateData: any = {};
    if (body.name && body.name.trim()) updateData.name = body.name.trim();
    if (body.category !== undefined) updateData.category = body.category.trim();
    if (Array.isArray(body.tags)) {
      const cleanTags = body.tags
        .map((t) => (t.startsWith('#') ? t.trim() : `#${t.trim()}`))
        .filter((t) => t.length > 1);
      updateData.tags = [...new Set(cleanTags)];
    }

    return (this.prisma as any).hashtagGroup.update({
      where: { id },
      data: updateData,
    });
  }

  @Delete('/hashtag-groups/:id')
  async deleteHashtagGroup(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    const existing = await (this.prisma as any).hashtagGroup.findFirst({
      where: { id, organizationId: org.id },
    });
    if (!existing) throw new NotFoundException('Hashtag group not found.');

    await (this.prisma as any).hashtagGroup.delete({ where: { id } });
    return { success: true, deletedId: id };
  }

  @Post('/hashtag-groups/combine')
  async combineHashtagGroups(
    @GetOrgFromRequest() org: Organization,
    @Body() body: { groupIds: string[] }
  ) {
    if (!Array.isArray(body.groupIds) || body.groupIds.length === 0) {
      throw new BadRequestException('groupIds array required.');
    }

    const groups = await (this.prisma as any).hashtagGroup.findMany({
      where: { id: { in: body.groupIds }, organizationId: org.id },
    });

    const allTags: string[] = [];
    groups.forEach((g: any) => {
      if (Array.isArray(g.tags)) allTags.push(...g.tags);
    });

    const uniqueTags = [...new Set(allTags)];
    const formattedString = uniqueTags.join(' ');

    return {
      uniqueTags,
      totalTags: uniqueTags.length,
      characterLength: formattedString.length,
      formattedString,
    };
  }
}

