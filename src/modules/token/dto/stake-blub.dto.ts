import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString } from 'class-validator';
import { Type } from 'class-transformer';

export class StakeBlubDto {
	@ApiProperty({ description: 'The public key of the sender wallet' })
	@IsString()
	senderPublicKey: string;

	@ApiProperty({ description: 'Amount to restake' })
	@Type(() => Number)
	@IsNumber()
	amount: number;

	@ApiProperty({ description: 'Signed transaction XDR for wallet verification' })
	@IsString()
	signedTxXdr: string;

	// Optional fields sometimes sent by the frontend; allowed for whitelist compatibility
	@ApiProperty({ description: 'Asset code (optional)', required: false })
	@IsOptional()
	@IsString()
	assetCode?: string;

	@ApiProperty({ description: 'Asset issuer (optional)', required: false })
	@IsOptional()
	@IsString()
	assetIssuer?: string;
}
