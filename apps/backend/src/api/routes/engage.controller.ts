import { Controller, Get, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Organization, User } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { ChatwootService } from '@gitroom/backend/services/chatwoot/chatwoot.service';

@ApiTags('Engage')
@Controller('/engage')
export class EngageController {
  constructor(private readonly chatwoot: ChatwootService) {}

  @Get('/status')
  status(@GetOrgFromRequest() organization: Organization) {
    return this.chatwoot.getStatus(organization);
  }

  @Post('/launch')
  launch(
    @GetOrgFromRequest() organization: Organization,
    @GetUserFromRequest() user: User
  ) {
    return this.chatwoot.createLaunchUrl(organization, user);
  }
}
