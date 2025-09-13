import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsString, Min, IsNotEmpty, IsOptional, IsDefined } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateStakeDto {
  @ApiProperty({ description: 'The name of the token' })
  @IsDefined({ message: 'Asset code is required' })
  @IsString({ message: 'Asset code must be a string' })
  @IsNotEmpty({ message: 'Asset code cannot be empty' })
  assetCode: string;

  @ApiProperty({ description: 'Contract address of the token' })
  @IsDefined({ message: 'Asset issuer is required' })
  @IsString({ message: 'Asset issuer must be a string' })
  @IsNotEmpty({ message: 'Asset issuer cannot be empty' })
  assetIssuer: string;

  @ApiProperty({ description: 'Amount to lock', minimum: 0.0000001 })
  @IsDefined({ message: 'Amount is required' })
  @Type(() => Number)
  @IsNumber({}, { message: 'Amount must be a valid number' })
  @Min(0.0000001, { message: 'Amount must be at least 0.0000001' })
  amount: number;

  @ApiProperty({ description: 'Treasury Amount', minimum: 0, required: false })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: 'Treasury amount must be a valid number' })
  treasuryAmount?: number;

  @ApiProperty({ description: 'The signed transaction from user' })
  @IsDefined({ message: 'Signed transaction XDR is required' })
  @IsString({ message: 'Signed transaction XDR must be a string' })
  @IsNotEmpty({ message: 'Signed transaction XDR cannot be empty' })
  signedTxXdr: string;

  @ApiProperty({ description: 'The sender public key' })
  @IsDefined({ message: 'Sender public key is required' })
  @IsString({ message: 'Sender public key must be a string' })
  @IsNotEmpty({ message: 'Sender public key cannot be empty' })
  senderPublicKey: string;
}
