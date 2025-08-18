import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsNumber } from 'class-validator';

export class UnlockAquaDto {
  @ApiProperty({ description: 'The public key of the sender wallet' })
  @IsString()
  @IsNotEmpty()
  senderPublicKey: string;

  @ApiProperty({ description: 'Amount to unstake', minimum: 0.0000001 })
  @IsNumber()
  amountToUnstake: number;

  @ApiProperty({ description: 'Signed transaction XDR for wallet verification - REQUIRED for security' })
  @IsString()
  @IsNotEmpty()
  signedTxXdr: string; // Require signed transaction for authentication
}
