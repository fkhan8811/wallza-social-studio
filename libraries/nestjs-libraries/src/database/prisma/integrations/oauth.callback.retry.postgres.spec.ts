import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OAuthCallbackRetryRepository } from './oauth.callback.retry.repository';

const databaseConfigured = Boolean(process.env.DATABASE_URL);
const prisma = databaseConfigured ? new PrismaClient() : null;
const organizationId = randomUUID();
const originalSecret = process.env.WALLZAOS_INTERNAL_SECRET;

describe.skipIf(!databaseConfigured)('PostgreSQL OAuth callback retry worker', () => {
  const makeRepository = () => {
    const repository: any = Object.create(OAuthCallbackRetryRepository.prototype);
    repository._prisma = { model: prisma };
    repository._transaction = { model: prisma };
    repository._logger = { warn: vi.fn() };
    return repository as OAuthCallbackRetryRepository;
  };

  beforeAll(async () => {
    if (!prisma) throw new Error('DATABASE_URL is required for OAuth callback retry tests');
    process.env.WALLZAOS_INTERNAL_SECRET =
      'test-wallza-internal-secret-with-at-least-32-characters';
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: 'OAuth Callback Retry Test Tenant',
        description: 'automated OAuth retry fixture',
      },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.oAuthCallbackRetry.deleteMany({ where: { organizationId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.$disconnect();
    if (originalSecret === undefined) {
      delete process.env.WALLZAOS_INTERNAL_SECRET;
    } else {
      process.env.WALLZAOS_INTERNAL_SECRET = originalSecret;
    }
    vi.unstubAllGlobals();
  });

  it('claims a pending callback event once across concurrent worker instances', async () => {
    if (!prisma) return;
    const repositoryA = makeRepository();
    const repositoryB = makeRepository();
    const state = randomUUID();

    await repositoryA.enqueueOrUpdate({
      state,
      organizationId,
      wallzaOrgId: randomUUID(),
      platform: 'facebook',
      accountName: 'Test Facebook Page',
      accountId: randomUUID(),
      socialStudioIntegrationId: randomUUID(),
      grantedScopes: ['pages_read_engagement'],
      category: 'major',
    });

    const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
    vi.stubGlobal('fetch', fetchMock);

    const [workerA, workerB] = await Promise.all([
      repositoryA.processPendingRetries(10),
      repositoryB.processPendingRetries(10),
    ]);

    expect(workerA.processed + workerB.processed).toBe(1);
    expect(workerA.succeeded + workerB.succeeded).toBe(1);
    expect(workerA.failed + workerB.failed).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const saved = await prisma.oAuthCallbackRetry.findUnique({ where: { state } });
    expect(saved).toMatchObject({
      status: 'completed',
      attempts: 1,
      lockedAt: null,
      lastError: null,
    });
  });
});
