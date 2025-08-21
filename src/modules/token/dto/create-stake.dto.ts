import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsString, Min, IsNotEmpty, IsOptional } from 'class-validator';
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

  @ApiProperty({ description: 'Amount to lock', minimum: 0.0000001 })
  @Type(() => Number)
  @IsNumber()
  @Min(0.0000001, { message: 'Amount must be at least 0.0000001' })
  amount: number;

  @ApiProperty({ description: 'Treasury Amount', minimum: 0, required: false })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  treasuryAmount?: number;

  @ApiProperty({ description: 'The signed transaction from user' })
  @IsString()
  @IsNotEmpty()
  signedTxXdr: string;

  @ApiProperty({ description: 'The signed transaction from user' })
  @IsString()
  @IsNotEmpty()
  senderPublicKey: string;
}
