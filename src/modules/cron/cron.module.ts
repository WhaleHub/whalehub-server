import { Module } from '@nestjs/common';
import { IceLockingService } from './ice-locking.service';
import { VaultCompoundService } from './vault-compound.service';
import { StakingRewardService } from './staking-reward.service';

@Module({
  providers: [IceLockingService, VaultCompoundService, StakingRewardService],
  exports: [IceLockingService, VaultCompoundService, StakingRewardService],
})
export class CronModule {}
