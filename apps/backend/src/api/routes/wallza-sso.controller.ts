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
    if (!code || !state) {
      throw new HttpException(
        'Missing authorization code or state',
        HttpStatus.BAD_REQUEST
      );
    }

    const wallzaUrl =
      process.env.WALLZAOS_INTERNAL_API_URL ||
      process.env.WALLZAOS_API_URL ||
      process.env.MAIN_URL ||
      'http://localhost:5011';

    const secret =
      process.env.WALLZAOS_INTERNAL_SECRET ||
      process.env.WALLZA_INTERNAL_SECRET ||
      'dev_wallza_internal_secret';

    // 1. Verify code server-to-server with WallzaOS
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

    try {
      const verifyRes = await fetch(`${wallzaUrl}/api/social-studio/sso/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${secret}`,
          'X-Wallza-Internal-Secret': secret,
        },
        body: JSON.stringify({ code, state, redirect_uri }),
      });

      if (!verifyRes.ok) {
        const errText = await verifyRes.text().catch(() => '');
        throw new Error(`WallzaOS rejected SSO code (${verifyRes.status}): ${errText}`);
      }

      verified = await verifyRes.json();
      if (!verified?.valid || !verified?.user?.id || !verified?.organization?.id) {
        throw new Error('Invalid verification payload from WallzaOS');
      }
    } catch (err: any) {
      throw new HttpException(
        err.message || 'SSO verification failed',
        HttpStatus.UNAUTHORIZED
      );
    }

    // 2. Resolve or create Social Studio Organization
    let org = await this._prisma.organization.findUnique({
      where: { supabaseOrgId: verified.organization.id },
    });

    if (!org) {
      org = await this._prisma.organization.create({
        data: {
          name: verified.organization.name || 'Wallza Workspace',
          supabaseOrgId: verified.organization.id,
        },
      });
    }

    // 3. Resolve or create Social Studio User
    let user = await this._prisma.user.findFirst({
      where: { supabaseUserId: verified.user.id },
    });

    if (!user) {
      // Check if user exists by email
      const existingByEmail = await this._prisma.user.findFirst({
        where: { email: verified.user.email.toLowerCase() },
      });

      if (existingByEmail) {
        user = await this._prisma.user.update({
          where: { id: existingByEmail.id },
          data: {
            supabaseUserId: verified.user.id,
            activated: true,
          },
        });
      } else {
        user = await this._prisma.user.create({
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
      }
    }

    // 4. Ensure UserOrganization membership and role
    const assignedRole: Role =
      verified.user.role === 'ADMIN' ? Role.ADMIN : Role.USER;

    const existingMembership = await this._prisma.userOrganization.findUnique({
      where: {
        userId_organizationId: {
          userId: user.id,
          organizationId: org.id,
        },
      },
    });

    if (!existingMembership) {
      await this._prisma.userOrganization.create({
        data: {
          userId: user.id,
          organizationId: org.id,
          role: assignedRole,
          disabled: false,
        },
      });
    } else if (existingMembership.disabled || existingMembership.role !== assignedRole) {
      await this._prisma.userOrganization.update({
        where: { id: existingMembership.id },
        data: {
          disabled: false,
          role: assignedRole,
        },
      });
    }

    // 5. Issue native Social Studio session token
    const userPayload = { ...user };
    delete userPayload.password;
    const jwt = AuthChecker.signJWT(userPayload);

    // Set secure cookies
    const cookieDomain = getCookieUrlFromDomain(
      process.env.FRONTEND_URL || 'http://localhost:4200'
    );
    const cookieOptions = {
      domain: cookieDomain,
      ...(!process.env.NOT_SECURED
        ? {
            secure: true,
            httpOnly: true,
            sameSite: 'none' as const,
          }
        : {}),
      expires: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30), // 30 days
      path: '/',
    };

    response.cookie('auth', jwt, cookieOptions);
    response.cookie('showorg', org.id, cookieOptions);

    if (process.env.NOT_SECURED) {
      response.header('auth', jwt);
      response.header('showorg', org.id);
    }

    return {
      success: true,
      token: jwt,
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

    const payload = AuthChecker.verifyJWT(auth as string) as any;
    if (!payload?.id) {
      throw new HttpException('Invalid session', HttpStatus.UNAUTHORIZED);
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
    response.cookie('showorg', org.id, {
      domain: cookieDomain,
      ...(!process.env.NOT_SECURED
        ? {
            secure: true,
            httpOnly: true,
            sameSite: 'none' as const,
          }
        : {}),
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

