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
import { getSsrfSafeDispatcher } from '@gitroom/nestjs-libraries/dtos/webhooks/ssrf.safe.dispatcher';
import { Request, Response } from 'express';
import { mapWallzaProviderCredentials } from '@gitroom/nestjs-libraries/database/prisma/integrations/wallza.provider.credentials';
import { verifyWallzaInternalRequest, signInternalRequest } from '@gitroom/nestjs-libraries/auth/wallza.hmac';
import { OAuthCallbackRetryRepository } from '@gitroom/nestjs-libraries/database/prisma/integrations/oauth.callback.retry.repository';

@ApiTags('Integrations')
@Controller('/integrations')
export class NoAuthIntegrationsController {
  constructor(
    private _integrationManager: IntegrationManager,
    private _integrationService: IntegrationService,
    private _refreshIntegrationService: RefreshIntegrationService,
    private _organizationService: OrganizationService,
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

    // Bridge OAuth callback to WallzaOS internal sync if initiated from WallzaOS.
    // Failure to dispatch or enqueue must not turn a successfully saved provider
    // connection into a failed OAuth callback response.
    const wallzaOrgState = await ioRedis.get(`wallza:oauth_org:${body.state}`);
    if (wallzaOrgState) {
      const wallzaApiUrl = (
        process.env.WALLZAOS_INTERNAL_API_URL ||
        process.env.WALLZA_BACKEND_URL ||
        'http://127.0.0.1:5001'
      ).replace(/\/$/, '');
      const suppliedExpiry = Number(expiresIn);
      const tokenExpiresAt = Number.isFinite(suppliedExpiry) && suppliedExpiry > 0
        ? new Date(Date.now() + suppliedExpiry * 1000).toISOString()
        : null;
      const syncPayload = {
        organizationId: wallzaOrgState,
        platform: integration,
        accountName: validName.trim(),
        accountId: String(id),
        avatarUrl: picture || null,
        socialStudioIntegrationId: createUpdate.id,
        grantedScopes: integrationProvider.scopes || [],
        tokenExpiresAt,
        category: 'major',
      };
      const retryEvent = {
        state: body.state,
        organizationId: org.id,
        wallzaOrgId: wallzaOrgState,
        platform: integration,
        accountName: validName.trim(),
        accountId: String(id),
        avatarUrl: picture || null,
        socialStudioIntegrationId: createUpdate.id,
        grantedScopes: integrationProvider.scopes || [],
        tokenExpiresAt,
        category: 'major',
      };
      const enqueueRetry = async (error: string) => {
        try {
          await this._oAuthCallbackRetryRepository.enqueueOrUpdate({
            ...retryEvent,
            error,
          });
        } catch {
          // Keep OAuth successful; alert operators without exposing payload data.
          console.warn('[WallzaBridge] Retry event could not be persisted.');
        }
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
          signal: AbortSignal.timeout(10000),
        });

        if (syncRes.ok) {
          await ioRedis.del(`wallza:oauth_org:${body.state}`);
          await this._oAuthCallbackRetryRepository.markCompletedByState(body.state);
        } else {
          // Never log or persist remote response bodies; providers may echo secrets.
          console.warn(`[WallzaBridge] WallzaOS account sync returned HTTP ${syncRes.status}; enqueuing durable retry event.`);
          await enqueueRetry(`HTTP ${syncRes.status}`);
        }
      } catch {
        console.warn('[WallzaBridge] Network/runtime error during dispatch; enqueuing durable retry event.');
        await enqueueRetry('Network/runtime error');
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

  @Get('/wallza-status')
  async wallzaStatus(@Req() req: Request, @Res() res: Response) {
    const authResult = await verifyWallzaInternalRequest(req as any, {
      expectedAudience: 'social-studio',
    });

    if (!authResult.valid) {
      return res.status(401).json({
        success: false,
        error: authResult.error || 'HMAC authentication failed',
      });
    }

    return res.status(200).json({
      success: true,
      service: 'wallza-social-engine',
      timestamp: new Date().toISOString(),
    });
  }

  @Post('/wallza-oauth-url')
  async wallzaOAuthUrl(@Req() req: Request, @Res() res: Response) {
    const authResult = await verifyWallzaInternalRequest(req as any, {
      expectedAudience: 'social-studio',
    });

    if (!authResult.valid) {
      return res.status(401).json({
        success: false,
        error: authResult.error || 'HMAC authentication failed',
      });
    }

    const { organizationId, provider, refresh, redirectUrl } = req.body || {};
    if (!organizationId || typeof organizationId !== 'string') {
      return res.status(400).json({ success: false, error: 'Missing or invalid organizationId' });
    }
    if (!provider || typeof provider !== 'string') {
      return res.status(400).json({ success: false, error: 'Missing or invalid provider' });
    }

    const normProvider = provider.toLowerCase().trim();
    if (!this._integrationManager.getAllowedSocialsIntegrations().includes(normProvider)) {
      return res.status(400).json({ success: false, error: `Provider ${normProvider} is not allowed` });
    }

    let targetOrg: any;
    try {
      targetOrg = await this._organizationService.resolveWallzaOrganization(organizationId);
    } catch (err: any) {
      return res.status(500).json({ success: false, error: 'Unable to resolve Wallza organization context' });
    }

    try {
      const integrationProvider = this._integrationManager.getSocialIntegration(normProvider);
      const { codeVerifier, state, url } = await integrationProvider.generateAuthUrl();

      // Store one-time state, code verifier, organization bindings in Redis with 1h TTL
      await ioRedis.set(`organization:${state}`, targetOrg.id, 'EX', 3600);
      await ioRedis.set(`wallza:oauth_org:${state}`, organizationId, 'EX', 3600);
      if (codeVerifier) {
        await ioRedis.set(`login:${state}`, codeVerifier, 'EX', 3600);
      }
      if (refresh) {
        await ioRedis.set(`refresh:${state}`, String(refresh), 'EX', 3600);
      }
      if (redirectUrl) {
        await ioRedis.set(`redirect:${state}`, String(redirectUrl), 'EX', 3600);
      }

      return res.status(200).json({
        success: true,
        url,
        state,
        provider: normProvider,
        isBetweenSteps: !!integrationProvider.isBetweenSteps,
      });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message || 'Failed to generate OAuth URL' });
    }
  }

  @Post('/wallza-callback-exchange')
  async wallzaCallbackExchange(@Req() req: Request, @Res() res: Response) {
    const authResult = await verifyWallzaInternalRequest(req as any, {
      expectedAudience: 'social-studio',
    });

    if (!authResult.valid) {
      return res.status(401).json({
        success: false,
        error: authResult.error || 'HMAC authentication failed',
      });
    }

    const { organizationId, provider, code, state, timezone } = req.body || {};
    if (!organizationId || typeof organizationId !== 'string') {
      return res.status(400).json({ success: false, error: 'Missing or invalid organizationId' });
    }
    if (!provider || typeof provider !== 'string') {
      return res.status(400).json({ success: false, error: 'Missing or invalid provider' });
    }
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ success: false, error: 'Missing or invalid authorization code' });
    }
    if (!state || typeof state !== 'string') {
      return res.status(400).json({ success: false, error: 'Missing or invalid state' });
    }

    const normProvider = provider.toLowerCase().trim();
    const integrationProvider = this._integrationManager.getSocialIntegration(normProvider);
    if (!integrationProvider) {
      return res.status(400).json({ success: false, error: 'Provider not found' });
    }

    // Atomic Lua script to validate and consume OAuth state keys together
    // Keys:
    // 1: organization:${state}
    // 2: wallza:oauth_org:${state}
    // 3: login:${state}
    // 4: refresh:${state}
    // 5: wallza:oauth_in_between:${state}
    // 6: wallza:oauth_payload:${state}
    //
    // Logic:
    // 1. Check if both organization:${state} and wallza:oauth_org:${state} exist.
    // 2. Check if wallza:oauth_org matches expected ARGV[1] (Wallza organizationId).
    // 3. If valid, read codeVerifier, refresh, and atomically delete state keys (or retain org binding if inBetweenSteps is required for page selection).
    const luaValidateAndConsume = `
      local orgId = redis.call('GET', KEYS[1])
      local wallzaOrgId = redis.call('GET', KEYS[2])
      if not orgId or not wallzaOrgId then
        return {0, 'OAuth state expired, invalid or already consumed'}
      end
      if wallzaOrgId ~= ARGV[1] then
        return {-1, 'Tenant mismatch: OAuth session does not belong to the requesting organization'}
      end
      local codeVerifier = redis.call('GET', KEYS[3]) or ''
      local refresh = redis.call('GET', KEYS[4]) or ''
      local isBetween = ARGV[2]

      -- Consume single-use login state keys immediately
      redis.call('DEL', KEYS[3])
      redis.call('DEL', KEYS[4])

      if isBetween == '1' then
        -- Retain organization and wallza:oauth_org bindings for page selection stage, but mark exchange as completed
        -- Set marker to prevent concurrent/repeated callback exchanges
        local consumed = redis.call('GET', KEYS[5])
        if consumed then
          return {0, 'OAuth state already exchanged'}
        end
        redis.call('SET', KEYS[5], '1', 'EX', 1800)
      else
        -- Completely consume all state keys immediately
        redis.call('DEL', KEYS[1])
        redis.call('DEL', KEYS[2])
      end

      return {1, orgId, wallzaOrgId, codeVerifier, refresh}
    `;

    const isBetweenFlag = integrationProvider.isBetweenSteps ? '1' : '0';
    let evalResult: any;
    try {
      evalResult = await ioRedis.eval(
        luaValidateAndConsume,
        5,
        `organization:${state}`,
        `wallza:oauth_org:${state}`,
        `login:${state}`,
        `refresh:${state}`,
        `wallza:oauth_in_between:${state}`,
        organizationId,
        isBetweenFlag
      );
    } catch (redisErr: any) {
      return res.status(500).json({ success: false, error: 'Redis state evaluation failed' });
    }

    const [statusCode, val1, val2, val3, val4] = evalResult || [];
    if (statusCode === -1) {
      return res.status(403).json({
        success: false,
        error: val1 || 'Tenant mismatch: OAuth session does not belong to the requesting organization',
      });
    }
    if (statusCode !== 1) {
      return res.status(400).json({
        success: false,
        error: val1 || 'OAuth state expired, invalid or already consumed',
      });
    }

    const storedOrgId = val1;
    const storedWallzaOrgId = val2;
    const storedCodeVerifier = val3 || '';
    const storedRefresh = val4 || '';

    let authOutcome: any;
    try {
      authOutcome = await integrationProvider.authenticate({
        code,
        codeVerifier: storedCodeVerifier,
        refresh: storedRefresh,
      });

      if (typeof authOutcome === 'string') {
        return res.status(400).json({ success: false, error: authOutcome });
      }
    } catch (err: any) {
      return res.status(400).json({
        success: false,
        error: err.message || 'Third-party OAuth exchange failed',
      });
    }

    const {
      accessToken,
      refreshToken = '',
      expiresIn = 0,
      id,
      name,
      picture,
      username,
    } = authOutcome;

    const validName = typeof name === 'string' && name.trim().length > 0 ? name.trim() : normProvider;

    // Persist into Postiz integration repository
    let createUpdate: any;
    try {
      createUpdate = await this._integrationService.createOrUpdateIntegration(
        undefined,
        !!integrationProvider.oneTimeToken,
        storedOrgId,
        validName,
        picture,
        'social',
        String(id),
        normProvider,
        accessToken,
        refreshToken,
        expiresIn,
        username,
        storedRefresh ? false : !!integrationProvider.isBetweenSteps,
        storedRefresh,
        Number(timezone) || 0
      );

      this._refreshIntegrationService
        .startRefreshWorkflow(storedOrgId, createUpdate.id, integrationProvider)
        .catch(() => {});
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: err.message || 'Failed to save integration in Postiz repository',
      });
    }

    // Fetch pages if two-step provider (Facebook/Instagram/LinkedIn)
    let pages: any[] = [];
    if (integrationProvider.isBetweenSteps && !storedRefresh) {
      try {
        const fetchMethod =
          'pages' in integrationProvider
            ? 'pages'
            : 'companies' in integrationProvider
            ? 'companies'
            : null;
        if (fetchMethod && typeof (integrationProvider as any)[fetchMethod] === 'function') {
          pages = await (integrationProvider as any)[fetchMethod](accessToken);
        }
      } catch (pageErr: any) {
        console.warn('[WallzaCallbackExchange] Failed to fetch pages:', pageErr.message);
      }
    }

    // Format safe response: NEVER leak raw access token or secrets
    const safeResult = {
      success: true,
      integrationId: createUpdate.id,
      internalId: String(id),
      name: validName,
      username: username || '',
      picture: picture || '',
      provider: normProvider,
      isBetweenSteps: !!integrationProvider.isBetweenSteps && !storedRefresh,
      pages: pages.map((p: any) => ({
        id: String(p.id),
        name: p.name,
        pageId: p.pageId ? String(p.pageId) : undefined,
        picture: p.picture?.data?.url || p.picture || '',
        username: p.username || '',
      })),
    };

    return res.status(200).json(safeResult);
  }

  @Post('/wallza-save-page')
  async wallzaSavePage(@Req() req: Request, @Res() res: Response) {
    const authResult = await verifyWallzaInternalRequest(req as any, {
      expectedAudience: 'social-studio',
    });

    if (!authResult.valid) {
      return res.status(401).json({
        success: false,
        error: authResult.error || 'HMAC authentication failed',
      });
    }

    const { organizationId, integrationId, pageData, state } = req.body || {};
    if (!organizationId || typeof organizationId !== 'string') {
      return res.status(400).json({ success: false, error: 'Missing or invalid organizationId' });
    }
    if (!integrationId || typeof integrationId !== 'string') {
      return res.status(400).json({ success: false, error: 'Missing or invalid integrationId' });
    }
    if (!pageData || typeof pageData !== 'object') {
      return res.status(400).json({ success: false, error: 'Missing or invalid pageData' });
    }
    if (!state || typeof state !== 'string' || state.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'Missing or invalid state parameter' });
    }

    let targetOrg: any;
    try {
      targetOrg = await this._organizationService.resolveWallzaOrganization(organizationId);
    } catch {
      return res.status(500).json({ success: false, error: 'Unable to resolve Wallza organization context' });
    }

    // Step 1: Pre-validate that integration exists and strictly belongs to targetOrg.id
    // Doing this BEFORE state reservation guarantees that an invalid or foreign integration ID
    // never blocks or reserves the valid OAuth state.
    let existingIntegration: any;
    try {
      existingIntegration = await this._integrationService.getIntegrationById(targetOrg.id, integrationId);
    } catch (err: any) {
      return res.status(404).json({ success: false, error: 'Integration not found for this organization' });
    }

    if (!existingIntegration || existingIntegration.organizationId !== targetOrg.id) {
      return res.status(403).json({
        success: false,
        error: 'Integration does not belong to the requesting organization',
      });
    }

    // Derive deterministic target page key to prevent different page selections from reusing state
    const targetPageKey = String(pageData.id || pageData.page || pageData.pageId || '');
    if (!targetPageKey) {
      return res.status(400).json({ success: false, error: 'Invalid pageData: missing page identifier' });
    }

    // Step 2: Atomic Lua script to validate state bindings and reserve in-progress execution
    // KEYS[1]: organization:${state}
    // KEYS[2]: wallza:oauth_org:${state}
    // KEYS[3]: wallza:oauth_page_state:${state}
    // KEYS[4]: wallza:oauth_page_result:${state}
    // ARGV[1]: expected organizationId (Wallza)
    // ARGV[2]: expected targetOrg.id (Postiz)
    // ARGV[3]: integrationId
    // ARGV[4]: targetPageKey
    const luaValidateAndReservePageSelect = `
      local orgId = redis.call('GET', KEYS[1])
      local wallzaOrgId = redis.call('GET', KEYS[2])
      local pageState = redis.call('GET', KEYS[3])

      if pageState == 'completed' then
        local savedResult = redis.call('GET', KEYS[4])
        return {2, savedResult or ''}
      end

      if pageState == 'in_progress' then
        return {3, 'Page selection is currently in progress. Please retry shortly.'}
      end

      if not orgId or not wallzaOrgId then
        return {0, 'OAuth state expired, invalid, missing or already consumed'}
      end

      if wallzaOrgId ~= ARGV[1] then
        return {-1, 'Tenant mismatch on page selection'}
      end

      if orgId ~= ARGV[2] then
        return {-2, 'Target organization mismatch on page selection'}
      end

      -- Reserve state as 'in_progress' with a 60s lease
      redis.call('SET', KEYS[3], 'in_progress', 'EX', 60)
      return {1, orgId, wallzaOrgId}
    `;

    let stateCheck: any;
    try {
      stateCheck = await ioRedis.eval(
        luaValidateAndReservePageSelect,
        4,
        `organization:${state}`,
        `wallza:oauth_org:${state}`,
        `wallza:oauth_page_state:${state}`,
        `wallza:oauth_page_result:${state}`,
        organizationId,
        targetOrg.id,
        integrationId,
        targetPageKey
      );
    } catch (redisErr: any) {
      return res.status(500).json({ success: false, error: 'Redis state verification failed' });
    }

    const [statusFlag, payload] = stateCheck || [];

    // Tenant mismatch
    if (statusFlag === -1 || statusFlag === -2) {
      return res.status(403).json({ success: false, error: payload || 'Tenant mismatch on page selection' });
    }

    // Invalid, missing, or expired state
    if (statusFlag === 0) {
      return res.status(400).json({ success: false, error: payload || 'OAuth state expired, invalid or already consumed' });
    }

    // Concurrent request while save is already in progress: return 409 Conflict with retry recommendation
    if (statusFlag === 3) {
      return res.status(409).json({
        success: false,
        retryable: true,
        error: 'Page selection operation is currently in progress. Please retry.',
      });
    }

    // Completed state encounter: return cached completed result if matching integration and page
    if (statusFlag === 2) {
      try {
        const completedData = JSON.parse(payload);
        if (
          completedData.integrationId === integrationId &&
          (completedData.pageKey === targetPageKey || completedData.internalId === targetPageKey)
        ) {
          return res.status(200).json({
            success: true,
            integrationId: completedData.integrationId,
            name: completedData.name,
            internalId: completedData.internalId,
            picture: completedData.picture || '',
            profile: completedData.profile || '',
            idempotent: true,
          });
        } else {
          return res.status(400).json({
            success: false,
            error: 'OAuth state was already finalized with a different page or integration selection',
          });
        }
      } catch {
        return res.status(200).json({
          success: true,
          integrationId: existingIntegration.id,
          name: existingIntegration.name,
          internalId: existingIntegration.internalId,
          picture: existingIntegration.picture || '',
          profile: existingIntegration.profile || '',
          idempotent: true,
        });
      }
    }

    // Status 1: Successfully acquired reservation. Execute page selection
    try {
      await this._integrationService.saveProviderPage(targetOrg.id, integrationId, pageData);
      const updated = await this._integrationService.getIntegrationById(targetOrg.id, integrationId);

      // Prepare final completed payload
      const completionResult = {
        integrationId: updated.id,
        name: updated.name,
        internalId: updated.internalId,
        picture: updated.picture || '',
        profile: updated.profile || '',
        pageKey: targetPageKey,
      };

      // Atomically transition state to 'completed', cache result, and release one-time org keys
      const luaCompletePageSelection = `
        redis.call('SET', KEYS[1], 'completed', 'EX', 1800)
        redis.call('SET', KEYS[2], ARGV[1], 'EX', 1800)
        redis.call('DEL', KEYS[3])
        redis.call('DEL', KEYS[4])
        redis.call('DEL', KEYS[5])
        return 1
      `;

      await ioRedis.eval(
        luaCompletePageSelection,
        5,
        `wallza:oauth_page_state:${state}`,
        `wallza:oauth_page_result:${state}`,
        `organization:${state}`,
        `wallza:oauth_org:${state}`,
        `wallza:oauth_in_between:${state}`,
        JSON.stringify(completionResult)
      );

      return res.status(200).json({
        success: true,
        integrationId: updated.id,
        name: updated.name,
        internalId: updated.internalId,
        picture: updated.picture || '',
        profile: updated.profile || '',
      });
    } catch (err: any) {
      // Release in-progress lock on failure so legitimate retry can proceed immediately
      await ioRedis.del(`wallza:oauth_page_state:${state}`).catch(() => {});
      return res.status(500).json({ success: false, error: err.message || 'Failed to save provider page selection' });
    }
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
    if (connections.length > 100) {
      return res.status(413).json({
        success: false,
        error: 'A sync batch cannot contain more than 100 accounts',
      });
    }

    // Resolve or provision Postiz Organization for WallzaOS tenant
    let targetOrg: any;
    try {
      targetOrg = await this._organizationService.resolveWallzaOrganization(organizationId);
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: 'Unable to resolve Wallza organization',
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

    if (action !== 'upsert' && action !== 'disconnect') {
      return res.status(400).json({ success: false, error: 'Unsupported sync action' });
    }

    const seenAccounts = new Set<string>();
    for (const incoming of connections) {
      const conn =
        incoming && typeof incoming === 'object' && !Array.isArray(incoming)
          ? incoming
          : {};
      const provider = typeof conn.provider === 'string'
        ? conn.provider.toLowerCase().trim().slice(0, 64)
        : '';
      const internalId = typeof conn.internalId === 'string'
        ? conn.internalId.trim().slice(0, 255)
        : '';
      const accountKey = `${provider}\u0000${internalId}`;

      if (!/^[a-z0-9_-]+$/.test(provider) || !internalId) {
        results.push({ provider, internalId, status: 'error', error: 'Provider and internal account ID are required' });
        continue;
      }
      if (seenAccounts.has(accountKey)) {
        results.push({ provider, internalId, status: 'error', error: 'Duplicate account in sync batch' });
        continue;
      }
      seenAccounts.add(accountKey);

      if (action === 'disconnect') {
        try {
          const outcome = await this._integrationService.deleteChannelWithGeneration(
            targetOrg.id,
            provider,
            internalId,
            incomingGen
          );

          if (!outcome.allowed) {
            results.push({
              provider,
              internalId,
              status: outcome.reason === 'superseded' ? 'superseded' : 'error',
              error: outcome.reason === 'conflict'
                ? 'Same-generation conflicting action rejected'
                : outcome.reason === 'invalid_generation'
                ? 'Generation must be a positive safe integer'
                : undefined,
              currentGeneration: outcome.currentGeneration,
              incomingGeneration: incomingGen,
            });
          } else {
            results.push({
              provider,
              internalId,
              status: 'disconnected',
              generation: incomingGen,
              affected: outcome.result?.count || 0,
            });
          }
        } catch (disconnectErr: any) {
          results.push({
            provider,
            internalId,
            status: 'error',
            error: 'Transactional disconnect failed',
          });
        }
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

      let accessToken = typeof conn.token === 'string' ? conn.token : '';
      let refreshToken = '';
      const suppliedExpiry = Number(conn.expiresIn);
      let expiresIn = Number.isFinite(suppliedExpiry) && suppliedExpiry > 0
        ? suppliedExpiry
        : 0;
      let name = typeof conn.name === 'string' && conn.name.trim()
        ? conn.name.trim().slice(0, 200)
        : `${provider} Account`;
      let picture = typeof conn.picture === 'string'
        ? conn.picture.trim().slice(0, 2048)
        : '';
      let username = typeof conn.username === 'string' ? conn.username.slice(0, 200) : '';
      let customDetails: string | undefined = undefined;

      // Real provider authentication / adaptation
      if (integrationProvider.customFields) {
        const authCodePayload = mapWallzaProviderCredentials(
          provider,
          conn.credentials || {},
          internalId,
          conn.token
        );

        if (!authCodePayload) {
          results.push({
            provider,
            internalId,
            status: 'error',
            error: `Direct credential mapping is not implemented for provider ${provider}`,
          });
          continue;
        }

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
              error: 'Provider authentication failed',
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
            error: 'Provider authentication request failed',
          });
          continue;
        }
      } else if (
        integrationProvider.isChromeExtension ||
        integrationProvider.extensionCookies ||
        integrationProvider.isWeb3 ||
        integrationProvider.externalUrl
      ) {
        results.push({
          provider,
          internalId,
          status: 'error',
          error: 'This provider requires an interactive extension, wallet, or instance-specific OAuth flow and cannot be linked with a bearer token',
        });
        continue;
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
      } else if (provider === 'discord' && !accessToken) {
        results.push({
          provider,
          internalId,
          status: 'error',
          error: 'Discord requires OAuth authorization. Webhook URLs are not supported as OAuth tokens.',
        });
        continue;
      } else if (!integrationProvider.customFields && !accessToken) {
        results.push({
          provider,
          internalId,
          status: 'error',
          error: 'A provider access token is required',
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
          customDetails,
          incomingGen
        );

        if (!saved.allowed) {
          results.push({
            provider,
            internalId,
            status: saved.reason === 'superseded' ? 'superseded' : 'error',
            error: saved.reason === 'conflict'
              ? 'Same-generation conflicting action rejected'
              : saved.reason === 'invalid_generation'
              ? 'Generation must be a positive safe integer'
              : undefined,
            currentGeneration: saved.currentGeneration,
            incomingGeneration: incomingGen,
          });
          continue;
        }

        results.push({
          provider,
          internalId,
          status: 'synced',
          integrationId: saved.result?.id,
          generation: incomingGen,
        });
      } catch (upsertErr: any) {
        results.push({
          provider,
          internalId,
          status: 'error',
          error: 'Integration persistence failed',
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
