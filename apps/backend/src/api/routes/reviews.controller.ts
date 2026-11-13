import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  GoneException,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { Organization, User } from '@prisma/client';
import { ApiTags } from '@nestjs/swagger';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';

const hashToken = (token: string) =>
  createHash('sha256').update(token, 'utf8').digest('hex');

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type ReviewerInput = { email?: string; name?: string };

type PublicReviewMedia = { url: string; alt: string };

const safeReviewMedia = (serialized: string | null): PublicReviewMedia[] => {
  if (!serialized || serialized.length > 100_000) return [];
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, 10).flatMap((item: any) => {
      const candidate = typeof item?.url === 'string' ? item.url : '';
      if (!candidate || candidate.length > 2048) return [];
      try {
        const url = new URL(candidate);
        if (url.protocol !== 'https:') return [];
        return [{
          url: url.toString(),
          alt: typeof item?.alt === 'string' ? item.alt.slice(0, 300) : '',
        }];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
};

@ApiTags('Reviews')
@Controller('/reviews')
export class ReviewsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('/available-post-groups')
  async availablePostGroups(@GetOrgFromRequest() org: Organization) {
    const posts = await this.prisma.post.findMany({
      where: { organizationId: org.id, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: {
        group: true,
        title: true,
        publishDate: true,
        integration: { select: { name: true } },
      },
    });
    const groups = new Map<string, {
      group: string;
      title: string | null;
      publishDate: Date;
      channels: string[];
    }>();
    for (const post of posts) {
      const current = groups.get(post.group);
      if (current) {
        if (post.integration?.name && !current.channels.includes(post.integration.name)) {
          current.channels.push(post.integration.name);
        }
        continue;
      }
      groups.set(post.group, {
        group: post.group,
        title: post.title,
        publishDate: post.publishDate,
        channels: post.integration?.name ? [post.integration.name] : [],
      });
    }
    return [...groups.values()];
  }

  @Get('/')
  async list(@GetOrgFromRequest() org: Organization) {
    const rows = await this.prisma.contentReview.findMany({
      where: { organizationId: org.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        postGroup: true,
        reviewerEmail: true,
        reviewerName: true,
        status: true,
        comment: true,
        expiresAt: true,
        reviewedAt: true,
        createdAt: true,
        events: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            action: true,
            actorEmail: true,
            actorName: true,
            comment: true,
            createdAt: true,
          },
        },
      },
    });
    return rows.map((row) => ({
      ...row,
      expired: row.expiresAt.getTime() <= Date.now() && row.status === 'pending',
    }));
  }

  @Post('/')
  async create(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: {
      postGroup?: string;
      reviewerEmail?: string;
      reviewerName?: string;
      reviewers?: ReviewerInput[];
      expiresInDays?: number;
    }
  ) {
    const postGroup = typeof body.postGroup === 'string' ? body.postGroup.trim() : '';
    if (!postGroup || postGroup.length > 160) {
      throw new BadRequestException('Provide a valid Postiz post group.');
    }

    // Support the earlier single-reviewer request while allowing up to 10
    // independent recipients. Each recipient receives a distinct bearer link.
    const suppliedReviewers = Array.isArray(body.reviewers) && body.reviewers.length
      ? body.reviewers
      : [{ email: body.reviewerEmail, name: body.reviewerName }];
    if (suppliedReviewers.length > 10) {
      throw new BadRequestException('A review request can have no more than 10 reviewers.');
    }

    const reviewers = suppliedReviewers.map((item) => ({
      email: typeof item?.email === 'string' ? item.email.trim().toLowerCase() : '',
      name: typeof item?.name === 'string' ? item.name.trim().slice(0, 120) : '',
    }));
    const uniqueEmails = new Set(reviewers.map((reviewer) => reviewer.email));
    if (
      reviewers.some((reviewer) =>
        !emailPattern.test(reviewer.email) || reviewer.email.length > 254
      ) ||
      uniqueEmails.size !== reviewers.length
    ) {
      throw new BadRequestException('Provide up to 10 unique, valid reviewer email addresses.');
    }

    const expiresInDays = body.expiresInDays ?? 7;
    if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 30) {
      throw new BadRequestException('Review links must expire between 1 and 30 days.');
    }

    const post = await this.prisma.post.findFirst({
      where: { group: postGroup, organizationId: org.id, deletedAt: null },
      select: { id: true },
    });
    if (!post) {
      throw new NotFoundException('No active posts were found for this organization and post group.');
    }

    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
    const created = await this.prisma.$transaction(async (tx) => {
      const results: Array<Record<string, unknown>> = [];
      for (const reviewer of reviewers) {
        const token = randomBytes(32).toString('base64url');
        const review = await tx.contentReview.create({
          data: {
            organizationId: org.id,
            postGroup,
            reviewerEmail: reviewer.email,
            reviewerName: reviewer.name || null,
            tokenHash: hashToken(token),
            expiresAt,
            createdById: user.id,
          },
          select: {
            id: true,
            postGroup: true,
            reviewerEmail: true,
            reviewerName: true,
            status: true,
            expiresAt: true,
            createdAt: true,
          },
        });
        await tx.contentReviewEvent.create({
          data: {
            reviewId: review.id,
            organizationId: org.id,
            action: 'created',
            actorEmail: user.email,
            actorName: user.name || null,
          },
        });
        // The raw token is returned once. Only its SHA-256 hash is stored.
        results.push({ ...review, reviewPath: `/review/${token}` });
      }
      return results;
    });

    return {
      reviews: created,
      // Backwards-compatible convenience for clients issuing one review link.
      ...(created.length === 1 ? { reviewPath: created[0].reviewPath } : {}),
    };
  }

  @Delete('/:id')
  async revoke(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string
  ) {
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.contentReview.updateMany({
        where: { id, organizationId: org.id, status: 'pending', expiresAt: { gt: new Date() } },
        data: { status: 'revoked', reviewedAt: new Date() },
      });
      if (result.count === 0) {
        throw new NotFoundException('Pending review link not found. It may already be used, expired or revoked.');
      }
      await tx.contentReviewEvent.create({
        data: {
          reviewId: id,
          organizationId: org.id,
          action: 'revoked',
          actorEmail: user.email,
          actorName: user.name || null,
        },
      });
      return { success: true };
    });
  }

  @Post('/internal/submit')
  async submitForInternalApproval(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: { postGroup: string; notes?: string }
  ) {
    const postGroup = typeof body.postGroup === 'string' ? body.postGroup.trim() : '';
    if (!postGroup) throw new BadRequestException('postGroup is required.');

    const posts = await this.prisma.post.findMany({
      where: { group: postGroup, organizationId: org.id, deletedAt: null },
    });
    if (!posts.length) throw new NotFoundException('Post group not found.');

    await this.prisma.post.updateMany({
      where: { group: postGroup, organizationId: org.id },
      data: {
        requiresApproval: true,
        approvalStatus: 'pending',
      },
    });

    return {
      success: true,
      postGroup,
      approvalStatus: 'pending',
      message: 'Post successfully submitted for internal review and approval.',
    };
  }

  @Post('/internal/decide')
  async decideInternalApproval(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body()
    body: {
      postGroup: string;
      decision: 'approved' | 'rejected' | 'changes_requested';
      feedback?: string;
    }
  ) {
    const postGroup = typeof body.postGroup === 'string' ? body.postGroup.trim() : '';
    if (!postGroup) throw new BadRequestException('postGroup is required.');
    const validDecisions = ['approved', 'rejected', 'changes_requested'];
    if (!validDecisions.includes(body.decision)) {
      throw new BadRequestException('decision must be approved, rejected, or changes_requested.');
    }

    const posts = await this.prisma.post.findMany({
      where: { group: postGroup, organizationId: org.id, deletedAt: null },
    });
    if (!posts.length) throw new NotFoundException('Post group not found.');

    const updateData: any = {
      approvalStatus: body.decision,
    };
    if (body.decision === 'approved') {
      updateData.approvedById = user.id;
      updateData.approvedAt = new Date();
    }

    await this.prisma.post.updateMany({
      where: { group: postGroup, organizationId: org.id },
      data: updateData,
    });

    return {
      success: true,
      postGroup,
      decision: body.decision,
      approvedById: body.decision === 'approved' ? user.id : null,
      feedback: body.feedback || null,
    };
  }

  @Post('/:id/reopen-revision')
  async reopenRevision(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body?: { additionalDays?: number }
  ) {
    const days = Math.min(30, Math.max(1, body?.additionalDays || 7));
    return this.prisma.$transaction(async (tx) => {
      const review = await tx.contentReview.findFirst({
        where: { id, organizationId: org.id },
      });
      if (!review) throw new NotFoundException('Review not found.');

      const newExpiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
      await tx.contentReview.update({
        where: { id },
        data: {
          status: 'pending',
          expiresAt: newExpiresAt,
          reviewedAt: null,
        },
      });

      await tx.post.updateMany({
        where: { group: review.postGroup, organizationId: org.id },
        data: {
          requiresApproval: true,
          approvalStatus: 'pending',
          approvedById: null,
          approvedAt: null,
        },
      });

      await tx.contentReviewEvent.create({
        data: {
          reviewId: id,
          organizationId: org.id,
          action: 'revision_reopened',
          actorEmail: user.email,
          actorName: user.name || null,
          comment: `Review reopened with expiry extended to ${newExpiresAt.toISOString()}`,
        },
      });

      return {
        success: true,
        reviewId: id,
        status: 'pending',
        expiresAt: newExpiresAt,
      };
    });
  }
}

@ApiTags('Public Reviews')
@Controller('/reviews/public')
export class PublicReviewsController {
  constructor(private readonly prisma: PrismaService) {}

  private async findReview(token: string) {
    if (!token || token.length < 40 || token.length > 100) {
      throw new NotFoundException('Review link not found.');
    }
    const review = await this.prisma.contentReview.findUnique({
      where: { tokenHash: hashToken(token) },
    });
    if (!review) throw new NotFoundException('Review link not found.');
    if (review.status === 'revoked') {
      throw new GoneException('This review link has been revoked.');
    }
    if (review.expiresAt.getTime() <= Date.now()) {
      throw new GoneException('This review link has expired.');
    }
    return review;
  }

  @Get('/:token')
  async view(@Param('token') token: string) {
    const review = await this.findReview(token);
    const posts = await this.prisma.post.findMany({
      where: {
        group: review.postGroup,
        organizationId: review.organizationId,
        deletedAt: null,
      },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        title: true,
        content: true,
        publishDate: true,
        state: true,
        image: true,
        integration: {
          select: { name: true, providerIdentifier: true },
        },
      },
    });
    if (!posts.length) {
      throw new NotFoundException('The posts for this review are no longer available.');
    }

    return {
      review: {
        reviewerName: review.reviewerName,
        status: review.status,
        comment: review.comment,
        expiresAt: review.expiresAt,
        reviewedAt: review.reviewedAt,
      },
      // Do not expose the stored image JSON verbatim: it can contain the
      // backend's local filesystem path. Return only validated public HTTPS
      // URLs and bounded alt text for the external reviewer.
      posts: posts.map(({ image, ...post }) => ({
        ...post,
        media: safeReviewMedia(image),
      })),
    };
  }

  @Post('/:token/decision')
  async decide(
    @Param('token') token: string,
    @Body() body: { decision?: string; comment?: string }
  ) {
    const decision = body.decision;
    if (decision !== 'approved' && decision !== 'changes_requested') {
      throw new BadRequestException('Choose approve or request changes.');
    }
    const comment = typeof body.comment === 'string' ? body.comment.trim().slice(0, 2000) : '';
    if (decision === 'changes_requested' && !comment) {
      throw new BadRequestException('Add a comment describing the requested changes.');
    }

    const review = await this.findReview(token);
    if (review.status !== 'pending') {
      throw new BadRequestException('This review has already been submitted.');
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.contentReview.updateMany({
        where: {
          id: review.id,
          status: 'pending',
          expiresAt: { gt: new Date() },
        },
        data: {
          status: decision,
          comment: comment || null,
          reviewedAt: new Date(),
        },
      });
      if (updated.count !== 1) {
        throw new GoneException('This review link has expired or has already been submitted.');
      }

      // Propagate client decision to the underlying posts in the group
      if (decision === 'approved') {
        await tx.post.updateMany({
          where: { group: review.postGroup, organizationId: review.organizationId },
          data: {
            approvalStatus: 'approved',
            approvedAt: new Date(),
          },
        });
      } else if (decision === 'changes_requested') {
        await tx.post.updateMany({
          where: { group: review.postGroup, organizationId: review.organizationId },
          data: {
            approvalStatus: 'changes_requested',
          },
        });
      } else if (decision === 'rejected') {
        await tx.post.updateMany({
          where: { group: review.postGroup, organizationId: review.organizationId },
          data: {
            approvalStatus: 'rejected',
          },
        });
      }

      await tx.contentReviewEvent.create({
        data: {
          reviewId: review.id,
          organizationId: review.organizationId,
          action: decision,
          actorEmail: review.reviewerEmail,
          actorName: review.reviewerName,
          comment: comment || null,
        },
      });
      return { success: true, status: decision };
    });
  }
}
