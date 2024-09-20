import { SummarizedAssets } from '@/utils/models/interfaces';

export class CreateRemoveLiquidityDto {
  senderPublicKey: string;
  userPoolPercentage: number;
  summarizedAssets: SummarizedAssets | null;
}
