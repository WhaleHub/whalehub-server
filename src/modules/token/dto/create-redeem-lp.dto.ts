import { SummarizedAssets } from '@/utils/models/interfaces';

export class CreateRedeemLiquidityDto {
  senderPublicKey: string;
  userPoolPercentage: number;
  summerizedAssets: SummarizedAssets | null;
}
