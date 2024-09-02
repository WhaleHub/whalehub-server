import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, Min } from 'class-validator';

export class CreateAddLiquidityDto {
  // @ApiProperty({ description: 'The name of the token' })
  // assetCode: string;
  // @ApiProperty({ description: 'Contract address of the token' })
  // assetIssuer: string;
  // @ApiProperty({ description: 'Amount to lock', minimum: 1 })
  // @IsNumber()
  // @Min(1, { message: 'Amount must be at least 1' })
  // amount: number;
  // @ApiProperty({ description: 'The total duration to be locked' })
  // timeline: string;

  @ApiProperty({ description: 'The signed transaction from user' })
  signedTxXdr: string;

  @ApiProperty({ description: 'The signed transaction from user' })
  senderPublicKey: string;
}
