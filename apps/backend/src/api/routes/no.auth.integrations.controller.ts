import {
  Body,
  Controller,
  Get,
  HttpException,
  Param,
  Post,
  Req,
  Res,
  UseFilters,
} from '@nestjs/common';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';
import { ConnectIntegrationDto } from '@gitroom/nestjs-libraries/dtos/integrations/connect.integration.dto';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { CheckPolicies } from '@gitroom/backend/services/auth/permissions/permissions.ability';
import { ApiTags } from '@nestjs/swagger';
import { NotEnoughScopesFilter } from '@gitroom/nestjs-libraries/integrations/integration.missing.scopes';
import { AuthService } from '@gitroom/helpers/auth/auth.service';
import { AuthTokenDetails } from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { NotEnoughScopes } from '@gitroom/nestjs-libraries/integrations/social.abstract';
import {
  AuthorizationActions,
  Sections,
} from '@gitroom/backend/services/auth/permissions/permission.exception.class';
import { RefreshIntegrationService } from '@gitroom/nestjs-libraries/integrations/refresh.integration.service';
import { OrganizationService } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service';
import { SocialSyncGenerationRepository } from '@gitroom/nestjs-libraries/database/prisma/integrations/social.sync.generation.repository';
import { OAuthCallbackRetryRepository } from '@gitroom/nestjs-libraries/database/prisma/integrations/oauth.callback.retry.repository';
import { getSsrfSafeDispatcher } from '@gitroom/nestjs-libraries/dtos/webhooks/ssrf.safe.dispatcher';
import { verifyWallzaInternalRequest, signInternalRequest } from '@gitroom/nestjs-libraries/auth/wallza.hmac';
import { Request, Response } from 'express';

@ApiTags('Integrations')
@Controller('/integrations')
export class NoAuthIntegrationsController {
  constructor(
    private _integrationManager: IntegrationManager,
    private _integrationService: IntegrationService,
    private _refreshIntegrationService: RefreshIntegrationService,
    private _organizationService: OrganizationService,
    private _socialSyncGenerationRepository: SocialSyncGenerationRepository,
    private _oAuthCallbackRetryRepository: OAuthCallbackRetryRepository
  ) {}

  @Get('/')
  getIntegrations() {
    return this._integrationManager.getAllIntegrations();
  }

  @Post('/social-connect/:integration')
  @CheckPolicies([AuthorizationActions.Create, Sections.CHANNEL])
  @UseFilters(new NotEnoughScopesFilter())
  async connectSocialMedia(
    @Param('integration') integration: string,
    @Body() body: ConnectIntegrationDto
  ) {
    if (
      !this._integrationManager
        .getAllowedSocialsIntegrations()
        .includes(integration)
    ) {
      throw new Error('Integration not allowed');
    }

    const integrationProvider =
      this._integrationManager.getSocialIntegration(integration);

    const getCodeVerifier = integrationProvider.customFields
      ? 'none'
      : await ioRedis.get(`login:${body.state}`);
    if (!getCodeVerifier) {
      // The state expires after an hour and is deleted once used (page reload)
      throw new HttpException(
        'This connection link expired or was already used, please connect the channel again',
        400
      );
    }

    const organization = await ioRedis.get(`organization:${body.state}`);
    if (!organization) {
      throw new Error('Organization not found');
    }

    const org = await this._organizationService.getOrgById(organization);

    if (!integrationProvider.customFields) {
      await ioRedis.del(`login:${body.state}`);
    }

    const details = integrationProvider.externalUrl
      ? await ioRedis.get(`external:${body.state}`)
      : undefined;

    if (details) {
      await ioRedis.del(`external:${body.state}`);
    }

    const refresh = await ioRedis.get(`refresh:${body.state}`);
    if (refresh) {
      await ioRedis.del(`refresh:${body.state}`);
    }

    const onboarding = await ioRedis.get(`onboarding:${body.state}`);
    if (onboarding) {
      await ioRedis.del(`onboarding:${body.state}`);
    }

    const {
      error,
      accessToken,
      expiresIn,
      refreshToken,
      id,
      name,
      picture,
      username,
      additionalSettings,
      // eslint-disable-next-line no-async-promise-executor
    } = await new Promise<AuthTokenDetails>(async (res) => {
      try {
        const auth = await integrationProvider.authenticate(
          {
            code: body.code,
            codeVerifier: getCodeVerifier,
            refresh: body.refresh,
          },
          details ? JSON.parse(details) : undefined
        );

        if (typeof auth === 'string') {
          return res({
            error: auth,
            accessToken: '',
            id: '',
            name: '',
            picture: '',
            username: '',
            additionalSettings: [],
          });
        }

        if (refresh && integrationProvider.reConnect) {
          console.log('reconnect');
          try {
            const newAuth = await integrationProvider.reConnect(
              auth.id,
              refresh,
              auth.accessToken
            );
            // keep the fresh refresh token and expiration from the new
            // authentication, otherwise the stored refresh token is wiped and
            // the channel breaks again as soon as the access token expires
            return res({
              ...newAuth,
              refreshToken: auth.refreshToken,
              expiresIn: auth.expiresIn,
            });
          } catch (err: any) {
            return res({
              error: err.message,
              accessToken: '',
              id: '',
              name: '',
              picture: '',
              username: '',
              additionalSettings: [],
            });
          }
        }

        return res(auth);
      } catch (err) {
        if (err instanceof NotEnoughScopes) {
          return res({
            error: err.message,
            accessToken: '',
            id: '',
            name: '',
            picture: '',
            username: '',
            additionalSettings: [],
          });
        }

        console.log(`Authentication failed for ${integration}:`, err);
        return res({
          error: 'Authentication failed',
          accessToken: '',
          id: '',
          name: '',
          picture: '',
          username: '',
          additionalSettings: [],
        });
      }
    });

    if (error) {
      throw new NotEnoughScopes(error);
    }

    if (!id) {
      throw new NotEnoughScopes('Invalid API key');
    }

    let validName = name;
    if (!validName) {
      if (username) {
        validName = username.split('.')[0] ?? username;
      } else {
        validName = `Channel_${String(id).slice(0, 8)}`;
      }
    }

    if (
      process.env.STRIPE_PUBLISHABLE_KEY &&
      org.isTrailing &&
      (await this._integrationService.checkPreviousConnections(
        org.id,
        String(id)
      ))
    ) {
      throw new HttpException('', 412);
    }

    if (refresh && String(id) !== String(refresh)) {
      // A reconnect that returns a different id is either the wrong account or
      // a channel migrating to another provider (MIGRATE_PROVIDERS) - the two
      // apps return different app-scoped ids, so the channel is matched by
      // profile and moved in place. Throws for anything else. Runs after every
      // check that can reject the connect, so a rejection can never leave a
      // half-migrated channel behind.
      await this._integrationService.migrateIntegration(
        org.id,
        refresh,
        integration,
        { id: String(id), username }
      );
    } else if (!refresh) {
      // A fresh connect of a migration target for an account the org already
      // has on the source provider adopts that channel instead of creating a
      // duplicate. No-op for everything else.
      await this._integrationService.migrateIntegrationOnConnect(
        org.id,
        integration,
        { id: String(id), username }
      );
    }

    const createUpdate =
      await this._integrationService.createOrUpdateIntegration(
        additionalSettings,
        !!integrationProvider.oneTimeToken,
        org.id,
        validName.trim(),
        picture,
        'social',
        String(id),
        integration,
        accessToken,
        refreshToken,
        expiresIn,
        username,
        refresh ? false : integrationProvider.isBetweenSteps,
        body.refresh,
        +body.timezone,
        details
          ? AuthService.fixedEncryption(details)
          : integrationProvider.customFields
          ? AuthService.fixedEncryption(
              Buffer.from(body.code, 'base64').toString()
            )
          : integrationProvider.isChromeExtension
          ? AuthService.fixedEncryption(
              Buffer.from(body.code, 'base64').toString()
            )
          : undefined
      );

    this._refreshIntegrationService
      .startRefreshWorkflow(org.id, createUpdate.id, integrationProvider)
      .catch((err) => {
        console.log(err);
      });

    // Fetch pages if this is a two-step provider and not a refresh
    let pages: any[] = [];
    if (integrationProvider.isBetweenSteps && !refresh) {
      try {
        // Check which method the provider uses (pages or companies)
        const fetchMethod =
          'pages' in integrationProvider
            ? 'pages'
            : 'companies' in integrationProvider
            ? 'companies'
            : null;

        if (fetchMethod) {
          // @ts-ignore - dynamic method call
          pages = await integrationProvider[fetchMethod](accessToken);
        }
      } catch (err) {
        console.log('Failed to fetch pages:', err);
      }
    }

    const webhookUrl = await ioRedis.get(`webhookUrl:${body.state}`);
    if (webhookUrl) {
      try {
        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            params: AuthService.signJWT({
              apiKey: org.apiKey,
            }),
          }),
          // @ts-ignore — undici option, not in lib.dom fetch types
          dispatcher: getSsrfSafeDispatcher(),
        });
      } catch (err) {}

      await ioRedis.del(`webhookUrl:${body.state}`);
    }

    const returnURL = await ioRedis.get(`redirect:${body.state}`);
    if (returnURL) {
      await ioRedis.del(`redirect:${body.state}`);
    }

    // Bridge OAuth callback to WallzaOS internal sync if initiated from WallzaOS
    const wallzaOrgState = await ioRedis.get(`wallza:oauth_org:${body.state}`);
    if (wallzaOrgState) {
      const wallzaApiUrl = process.env.WALLZAOS_INTERNAL_API_URL || process.env.WALLZA_BACKEND_URL || 'http://127.0.0.1:5001';
      const syncPayload = {
        organizationId: wallzaOrgState,
        platform: integration,
        accountName: validName.trim(),
        accountId: String(id),
        avatarUrl: picture || null,
        socialStudioIntegrationId: createUpdate.id,
        grantedScopes: integrationProvider.scopes || [],
        tokenExpiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
        category: 'major',
      };

      try {
        const signed = signInternalRequest({
          method: 'POST',
          path: '/api/social/accounts/sync-internal',
          audience: 'wallzaos',
          body: syncPayload,
        });

        const syncRes = await fetch(`${wallzaApiUrl}/api/social/accounts/sync-internal`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...signed,
          },
          body: JSON.stringify(syncPayload),
        });

        if (syncRes.ok) {
          await ioRedis.del(`wallza:oauth_org:${body.state}`);
          await this._oAuthCallbackRetryRepository.markCompletedByState(body.state);
        } else {
          const errBody = await syncRes.text().catch(() => '');
          console.warn(`[WallzaBridge] Failed to sync to WallzaOS (status ${syncRes.status}): ${errBody}. Enqueuing durable Postgres retry event.`);
          await this._oAuthCallbackRetryRepository.enqueueOrUpdate({
            state: body.state,
            organizationId: org.id,
            wallzaOrgId: wallzaOrgState,
            platform: integration,
            accountName: validName.trim(),
            accountId: String(id),
            avatarUrl: picture || null,
            socialStudioIntegrationId: createUpdate.id,
            grantedScopes: integrationProvider.scopes || [],
            tokenExpiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
            category: 'major',
            error: `HTTP ${syncRes.status}: ${errBody}`,
          });
        }
      } catch (bridgeErr: any) {
        console.warn('[WallzaBridge] Network/runtime error during WallzaOS bridge dispatch:', bridgeErr.message);
        await this._oAuthCallbackRetryRepository.enqueueOrUpdate({
          state: body.state,
          organizationId: org.id,
          wallzaOrgId: wallzaOrgState,
          platform: integration,
          accountName: validName.trim(),
          accountId: String(id),
          avatarUrl: picture || null,
          socialStudioIntegrationId: createUpdate.id,
          grantedScopes: integrationProvider.scopes || [],
          tokenExpiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
          category: 'major',
          error: bridgeErr.message,
        });
      }
    }

    const extensionToken = integrationProvider.isChromeExtension
      ? AuthService.signJWT({
          integrationId: createUpdate.id,
          organizationId: org.id,
          internalId: String(id),
          provider: integration,
        })
      : undefined;

    // Never leak stored credentials (signed/encrypted secrets) back to the
    // caller. These columns hold the integration access token, refresh token
    // and encrypted custom instance details and must stay server-side.
    const {
      token: _token,
      refreshToken: _refreshToken,
      customInstanceDetails: _customInstanceDetails,
      ...safeIntegration
    } = createUpdate as any;

    return {
      ...safeIntegration,
      onboarding: onboarding === 'true',
      pages,
      ...(returnURL ? { returnURL } : {}),
      ...(extensionToken ? { extensionToken } : {}),
    };
  }

  @Post('/public/provider/:id/connect')
  async saveProviderPage(@Param('id') id: string, @Body() body: any) {
    if (!body.state) {
      throw new Error('Invalid state');
    }

    const organization = await ioRedis.get(`organization:${body.state}`);
    if (!organization) {
      throw new Error('Organization not found');
    }

    const org = await this._organizationService.getOrgById(organization);

    return this._integrationService.saveProviderPage(org.id, id, body);
  }

  @Post('/extension-refresh')
  async extensionRefreshCookies(
    @Body() body: { jwt: string; cookies: string }
  ) {
    let payload: any;
    try {
      payload = AuthService.verifyJWT(body.jwt);
    } catch {
      throw new HttpException('Invalid token', 401);
    }

    const { integrationId, organizationId, internalId, provider } = payload;
    if (
      !integrationId ||
      typeof integrationId !== 'string' ||
      !organizationId ||
      typeof organizationId !== 'string' ||
      !internalId ||
      typeof internalId !== 'string' ||
      !provider ||
      typeof provider !== 'string' ||
      'timeLimit' in payload || // team invite token
      'expires' in payload // password reset token
    ) {
      throw new HttpException('Invalid token payload', 400);
    }

    const integration = await this._integrationService.getIntegrationById(
      organizationId,
      integrationId
    );
    if (
      !integration ||
      integration.internalId !== internalId ||
      integration.providerIdentifier !== provider
    ) {
      throw new HttpException('Integration not found', 404);
    }

    const integrationProvider =
      this._integrationManager.getSocialIntegration(provider);
    if (!integrationProvider?.isChromeExtension) {
      throw new HttpException('Not a Chrome extension integration', 400);
    }

    const authResult = await integrationProvider.authenticate({
      code: body.cookies,
      codeVerifier: '',
    });

    if (typeof authResult === 'string') {
      throw new HttpException(authResult, 400);
    }

    if (String(authResult.id) !== String(integration.internalId)) {
      await this._integrationService.refreshNeeded(
        organizationId,
        integrationId
      );
      return { success: false, reason: 'account_mismatch' };
    }

    await this._integrationService.createOrUpdateIntegration(
      undefined,
      false,
      organizationId,
      integration.name,
      undefined,
      'social',
      integration.internalId,
      integration.providerIdentifier,
      authResult.accessToken,
      '',
      authResult.expiresIn,
      undefined,
      false,
      undefined,
      undefined,
      // stored encrypted like connectSocialMedia does, never signed: the
      // cookies JSON comes from the request
      AuthService.fixedEncryption(
        Buffer.from(body.cookies, 'base64').toString()
      )
    );

    return { success: true };
  }

  @Post('/sync-from-wallza')
  async syncFromWallza(@Req() req: Request, @Res() res: Response) {
    const authResult = await verifyWallzaInternalRequest(req as any, {
      expectedAudience: 'social-studio',
    });

    if (!authResult.valid) {
      return res.status(401).json({
        success: false,
        error: authResult.error || 'HMAC authentication failed',
      });
    }

    const { organizationId, action, connections, generation } = req.body || {};

    if (!organizationId || typeof organizationId !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Missing or invalid organizationId',
      });
    }

    if (!Array.isArray(connections) || connections.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Connections array must not be empty',
      });
    }

    // Resolve or provision Postiz Organization for WallzaOS tenant
    let targetOrg: any;
    try {
      targetOrg = await this._organizationService.resolveWallzaOrganization(organizationId);
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: `Failed to resolve organization: ${err.message}`,
      });
    }

    const results: any[] = [];
    const incomingGen = Number(generation);

    if (!Number.isSafeInteger(incomingGen) || incomingGen <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid generation: must be a positive safe integer (> 0)',
        results: connections.map((conn: any) => ({
          provider: conn.provider,
          internalId: conn.internalId,
          status: 'error',
          error: 'Generation must be a positive safe integer',
        })),
      });
    }

    for (const conn of connections) {
      const provider = String(conn.provider || '').toLowerCase();
      const internalId = String(conn.internalId || '');

      // Fencing check strictly against PostgreSQL SocialSyncGeneration repository (PostgreSQL is sole authority)
      let genCheck: { allowed: boolean; currentGeneration: number; reason?: string };

      try {
        genCheck = await this._socialSyncGenerationRepository.checkAndAdvanceGeneration(
          targetOrg.id,
          provider,
          internalId,
          incomingGen,
          action
        );
      } catch (genDbErr: any) {
        // Strict fail-closed: do not fallback to permissive Redis on PostgreSQL failure
        results.push({
          provider,
          internalId,
          status: 'error',
          error: `Durable generation repository check failed: ${genDbErr.message}`,
        });
        continue;
      }

      if (!genCheck.allowed) {
        results.push({
          provider,
          internalId,
          status: genCheck.reason === 'conflict' || genCheck.reason === 'invalid_generation' ? 'error' : 'superseded',
          error: genCheck.reason === 'conflict'
            ? 'Same-generation conflicting action rejected'
            : genCheck.reason === 'invalid_generation'
            ? 'Generation must be a positive safe integer'
            : undefined,
          currentGeneration: genCheck.currentGeneration,
          incomingGeneration: incomingGen,
        });
        continue;
      }

      if (action === 'disconnect') {
        const existing = await this._integrationService.getIntegrationByInternalId(
          targetOrg.id,
          internalId
        );

        if (existing) {
          await this._integrationService.deleteChannel(targetOrg.id, existing.id);
        }

        results.push({ provider, internalId, status: 'disconnected', generation: incomingGen });
        continue;
      }

      // Action === 'upsert'
      const integrationProvider = this._integrationManager.getSocialIntegration(provider);
      if (!integrationProvider) {
        results.push({
          provider,
          internalId,
          status: 'error',
          error: `Provider ${provider} is not supported by Social Studio`,
        });
        continue;
      }

      let accessToken = conn.token || '';
      let refreshToken = '';
      let expiresIn = conn.expiresIn || 0;
      let name = conn.name || `${provider} Account`;
      let picture = conn.picture || '';
      let username = '';
      let customDetails: string | undefined = undefined;

      // Real provider authentication / adaptation
      if (integrationProvider.customFields) {
        // Direct credential providers: bluesky, wordpress, devto, hashnode, medium, nostr, lemmy, listmonk
        let authCodePayload: any = null;
        const creds = conn.credentials || {};

        if (provider === 'bluesky') {
          authCodePayload = {
            service: creds.service || 'https://bsky.social',
            identifier: creds.identifier || internalId,
            password: creds.appPassword || conn.token,
          };
        } else if (provider === 'wordpress') {
          authCodePayload = {
            domain: creds.siteUrl || creds.domain,
            username: creds.username,
            password: creds.applicationPassword || conn.token,
          };
        } else if (provider === 'devto') {
          authCodePayload = { apiKey: creds.apiKey || conn.token };
        } else if (provider === 'hashnode') {
          authCodePayload = {
            apiKey: creds.personalAccessToken || creds.apiKey || conn.token,
            publicationId: creds.publicationId,
          };
        } else if (provider === 'medium') {
          authCodePayload = { apiKey: creds.apiKey || conn.token };
        } else if (provider === 'nostr') {
          authCodePayload = { password: creds.privateKey || conn.token };
        } else if (provider === 'listmonk') {
          authCodePayload = {
            url: creds.url,
            username: creds.username,
            password: creds.password || conn.token,
          };
        } else if (provider === 'lemmy') {
          authCodePayload = {
            instance: creds.instance,
            username: creds.username,
            password: creds.password || conn.token,
          };
        }

        if (authCodePayload) {
          const base64Code = Buffer.from(JSON.stringify(authCodePayload)).toString('base64');
          try {
            const authResult = await integrationProvider.authenticate({
              code: base64Code,
              codeVerifier: '',
            });

            if (typeof authResult === 'string') {
              results.push({
                provider,
                internalId,
                status: 'error',
                error: `Authentication failed: ${authResult}`,
              });
              continue;
            }

            accessToken = authResult.accessToken;
            refreshToken = authResult.refreshToken || '';
            expiresIn = authResult.expiresIn || expiresIn;
            name = authResult.name || name;
            picture = authResult.picture || picture;
            username = authResult.username || '';
            customDetails = AuthService.fixedEncryption(JSON.stringify(authCodePayload));
          } catch (authErr: any) {
            results.push({
              provider,
              internalId,
              status: 'error',
              error: `Provider authenticate thrown: ${authErr.message}`,
            });
            continue;
          }
        }
      } else if (provider === 'telegram') {
        // Telegram in Postiz uses server-configured TELEGRAM_TOKEN bot.
        // Direct bot-token credentials from user are not supported without dedicated bot instance.
        results.push({
          provider,
          internalId,
          status: 'error',
          error: 'Telegram requires platform bot setup and is unsupported for user direct tokens',
        });
        continue;
      } else if (provider === 'discord' && !conn.token) {
        results.push({
          provider,
          internalId,
          status: 'error',
          error: 'Discord requires OAuth authorization. Webhook URLs are not supported as OAuth tokens.',
        });
        continue;
      }

      // Upsert into Postiz Prisma Integrations
      try {
        const saved = await this._integrationService.createOrUpdateIntegration(
          undefined,
          !!integrationProvider.oneTimeToken,
          targetOrg.id,
          name,
          picture,
          'social',
          internalId,
          provider,
          accessToken,
          refreshToken,
          expiresIn,
          username,
          false,
          undefined,
          0,
          customDetails
        );

        results.push({
          provider,
          internalId,
          status: 'synced',
          integrationId: saved.id,
          generation: incomingGen,
        });
      } catch (upsertErr: any) {
        results.push({
          provider,
          internalId,
          status: 'error',
          error: `Prisma upsert failed: ${upsertErr.message}`,
        });
      }
    }

    return res.json({
      success: true,
      synchronized: results.filter((r) => r.status === 'synced' || r.status === 'disconnected').length,
      results,
    });
  }
}
