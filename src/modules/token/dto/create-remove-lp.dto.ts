import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsNumber, MinLength, IsDefined } from 'class-validator';
import { Type } from 'class-transformer';

export class UnlockAquaDto {
  @ApiProperty({ description: 'The public key of the sender wallet' })
  @IsDefined({ message: 'Sender public key is required' })
  @IsString()
  @IsNotEmpty({ message: 'Sender public key is required' })
  senderPublicKey: string;

  @ApiProperty({ description: 'Amount to unstake', minimum: 0.0000001 })
  @IsDefined({ message: 'Unstake amount is required' })
  @Type(() => Number)
  @IsNumber({}, { message: 'Amount must be a valid number' })
  amountToUnstake: number;

  @ApiProperty({ 
    description: 'Signed transaction XDR for wallet verification - REQUIRED for security',
    required: true,
    example: 'AAAA...XDR_DATA_HERE'
  })
  @IsDefined({ message: 'Signed transaction XDR is required for wallet verification' })
  @IsString({ message: 'Signed transaction XDR must be a string' })
  @IsNotEmpty({ message: 'Signed transaction XDR is required for wallet verification' })
  @MinLength(10, { message: 'Signed transaction XDR appears to be invalid' })
  signedTxXdr: string; // Require signed transaction for authentication
}
