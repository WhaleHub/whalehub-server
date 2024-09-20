import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsString, Min } from 'class-validator';

export class CreateStakeDto {
  @ApiProperty({ description: 'The name of the token' })
  assetCode: string;

  @ApiProperty({ description: 'Contract address of the token' })
  assetIssuer: string;

  @ApiProperty({ description: 'Amount to lock', minimum: 1 })
  @IsNumber()
  amount: number;

  @ApiProperty({ description: 'Treasury Amount', minimum: 1 })
  @IsNumber()
  treasuryAmount: number;

  @ApiProperty({ description: 'The total duration to be locked' })
  @IsString()
  timeline: string;

  @ApiProperty({ description: 'The signed transaction from user' })
  @IsString()
  signedTxXdr: string;

  @ApiProperty({ description: 'The signed transaction from user' })
  @IsString()
  senderPublicKey: string;
}
