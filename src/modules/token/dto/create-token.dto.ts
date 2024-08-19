import { ApiProperty } from '@nestjs/swagger';

export class CreateTokenDto {
  @ApiProperty({ description: 'The name of the token' })
  tokenName: string;
}
