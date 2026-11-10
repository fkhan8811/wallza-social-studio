import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Injectable } from '@nestjs/common';
import { SaveMediaInformationDto } from '@gitroom/nestjs-libraries/dtos/media/save.media.information.dto';

@Injectable()
export class MediaRepository {
  constructor(private _media: PrismaRepository<'media' | 'mediaCollection' | 'mediaCollectionItem' | '$transaction'>) {}

  saveFile(org: string, fileName: string, filePath: string, originalName?: string) {
    return this._media.model.media.create({
      data: {
        organization: {
          connect: {
            id: org,
          },
        },
        name: fileName,
        path: filePath,
        originalName: originalName || null,
      },
      select: {
        id: true,
        name: true,
        originalName: true,
        path: true,
        thumbnail: true,
        alt: true,
        status: true,
      },
    });
  }

  startProcessing(org: string, id: string) {
    return this._media.model.media.update({
      where: { id, organizationId: org },
      data: { status: 'processing', processingError: null },
      select: { id: true, status: true },
    });
  }

  finishProcessing(
    org: string,
    id: string,
    data: { name?: string; path?: string; fileSize?: number; error?: string }
  ) {
    return this._media.model.media.update({
      where: { id, organizationId: org },
      data: {
        ...(data.name ? { name: data.name } : {}),
        ...(data.path ? { path: data.path } : {}),
        ...(data.fileSize ? { fileSize: data.fileSize } : {}),
        status: data.error ? 'failed' : 'ready',
        processingError: data.error || null,
      },
      select: { id: true, status: true },
    });
  }

  getMediaStatus(org: string, id: string) {
    return this._media.model.media.findFirst({
      where: {
        id,
        organizationId: org,
        deletedAt: null,
      },
      select: {
        id: true,
        name: true,
        originalName: true,
        path: true,
        thumbnail: true,
        alt: true,
        status: true,
        processingError: true,
      },
    });
  }

  getMediaById(id: string) {
    return this._media.model.media.findUnique({
      where: {
        id,
      },
    });
  }

  async deleteMedia(org: string, id: string) {
    return this._media.model.$transaction(async (tx) => {
      const media = await tx.media.updateMany({
        where: { id, organizationId: org, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      if (media.count === 0) return { success: false };
      await tx.mediaCollectionItem.deleteMany({
        where: { mediaId: id, organizationId: org },
      });
      return { success: true };
    });
  }

  saveMediaInformation(org: string, data: SaveMediaInformationDto) {
    return this._media.model.media.update({
      where: {
        id: data.id,
        organizationId: org,
      },
      data: {
        alt: data.alt,
        thumbnail: data.thumbnail,
        thumbnailTimestamp: data.thumbnailTimestamp,
      },
      select: {
        id: true,
        name: true,
        originalName: true,
        alt: true,
        thumbnail: true,
        path: true,
        thumbnailTimestamp: true,
      },
    });
  }

  async getMedia(
    org: string,
    page: number,
    search?: string,
    favorite?: boolean,
    tag?: string,
    collectionId?: string
  ) {
    const pageNum = Math.max(0, (Number(page) || 1) - 1);
    const trimmedSearch = search?.trim();
    const trimmedTag = tag?.trim().toLowerCase();
    const where = {
      organizationId: org,
      deletedAt: null,
      status: { not: 'processing' },
      ...(trimmedSearch
        ? {
            originalName: {
              contains: trimmedSearch,
              mode: 'insensitive' as const,
            },
          }
        : {}),
      ...(favorite !== undefined ? { isFavorite: favorite } : {}),
      ...(trimmedTag ? { tags: { has: trimmedTag } } : {}),
      ...(collectionId
        ? { collectionItems: { some: { organizationId: org, collectionId } } }
        : {}),
    };
    const total = await this._media.model.media.count({ where });
    const pages = Math.ceil(total / 18);
    const results = await this._media.model.media.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        originalName: true,
        path: true,
        thumbnail: true,
        alt: true,
        thumbnailTimestamp: true,
        isFavorite: true,
        tags: true,
        collectionItems: {
          where: { organizationId: org },
          select: {
            collection: { select: { id: true, name: true } },
          },
        },
        createdAt: true,
      },
      skip: pageNum * 18,
      take: 18,
    });

    return { pages, total, results };
  }

  async setFavorite(org: string, id: string, favorite: boolean) {
    const result = await this._media.model.media.updateMany({
      where: { id, organizationId: org, deletedAt: null },
      data: { isFavorite: favorite },
    });
    if (!result.count) return null;
    return this._media.model.media.findFirst({
      where: { id, organizationId: org, deletedAt: null },
      select: { id: true, isFavorite: true },
    });
  }

  async setTags(org: string, id: string, tags: string[]) {
    const result = await this._media.model.media.updateMany({
      where: { id, organizationId: org, deletedAt: null },
      data: { tags },
    });
    if (!result.count) return null;
    return this._media.model.media.findFirst({
      where: { id, organizationId: org, deletedAt: null },
      select: { id: true, tags: true },
    });
  }

  getCollections(org: string) {
    return this._media.model.mediaCollection.findMany({
      where: { organizationId: org },
      orderBy: [{ name: 'asc' }],
      select: {
        id: true,
        name: true,
        description: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { items: true } },
      },
    });
  }

  createCollection(org: string, name: string, description: string) {
    return this._media.model.mediaCollection.create({
      data: { organizationId: org, name, description },
      select: { id: true, name: true, description: true, createdAt: true, updatedAt: true },
    });
  }

  async updateCollection(org: string, id: string, name?: string, description?: string) {
    const data = {
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
    };
    const result = await this._media.model.mediaCollection.updateMany({
      where: { id, organizationId: org },
      data,
    });
    if (!result.count) return null;
    return this._media.model.mediaCollection.findFirst({
      where: { id, organizationId: org },
      select: { id: true, name: true, description: true, updatedAt: true },
    });
  }

  async deleteCollection(org: string, id: string) {
    const result = await this._media.model.mediaCollection.deleteMany({
      where: { id, organizationId: org },
    });
    return result.count > 0;
  }

  async addToCollection(org: string, collectionId: string, mediaId: string) {
    return this._media.model.$transaction(async (tx) => {
      const [collection, media] = await Promise.all([
        tx.mediaCollection.findFirst({
          where: { id: collectionId, organizationId: org },
          select: { id: true },
        }),
        tx.media.findFirst({
          where: { id: mediaId, organizationId: org, deletedAt: null },
          select: { id: true },
        }),
      ]);
      if (!collection || !media) return null;
      const last = await tx.mediaCollectionItem.aggregate({
        where: { collectionId, organizationId: org },
        _max: { position: true },
      });
      return tx.mediaCollectionItem.upsert({
        where: { collectionId_mediaId: { collectionId, mediaId } },
        create: {
          organizationId: org,
          collectionId,
          mediaId,
          position: (last._max.position ?? -1) + 1,
        },
        update: {},
        select: { id: true, collectionId: true, mediaId: true, position: true },
      });
    });
  }

  async removeFromCollection(org: string, collectionId: string, mediaId: string) {
    const result = await this._media.model.mediaCollectionItem.deleteMany({
      where: { organizationId: org, collectionId, mediaId },
    });
    return result.count > 0;
  }
}
