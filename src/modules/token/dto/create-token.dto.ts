import { ApiProperty } from '@nestjs/swagger';

export class CreateTokenDto {
  @ApiProperty({ description: 'The token code' })
  code: string;

  @ApiProperty({ description: 'Token Issuere address' })
  issuer: string;
}
