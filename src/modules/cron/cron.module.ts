import { Module } from '@nestjs/common';
import { IceLockingService } from './ice-locking.service';
import { VaultCompoundService } from './vault-compound.service';
import { StakingRewardService } from './staking-reward.service';
import { StakingApyIndexerService } from './staking-apy-indexer.service';

@Module({
  providers: [
    IceLockingService,
    VaultCompoundService,
    StakingRewardService,
    StakingApyIndexerService,
  ],
  exports: [
    IceLockingService,
    VaultCompoundService,
    StakingRewardService,
    StakingApyIndexerService,
  ],
})
export class CronModule {}
