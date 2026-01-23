import { Module } from '@nestjs/common';
import { IceLockingService } from './ice-locking.service';
import { VaultCompoundService } from './vault-compound.service';
import { VotingService } from './voting.service';

@Module({
  providers: [IceLockingService, VaultCompoundService, VotingService],
  exports: [IceLockingService, VaultCompoundService, VotingService],
})
export class CronModule {}
