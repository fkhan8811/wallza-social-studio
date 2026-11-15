import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IntegrationRepository } from './integration.repository';
import { OrganizationRepository } from '../organizations/organization.repository';

const databaseConfigured = Boolean(process.env.DATABASE_URL);
const prisma = databaseConfigured ? new PrismaClient() : null;
const organizationId = randomUUID();
const otherOrganizationId = randomUUID();
const wallzaOrganizationId = randomUUID();
const wallzaTestOrganizationIds: string[] = [];

describe.skipIf(!databaseConfigured)('PostgreSQL generation-fenced integration mutations', () => {
  const repository: any = Object.create(IntegrationRepository.prototype);

  beforeAll(async () => {
    if (!prisma) throw new Error('DATABASE_URL is required for the PostgreSQL fence tests');
    repository._transaction = { model: prisma };
    repository._integration = { model: prisma };
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: 'Wallza Social Sync Fence Test',
        description: 'automated test fixture',
      },
    });
    await prisma.organization.create({
      data: {
        id: otherOrganizationId,
        name: 'Wallza Social Sync Other Tenant Test',
        description: 'automated other-tenant fixture',
      },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.integration.deleteMany({
      where: { organizationId: { in: [organizationId, otherOrganizationId] } },
    });
    await prisma.socialSyncGeneration.deleteMany({
      where: { organizationId: { in: [organizationId, otherOrganizationId] } },
    });
    await prisma.organization.deleteMany({
      where: { id: { in: [organizationId, otherOrganizationId, ...wallzaTestOrganizationIds] } },
    });
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

  it('does not propagate one-time provider tokens across organizations', async () => {
    if (!prisma) return;
    const rootInternalId = randomUUID();
    await prisma.integration.create({
      data: {
        organizationId,
        internalId: 'same-tenant-child',
        rootInternalId,
        name: 'Same tenant child',
        providerIdentifier: 'tiktok',
        type: 'social',
        token: 'old-same-tenant-token',
        refreshToken: 'old-same-tenant-refresh',
      },
    });
    await prisma.integration.create({
      data: {
        organizationId: otherOrganizationId,
        internalId: 'other-tenant-child',
        rootInternalId,
        name: 'Other tenant child',
        providerIdentifier: 'tiktok',
        type: 'social',
        token: 'other-tenant-token',
        refreshToken: 'other-tenant-refresh',
      },
    });

    await repository.createOrUpdateIntegration(
      undefined,
      true,
      organizationId,
      'One-time Token Source',
      undefined,
      'social',
      rootInternalId,
      'tiktok',
      'new-same-tenant-token',
      'new-same-tenant-refresh',
      3600,
      'publisher',
      false,
      undefined,
      0,
      undefined
    );

    const sameTenantChild = await prisma.integration.findUnique({
      where: {
        organizationId_internalId: {
          organizationId,
          internalId: 'same-tenant-child',
        },
      },
    });
    const otherTenantChild = await prisma.integration.findUnique({
      where: {
        organizationId_internalId: {
          organizationId: otherOrganizationId,
          internalId: 'other-tenant-child',
        },
      },
    });

    expect(sameTenantChild?.token).toBe('new-same-tenant-token');
    expect(otherTenantChild?.token).toBe('other-tenant-token');
    expect(otherTenantChild?.refreshToken).toBe('other-tenant-refresh');
  });

  it('resolves a canonical Wallza tenant ID ahead of a colliding legacy description', async () => {
    if (!prisma) return;
    const canonical = await prisma.organization.create({
      data: {
        name: 'Canonical Wallza Tenant',
        description: `wallza_org:${wallzaOrganizationId}`,
        wallzaOrgId: wallzaOrganizationId,
      },
    });
    wallzaTestOrganizationIds.push(canonical.id);
    const legacy = await prisma.organization.create({
      data: {
        name: 'Legacy description collision',
        description: `wallza_org:${wallzaOrganizationId}`,
      },
    });
    wallzaTestOrganizationIds.push(legacy.id);

    const organizationRepository: any = Object.create(OrganizationRepository.prototype);
    organizationRepository._organization = { model: prisma };

    const resolved = await organizationRepository.findByWallzaOrgId(wallzaOrganizationId);
    expect(resolved?.id).toBe(canonical.id);

    await prisma.organization.update({
      where: { id: canonical.id },
      data: { deletedAt: new Date() },
    });
    await expect(
      organizationRepository.findByWallzaOrgId(wallzaOrganizationId)
    ).resolves.toBeNull();
  });
});
