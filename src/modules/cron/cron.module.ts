import { Module } from '@nestjs/common';
import { IceLockingService } from './ice-locking.service';
import { VaultCompoundService } from './vault-compound.service';
import { StakingRewardService } from './staking-reward.service';
import { StakingApyIndexerService } from './staking-apy-indexer.service';
import { BribeRewardService } from './bribe-reward.service';
import { AutoCompoundService } from './auto-compound.service';
import { VaultApyService } from './vault-apy.service';

@Module({
  providers: [
    IceLockingService,
    VaultCompoundService,
    StakingRewardService,
    StakingApyIndexerService,
    BribeRewardService,
    AutoCompoundService,
    VaultApyService,
  ],
  exports: [
    IceLockingService,
    VaultCompoundService,
    StakingRewardService,
    StakingApyIndexerService,
    BribeRewardService,
    AutoCompoundService,
    VaultApyService,
  ],
})
export class CronModule {}
