import { ApiProperty } from '@nestjs/swagger';

export class CreateStakeDto {
  @ApiProperty({ description: 'The name of the token' })
  assetCode: string;

  @ApiProperty({ description: 'Contract address of the token' })
  assetIssuer: string;

  @ApiProperty({ description: 'Amount to lock' })
  amount: number;

  @ApiProperty({ description: 'The total duration to be locked' })
  timeline: string;

  @ApiProperty({ description: 'The signed transaction from user' })
  signedTxXdr: string;

  @ApiProperty({ description: 'The signed transaction from user' })
  senderPublicKey: string;
}
