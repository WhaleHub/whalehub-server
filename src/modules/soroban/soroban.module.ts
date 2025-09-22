import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { SorobanCoreService } from './services/soroban-core.service';
import { StakingContractService } from './services/staking-contract.service';
import { GovernanceContractService } from './services/governance-contract.service';
import { RewardsContractService } from './services/rewards-contract.service';
import { LiquidityContractService } from './services/liquidity-contract.service';
import { ContractSyncService } from './services/contract-sync.service';
import { TransactionService } from './services/transaction.service';
import { MigrationService } from './services/migration.service';
import { SorobanController } from './soroban.controller';

// Import existing entities
import { UserEntity } from '@/utils/typeorm/entities/user.entity';
import { StakeEntity } from '@/utils/typeorm/entities/stake.entity';
import { PoolsEntity } from '@/utils/typeorm/entities/pools.entity';
import { LpBalanceEntity } from '@/utils/typeorm/entities/lp-balances.entity';
import { ClaimableRecordsEntity } from '@/utils/typeorm/entities/claimableRecords.entity';

// New entities for contract integration
import { TransactionLogEntity } from './entities/transaction-log.entity';
import { ContractSyncStatusEntity } from './entities/contract-sync-status.entity';
import { HybridUserDataEntity } from './entities/hybrid-user-data.entity';
import { ContractEventLogEntity } from './entities/contract-event-log.entity';
import { MigrationStatusEntity } from './entities/migration-status.entity';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([
      // Existing entities
      UserEntity,
      StakeEntity,
      PoolsEntity,
      LpBalanceEntity,
      ClaimableRecordsEntity,
      // New contract entities
      TransactionLogEntity,
      ContractSyncStatusEntity,
      HybridUserDataEntity,
      ContractEventLogEntity,
      MigrationStatusEntity,
    ]),
  ],
  controllers: [SorobanController],
  providers: [
    SorobanCoreService,
    StakingContractService,
    GovernanceContractService,
    RewardsContractService,
    LiquidityContractService,
    ContractSyncService,
    TransactionService,
    MigrationService,
  ],
  exports: [
    SorobanCoreService,
    StakingContractService,
    GovernanceContractService,
    RewardsContractService,
    LiquidityContractService,
    ContractSyncService,
    TransactionService,
    MigrationService,
  ],
})
export class SorobanModule {} 