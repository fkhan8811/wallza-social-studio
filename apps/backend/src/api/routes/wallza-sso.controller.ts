import {
  Controller,
  Post,
  Body,
  Res,
  Req,
  Get,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthService as AuthChecker } from '@gitroom/helpers/auth/auth.service';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Provider, Role } from '@prisma/client';
import { getCookieUrlFromDomain } from '@gitroom/helpers/subdomain/subdomain.management';
import { signInternalRequest } from '../auth/internal-hmac.util';

@Controller('/auth/wallza-sso')
export class WallzaSsoController {
  constructor(private _prisma: PrismaService) {}

  @Get('/status')
  async status() {
    return {
      status: 'active',
      provider: 'wallzaos-supabase-sso',
      timestamp: new Date().toISOString(),
    };
  }

  @Post('/exchange')
  async exchange(
    @Body() body: { code: string; state: string; redirect_uri: string },
    @Res({ passthrough: true }) response: Response
  ) {
    const { code, state, redirect_uri } = body || {};
    if (!code || !state || !redirect_uri) {
      throw new HttpException(
        'Missing authorization code, state, or redirect_uri',
        HttpStatus.BAD_REQUEST
      );
    }

    const wallzaUrl =
      process.env.WALLZAOS_INTERNAL_API_URL ||
      process.env.WALLZAOS_API_URL ||
      process.env.MAIN_URL ||
      'http://localhost:5011';

    // 1. Verify code server-to-server with WallzaOS using canonical HMAC signature
    let verified: {
      valid: boolean;
      user: {
        id: string;
        email: string;
        firstName?: string;
        lastName?: string;
        role?: 'ADMIN' | 'USER';
      };
      organization: {
        id: string;
        name: string;
      };
    };

    const verifyPayload = { code, state, redirect_uri };
    let signedHeaders: Record<string, string>;
    try {
      signedHeaders = signInternalRequest({
        method: 'POST',
        path: '/api/social-studio/sso/verify',
        audience: 'wallzaos-api',
        body: verifyPayload,
      });
    } catch (err: any) {
      throw new HttpException(
        `Internal secret misconfiguration: ${err.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }

    try {
      const verifyRes = await fetch(`${wallzaUrl}/api/social-studio/sso/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...signedHeaders,
        },
        body: JSON.stringify(verifyPayload),
      });

      if (!verifyRes.ok) {
        const errJson = await verifyRes.json().catch(() => ({}));
        const status = verifyRes.status === 403 ? HttpStatus.FORBIDDEN : HttpStatus.UNAUTHORIZED;
        throw new HttpException(
          errJson.error || errJson.message || `WallzaOS rejected SSO code (${verifyRes.status})`,
          status
        );
      }

      verified = await verifyRes.json();
      if (!verified?.valid || !verified?.user?.id || !verified?.organization?.id) {
        throw new HttpException('Invalid verification payload received from WallzaOS', HttpStatus.UNAUTHORIZED);
      }
    } catch (err: any) {
      if (err instanceof HttpException) throw err;
      throw new HttpException(
        err.message || 'SSO verification communication failed',
        HttpStatus.UNAUTHORIZED
      );
    }

    // 2. Transaction-safe resolution and synchronization of User, Org, and Membership
    const assignedRole: Role =
      verified.user.role === 'ADMIN' ? Role.ADMIN : Role.USER;

    const { user, org } = await this._prisma.$transaction(async (tx) => {
      // 2a. Resolve or create Social Studio Organization
      const resolvedOrg = await tx.organization.upsert({
        where: { supabaseOrgId: verified.organization.id },
        create: {
          name: verified.organization.name || 'Wallza Workspace',
          supabaseOrgId: verified.organization.id,
        },
        update: {
          name: verified.organization.name || undefined,
        },
      });

      // 2b. Resolve or create Social Studio User
      let resolvedUser = await tx.user.findFirst({
        where: {
          OR: [
            { supabaseUserId: verified.user.id },
            { email: verified.user.email.toLowerCase() },
          ],
        },
      });

      if (!resolvedUser) {
        try {
          resolvedUser = await tx.user.create({
            data: {
              email: verified.user.email.toLowerCase(),
              name: verified.user.firstName || 'Wallza',
              lastName: verified.user.lastName || 'User',
              providerName: Provider.GENERIC,
              activated: true,
              supabaseUserId: verified.user.id,
              timezone: 0,
            },
          });
        } catch {
          // Fallback on race condition
          resolvedUser = await tx.user.findFirst({
            where: {
              OR: [
                { supabaseUserId: verified.user.id },
                { email: verified.user.email.toLowerCase() },
              ],
            },
          });
          if (!resolvedUser) {
            throw new Error('Failed to resolve or create user during SSO exchange');
          }
        }
      } else if (!resolvedUser.supabaseUserId || resolvedUser.supabaseUserId !== verified.user.id) {
        resolvedUser = await tx.user.update({
          where: { id: resolvedUser.id },
          data: {
            supabaseUserId: verified.user.id,
            activated: true,
          },
        });
      }

      // 2c. Ensure UserOrganization membership and role
      await tx.userOrganization.upsert({
        where: {
          userId_organizationId: {
            userId: resolvedUser.id,
            organizationId: resolvedOrg.id,
          },
        },
        create: {
          userId: resolvedUser.id,
          organizationId: resolvedOrg.id,
          role: assignedRole,
          disabled: false,
        },
        update: {
          role: assignedRole,
          disabled: false,
        },
      });

      return { user: resolvedUser, org: resolvedOrg };
    });

    // 3. Issue native Social Studio session token
    const userPayload = { ...user };
    delete userPayload.password;
    const jwt = AuthChecker.signJWT(userPayload);

    // 4. Set native server-side HttpOnly cookies (Requirement 1)
    const cookieDomain = getCookieUrlFromDomain(
      process.env.FRONTEND_URL || 'http://localhost:4200'
    );
    const isProduction = process.env.NODE_ENV === 'production';
    const isSecure = isProduction || !process.env.NOT_SECURED;

    // Cookie configuration: strictly HttpOnly, Secure when appropriate, SameSite Lax for navigation
    const cookieOptions = {
      domain: cookieDomain,
      httpOnly: true,
      secure: isSecure,
      sameSite: (isSecure && isProduction ? 'none' : 'lax') as 'none' | 'lax',
      expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30), // 30 days
      path: '/',
    };

    response.cookie('auth', jwt, cookieOptions);
    response.cookie('showorg', org.id, cookieOptions);

    // 5. Return success JSON WITHOUT the JWT (Requirement 1: zero JWT in response body)
    return {
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        lastName: user.lastName,
      },
      organization: {
        id: org.id,
        name: org.name,
        supabaseOrgId: org.supabaseOrgId,
      },
    };
  }

  @Post('/switch-org')
  async switchOrg(
    @Req() req: Request,
    @Body() body: { supabaseOrgId: string },
    @Res({ passthrough: true }) response: Response
  ) {
    const auth = req.headers.auth || req.cookies?.auth;
    if (!auth) {
      throw new HttpException('Unauthenticated', HttpStatus.UNAUTHORIZED);
    }

    let payload: any;
    try {
      payload = AuthChecker.verifyJWT(auth as string);
    } catch {
      throw new HttpException('Invalid or expired session', HttpStatus.UNAUTHORIZED);
    }

    if (!payload?.id) {
      throw new HttpException('Invalid session payload', HttpStatus.UNAUTHORIZED);
    }

    const { supabaseOrgId } = body || {};
    if (!supabaseOrgId) {
      throw new HttpException('Missing supabaseOrgId', HttpStatus.BAD_REQUEST);
    }

    const org = await this._prisma.organization.findUnique({
      where: { supabaseOrgId },
    });

    if (!org) {
      throw new HttpException('Organization not found in Social Studio', HttpStatus.NOT_FOUND);
    }

    const membership = await this._prisma.userOrganization.findUnique({
      where: {
        userId_organizationId: {
          userId: payload.id,
          organizationId: org.id,
        },
      },
    });

    if (!membership || membership.disabled) {
      throw new HttpException(
        'User does not have active membership in this organization',
        HttpStatus.FORBIDDEN
      );
    }

    const cookieDomain = getCookieUrlFromDomain(
      process.env.FRONTEND_URL || 'http://localhost:4200'
    );
    const isProduction = process.env.NODE_ENV === 'production';
    const isSecure = isProduction || !process.env.NOT_SECURED;

    response.cookie('showorg', org.id, {
      domain: cookieDomain,
      httpOnly: true,
      secure: isSecure,
      sameSite: (isSecure && isProduction ? 'none' : 'lax') as 'none' | 'lax',
      expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
      path: '/',
    });

    return {
      success: true,
      organizationId: org.id,
      supabaseOrgId: org.supabaseOrgId,
      name: org.name,
    };
  }
}
