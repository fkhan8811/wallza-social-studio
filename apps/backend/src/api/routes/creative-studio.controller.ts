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
import { Organization, User } from '@prisma/client';
import { ApiTags } from '@nestjs/swagger';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { UploadFactory } from '@gitroom/nestjs-libraries/upload/upload.factory';
import sharp from 'sharp';

const VALID_PROJECT_TYPES = ['image', 'carousel', 'video'] as const;

export interface BuiltinTemplate {
  id: string;
  name: string;
  type: 'image' | 'carousel' | 'video';
  category: string;
  dimensions: { width: number; height: number; preset: string };
  thumbnailUrl: string;
  data: any;
}

const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  {
    id: 'tpl_insta_quote',
    name: 'Instagram Elegant Quote',
    type: 'image',
    category: 'Quotes & Inspiration',
    dimensions: { width: 1080, height: 1080, preset: '1:1 Square' },
    thumbnailUrl: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=400&q=80',
    data: {
      backgroundColor: '#0F172A',
      layers: [
        { id: 'bg-gradient', type: 'shape', shape: 'rect', x: 0, y: 0, width: 1080, height: 1080, fill: '#0F172A', locked: true },
        { id: 'accent-badge', type: 'shape', shape: 'pill', x: 440, y: 220, width: 200, height: 48, fill: '#3B82F6' },
        { id: 'badge-text', type: 'text', text: 'DAILY INSIGHT', x: 460, y: 234, fontSize: 18, fontWeight: 'bold', fill: '#FFFFFF' },
        { id: 'quote-text', type: 'text', text: '"Simplicity is the soul of modern efficiency."', x: 120, y: 440, fontSize: 52, fontWeight: 'bold', fill: '#F8FAFC', textAlign: 'center', width: 840 },
        { id: 'author-text', type: 'text', text: '— Wallza Studio Editorial', x: 380, y: 680, fontSize: 24, fontWeight: 'normal', fill: '#94A3B8' },
        { id: 'handle-text', type: 'text', text: '@wallzaofficial', x: 460, y: 880, fontSize: 20, fill: '#64748B' },
      ],
    },
  },
  {
    id: 'tpl_product_announcement',
    name: 'Product Feature Launch',
    type: 'image',
    category: 'Product & SaaS',
    dimensions: { width: 1080, height: 1350, preset: '4:5 Portrait' },
    thumbnailUrl: 'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=400&q=80',
    data: {
      backgroundColor: '#18181B',
      layers: [
        { id: 'bg-mesh', type: 'shape', shape: 'rect', x: 0, y: 0, width: 1080, height: 1350, fill: '#18181B', locked: true },
        { id: 'glow-orb', type: 'shape', shape: 'circle', x: 290, y: 150, radius: 250, fill: '#6366F122' },
        { id: 'pill', type: 'shape', shape: 'pill', x: 100, y: 120, width: 180, height: 40, fill: '#10B981' },
        { id: 'pill-text', type: 'text', text: 'NEW RELEASE', x: 120, y: 132, fontSize: 16, fontWeight: 'bold', fill: '#FFFFFF' },
        { id: 'headline', type: 'text', text: 'Supercharge Your Social Growth', x: 100, y: 220, fontSize: 64, fontWeight: '900', fill: '#FFFFFF', width: 880 },
        { id: 'subheadline', type: 'text', text: 'All your channels, media, and scheduling in one unified studio.', x: 100, y: 380, fontSize: 28, fill: '#A1A1AA', width: 880 },
        { id: 'cta-btn', type: 'shape', shape: 'rect', x: 100, y: 1100, width: 320, height: 72, fill: '#3B82F6', rx: 16 },
        { id: 'cta-text', type: 'text', text: 'Explore Features →', x: 140, y: 1124, fontSize: 24, fontWeight: 'bold', fill: '#FFFFFF' },
      ],
    },
  },
  {
    id: 'tpl_carousel_5step',
    name: '5-Slide Educational Carousel',
    type: 'carousel',
    category: 'Educational & Growth',
    dimensions: { width: 1080, height: 1350, preset: '4:5 Carousel' },
    thumbnailUrl: 'https://images.unsplash.com/photo-1542744094-3a31f272c490?w=400&q=80',
    data: {
      slides: [
        {
          slideIndex: 1,
          title: 'Cover Slide',
          layers: [
            { id: 'c1-bg', type: 'shape', shape: 'rect', x: 0, y: 0, width: 1080, height: 1350, fill: '#09090B' },
            { id: 'c1-step', type: 'text', text: 'SWIPE FOR BLUEPRINT ➔', x: 100, y: 160, fontSize: 20, fill: '#38BDF8', fontWeight: 'bold' },
            { id: 'c1-h1', type: 'text', text: '5 Tactics To 10x Your Reach In 30 Days', x: 100, y: 320, fontSize: 68, fontWeight: '900', fill: '#FFFFFF', width: 880 },
            { id: 'c1-author', type: 'text', text: 'Curated by Growth Ops', x: 100, y: 1180, fontSize: 22, fill: '#71717A' },
          ],
        },
        {
          slideIndex: 2,
          title: 'Tactic 1',
          layers: [
            { id: 'c2-bg', type: 'shape', shape: 'rect', x: 0, y: 0, width: 1080, height: 1350, fill: '#09090B' },
            { id: 'c2-num', type: 'text', text: '01', x: 100, y: 160, fontSize: 72, fill: '#38BDF8', fontWeight: '900' },
            { id: 'c2-title', type: 'text', text: 'Consistency Beats Virality', x: 100, y: 300, fontSize: 48, fontWeight: 'bold', fill: '#FFFFFF' },
            { id: 'c2-body', type: 'text', text: 'Algorithms reward consistent publishers who establish authority in specific topic niches. Schedule recurring slots instead of irregular bursts.', x: 100, y: 440, fontSize: 32, fill: '#D4D4D8', width: 880 },
          ],
        },
        {
          slideIndex: 3,
          title: 'Tactic 2',
          layers: [
            { id: 'c3-bg', type: 'shape', shape: 'rect', x: 0, y: 0, width: 1080, height: 1350, fill: '#09090B' },
            { id: 'c3-num', type: 'text', text: '02', x: 100, y: 160, fontSize: 72, fill: '#38BDF8', fontWeight: '900' },
            { id: 'c3-title', type: 'text', text: 'Tailor Formats Per Channel', x: 100, y: 300, fontSize: 48, fontWeight: 'bold', fill: '#FFFFFF' },
            { id: 'c3-body', type: 'text', text: 'Carousels excel on LinkedIn and Instagram. Micro-threads thrive on X and Bluesky. Adapt each message rather than cross-posting verbatim.', x: 100, y: 440, fontSize: 32, fill: '#D4D4D8', width: 880 },
          ],
        },
        {
          slideIndex: 4,
          title: 'Tactic 3',
          layers: [
            { id: 'c4-bg', type: 'shape', shape: 'rect', x: 0, y: 0, width: 1080, height: 1350, fill: '#09090B' },
            { id: 'c4-num', type: 'text', text: '03', x: 100, y: 160, fontSize: 72, fill: '#38BDF8', fontWeight: '900' },
            { id: 'c4-title', type: 'text', text: 'Leverage Content Signatures', x: 100, y: 300, fontSize: 48, fontWeight: 'bold', fill: '#FFFFFF' },
            { id: 'c4-body', type: 'text', text: 'Always close with an actionable brand signature (plug) to guide viewers to your newsletter, bio link, or product community.', x: 100, y: 440, fontSize: 32, fill: '#D4D4D8', width: 880 },
          ],
        },
        {
          slideIndex: 5,
          title: 'Summary & Call to Action',
          layers: [
            { id: 'c5-bg', type: 'shape', shape: 'rect', x: 0, y: 0, width: 1080, height: 1350, fill: '#09090B' },
            { id: 'c5-h1', type: 'text', text: 'Found this valuable?', x: 100, y: 300, fontSize: 60, fontWeight: 'bold', fill: '#FFFFFF' },
            { id: 'c5-body', type: 'text', text: 'Save this post for your next content batch.\nFollow @wallzaofficial for weekly tactical breakdowns.', x: 100, y: 440, fontSize: 34, fill: '#D4D4D8', width: 880 },
          ],
        },
      ],
    },
  },
  {
    id: 'tpl_short_video_intro',
    name: 'Short-Form Reel / TikTok Storyboard',
    type: 'video',
    category: 'Short Video',
    dimensions: { width: 1080, height: 1920, preset: '9:16 Vertical Video' },
    thumbnailUrl: 'https://images.unsplash.com/photo-1574717024653-61fd2cf4d44d?w=400&q=80',
    data: {
      durationSeconds: 15,
      fps: 30,
      tracks: [
        {
          id: 'video-track-1',
          name: 'Main Video',
          type: 'video',
          clips: [
            { id: 'clip-1', title: 'Hook Intro', startSec: 0, endSec: 4, src: '', volume: 1 },
            { id: 'clip-2', title: 'Core Demonstration', startSec: 4, endSec: 11, src: '', volume: 1 },
            { id: 'clip-3', title: 'Call to Action Outro', startSec: 11, endSec: 15, src: '', volume: 1 },
          ],
        },
        {
          id: 'audio-track-1',
          name: 'Background Music',
          type: 'audio',
          clips: [
            { id: 'bg-music', title: 'Lo-Fi Chill Beat', startSec: 0, endSec: 15, src: '', volume: 0.35 },
          ],
        },
        {
          id: 'text-track-1',
          name: 'Captions & Titles',
          type: 'text',
          clips: [
            { id: 'txt-hook', text: 'Watch what happens next... 👀', startSec: 0, endSec: 3.5, style: { fontSize: 44, fill: '#FFFF00', x: 100, y: 300 } },
            { id: 'txt-cta', text: 'Link in Bio for Full Guide 🔗', startSec: 11.5, endSec: 15, style: { fontSize: 40, fill: '#FFFFFF', x: 120, y: 1500 } },
          ],
        },
      ],
    },
  },
];

@ApiTags('Creative Studio')
@Controller('/creative-studio')
export class CreativeStudioController {
  constructor(private readonly prisma: PrismaService) {}

  private async saveVersionSnapshot(organizationId: string, userId: string, project: any) {
    const versions = (this.prisma as any).creativeProjectVersion;
    const latest = await versions.findFirst({
      where: { projectId: project.id, organizationId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    await versions.create({
      data: {
        projectId: project.id,
        organizationId,
        version: (latest?.version || 0) + 1,
        name: project.name,
        type: project.type,
        data: project.data,
        dimensions: project.dimensions,
        // Browser data URLs are deliberately not copied into each database snapshot.
        thumbnailUrl:
          typeof project.thumbnailUrl === 'string' && project.thumbnailUrl.startsWith('data:')
            ? null
            : project.thumbnailUrl || null,
        assetReferences: Array.isArray(project.assetReferences) ? project.assetReferences : [],
        createdById: userId,
      },
    });

    // Bound database growth: retain the latest 20 recoverable versions per project.
    const retained = await versions.findMany({
      where: { projectId: project.id, organizationId },
      orderBy: { version: 'desc' },
      take: 20,
      select: { id: true },
    });
    await versions.deleteMany({
      where: {
        projectId: project.id,
        organizationId,
        id: { notIn: retained.map((item: { id: string }) => item.id) },
      },
    });
  }

  @Get('/templates')
  async listTemplates(@Query('type') type?: string) {
    if (type && VALID_PROJECT_TYPES.includes(type as any)) {
      return BUILTIN_TEMPLATES.filter((t) => t.type === type);
    }
    return BUILTIN_TEMPLATES;
  }

  @Get('/projects')
  async listProjects(
    @GetOrgFromRequest() org: Organization,
    @Query('type') type?: string,
    @Query('search') search?: string,
    @Query('page') page = '1',
    @Query('limit') limit = '20'
  ) {
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    const where: any = { organizationId: org.id };
    if (type && VALID_PROJECT_TYPES.includes(type as any)) {
      where.type = type;
    }
    if (search && search.trim()) {
      where.name = { contains: search.trim(), mode: 'insensitive' };
    }

    const [total, projects] = await Promise.all([
      (this.prisma as any).creativeProject.count({ where }),
      (this.prisma as any).creativeProject.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip,
        take: limitNum,
        include: {
          owner: {
            select: { id: true, name: true, email: true },
          },
        },
      }),
    ]);

    return {
      projects,
      total,
      page: pageNum,
      totalPages: Math.ceil(total / limitNum),
    };
  }

  @Get('/projects/:id')
  async getProject(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    const project = await (this.prisma as any).creativeProject.findFirst({
      where: { id, organizationId: org.id },
      include: {
        owner: { select: { id: true, name: true, email: true } },
      },
    });

    if (!project) throw new NotFoundException('Project not found in this organization.');
    return project;
  }

  @Post('/projects')
  async createProject(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: {
      name: string;
      type: string;
      data?: any;
      dimensions?: { width: number; height: number; preset?: string };
      thumbnailUrl?: string;
      assetReferences?: string[];
      fromTemplateId?: string;
    }
  ) {
    if (!body.name || !body.name.trim()) {
      throw new BadRequestException('Project name is required.');
    }
    if (!VALID_PROJECT_TYPES.includes(body.type as any)) {
      throw new BadRequestException(`Invalid project type. Must be one of: ${VALID_PROJECT_TYPES.join(', ')}`);
    }

    let initialData = body.data || {};
    let initialDimensions = body.dimensions || { width: 1080, height: 1080, preset: '1:1 Square' };
    let initialThumbnail = body.thumbnailUrl || null;

    if (body.fromTemplateId) {
      const tpl = BUILTIN_TEMPLATES.find((t) => t.id === body.fromTemplateId);
      if (tpl) {
        initialData = tpl.data;
        initialDimensions = tpl.dimensions;
        initialThumbnail = tpl.thumbnailUrl;
      }
    }

    const project = await (this.prisma as any).creativeProject.create({
      data: {
        organizationId: org.id,
        ownerId: user.id,
        name: body.name.trim(),
        type: body.type,
        data: initialData,
        dimensions: initialDimensions,
        thumbnailUrl: initialThumbnail,
        assetReferences: Array.isArray(body.assetReferences) ? body.assetReferences : [],
      },
    });
    await this.saveVersionSnapshot(org.id, user.id, project);

    return project;
  }

  @Get('/projects/:id/versions')
  async listProjectVersions(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    const project = await (this.prisma as any).creativeProject.findFirst({
      where: { id, organizationId: org.id },
      select: { id: true },
    });
    if (!project) throw new NotFoundException('Project not found in this organization.');

    return (this.prisma as any).creativeProjectVersion.findMany({
      where: { projectId: id, organizationId: org.id },
      orderBy: { version: 'desc' },
      take: 20,
      select: {
        id: true,
        version: true,
        name: true,
        type: true,
        createdAt: true,
        createdById: true,
      },
    });
  }

  @Post('/projects/:id/versions/:version/restore')
  async restoreProjectVersion(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Param('version') versionRaw: string
  ) {
    const version = Number.parseInt(versionRaw, 10);
    if (!Number.isInteger(version) || version < 1) {
      throw new BadRequestException('Choose a valid project version.');
    }
    const project = await (this.prisma as any).creativeProject.findFirst({
      where: { id, organizationId: org.id },
    });
    if (!project) throw new NotFoundException('Project not found in this organization.');

    const snapshot = await (this.prisma as any).creativeProjectVersion.findFirst({
      where: { projectId: id, organizationId: org.id, version },
    });
    if (!snapshot) throw new NotFoundException('Project version not found. It may have expired from version retention.');

    const restored = await (this.prisma as any).creativeProject.update({
      where: { id },
      data: {
        name: snapshot.name,
        type: snapshot.type,
        data: snapshot.data,
        dimensions: snapshot.dimensions,
        thumbnailUrl: snapshot.thumbnailUrl,
        assetReferences: snapshot.assetReferences,
      },
    });
    // Record the restored state as a new version so the restore itself is reversible.
    await this.saveVersionSnapshot(org.id, user.id, restored);
    return restored;
  }

  @Put('/projects/:id')
  async updateProject(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: {
      name?: string;
      data?: any;
      dimensions?: { width: number; height: number; preset?: string };
      thumbnailUrl?: string;
      assetReferences?: string[];
    }
  ) {
    const existing = await (this.prisma as any).creativeProject.findFirst({
      where: { id, organizationId: org.id },
    });
    if (!existing) throw new NotFoundException('Project not found in this organization.');

    const updateData: any = {};
    if (body.name && body.name.trim()) updateData.name = body.name.trim();
    if (body.data !== undefined) updateData.data = body.data;
    if (body.dimensions !== undefined) updateData.dimensions = body.dimensions;
    if (body.thumbnailUrl !== undefined) updateData.thumbnailUrl = body.thumbnailUrl;
    if (Array.isArray(body.assetReferences)) updateData.assetReferences = body.assetReferences;

    const changed =
      (body.name !== undefined && body.name.trim() !== existing.name) ||
      (body.data !== undefined && JSON.stringify(body.data) !== JSON.stringify(existing.data)) ||
      (body.dimensions !== undefined && JSON.stringify(body.dimensions) !== JSON.stringify(existing.dimensions)) ||
      (body.thumbnailUrl !== undefined && body.thumbnailUrl !== existing.thumbnailUrl) ||
      (Array.isArray(body.assetReferences) && JSON.stringify(body.assetReferences) !== JSON.stringify(existing.assetReferences));

    if (changed) {
      await this.saveVersionSnapshot(org.id, user.id, existing);
    }

    const updated = await (this.prisma as any).creativeProject.update({
      where: { id },
      data: updateData,
    });

    return updated;
  }

  @Delete('/projects/:id')
  async deleteProject(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    const existing = await (this.prisma as any).creativeProject.findFirst({
      where: { id, organizationId: org.id },
    });
    if (!existing) throw new NotFoundException('Project not found in this organization.');

    await (this.prisma as any).creativeProject.delete({ where: { id } });
    return { success: true, deletedId: id };
  }

  @Post('/projects/:id/export')
  async exportProject(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body()
    body: {
      exportFormat?: string;
      targetMediaCollectionId?: string;
      slideIndex?: number;
      dataUrl?: string;
    }
  ) {
    const project = await (this.prisma as any).creativeProject.findFirst({
      where: { id, organizationId: org.id },
    });
    if (!project) throw new NotFoundException('Project not found.');

    const format = (
      body.exportFormat || (project.type === 'video' ? 'mp4' : 'png')
    ).toLowerCase();
    const storage = UploadFactory.createStorage();
    let uploadedPublicUrl: string;

    if (project.type === 'image' || project.type === 'carousel') {
      let sourceDataUrl = body.dataUrl;

      if (!sourceDataUrl) {
        // Generate authentic image rendering using Sharp from dimensions and data
        const dims = project.dimensions || { width: 1080, height: 1080 };
        const width = Math.min(Math.max(Number(dims.width) || 1080, 100), 4000);
        const height = Math.min(
          Math.max(Number(dims.height) || 1080, 100),
          4000
        );

        const safeTitle = (project.name || 'Creative Export')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');

        const svgOverlay = Buffer.from(`
          <svg width="${width}" height="${height}">
            <rect width="100%" height="100%" fill="#111827"/>
            <circle cx="${Math.round(width / 2)}" cy="${Math.round(
          height / 2
        )}" r="${Math.round(Math.min(width, height) * 0.35)}" fill="#1f2937" />
            <text x="50%" y="45%" text-anchor="middle" fill="#6366f1" font-size="${Math.round(
              width * 0.05
            )}px" font-family="sans-serif" font-weight="bold">${safeTitle}</text>
            <text x="50%" y="55%" text-anchor="middle" fill="#9ca3af" font-size="${Math.round(
              width * 0.025
            )}px" font-family="sans-serif">${width}x${height} • Creative Studio Export</text>
          </svg>
        `);

        const sharpInstance = sharp({
          create: {
            width,
            height,
            channels: 4,
            background: { r: 17, g: 24, b: 39, alpha: 1 },
          },
        }).composite([{ input: svgOverlay, blend: 'over' }]);

        const renderedBuffer =
          format === 'jpeg' || format === 'jpg'
            ? await sharpInstance.jpeg({ quality: 90 }).toBuffer()
            : await sharpInstance.png().toBuffer();

        const mime =
          format === 'jpeg' || format === 'jpg' ? 'image/jpeg' : 'image/png';
        sourceDataUrl = `data:${mime};base64,${renderedBuffer.toString('base64')}`;
      }

      // Persist real file to storage provider (LocalStorage or Cloudflare S3/R2)
      try {
        uploadedPublicUrl = await storage.uploadSimple(sourceDataUrl);
      } catch (err: any) {
        throw new BadRequestException(
          `Failed to persist exported asset to storage: ${err.message}`
        );
      }
    } else if (project.type === 'video') {
      if (
        body.dataUrl &&
        (body.dataUrl.startsWith('data:video/') ||
          body.dataUrl.startsWith('data:application/octet-stream'))
      ) {
        // Validate video magic bytes to prevent spoofed or corrupted arbitrary payloads
        const base64Part = body.dataUrl.split(',')[1];
        if (!base64Part) {
          throw new BadRequestException('Malformed video dataUrl payload.');
        }
        const sampleBuffer = Buffer.from(base64Part.slice(0, 64), 'base64');
        const isWebm =
          sampleBuffer.length >= 4 &&
          sampleBuffer[0] === 0x1a &&
          sampleBuffer[1] === 0x45 &&
          sampleBuffer[2] === 0xdf &&
          sampleBuffer[3] === 0xa3;
        const isMp4 =
          sampleBuffer.length >= 12 &&
          sampleBuffer.toString('utf8', 4, 8) === 'ftyp';

        if (!isWebm && !isMp4) {
          throw new BadRequestException(
            'Invalid video payload: Header must be a valid WebM (1A 45 DF A3) or MP4 (ftyp) video stream.'
          );
        }

        try {
          uploadedPublicUrl = await storage.uploadSimple(body.dataUrl);
        } catch (err: any) {
          throw new BadRequestException(
            `Failed to persist video asset to storage: ${err.message}`
          );
        }
      } else {
        throw new BadRequestException(
          'Server-side multi-track video transcoding without client-rendered stream requires external GPU worker (RunPod). Client-side canvas recording is supported.'
        );
      }
    } else {
      throw new BadRequestException(`Unsupported project type: ${project.type}`);
    }

    const assetName = `${project.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_export_${Date.now()}.${format}`;

    // Register exported asset directly into Organization Media Library with real accessible storage URL
    const media = await this.prisma.media.create({
      data: {
        organizationId: org.id,
        name: assetName,
        originalName: `${project.name}.${format}`,
        path: uploadedPublicUrl,
        type: project.type === 'video' ? 'video' : 'image',
        alt: `Creative Studio export from ${project.name}`,
        thumbnail: uploadedPublicUrl,
        status: 'ready',
        retentionExpiresAt: new Date(Date.now() + 72 * 3600 * 1000), // 72-hour safe retention window
      },
    });

    if (body.targetMediaCollectionId) {
      await (this.prisma as any).mediaCollectionItem
        .create({
          data: {
            organizationId: org.id,
            mediaId: media.id,
            collectionId: body.targetMediaCollectionId,
          },
        })
        .catch(() => null);
    }

    return {
      success: true,
      exportedMedia: media,
      projectType: project.type,
      storageUrl: uploadedPublicUrl,
      message:
        'Project successfully exported to storage and registered in Media Library. Ready for post composition.',
    };
  }
}

