import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsNumber, MinLength } from 'class-validator';

export class UnlockAquaDto {
  @ApiProperty({ description: 'The public key of the sender wallet' })
  @IsString()
  @IsNotEmpty({ message: 'Sender public key is required' })
  senderPublicKey: string;

  @ApiProperty({ description: 'Amount to unstake', minimum: 0.0000001 })
  @IsNumber({}, { message: 'Amount must be a valid number' })
  amountToUnstake: number;

  @ApiProperty({ 
    description: 'Signed transaction XDR for wallet verification - REQUIRED for security',
    required: true,
    example: 'AAAA...XDR_DATA_HERE'
  })
  @IsString({ message: 'Signed transaction XDR must be a string' })
  @IsNotEmpty({ message: 'Signed transaction XDR is required for wallet verification' })
  @MinLength(10, { message: 'Signed transaction XDR appears to be invalid' })
  signedTxXdr: string; // Require signed transaction for authentication
}
