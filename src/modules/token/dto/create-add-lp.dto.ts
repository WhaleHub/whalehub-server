import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, Min } from 'class-validator';

class AssetDto {
  @ApiProperty({ description: 'The code of the asset (e.g., XLM, AQUA)' })
  code: string;

  @ApiProperty({
    description:
      'The issuer of the asset (only applicable for non-native assets like AQUA)',
  })
  issuer?: string;

  @ApiProperty({ description: 'The amount of the asset' })
  @IsNumber()
  @Min(1, { message: 'Amount must be at least 1' })
  amount: number;
}

export class CreateAddLiquidityDto {
  @ApiProperty({
    description: 'Details of the first asset involved in the liquidity pool',
  })
  asset1: AssetDto;

  @ApiProperty({
    description: 'Details of the second asset involved in the liquidity pool',
  })
  asset2: AssetDto;

  @ApiProperty({ description: 'The signed transaction from user' })
  signedTxXdr: string;

  @ApiProperty({ description: 'The sender public key' })
  senderPublicKey: string;
}
