import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateStakeDto {
  @ApiProperty({ description: 'The name of the token' })
  assetCode: string;

  @ApiProperty({ description: 'Contract address of the token' })
  assetIssuer: string;

  @ApiProperty({ description: 'Amount to lock', minimum: 1 })
  @Type(() => Number)
  @IsNumber()
  amount: number;

  @ApiProperty({ description: 'Treasury Amount', minimum: 1 })
  treasuryAmount: number;

  @ApiProperty({ description: 'The signed transaction from user' })
  @IsString()
  signedTxXdr: string;

  @ApiProperty({ description: 'The signed transaction from user' })
  @IsString()
  senderPublicKey: string;
}
