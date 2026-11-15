import { IsDefined, IsOptional, IsString } from 'class-validator';

export class SsoExchangeDto {
  @IsString()
  @IsDefined()
  code: string;

  @IsString()
  @IsDefined()
  state: string;

  @IsString()
  @IsDefined()
  redirectUri: string;

  @IsString()
  @IsOptional()
  returnUrl?: string;
}

