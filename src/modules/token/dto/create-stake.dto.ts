import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsString, Min, IsNotEmpty } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateStakeDto {
  @ApiProperty({ description: 'The name of the token' })
  @IsString()
  @IsNotEmpty()
  assetCode: string;

  @ApiProperty({ description: 'Contract address of the token' })
  @IsString()
  @IsNotEmpty()
  assetIssuer: string;

  @ApiProperty({ description: 'Amount to lock', minimum: 1 })
  @Type(() => Number)
  @IsNumber()
  amount: number;

  @ApiProperty({ description: 'Treasury Amount', minimum: 1 })
  treasuryAmount: number;

  @ApiProperty({ description: 'The signed transaction from user' })
  @IsString()
  @IsNotEmpty()
  signedTxXdr: string;

  @ApiProperty({ description: 'The signed transaction from user' })
  @IsString()
  @IsNotEmpty()
  senderPublicKey: string;
}
