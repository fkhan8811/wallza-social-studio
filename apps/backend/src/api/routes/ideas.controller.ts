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
import { Organization, Prisma } from '@prisma/client';
import { ApiTags } from '@nestjs/swagger';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';

const DEFAULT_STAGES = [
  { name: 'Inbox', color: '#64748b' },
  { name: 'Idea', color: '#8b5cf6' },
  { name: 'Brief', color: '#0ea5e9' },
  { name: 'In production', color: '#f59e0b' },
  { name: 'Ready', color: '#10b981' },
  { name: 'Scheduled', color: '#06b6d4' },
  { name: 'Published', color: '#22c55e' },
  { name: 'Archived', color: '#94a3b8' },
];

const cleanStringList = (value: unknown, maxItems = 12): string[] => {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean))]
    .slice(0, maxItems);
};

@ApiTags('Ideas')
@Controller('/ideas')
export class IdeasController {
  constructor(private readonly prisma: PrismaService) {}

  private async ensureDefaultStages(organizationId: string) {
    const count = await this.prisma.contentIdeaStage.count({
      where: { organizationId },
    });
    if (count > 0) return;

    try {
      await this.prisma.contentIdeaStage.createMany({
        data: DEFAULT_STAGES.map((stage, position) => ({
          ...stage,
          position,
          organizationId,
        })),
        skipDuplicates: true,
      });
    } catch (error) {
      // A concurrent first request may have created the stages already.
      const check = await this.prisma.contentIdeaStage.count({
        where: { organizationId },
      });
      if (check === 0) throw error;
    }
  }

  @Get('/')
  async list(@GetOrgFromRequest() org: Organization) {
    await this.ensureDefaultStages(org.id);
    return this.prisma.contentIdeaStage.findMany({
      where: { organizationId: org.id },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      include: {
        ideas: {
          where: { organizationId: org.id },
          orderBy: [{ position: 'asc' }, { updatedAt: 'desc' }],
          include: {
            attachments: {
              where: { organizationId: org.id },
              orderBy: { position: 'asc' },
              include: {
                media: {
                  select: {
                    id: true,
                    name: true,
                    originalName: true,
                    path: true,
                    thumbnail: true,
                    alt: true,
                    type: true,
                  },
                },
              },
            },
          },
        },
      },
    });
  }

  @Post('/stages')
  async createStage(
    @GetOrgFromRequest() org: Organization,
    @Body() body: { name?: string; color?: string }
  ) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 40) {
      throw new BadRequestException('Stage name must be between 1 and 40 characters.');
    }
    const color =
      typeof body.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.color)
        ? body.color
        : '#64748b';
    const position = await this.prisma.contentIdeaStage.count({
      where: { organizationId: org.id },
    });
    return this.prisma.contentIdeaStage.create({
      data: { name, color, position, organizationId: org.id },
    });
  }

  @Put('/stages/:id')
  async updateStage(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: { name?: string; color?: string; position?: number }
  ) {
    const existing = await this.prisma.contentIdeaStage.findFirst({
      where: { id, organizationId: org.id },
    });
    if (!existing) throw new NotFoundException('Stage not found.');
    const data: { name?: string; color?: string; position?: number } = {};
    if (body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > 40) {
        throw new BadRequestException('Stage name must be between 1 and 40 characters.');
      }
      data.name = name;
    }
    if (body.color !== undefined) {
      if (typeof body.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(body.color)) {
        throw new BadRequestException('Stage color must be a six-digit hex color.');
      }
      data.color = body.color;
    }
    if (body.position !== undefined && Number.isInteger(body.position) && body.position >= 0) {
      data.position = body.position;
    }
    return this.prisma.contentIdeaStage.update({
      where: { id },
      data,
    });
  }

  @Delete('/stages/:id')
  async deleteStage(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    const stage = await this.prisma.contentIdeaStage.findFirst({
      where: { id, organizationId: org.id },
      include: { _count: { select: { ideas: true } } },
    });
    if (!stage) throw new NotFoundException('Stage not found.');
    if (stage._count.ideas > 0) {
      throw new BadRequestException('Move or archive the ideas in this stage before deleting it.');
    }
    await this.prisma.contentIdeaStage.delete({ where: { id } });
    return { success: true };
  }

  @Post('/')
  async createIdea(
    @GetOrgFromRequest() org: Organization,
    @Body() body: {
      title?: string;
      brief?: string;
      stageId?: string;
      platformTargets?: string[];
      labels?: string[];
      dueDate?: string | null;
      ownerName?: string | null;
      campaignId?: string | null;
    }
  ) {
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title || title.length > 160) {
      throw new BadRequestException('Idea title must be between 1 and 160 characters.');
    }
    await this.ensureDefaultStages(org.id);
    const stage = body.stageId
      ? await this.prisma.contentIdeaStage.findFirst({
          where: { id: body.stageId, organizationId: org.id },
        })
      : await this.prisma.contentIdeaStage.findFirst({
          where: { organizationId: org.id },
          orderBy: { position: 'asc' },
        });
    if (!stage) throw new BadRequestException('Choose a valid pipeline stage.');
    const campaign = body.campaignId
      ? await this.prisma.contentCampaign.findFirst({
          where: { id: body.campaignId, organizationId: org.id },
          select: { id: true },
        })
      : null;
    if (body.campaignId && !campaign) {
      throw new BadRequestException('Choose a campaign belonging to this organization.');
    }

    const dueDate = body.dueDate ? new Date(body.dueDate) : null;
    if (dueDate && Number.isNaN(dueDate.getTime())) {
      throw new BadRequestException('Due date is invalid.');
    }
    const position = await this.prisma.contentIdea.count({
      where: { organizationId: org.id, stageId: stage.id },
    });
    return this.prisma.contentIdea.create({
      data: {
        title,
        brief: typeof body.brief === 'string' ? body.brief.trim().slice(0, 4000) : '',
        stageId: stage.id,
        organizationId: org.id,
        position,
        platformTargets: cleanStringList(body.platformTargets),
        labels: cleanStringList(body.labels),
        dueDate,
        ownerName:
          typeof body.ownerName === 'string' ? body.ownerName.trim().slice(0, 80) || null : null,
        campaignId: campaign?.id ?? null,
      },
    });
  }

  @Put('/:id')
  async updateIdea(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: {
      title?: string;
      brief?: string;
      platformTargets?: string[];
      labels?: string[];
      dueDate?: string | null;
      ownerName?: string | null;
      campaignId?: string | null;
      stageId?: string;
    }
  ) {
    const existing = await this.prisma.contentIdea.findFirst({
      where: { id, organizationId: org.id },
    });
    if (!existing) throw new NotFoundException('Idea not found.');

    const data: Prisma.ContentIdeaUncheckedUpdateInput = {};
    if (body.title !== undefined) {
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      if (!title || title.length > 160) {
        throw new BadRequestException('Idea title must be between 1 and 160 characters.');
      }
      data.title = title;
    }
    if (body.brief !== undefined) {
      data.brief = typeof body.brief === 'string' ? body.brief.trim().slice(0, 4000) : '';
    }
    if (body.platformTargets !== undefined) {
      data.platformTargets = cleanStringList(body.platformTargets);
    }
    if (body.labels !== undefined) data.labels = cleanStringList(body.labels);
    if (body.dueDate !== undefined) {
      const dueDate = body.dueDate ? new Date(body.dueDate) : null;
      if (dueDate && Number.isNaN(dueDate.getTime())) {
        throw new BadRequestException('Due date is invalid.');
      }
      data.dueDate = dueDate;
    }
    if (body.ownerName !== undefined) {
      data.ownerName =
        typeof body.ownerName === 'string' ? body.ownerName.trim().slice(0, 80) || null : null;
    }
    if (body.stageId !== undefined) {
      const stage = await this.prisma.contentIdeaStage.findFirst({
        where: { id: body.stageId, organizationId: org.id },
        select: { id: true },
      });
      if (!stage) throw new BadRequestException('Choose a pipeline stage belonging to this organization.');
      data.stageId = stage.id;
    }
    if (body.campaignId !== undefined) {
      const campaignId = typeof body.campaignId === 'string' ? body.campaignId.trim() : '';
      if (!campaignId) {
        data.campaignId = null;
      } else {
        const campaign = await this.prisma.contentCampaign.findFirst({
          where: { id: campaignId, organizationId: org.id },
          select: { id: true },
        });
        if (!campaign) throw new BadRequestException('Choose a campaign belonging to this organization.');
        data.campaignId = campaign.id;
      }
    }
    return this.prisma.contentIdea.update({ where: { id }, data });
  }

  @Post('/:id/attachments')
  async addAttachment(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body('mediaId') mediaId: string
  ) {
    if (typeof mediaId !== 'string' || !mediaId.trim()) {
      throw new BadRequestException('A media ID is required.');
    }
    const normalizedMediaId = mediaId.trim();
    return this.prisma.$transaction(async (tx) => {
      const [idea, media] = await Promise.all([
        tx.contentIdea.findFirst({
          where: { id, organizationId: org.id },
          select: { id: true },
        }),
        tx.media.findFirst({
          where: {
            id: normalizedMediaId,
            organizationId: org.id,
            deletedAt: null,
            status: { not: 'processing' },
          },
          select: { id: true },
        }),
      ]);
      if (!idea) throw new NotFoundException('Idea not found.');
      if (!media) throw new NotFoundException('Media item not found in this workspace.');

      const last = await tx.contentIdeaMedia.aggregate({
        where: { ideaId: id, organizationId: org.id },
        _max: { position: true },
      });
      return tx.contentIdeaMedia.upsert({
        where: { ideaId_mediaId: { ideaId: id, mediaId: normalizedMediaId } },
        create: {
          ideaId: id,
          mediaId: normalizedMediaId,
          organizationId: org.id,
          position: (last._max.position ?? -1) + 1,
        },
        update: {},
        include: {
          media: {
            select: {
              id: true,
              name: true,
              originalName: true,
              path: true,
              thumbnail: true,
              alt: true,
              type: true,
            },
          },
        },
      });
    });
  }

  @Delete('/:id/attachments/:mediaId')
  async removeAttachment(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Param('mediaId') mediaId: string
  ) {
    const idea = await this.prisma.contentIdea.findFirst({
      where: { id, organizationId: org.id },
      select: { id: true },
    });
    if (!idea) throw new NotFoundException('Idea not found.');
    const result = await this.prisma.contentIdeaMedia.deleteMany({
      where: { ideaId: id, mediaId, organizationId: org.id },
    });
    if (!result.count) throw new NotFoundException('Attachment not found.');
    return { success: true };
  }

  @Post('/:id/move')
  async moveIdea(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: { stageId?: string; position?: number }
  ) {
    if (!body.stageId) throw new BadRequestException('Choose a destination stage.');
    const [idea, stage] = await Promise.all([
      this.prisma.contentIdea.findFirst({ where: { id, organizationId: org.id } }),
      this.prisma.contentIdeaStage.findFirst({
        where: { id: body.stageId, organizationId: org.id },
      }),
    ]);
    if (!idea) throw new NotFoundException('Idea not found.');
    if (!stage) throw new NotFoundException('Destination stage not found.');
    return this.prisma.$transaction(async (tx) => {
      const destination = await tx.contentIdea.findMany({
        where: {
          organizationId: org.id,
          stageId: stage.id,
          id: { not: id },
        },
        orderBy: [{ position: 'asc' }, { updatedAt: 'asc' }],
        select: { id: true },
      });
      const requestedPosition =
        Number.isInteger(body.position) && (body.position as number) >= 0
          ? (body.position as number)
          : destination.length;
      const insertAt = Math.min(requestedPosition, destination.length);
      const orderedIds = destination.map((item) => item.id);
      orderedIds.splice(insertAt, 0, id);

      const moveData: Prisma.ContentIdeaUncheckedUpdateInput = {
        stageId: stage.id,
        position: insertAt,
      };
      await tx.contentIdea.update({
        where: { id },
        data: moveData,
      });
      await Promise.all(
        orderedIds.map((ideaId, index) =>
          tx.contentIdea.updateMany({
            where: { id: ideaId, organizationId: org.id, stageId: stage.id },
            data: { position: index },
          })
        )
      );

      if (idea.stageId !== stage.id) {
        const source = await tx.contentIdea.findMany({
          where: {
            organizationId: org.id,
            stageId: idea.stageId,
          },
          orderBy: [{ position: 'asc' }, { updatedAt: 'asc' }],
          select: { id: true },
        });
        await Promise.all(
          source.map((item, index) =>
            tx.contentIdea.updateMany({
              where: { id: item.id, organizationId: org.id, stageId: idea.stageId },
              data: { position: index },
            })
          )
        );
      }
      return tx.contentIdea.findFirst({
        where: { id, organizationId: org.id },
      });
    });
  }

  @Delete('/:id')
  async deleteIdea(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    const result = await this.prisma.contentIdea.deleteMany({
      where: { id, organizationId: org.id },
    });
    if (result.count === 0) throw new NotFoundException('Idea not found.');
    return { success: true };
  }
}
