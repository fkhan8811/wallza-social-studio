import { Controller, Get, Param, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { verifyWallzaInternalRequest } from '@gitroom/nestjs-libraries/auth/wallza.hmac';

@ApiTags('Monitor')
@Controller('/monitor')
export class MonitorController {
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

  @Get('/queue/:name')
  async getMessagesGroup(@Param('name') name: string) {
    return {
      status: 'success',
      message: `Queue ${name} is healthy.`,
    };
  }
}
