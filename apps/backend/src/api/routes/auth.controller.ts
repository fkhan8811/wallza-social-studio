import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ThrottlerRealIpGuard } from '@gitroom/nestjs-libraries/throttler/throttler.provider';
import { Response, Request } from 'express';

import { CreateOrgUserDto } from '@gitroom/nestjs-libraries/dtos/auth/create.org.user.dto';
import { LoginUserDto } from '@gitroom/nestjs-libraries/dtos/auth/login.user.dto';
import { AuthService } from '@gitroom/backend/services/auth/auth.service';
import { ForgotReturnPasswordDto } from '@gitroom/nestjs-libraries/dtos/auth/forgot-return.password.dto';
import { ForgotPasswordDto } from '@gitroom/nestjs-libraries/dtos/auth/forgot.password.dto';
import { ResendActivationDto } from '@gitroom/nestjs-libraries/dtos/auth/resend-activation.dto';
import { ApiTags } from '@nestjs/swagger';
import { getCookieUrlFromDomain } from '@gitroom/helpers/subdomain/subdomain.management';
import { EmailService } from '@gitroom/nestjs-libraries/services/email.service';
import { RealIP } from 'nestjs-real-ip';
import { UserAgent } from '@gitroom/nestjs-libraries/user/user.agent';
import { Provider } from '@prisma/client';
import { makeSecureId } from '@gitroom/nestjs-libraries/services/make.secure.id';
import * as Sentry from '@sentry/nestjs';
import { FarcasterProvider } from '@gitroom/nestjs-libraries/integrations/social/farcaster.provider';
import { AttributionService } from '@gitroom/nestjs-libraries/services/attribution/attribution.service';
import { SsoExchangeDto } from '@gitroom/nestjs-libraries/dtos/auth/sso.exchange.dto';
import { OrganizationService } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service';
import { UsersService } from '@gitroom/nestjs-libraries/database/prisma/users/users.service';
import { AuthService as AuthChecker } from '@gitroom/helpers/auth/auth.service';
import { signInternalRequest } from '@gitroom/nestjs-libraries/auth/wallza.hmac';
import { sanitizeReturnUrl } from '@gitroom/helpers/utils/safe.return.url';

@ApiTags('Auth')
@Controller('/auth')
export class AuthController {
  constructor(
    private _authService: AuthService,
    private _emailService: EmailService,
    private _attributionService: AttributionService,
    private _organizationService: OrganizationService,
    private _usersService: UsersService
  ) {}

  @Get('/can-register')
  async canRegister() {
    return {
      register: await this._authService.canRegister(Provider.LOCAL as string),
    };
  }

  // URL parameters the app keeps until sign-up for the attribution tools
  @Get('/attribution')
  attribution() {
    return {
      params: this._attributionService.queryParams(),
    };
  }

  @Post('/register')
  async register(
    @Req() req: Request,
    @Body() body: CreateOrgUserDto,
    @Res({ passthrough: false }) response: Response,
    @RealIP() ip: string,
    @UserAgent() userAgent: string
  ) {
    try {
      const getOrgFromCookie = this._authService.getOrgFromCookie(
        req?.cookies?.org
      );

      const { jwt, addedOrg } = await this._authService.routeAuth(
        body.provider,
        body,
        ip,
        userAgent,
        getOrgFromCookie
      );

      const activationRequired =
        body.provider === 'LOCAL' && this._emailService.hasProvider();

      if (activationRequired) {
        response.header('activate', 'true');
        response.status(200).json({ activate: true });
        return;
      }

      response.cookie('auth', jwt, {
        domain: getCookieUrlFromDomain(process.env.FRONTEND_URL!),
        ...(!process.env.NOT_SECURED
          ? {
              secure: true,
              httpOnly: true,
              sameSite: 'none',
            }
          : {}),
        expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365),
      });

      if (process.env.NOT_SECURED) {
        response.header('auth', jwt);
      }

      if (typeof addedOrg !== 'boolean' && addedOrg?.organizationId) {
        response.cookie('showorg', addedOrg.organizationId, {
          domain: getCookieUrlFromDomain(process.env.FRONTEND_URL!),
          ...(!process.env.NOT_SECURED
            ? {
                secure: true,
                httpOnly: true,
                sameSite: 'none',
              }
            : {}),
          expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365),
        });

        if (process.env.NOT_SECURED) {
          response.header('showorg', addedOrg.organizationId);
        }
      }

      Sentry.metrics.count('new_user', 1);
      response.header('onboarding', 'true');
      response.status(200).json({
        register: true,
      });
    } catch (e: any) {
      response.status(400).send(e.message);
    }
  }

  @Post('/login')
  async login(
    @Req() req: Request,
    @Body() body: LoginUserDto,
    @Res({ passthrough: false }) response: Response,
    @RealIP() ip: string,
    @UserAgent() userAgent: string
  ) {
    try {
      const getOrgFromCookie = this._authService.getOrgFromCookie(
        req?.cookies?.org
      );

      const { jwt, addedOrg } = await this._authService.routeAuth(
        body.provider,
        body,
        ip,
        userAgent,
        getOrgFromCookie
      );

      response.cookie('auth', jwt, {
        domain: getCookieUrlFromDomain(process.env.FRONTEND_URL!),
        ...(!process.env.NOT_SECURED
          ? {
              secure: true,
              httpOnly: true,
              sameSite: 'none',
            }
          : {}),
        expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365),
      });

      if (process.env.NOT_SECURED) {
        response.header('auth', jwt);
      }

      if (typeof addedOrg !== 'boolean' && addedOrg?.organizationId) {
        response.cookie('showorg', addedOrg.organizationId, {
          domain: getCookieUrlFromDomain(process.env.FRONTEND_URL!),
          ...(!process.env.NOT_SECURED
            ? {
                secure: true,
                httpOnly: true,
                sameSite: 'none',
              }
            : {}),
          expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365),
        });

        if (process.env.NOT_SECURED) {
          response.header('showorg', addedOrg.organizationId);
        }
      }

      response.header('reload', 'true');
      response.status(200).json({
        login: true,
      });
    } catch (e: any) {
      response.status(400).send(e.message);
    }
  }

  @Post('/forgot')
  async forgot(@Body() body: ForgotPasswordDto) {
    try {
      await this._authService.forgot(body.email);
      return {
        forgot: true,
      };
    } catch (e) {
      return {
        forgot: false,
      };
    }
  }

  @Post('/forgot-return')
  async forgotReturn(@Body() body: ForgotReturnPasswordDto) {
    const reset = await this._authService.forgotReturn(body);
    return {
      reset: !!reset,
    };
  }

  @Get('/oauth-mobile-callback')
  mobileCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res({ passthrough: false }) response: Response
  ) {
    const scheme = process.env.MOBILE_APP_SCHEME || 'postiz://auth/callback';
    const params = new URLSearchParams();
    if (code) params.set('code', code);
    if (state) params.set('state', state);
    return response.redirect(302, `${scheme}?${params.toString()}`);
  }

  @Get('/oauth/:provider')
  async oauthLink(
    @Param('provider') provider: string,
    @Query() query: any,
    @Res({ passthrough: true }) response: Response
  ) {
    const state = `login-${makeSecureId(16)}`;
    response.cookie('oauth_state', state, {
      domain: getCookieUrlFromDomain(process.env.FRONTEND_URL!),
      ...(!process.env.NOT_SECURED
        ? {
            secure: true,
            httpOnly: true,
            sameSite: 'none',
          }
        : {}),
      expires: new Date(Date.now() + 1000 * 60 * 10),
    });

    return this._authService.oauthLink(provider, { ...query, state });
  }

  @Post('/activate')
  async activate(
    @Body('code') code: string,
    @Body('datafast_visitor_id') datafast_visitor_id: string,
    @Res({ passthrough: false }) response: Response
  ) {
    const activate = await this._authService.activate(
      code,
      datafast_visitor_id
    );
    if (!activate) {
      return response.status(200).json({ can: false });
    }

    response.cookie('auth', activate, {
      domain: getCookieUrlFromDomain(process.env.FRONTEND_URL!),
      ...(!process.env.NOT_SECURED
        ? {
            secure: true,
            httpOnly: true,
            sameSite: 'none',
          }
        : {}),
      expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365),
    });

    if (process.env.NOT_SECURED) {
      response.header('auth', activate);
    }

    response.header('onboarding', 'true');

    return response.status(200).json({ can: true });
  }

  @Post('/resend-activation')
  async resendActivation(@Body() body: ResendActivationDto) {
    try {
      await this._authService.resendActivationEmail(body.email);
      return {
        success: true,
      };
    } catch (e: any) {
      return {
        success: false,
        message: e.message,
      };
    }
  }

  // public and creates a signer at Neynar per call, so cap it per client
  @UseGuards(ThrottlerRealIpGuard)
  @Throttle({ default: { limit: 30, ttl: 3600000 } })
  @Post('/farcaster/signer')
  async farcasterSigner() {
    try {
      return await new FarcasterProvider().createSigner();
    } catch (err: any) {
      return { error: err.message || 'Failed to create signer' };
    }
  }

  // the modal polls every 2s for up to 10 minutes, so leave room for that
  @UseGuards(ThrottlerRealIpGuard)
  @Throttle({ default: { limit: 1000, ttl: 3600000 } })
  @Get('/farcaster/signer')
  async farcasterSignerStatus(@Query('signerUuid') signerUuid: string) {
    try {
      return await new FarcasterProvider().signerStatus(signerUuid);
    } catch (err: any) {
      return { error: err.message || 'Failed to check signer' };
    }
  }

  @Post('/oauth/:provider/redirect')
  oauthRedirect(
    @Param('provider') provider: string,
    @Body('code') code: string,
    @Body('state') state: string,
    @Res({ passthrough: false }) response: Response
  ) {
    if (!code) {
      return response.redirect(303, `${process.env.FRONTEND_URL}/auth/login`);
    }

    const params = new URLSearchParams();
    params.set('code', code);
    if (state) params.set('state', state);
    params.set('provider', provider.toUpperCase());
    return response.redirect(
      303,
      `${process.env.FRONTEND_URL}/auth?${params.toString()}`
    );
  }

  @Post('/oauth/:provider/exists')
  async oauthExists(
    @Req() req: Request,
    @Body('code') code: string,
    @Body('redirect_uri') redirect_uri: string,
    @Body('state') state: string,
    @Param('provider') provider: string,
    @Res({ passthrough: false }) response: Response
  ) {
    // a cross-site form post can spoof any body field, a json body cannot
    if (!req.headers['content-type']?.includes('application/json')) {
      return response.status(400).send('Invalid request');
    }

    // Existing-user OAuth login: this path doesn't run routeAuth, so read the
    // org invite cookie and join the org here too (when the invite is valid).
    // See register/login for the same logic.
    const getOrgFromCookie = this._authService.getOrgFromCookie(
      req?.cookies?.org
    );

    const { jwt, token, addedOrg } = await this._authService.checkExists(
      provider,
      code,
      redirect_uri,
      state,
      req?.cookies?.oauth_state,
      getOrgFromCookie
    );

    if (token) {
      return response.json({ token });
    }

    response.cookie('auth', jwt, {
      domain: getCookieUrlFromDomain(process.env.FRONTEND_URL!),
      ...(!process.env.NOT_SECURED
        ? {
            secure: true,
            httpOnly: true,
            sameSite: 'none',
          }
        : {}),
      expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365),
    });

    if (process.env.NOT_SECURED) {
      response.header('auth', jwt);
    }

    // Joined a new org via the invite: tell the frontend to switch the active
    // org to it (mirrors register/login). showorg is also a header so the
    // NOT_SECURED setup, which can't set cross-site cookies, still works.
    if (typeof addedOrg !== 'boolean' && addedOrg?.organizationId) {
      response.cookie('showorg', addedOrg.organizationId, {
        domain: getCookieUrlFromDomain(process.env.FRONTEND_URL!),
        ...(!process.env.NOT_SECURED
          ? {
              secure: true,
              httpOnly: true,
              sameSite: 'none',
            }
          : {}),
        expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365),
      });

      if (process.env.NOT_SECURED) {
        response.header('showorg', addedOrg.organizationId);
      }
    }

    response.header('reload', 'true');

    response.status(200).json({
      login: true,
    });
  }

  @Post('/sso/exchange')
  async ssoExchange(
    @Body() body: SsoExchangeDto,
    @Res({ passthrough: false }) response: Response
  ) {
    try {
      const code = String(body.code || '').trim();
      const state = String(body.state || '').trim();
      const redirectUri = String(body.redirectUri || '').trim();

      if (!code || !state || !redirectUri) {
        return response.status(400).json({ error: 'Missing code, state, or redirectUri' });
      }

      // Only accept the exact configured Postiz SSO callback origin and path.
      let callbackUrl: URL;
      let frontendUrl: URL;
      try {
        callbackUrl = new URL(redirectUri);
        frontendUrl = new URL(process.env.FRONTEND_URL || '');
      } catch {
        return response.status(400).json({ error: 'Invalid SSO redirect URI' });
      }
      if (
        callbackUrl.origin !== frontendUrl.origin ||
        callbackUrl.pathname !== '/auth/sso' ||
        callbackUrl.search ||
        callbackUrl.hash
      ) {
        return response.status(400).json({ error: 'Invalid SSO redirect URI' });
      }

      const wallzaApiUrl = (
        process.env.WALLZAOS_INTERNAL_API_URL ||
        process.env.WALLZAOS_API_URL ||
        'http://127.0.0.1:5001'
      ).replace(/\/$/, '');

      const verifyPath = '/api/social-studio/sso/verify';
      const verifyPayload = {
        code,
        state,
        redirect_uri: redirectUri,
      };

      const hmacHeaders = signInternalRequest({
        method: 'POST',
        path: verifyPath,
        audience: 'wallzaos-api',
        body: verifyPayload,
      });

      const verifyRes = await fetch(`${wallzaApiUrl}${verifyPath}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...hmacHeaders,
        },
        body: JSON.stringify(verifyPayload),
        signal: AbortSignal.timeout(10000),
      });

      if (!verifyRes.ok) {
        return response.status(401).json({
          error: 'WallzaOS rejected the SSO ticket',
        });
      }

      const verifyJson = (await verifyRes.json()) as {
        valid: boolean;
        user?: {
          id: string;
          email: string;
          firstName: string;
          lastName: string;
          role: string;
        };
        organization?: {
          id: string;
          name: string;
        };
        error?: string;
      };

      if (!verifyJson.valid || !verifyJson.user || !verifyJson.organization) {
        return response.status(400).json({
          error: 'Invalid or expired WallzaOS SSO ticket',
        });
      }

      // 1. Resolve Wallza Organization in Postiz
      const org = await this._organizationService.resolveWallzaOrganization(
        verifyJson.organization.id,
        verifyJson.organization.name
      );

      // 2. Find or create user in Postiz
      const fullName = `${verifyJson.user.firstName || ''} ${verifyJson.user.lastName || ''}`.trim() || verifyJson.user.email;
      const user = await this._usersService.findOrCreateUserByEmail({
        email: verifyJson.user.email,
        name: fullName,
        provider: Provider.LOCAL,
      });

      // 3. Link user to organization
      const orgRole = String(verifyJson.user.role || '').toUpperCase() === 'ADMIN' ? 'ADMIN' : 'USER';
      await this._organizationService.linkUserToOrg(user.id, org.id, orgRole);

      // 4. Issue authenticated session cookies
      const userWithoutPassword = { ...user };
      if ((userWithoutPassword as any).password) {
        delete (userWithoutPassword as any).password;
      }
      const jwt = AuthChecker.signJWT(userWithoutPassword);

      response.cookie('auth', jwt, {
        domain: getCookieUrlFromDomain(process.env.FRONTEND_URL!),
        ...(!process.env.NOT_SECURED
          ? {
              secure: true,
              httpOnly: true,
              sameSite: 'none',
            }
          : {}),
        expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365),
      });

      response.cookie('showorg', org.id, {
        domain: getCookieUrlFromDomain(process.env.FRONTEND_URL!),
        ...(!process.env.NOT_SECURED
          ? {
              secure: true,
              httpOnly: true,
              sameSite: 'none',
            }
          : {}),
        expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 365),
      });

      if (process.env.NOT_SECURED) {
        response.header('auth', jwt);
        response.header('showorg', org.id);
      }

      const safeUrl = sanitizeReturnUrl(body.returnUrl, '/launches');

      return response.status(200).json({
        success: true,
        user: {
          id: user.id,
          email: user.email,
        },
        organizationId: org.id,
        returnUrl: safeUrl,
      });
    } catch (err: any) {
      console.error('[SSOExchange] Failed:', err?.name || 'Error');
      return response.status(400).json({
        error: 'SSO exchange failed',
      });
    }
  }
}
