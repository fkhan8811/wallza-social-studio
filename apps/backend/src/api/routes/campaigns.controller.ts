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

  @Get('/')
  async list(@GetOrgFromRequest() org: Organization) {
    return this.prisma.contentCampaign.findMany({
      where: { organizationId: org.id },
      orderBy: [{ updatedAt: 'desc' }],
      include: {
        _count: { select: { ideas: true } },
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
}
