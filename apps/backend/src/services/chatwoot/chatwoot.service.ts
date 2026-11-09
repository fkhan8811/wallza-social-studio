import {
  BadGatewayException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Organization, User } from '@prisma/client';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

type ChatwootResource = {
  id?: number | string;
  url?: string;
  message?: string;
  error?: string;
};

@Injectable()
export class ChatwootService {
  private readonly accountLocks = new Map<string, Promise<number>>();
  private readonly userLocks = new Map<string, Promise<number>>();

  constructor(private readonly prisma: PrismaService) {}

  isConfigured() {
    return Boolean(
      process.env.CHATWOOT_BASE_URL?.trim() &&
        process.env.CHATWOOT_PLATFORM_API_TOKEN?.trim()
    );
  }

  getStatus(organization: Organization) {
    const configured = this.isConfigured();
    let host: string | null = null;
    if (configured) {
      try {
        host = new URL(process.env.CHATWOOT_BASE_URL!).host;
      } catch {
        host = null;
      }
    }

    return {
      configured,
      provider: 'Chatwoot',
      workspaceName: organization.name,
      host,
      note: configured
        ? 'Your team can open its organization inbox using Postiz single sign-on.'
        : 'The Chatwoot server connection has not been configured by the administrator.',
    };
  }

  async createLaunchUrl(organization: Organization, user: User) {
    this.assertConfigured();

    // Validate the Postiz tenant boundary before creating any external resource.
    const membership = await this.prisma.userOrganization.findUnique({
      where: {
        userId_organizationId: {
          userId: user.id,
          organizationId: organization.id,
        },
      },
      select: { role: true, disabled: true },
    });

    if (!membership || membership.disabled) {
      throw new BadGatewayException(
        'Your Postiz organization membership is not active.'
      );
    }

    const [accountId, chatwootUserId] = await Promise.all([
      this.getOrCreateAccount(organization),
      this.getOrCreateUser(user),
    ]);

    const role =
      membership.role === 'ADMIN' || membership.role === 'SUPERADMIN'
        ? 'administrator'
        : 'agent';

    // Chatwoot's Platform API uses api_access_token (not the end-user
    // access_token) for account/user provisioning and account membership.
    await this.request<ChatwootResource>(
      `/platform/api/v1/accounts/${accountId}/account_users`,
      'POST',
      { user_id: chatwootUserId, role }
    );

    const login = await this.request<ChatwootResource>(
      `/platform/api/v1/users/${chatwootUserId}/login`,
      'GET'
    );

    if (!login.url) {
      throw new BadGatewayException(
        'Chatwoot did not return a single sign-on URL.'
      );
    }

    // Never allow the Platform API response to turn this endpoint into an
    // arbitrary external redirect.
    let target: URL;
    try {
      target = new URL(login.url);
    } catch {
      throw new BadGatewayException(
        'Chatwoot returned an invalid single sign-on URL.'
      );
    }
    const configured = new URL(this.baseUrl());
    if (target.origin !== configured.origin) {
      throw new BadGatewayException(
        'Chatwoot returned an SSO URL on an unexpected domain.'
      );
    }

    return { url: target.toString() };
  }

  private assertConfigured() {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException(
        'Engage is not configured. Set CHATWOOT_BASE_URL and CHATWOOT_PLATFORM_API_TOKEN on the backend.'
      );
    }
  }

  private baseUrl() {
    this.assertConfigured();
    let parsed: URL;
    try {
      parsed = new URL(process.env.CHATWOOT_BASE_URL!.trim());
    } catch {
      throw new ServiceUnavailableException(
        'CHATWOOT_BASE_URL must be a valid absolute URL.'
      );
    }

    if (
      !['https:', 'http:'].includes(parsed.protocol) ||
      (parsed.protocol !== 'https:' &&
        !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname))
    ) {
      throw new ServiceUnavailableException(
        'CHATWOOT_BASE_URL must use HTTPS outside localhost.'
      );
    }

    return parsed.toString().replace(/\/$/, '');
  }

  private async request<T extends ChatwootResource>(
    path: string,
    method: 'GET' | 'POST',
    payload?: Record<string, unknown>
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl()}${path}`, {
        method,
        headers: {
          api_access_token: process.env.CHATWOOT_PLATFORM_API_TOKEN!.trim(),
          Accept: 'application/json',
          ...(payload ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ServiceUnavailableException(
        'Could not reach the configured Chatwoot server.'
      );
    }

    const raw = await response.text();
    let data: T = {} as T;
    try {
      data = raw ? (JSON.parse(raw) as T) : ({} as T);
    } catch {
      if (response.ok) {
        throw new BadGatewayException(
          'Chatwoot returned an unreadable response.'
        );
      }
    }

    if (!response.ok) {
      const detail =
        typeof data.message === 'string'
          ? data.message
          : typeof data.error === 'string'
            ? data.error
            : `HTTP ${response.status}`;
      throw new BadGatewayException(
        `Chatwoot API request failed: ${detail}`
      );
    }

    return data;
  }

  private async getOrCreateAccount(organization: Organization): Promise<number> {
    const existing = await this.prisma.chatwootAccountMapping.findUnique({
      where: { organizationId: organization.id },
      select: { accountId: true },
    });
    if (existing) return existing.accountId;

    const inFlight = this.accountLocks.get(organization.id);
    if (inFlight) return inFlight;

    const pending = this.createAccountMapping(organization);
    this.accountLocks.set(organization.id, pending);
    try {
      return await pending;
    } finally {
      this.accountLocks.delete(organization.id);
    }
  }

  private async createAccountMapping(organization: Organization) {
    const created = await this.request<ChatwootResource>(
      '/platform/api/v1/accounts',
      'POST',
      { name: organization.name, locale: 'en' }
    );
    const accountId = this.numericId(created.id, 'account');

    try {
      await this.prisma.chatwootAccountMapping.create({
        data: { organizationId: organization.id, accountId },
      });
      return accountId;
    } catch (error) {
      const raced = await this.prisma.chatwootAccountMapping.findUnique({
        where: { organizationId: organization.id },
        select: { accountId: true },
      });
      if (raced) return raced.accountId;
      throw error;
    }
  }

  private async getOrCreateUser(user: User): Promise<number> {
    const existing = await this.prisma.chatwootUserMapping.findUnique({
      where: { userId: user.id },
      select: { chatwootUserId: true },
    });
    if (existing) return existing.chatwootUserId;

    const inFlight = this.userLocks.get(user.id);
    if (inFlight) return inFlight;

    const pending = this.createUserMapping(user);
    this.userLocks.set(user.id, pending);
    try {
      return await pending;
    } finally {
      this.userLocks.delete(user.id);
    }
  }

  private async createUserMapping(user: User) {
    const fullName =
      [user.name, user.lastName].filter(Boolean).join(' ').trim() ||
      user.email;
    const created = await this.request<ChatwootResource>(
      '/platform/api/v1/users',
      'POST',
      {
        name: fullName,
        display_name: fullName,
        email: user.email,
        // The user never needs this password; sign-in is through Chatwoot SSO.
        password: randomBytes(48).toString('base64url'),
      }
    );
    const chatwootUserId = this.numericId(created.id, 'user');

    try {
      await this.prisma.chatwootUserMapping.create({
        data: { userId: user.id, chatwootUserId },
      });
      return chatwootUserId;
    } catch (error) {
      const raced = await this.prisma.chatwootUserMapping.findUnique({
        where: { userId: user.id },
        select: { chatwootUserId: true },
      });
      if (raced) return raced.chatwootUserId;
      throw error;
    }
  }

  private numericId(value: number | string | undefined, resource: string) {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id < 1) {
      throw new BadGatewayException(
        `Chatwoot returned an invalid ${resource} identifier.`
      );
    }
    return id;
  }
}
