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
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { CheckPolicies } from '@gitroom/backend/services/auth/permissions/permissions.ability';
import {
  AuthorizationActions,
  Sections,
} from '@gitroom/backend/services/auth/permissions/permission.exception.class';

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

const isValidTimeZone = (timeZone: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
};

const zonedParts = (date: Date, timeZone: string) => {
  const values: Record<string, string> = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date).forEach((part) => {
    if (part.type !== 'literal') values[part.type] = part.value;
  });
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
};

/** Convert a wall-clock time in an IANA zone into UTC, rejecting DST gaps. */
const localWallClockToUtc = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): Date | null => {
  const desiredUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let candidate = desiredUtc;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const actual = zonedParts(new Date(candidate), timeZone);
    const representedUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      0,
      0
    );
    const adjustment = desiredUtc - representedUtc;
    if (adjustment === 0) break;
    candidate += adjustment;
  }

  const resolved = zonedParts(new Date(candidate), timeZone);
  if (
    resolved.year !== year ||
    resolved.month !== month ||
    resolved.day !== day ||
    resolved.hour !== hour ||
    resolved.minute !== minute
  ) {
    // A local clock time inside a daylight-saving jump does not exist.
    return null;
  }

  return new Date(candidate);
};

@ApiTags('Publishing Automation')
@Controller('/automation')
export class PublishingAutomationController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly postsService: PostsService
  ) {}

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

  private async findNextAvailableSlot(organizationId: string, queue: any, integrationId?: string) {
    const timeZone = queue.timezone || 'UTC';
    if (!isValidTimeZone(timeZone)) {
      throw new BadRequestException('Queue timezone must be a valid IANA timezone.');
    }

    const now = new Date();
    const [pendingCount, currentLocal] = await Promise.all([
      this.prisma.post.count({
        where: {
          organizationId,
          queueId: queue.id,
          state: 'QUEUE',
          deletedAt: null,
          publishDate: { gte: now },
        },
      }),
      Promise.resolve(zonedParts(now, timeZone)),
    ]);

    if (queue.capacityLimit && pendingCount >= queue.capacityLimit) {
      throw new BadRequestException('This publishing queue has reached its pending-post capacity.');
    }

    const slots: ScheduleSlot[] = Array.isArray(queue.scheduleSlots)
      ? queue.scheduleSlots
      : DEFAULT_SCHEDULE_SLOTS;
    if (!slots.length) return new Date(now.getTime() + 60 * 60 * 1000);

    // Advance through local calendar dates, not UTC dates, so weekday slots
    // and daylight-saving changes follow the queue's configured timezone.
    const localToday = Date.UTC(currentLocal.year, currentLocal.month - 1, currentLocal.day);
    for (let dayOffset = 0; dayOffset < 14; dayOffset += 1) {
      const localDate = new Date(localToday + dayOffset * 24 * 60 * 60 * 1000);
      const dayOfWeek = localDate.getUTCDay();
      const daySlots = slots
        .filter((slot) =>
          Number.isInteger(slot.dayOfWeek) &&
          slot.dayOfWeek >= 0 &&
          slot.dayOfWeek <= 6 &&
          slot.dayOfWeek === dayOfWeek &&
          typeof slot.time === 'string' &&
          /^(?:[01]\\d|2[0-3]):[0-5]\\d$/.test(slot.time) &&
          (!integrationId || !Array.isArray(slot.integrations) || !slot.integrations.length || slot.integrations.includes(integrationId))
        )
        .sort((a, b) => a.time.localeCompare(b.time));

      for (const slot of daySlots) {
        const [hour, minute] = slot.time.split(':').map(Number);
        const target = localWallClockToUtc(
          localDate.getUTCFullYear(),
          localDate.getUTCMonth() + 1,
          localDate.getUTCDate(),
          hour,
          minute,
          timeZone
        );
        if (!target || target <= now) continue;

        const spacingMs = Math.max(0, Number(queue.minSpacingMinutes) || 30) * 60 * 1000;
        const where: any = {
          organizationId,
          queueId: queue.id,
          state: 'QUEUE',
          deletedAt: null,
          publishDate: {
            gte: new Date(target.getTime() - spacingMs),
            lte: new Date(target.getTime() + spacingMs),
          },
        };
        if (integrationId) {
          where.integrationId = integrationId;
        } else if (Array.isArray(slot.integrations) && slot.integrations.length) {
          where.integrationId = { in: slot.integrations };
        }

        const collision = await this.prisma.post.count({ where });
        if (collision === 0) return target;
      }
    }

    throw new BadRequestException('No free queue slot is available in the next 14 days.');
  }

  private async getNextAvailableSlot(org: Organization, queueId: string) {
    const queue = await (this.prisma as any).publishingQueue.findFirst({
      where: { id: queueId, organizationId: org.id, isActive: true },
    });
    if (!queue) throw new NotFoundException('Active publishing queue not found.');
    const nextSlot = await this.findNextAvailableSlot(org.id, queue);
    return { nextSlot: nextSlot.toISOString(), queueId: queue.id, timezone: queue.timezone };
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
            queueId: q.id,
            state: 'QUEUE',
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

    const timeZone = body.timezone || 'UTC';
    if (!isValidTimeZone(timeZone)) {
      throw new BadRequestException('Queue timezone must be a valid IANA timezone.');
    }

    const queue = await (this.prisma as any).publishingQueue.create({
      data: {
        organizationId: org.id,
        name: body.name.trim(),
        description: body.description?.trim() || null,
        timezone: timeZone,
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
    if (body.timezone) {
      if (!isValidTimeZone(body.timezone)) {
        throw new BadRequestException('Queue timezone must be a valid IANA timezone.');
      }
      updateData.timezone = body.timezone;
    }
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

    // Detach queued posts before deleting the queue; preserve their publish dates.
    await this.prisma.post.updateMany({
      where: { organizationId: org.id, queueId: id },
      data: { queueId: null },
    });
    await (this.prisma as any).publishingQueue.delete({ where: { id } });
    return { success: true, deletedId: id };
  }

  @Get('/queues/:id/next-slot')
  async calculateNextSlot(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    const queue = await (this.prisma as any).publishingQueue.findFirst({
      where: { id, organizationId: org.id, isActive: true },
    });
    if (!queue) throw new NotFoundException('Active publishing queue not found.');
    const nextSlot = await this.findNextAvailableSlot(org.id, queue);
    return {
      nextSlot: nextSlot.toISOString(),
      queueId: queue.id,
      queueName: queue.name,
      timezone: queue.timezone,
    };
  }

  @Post('/queues/:id/enqueue')
  @CheckPolicies([AuthorizationActions.Create, Sections.POSTS_PER_MONTH])
  async enqueuePosts(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: { postIds?: string[] }
  ) {
    const queue = await (this.prisma as any).publishingQueue.findFirst({
      where: { id, organizationId: org.id, isActive: true },
    });
    if (!queue) throw new NotFoundException('Active publishing queue not found.');

    const ids = Array.isArray(body.postIds)
      ? [...new Set(body.postIds.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))]
      : [];
    if (!ids.length || ids.length > 50) {
      throw new BadRequestException('Choose between 1 and 50 draft posts to add to this queue.');
    }

    const posts = await this.prisma.post.findMany({
      where: { organizationId: org.id, id: { in: ids }, state: 'DRAFT', deletedAt: null },
      select: { id: true, integrationId: true },
    });
    if (posts.length !== ids.length) {
      throw new BadRequestException('One or more selected posts are not active drafts in this organization.');
    }

    const scheduled: Array<{ postId: string; publishDate: string }> = [];
    for (const post of posts) {
      const nextSlot = await this.findNextAvailableSlot(org.id, queue, post.integrationId);
      const assigned = await this.prisma.post.updateMany({
        where: { id: post.id, organizationId: org.id, state: 'DRAFT', deletedAt: null },
        data: { queueId: queue.id },
      });
      if (assigned.count !== 1) {
        throw new BadRequestException('A selected draft changed before it could be queued. Refresh and try again.');
      }
      try {
        await this.postsService.changeDate(org.id, post.id, nextSlot.toISOString(), 'schedule');
      } catch (error) {
        await this.prisma.post.updateMany({
          where: { id: post.id, organizationId: org.id, queueId: queue.id },
          data: { queueId: null },
        });
        throw error;
      }
      scheduled.push({ postId: post.id, publishDate: nextSlot.toISOString() });
    }

    return { success: true, queueId: queue.id, scheduled };
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
    return this.executeRule(org, id, { mode: 'dry_run', eventPayload });
  }

  @Post('/rules/:id/execute')
  async executeRule(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body()
    body: {
      mode?: 'dry_run' | 'execute';
      eventPayload?: any;
      targetPostId?: string;
    }
  ) {
    const rule = await (this.prisma as any).automationRule.findFirst({
      where: { id, organizationId: org.id },
    });
    if (!rule) throw new NotFoundException('Rule not found.');

    const mode = body.mode || 'dry_run';
    const payload = body.eventPayload || {};
    const conditions = rule.conditions || {};

    let matched = true;
    const matchReasons: string[] = [];

    if (conditions.platform && payload.platform) {
      if (
        conditions.platform.toLowerCase() !== payload.platform.toLowerCase()
      ) {
        matched = false;
        matchReasons.push(
          `Platform mismatch: expected ${conditions.platform}, got ${payload.platform}`
        );
      } else {
        matchReasons.push(`Platform matched: ${conditions.platform}`);
      }
    }

    if (conditions.campaignId && payload.campaignId) {
      if (conditions.campaignId !== payload.campaignId) {
        matched = false;
        matchReasons.push('Campaign mismatch');
      } else {
        matchReasons.push('Campaign matched');
      }
    }

    if (!matched) {
      return {
        ruleId: rule.id,
        ruleName: rule.name,
        trigger: rule.trigger,
        mode,
        matched: false,
        matchReasons,
        executedActions: [],
        message: 'Rule conditions did not match event payload.',
      };
    }

    const actions = rule.actions || {};
    const executionResults: any[] = [];

    // Real Execution Path
    if (mode === 'execute') {
      // 1. Assign drafts to the selected timezone-aware queue.
      if (actions.targetQueueId || actions.action === 'assign_to_queue') {
        const queueId = actions.targetQueueId;
        const targetQueue = await (this.prisma as any).publishingQueue.findFirst({
          where: { id: queueId, organizationId: org.id, isActive: true },
        });

        if (targetQueue) {
          const candidatePosts = await this.prisma.post.findMany({
            where: {
              organizationId: org.id,
              id: body.targetPostId || payload.postId || undefined,
              state: 'DRAFT',
              deletedAt: null,
            },
            orderBy: { createdAt: 'asc' },
            take: body.targetPostId || payload.postId ? 1 : 5,
            select: { id: true, integrationId: true },
          });

          for (const post of candidatePosts) {
            const nextSlot = await this.findNextAvailableSlot(org.id, targetQueue, post.integrationId);
            await this.prisma.post.update({
              where: { id: post.id },
              data: { queueId: targetQueue.id },
            });
            try {
              await this.postsService.changeDate(
                org.id,
                post.id,
                nextSlot.toISOString(),
                'schedule'
              );
            } catch (error) {
              await this.prisma.post.updateMany({
                where: { id: post.id, organizationId: org.id, queueId: targetQueue.id },
                data: { queueId: null },
              });
              throw error;
            }
            executionResults.push({
              action: 'assign_to_queue',
              postId: post.id,
              queueId: targetQueue.id,
              scheduledFor: nextSlot.toISOString(),
              status: 'SUCCESS',
            });
          }
        }
      }

      // 2. Auto-retry failed posts action
      if (actions.autoRetry || actions.action === 'auto_retry') {
        const failedPosts = await this.prisma.post.findMany({
          where: {
            organizationId: org.id,
            id: body.targetPostId || payload.postId || undefined,
            state: 'ERROR',
            deletedAt: null,
          },
          take: 3,
        });

        const retryDate = new Date(Date.now() + 15 * 60 * 1000); // 15-minute retry backoff
        for (const post of failedPosts) {
          await this.postsService.changeDate(
            org.id,
            post.id,
            retryDate.toISOString(),
            'schedule',
            true
          );
          executionResults.push({
            action: 'auto_retry',
            postId: post.id,
            rescheduledFor: retryDate.toISOString(),
            status: 'SUCCESS',
          });
        }
      }

      // Increment execution count and record timestamp
      await (this.prisma as any).automationRule.update({
        where: { id: rule.id },
        data: {
          executionCount: { increment: 1 },
          lastExecutedAt: new Date(),
        },
      });
    }

    return {
      ruleId: rule.id,
      ruleName: rule.name,
      trigger: rule.trigger,
      mode,
      matched: true,
      matchReasons,
      projectedActions: actions,
      executedActions: executionResults,
      executedCount: executionResults.length,
      executedAt: mode === 'execute' ? new Date().toISOString() : null,
      message:
        mode === 'execute'
          ? `Successfully executed automation rule. ${executionResults.length} post action(s) processed.`
          : 'Dry-run evaluation passed. Ready for execution.',
    };
  }
}

