import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IntegrationRepository } from './integration.repository';

const databaseConfigured = Boolean(process.env.DATABASE_URL);
const prisma = databaseConfigured ? new PrismaClient() : null;
const organizationId = randomUUID();

describe.skipIf(!databaseConfigured)('PostgreSQL generation-fenced integration mutations', () => {
  const repository: any = Object.create(IntegrationRepository.prototype);

  beforeAll(async () => {
    if (!prisma) throw new Error('DATABASE_URL is required for the PostgreSQL fence tests');
    repository._transaction = { model: prisma };
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: 'Wallza Social Sync Fence Test',
        description: 'automated test fixture',
      },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.integration.deleteMany({ where: { organizationId } });
    await prisma.socialSyncGeneration.deleteMany({ where: { organizationId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.$disconnect();
  });

  async function upsertInTransaction(tx: any, internalId: string) {
    return tx.integration.upsert({
      where: {
        organizationId_internalId: { organizationId, internalId },
      },
      create: {
        organizationId,
        internalId,
        name: 'Generation fence test account',
        providerIdentifier: 'facebook',
        type: 'social',
        token: 'test-token-only',
        rootInternalId: internalId,
      },
      update: {
        name: 'Generation fence test account',
        providerIdentifier: 'facebook',
        type: 'social',
        token: 'test-token-only',
        deletedAt: null,
      },
    });
  }

  async function upsert(internalId: string, generation: number) {
    return repository.withGenerationFence(
      organizationId,
      'facebook',
      internalId,
      generation,
      'upsert',
      (tx: any) => upsertInTransaction(tx, internalId)
    );
  }

  async function disconnect(internalId: string, generation: number) {
    return repository.withGenerationFence(
      organizationId,
      'facebook',
      internalId,
      generation,
      'disconnect',
      (tx: any) => tx.integration.updateMany({
        where: {
          organizationId,
          internalId,
          providerIdentifier: 'facebook',
          deletedAt: null,
        },
        data: { deletedAt: new Date() },
      })
    );
  }

  it('commits the highest generation when upsert and disconnect overlap', async () => {
    if (!prisma) return;
    const internalId = randomUUID();

    await Promise.all([
      upsert(internalId, 40),
      disconnect(internalId, 41),
    ]);

    const generation = await prisma.socialSyncGeneration.findUnique({
      where: {
        organizationId_provider_internalId: {
          organizationId,
          provider: 'facebook',
          internalId,
        },
      },
    });
    const integration = await prisma.integration.findUnique({
      where: { organizationId_internalId: { organizationId, internalId } },
    });

    expect(generation).toMatchObject({ generation: 41, lastAction: 'disconnect' });
    expect(!integration || integration.deletedAt !== null).toBe(true);
  });

  it('prevents a stale disconnect from deleting a newer reconnect', async () => {
    if (!prisma) return;
    const internalId = randomUUID();

    await upsert(internalId, 50);
    const staleDisconnect = await disconnect(internalId, 49);
    const integration = await prisma.integration.findUnique({
      where: { organizationId_internalId: { organizationId, internalId } },
    });

    expect(staleDisconnect).toMatchObject({ allowed: false, reason: 'superseded' });
    expect(integration?.deletedAt).toBeNull();
  });

  it('prevents a stale upsert from recreating an account after disconnect', async () => {
    if (!prisma) return;
    const internalId = randomUUID();

    await disconnect(internalId, 60);
    const staleUpsert = await upsert(internalId, 59);
    const integration = await prisma.integration.findUnique({
      where: { organizationId_internalId: { organizationId, internalId } },
    });

    expect(staleUpsert).toMatchObject({ allowed: false, reason: 'superseded' });
    expect(integration).toBeNull();
  });

  it('rejects a same-generation action conflict while allowing idempotent replay', async () => {
    if (!prisma) return;
    const internalId = randomUUID();

    await upsert(internalId, 70);
    const replay = await upsert(internalId, 70);
    const conflict = await disconnect(internalId, 70);

    expect(replay).toMatchObject({ allowed: true, reason: 'replayed' });
    expect(conflict).toMatchObject({ allowed: false, reason: 'conflict' });
  });
});
