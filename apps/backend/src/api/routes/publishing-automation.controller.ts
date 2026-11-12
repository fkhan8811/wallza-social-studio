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

export interface ScheduleSlot {
  dayOfWeek: number; // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  time: string; // "HH:mm" (24-hour format)
  integrations?: string[];
}

const DEFAULT_SCHEDULE_SLOTS: ScheduleSlot[] = [
  { dayOfWeek: 1, time: '09:00' },
  { dayOfWeek: 1, time: '17:00' },
  { dayOfWeek: 2, time: '09:00' },
  { dayOfWeek: 2, time: '17:00' },
  { dayOfWeek: 3, time: '09:00' },
  { dayOfWeek: 3, time: '17:00' },
  { dayOfWeek: 4, time: '09:00' },
  { dayOfWeek: 4, time: '17:00' },
  { dayOfWeek: 5, time: '09:00' },
  { dayOfWeek: 5, time: '15:00' },
];

const VALID_TRIGGERS = [
  'draft_approved',
  'post_failed',
  'post_scheduled',
  'queue_low',
  'campaign_assigned',
] as const;

@ApiTags('Publishing Automation')
@Controller('/automation')
export class PublishingAutomationController {
  constructor(private readonly prisma: PrismaService) {}

  private async ensureDefaultQueue(organizationId: string) {
    const count = await (this.prisma as any).publishingQueue.count({
      where: { organizationId },
    });
    if (count > 0) return;

    try {
      await (this.prisma as any).publishingQueue.create({
        data: {
          organizationId,
          name: 'Primary Queue',
          description: 'Default organization posting schedule slots',
          isDefault: true,
          isActive: true,
          timezone: 'UTC',
          scheduleSlots: DEFAULT_SCHEDULE_SLOTS,
          minSpacingMinutes: 45,
          capacityLimit: 100,
        },
      });
    } catch {
      // Concurrent initial creation check
    }
  }

  // ── 1. PUBLISHING QUEUES ───────────────────────────────────────────────────

  @Get('/queues')
  async listQueues(@GetOrgFromRequest() org: Organization) {
    await this.ensureDefaultQueue(org.id);
    const queues = await (this.prisma as any).publishingQueue.findMany({
      where: { organizationId: org.id },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });

    // Attach current queued post count for each queue
    const queuesWithMetrics = await Promise.all(
      queues.map(async (q: any) => {
        const pendingCount = await this.prisma.post.count({
          where: {
            organizationId: org.id,
            state: 'DRAFT',
            publishDate: { gte: new Date() },
            deletedAt: null,
          },
        });
        return {
          ...q,
          queuedPostsCount: pendingCount,
        };
      })
    );

    return queuesWithMetrics;
  }

  @Post('/queues')
  async createQueue(
    @GetOrgFromRequest() org: Organization,
    @Body() body: {
      name: string;
      description?: string;
      timezone?: string;
      scheduleSlots?: ScheduleSlot[];
      minSpacingMinutes?: number;
      capacityLimit?: number;
      isDefault?: boolean;
    }
  ) {
    if (!body.name || !body.name.trim()) {
      throw new BadRequestException('Queue name is required.');
    }

    if (body.isDefault) {
      await (this.prisma as any).publishingQueue.updateMany({
        where: { organizationId: org.id, isDefault: true },
        data: { isDefault: false },
      });
    }

    const queue = await (this.prisma as any).publishingQueue.create({
      data: {
        organizationId: org.id,
        name: body.name.trim(),
        description: body.description?.trim() || null,
        timezone: body.timezone || 'UTC',
        scheduleSlots: body.scheduleSlots || DEFAULT_SCHEDULE_SLOTS,
        minSpacingMinutes: body.minSpacingMinutes || 30,
        capacityLimit: body.capacityLimit || null,
        isDefault: Boolean(body.isDefault),
        isActive: true,
      },
    });

    return queue;
  }

  @Put('/queues/:id')
  async updateQueue(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: {
      name?: string;
      description?: string;
      timezone?: string;
      scheduleSlots?: ScheduleSlot[];
      minSpacingMinutes?: number;
      capacityLimit?: number;
      isActive?: boolean;
      isDefault?: boolean;
    }
  ) {
    const existing = await (this.prisma as any).publishingQueue.findFirst({
      where: { id, organizationId: org.id },
    });
    if (!existing) throw new NotFoundException('Queue not found.');

    if (body.isDefault) {
      await (this.prisma as any).publishingQueue.updateMany({
        where: { organizationId: org.id, isDefault: true, id: { not: id } },
        data: { isDefault: false },
      });
    }

    const updateData: any = {};
    if (body.name && body.name.trim()) updateData.name = body.name.trim();
    if (body.description !== undefined) updateData.description = body.description?.trim() || null;
    if (body.timezone) updateData.timezone = body.timezone;
    if (body.scheduleSlots) updateData.scheduleSlots = body.scheduleSlots;
    if (body.minSpacingMinutes !== undefined) updateData.minSpacingMinutes = body.minSpacingMinutes;
    if (body.capacityLimit !== undefined) updateData.capacityLimit = body.capacityLimit;
    if (body.isActive !== undefined) updateData.isActive = body.isActive;
    if (body.isDefault !== undefined) updateData.isDefault = body.isDefault;

    const updated = await (this.prisma as any).publishingQueue.update({
      where: { id },
      data: updateData,
    });

    return updated;
  }

  @Delete('/queues/:id')
  async deleteQueue(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    const existing = await (this.prisma as any).publishingQueue.findFirst({
      where: { id, organizationId: org.id },
    });
    if (!existing) throw new NotFoundException('Queue not found.');
    if (existing.isDefault) {
      throw new BadRequestException('Cannot delete the default organization queue.');
    }

    await (this.prisma as any).publishingQueue.delete({ where: { id } });
    return { success: true, deletedId: id };
  }

  @Get('/queues/:id/next-slot')
  async calculateNextSlot(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    const queue = await (this.prisma as any).publishingQueue.findFirst({
      where: { id, organizationId: org.id },
    });
    if (!queue) throw new NotFoundException('Queue not found.');

    const slots: ScheduleSlot[] = (queue.scheduleSlots as ScheduleSlot[]) || DEFAULT_SCHEDULE_SLOTS;
    if (!slots.length) {
      const fallback = new Date(Date.now() + 60 * 60 * 1000);
      return { nextSlot: fallback.toISOString(), queueName: queue.name };
    }

    // Sort slots by dayOfWeek then time
    const now = new Date();
    const currentDay = now.getUTCDay();
    const currentHour = now.getUTCHours();
    const currentMin = now.getUTCMinutes();
    const currentTimeStr = `${String(currentHour).padStart(2, '0')}:${String(currentMin).padStart(2, '0')}`;

    // Find the next upcoming slot in the next 14 days
    let foundDate: Date | null = null;
    for (let dayOffset = 0; dayOffset < 14; dayOffset++) {
      const checkDate = new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000);
      const dayOfWeek = checkDate.getUTCDay();
      const daySlots = slots.filter((s) => s.dayOfWeek === dayOfWeek).sort((a, b) => a.time.localeCompare(b.time));

      for (const slot of daySlots) {
        if (dayOffset === 0 && slot.time <= currentTimeStr) {
          continue; // Slot already passed today
        }
        const [h, m] = slot.time.split(':').map((v) => parseInt(v, 10));
        const targetSlotDate = new Date(Date.UTC(
          checkDate.getUTCFullYear(),
          checkDate.getUTCMonth(),
          checkDate.getUTCDate(),
          h,
          m,
          0,
          0
        ));

        // Check if a post is already scheduled within minSpacingMinutes
        const spacingMs = (queue.minSpacingMinutes || 30) * 60 * 1000;
        const collision = await this.prisma.post.count({
          where: {
            organizationId: org.id,
            deletedAt: null,
            publishDate: {
              gte: new Date(targetSlotDate.getTime() - spacingMs),
              lte: new Date(targetSlotDate.getTime() + spacingMs),
            },
          },
        });

        if (collision === 0) {
          foundDate = targetSlotDate;
          break;
        }
      }
      if (foundDate) break;
    }

    const finalSlot = foundDate || new Date(now.getTime() + 2 * 60 * 60 * 1000);
    return {
      nextSlot: finalSlot.toISOString(),
      queueId: queue.id,
      queueName: queue.name,
      timezone: queue.timezone,
    };
  }

  // ── 2. AUTOMATION RULES ENGINE ─────────────────────────────────────────────

  @Get('/rules')
  async listRules(@GetOrgFromRequest() org: Organization) {
    return (this.prisma as any).automationRule.findMany({
      where: { organizationId: org.id },
      orderBy: { createdAt: 'desc' },
    });
  }

  @Post('/rules')
  async createRule(
    @GetOrgFromRequest() org: Organization,
    @Body() body: {
      name: string;
      description?: string;
      trigger: string;
      conditions?: any;
      actions?: any;
      isActive?: boolean;
    }
  ) {
    if (!body.name || !body.name.trim()) {
      throw new BadRequestException('Rule name is required.');
    }
    if (!VALID_TRIGGERS.includes(body.trigger as any)) {
      throw new BadRequestException(`Invalid trigger. Must be one of: ${VALID_TRIGGERS.join(', ')}`);
    }

    const rule = await (this.prisma as any).automationRule.create({
      data: {
        organizationId: org.id,
        name: body.name.trim(),
        description: body.description?.trim() || null,
        trigger: body.trigger,
        conditions: body.conditions || {},
        actions: body.actions || {},
        isActive: body.isActive !== undefined ? body.isActive : true,
      },
    });

    return rule;
  }

  @Put('/rules/:id')
  async updateRule(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: {
      name?: string;
      description?: string;
      trigger?: string;
      conditions?: any;
      actions?: any;
      isActive?: boolean;
    }
  ) {
    const existing = await (this.prisma as any).automationRule.findFirst({
      where: { id, organizationId: org.id },
    });
    if (!existing) throw new NotFoundException('Rule not found.');

    const updateData: any = {};
    if (body.name && body.name.trim()) updateData.name = body.name.trim();
    if (body.description !== undefined) updateData.description = body.description?.trim() || null;
    if (body.trigger && VALID_TRIGGERS.includes(body.trigger as any)) updateData.trigger = body.trigger;
    if (body.conditions !== undefined) updateData.conditions = body.conditions;
    if (body.actions !== undefined) updateData.actions = body.actions;
    if (body.isActive !== undefined) updateData.isActive = body.isActive;

    const updated = await (this.prisma as any).automationRule.update({
      where: { id },
      data: updateData,
    });

    return updated;
  }

  @Delete('/rules/:id')
  async deleteRule(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    const existing = await (this.prisma as any).automationRule.findFirst({
      where: { id, organizationId: org.id },
    });
    if (!existing) throw new NotFoundException('Rule not found.');

    await (this.prisma as any).automationRule.delete({ where: { id } });
    return { success: true, deletedId: id };
  }

  @Post('/rules/:id/trigger-test')
  async testRule(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() eventPayload: any
  ) {
    const rule = await (this.prisma as any).automationRule.findFirst({
      where: { id, organizationId: org.id },
    });
    if (!rule) throw new NotFoundException('Rule not found.');

    // Evaluate conditions against eventPayload
    const conditions = rule.conditions || {};
    let matched = true;
    const matchReasons: string[] = [];

    if (conditions.platform && eventPayload.platform) {
      if (conditions.platform.toLowerCase() !== eventPayload.platform.toLowerCase()) {
        matched = false;
        matchReasons.push(`Platform mismatch: expected ${conditions.platform}, got ${eventPayload.platform}`);
      } else {
        matchReasons.push(`Platform matched: ${conditions.platform}`);
      }
    }

    if (conditions.campaignId && eventPayload.campaignId) {
      if (conditions.campaignId !== eventPayload.campaignId) {
        matched = false;
        matchReasons.push(`Campaign mismatch`);
      } else {
        matchReasons.push(`Campaign matched`);
      }
    }

    return {
      ruleId: rule.id,
      ruleName: rule.name,
      trigger: rule.trigger,
      evaluatedPayload: eventPayload,
      matched,
      matchReasons,
      projectedActions: matched ? rule.actions : [],
    };
  }
}
