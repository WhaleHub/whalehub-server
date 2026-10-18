import { Module } from '@nestjs/common';
import { IceLockingService } from './ice-locking.service';
import { VaultCompoundService } from './vault-compound.service';
import { StakingRewardService } from './staking-reward.service';
import { StakingApyIndexerService } from './staking-apy-indexer.service';
import { BribeRewardService } from './bribe-reward.service';
import { AutoCompoundService } from './auto-compound.service';

@Module({
  providers: [
    IceLockingService,
    VaultCompoundService,
    StakingRewardService,
    StakingApyIndexerService,
    BribeRewardService,
    AutoCompoundService,
  ],
  exports: [
    IceLockingService,
    VaultCompoundService,
    StakingRewardService,
    StakingApyIndexerService,
    BribeRewardService,
    AutoCompoundService,
  ],
})
export class CronModule {}
