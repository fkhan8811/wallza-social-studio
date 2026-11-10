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
      expiresInDays?: number;
    }
  ) {
    const postGroup = typeof body.postGroup === 'string' ? body.postGroup.trim() : '';
    const reviewerEmail = typeof body.reviewerEmail === 'string'
      ? body.reviewerEmail.trim().toLowerCase()
      : '';
    const reviewerName = typeof body.reviewerName === 'string'
      ? body.reviewerName.trim().slice(0, 120)
      : '';

    if (!postGroup || postGroup.length > 160) {
      throw new BadRequestException('Provide a valid Postiz post group.');
    }
    if (!emailPattern.test(reviewerEmail) || reviewerEmail.length > 254) {
      throw new BadRequestException('Provide a valid reviewer email address.');
    }
    const expiresInDays = body.expiresInDays ?? 7;
    if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 30) {
      throw new BadRequestException('Review links must expire between 1 and 30 days.');
    }

    const post = await this.prisma.post.findFirst({
      where: { group: postGroup, organizationId: org.id, deletedAt: null },
      select: { id: true },
    });
    if (!post) throw new NotFoundException('No active posts were found for this organization and post group.');

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
    const review = await this.prisma.contentReview.create({
      data: {
        organizationId: org.id,
        postGroup,
        reviewerEmail,
        reviewerName: reviewerName || null,
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

    // The raw token is returned once. Only its SHA-256 hash is stored.
    return { ...review, reviewPath: `/review/${token}` };
  }

  @Delete('/:id')
  async revoke(@GetOrgFromRequest() org: Organization, @Param('id') id: string) {
    const result = await this.prisma.contentReview.deleteMany({
      where: { id, organizationId: org.id, status: 'pending' },
    });
    if (result.count === 0) {
      throw new NotFoundException('Pending review link not found. It may already have been used or revoked.');
    }
    return { success: true };
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
    if (!posts.length) throw new NotFoundException('The posts for this review are no longer available.');

    return {
      review: {
        reviewerName: review.reviewerName,
        status: review.status,
        comment: review.comment,
        expiresAt: review.expiresAt,
        reviewedAt: review.reviewedAt,
      },
      posts,
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
    const updated = await this.prisma.contentReview.updateMany({
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
    return { success: true, status: decision };
  }
}
