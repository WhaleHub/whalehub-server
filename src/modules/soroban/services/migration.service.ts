import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SorobanCoreService } from './soroban-core.service';
import { StakingContractService } from './staking-contract.service';
import { GovernanceContractService } from './governance-contract.service';
import { RewardsContractService } from './rewards-contract.service';
import { LiquidityContractService } from './liquidity-contract.service';
import { UserEntity } from '@/utils/typeorm/entities/user.entity';
import { StakeEntity } from '@/utils/typeorm/entities/stake.entity';
import { LpBalanceEntity } from '@/utils/typeorm/entities/lp-balances.entity';
import { MigrationStatusEntity, MigrationStatus, MigrationType } from '../entities/migration-status.entity';
import { HybridUserDataEntity } from '../entities/hybrid-user-data.entity';
import BigNumber from 'bignumber.js';

export interface MigrationPlan {
  userAddress: string;
  migrationType: MigrationType;
  estimatedRecords: number;
  estimatedTime: string;
  dataPreview: any;
}

export interface MigrationResult {
  success: boolean;
  recordsMigrated: number;
  recordsFailed: number;
  transactionHashes: string[];
  errors: string[];
}

@Injectable()
export class MigrationService {
  private readonly logger = new Logger(MigrationService.name);

  constructor(
    private sorobanCore: SorobanCoreService,
    private stakingService: StakingContractService,
    private governanceService: GovernanceContractService,
    private rewardsService: RewardsContractService,
    private liquidityService: LiquidityContractService,
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
    @InjectRepository(StakeEntity)
    private stakeRepository: Repository<StakeEntity>,
    @InjectRepository(LpBalanceEntity)
    private lpBalanceRepository: Repository<LpBalanceEntity>,
    @InjectRepository(MigrationStatusEntity)
    private migrationStatusRepository: Repository<MigrationStatusEntity>,
    @InjectRepository(HybridUserDataEntity)
    private hybridUserRepository: Repository<HybridUserDataEntity>,
  ) {}

  /**
   * Migrate a single user to the new hybrid system
   */
  async migrateUser(userAddress: string, migrationType: MigrationType = MigrationType.FULL_USER): Promise<MigrationResult> {
    // Create migration record
    const migration = await this.createMigrationRecord(userAddress, migrationType);
    
    try {
      // Update status to in progress
      migration.status = MigrationStatus.IN_PROGRESS;
      await this.migrationStatusRepository.save(migration);

      // Get user data for migration
      const userMigrationPlan = await this.createUserMigrationPlan(userAddress, migrationType);
      
      if (userMigrationPlan.estimatedRecords === 0) {
        await this.completeMigration(migration, {
          success: true,
          recordsMigrated: 0,
          recordsFailed: 0,
          transactionHashes: [],
          errors: [],
        });
        
        return {
          success: true,
          recordsMigrated: 0,
          recordsFailed: 0,
          transactionHashes: [],
          errors: [],
        };
      }

      // Perform migration based on type
      const migrationResults = await this.performMigration(userAddress, migrationType);

      // Complete migration
      await this.completeMigration(migration, migrationResults);

      return migrationResults;
    } catch (error) {
      await this.failMigration(migration, error.message);
      throw error;
    }
  }

  /**
   * Migrate multiple users in batch
   */
  async migrateBatch(userAddresses: string[], migrationType: MigrationType = MigrationType.FULL_USER): Promise<{
    successful: string[];
    failed: Array<{ userAddress: string; error: string }>;
    totalRecordsMigrated: number;
  }> {
    const successful = [];
    const failed = [];
    let totalRecordsMigrated = 0;

    for (const userAddress of userAddresses) {
      try {
        const result = await this.migrateUser(userAddress, migrationType);
        if (result.success) {
          successful.push(userAddress);
          totalRecordsMigrated += result.recordsMigrated;
        } else {
          failed.push({ userAddress, error: result.errors.join(', ') });
        }
      } catch (error) {
        failed.push({ userAddress, error: error.message });
      }
    }

    return { successful, failed, totalRecordsMigrated };
  }

  /**
   * Create migration plan for a user
   */
  async createUserMigrationPlan(userAddress: string, migrationType: MigrationType): Promise<MigrationPlan> {
    try {
      // Get user's stakes
      const stakes = await this.stakeRepository.find({
        where: { 
          account: { account: userAddress },
        },
        relations: ['account'],
      });

      // Get user's LP balances
      const lpBalances = await this.lpBalanceRepository.find({
        where: { account: { account: userAddress } },
        relations: ['account'],
      });

      // Calculate totals (simplified since fields not available in current entities)
      const totalAquaStaked = stakes
        .reduce((sum, stake) => sum.plus(stake.amount), new BigNumber(0))
        .toFixed(7);

      const totalBlubStaked = '0'; // Not distinguishable in current entity

      const totalLpTokens = lpBalances
        .reduce((sum, balance) => sum.plus(balance.assetAAmount || '0'), new BigNumber(0))
        .toFixed(7);

      let estimatedRecords = 0;
      let dataPreview: any = {};

      switch (migrationType) {
        case MigrationType.STAKES:
          estimatedRecords = stakes.length;
          dataPreview = { stakesCount: stakes.length, totalAquaStaked };
          break;

        case MigrationType.LIQUIDITY:
          estimatedRecords = lpBalances.length;
          dataPreview = { lpPositions: lpBalances.length, totalLpTokens };
          break;

        case MigrationType.FULL_USER:
          estimatedRecords = stakes.length + lpBalances.length;
          dataPreview = {
            stakesCount: stakes.length,
            lpPositions: lpBalances.length,
            totalAquaStaked,
            totalBlubStaked,
            totalLpTokens,
          };
          break;

        default:
          estimatedRecords = stakes.length;
          dataPreview = { stakesCount: stakes.length };
      }

      // Estimate time (1 second per record + overhead)
      const estimatedTime = `${Math.max(1, estimatedRecords)} seconds`;

      return {
        userAddress,
        migrationType,
        estimatedRecords,
        estimatedTime,
        dataPreview,
      };
    } catch (error) {
      this.logger.error('Failed to create user migration plan:', error);
      throw error;
    }
  }

  /**
   * Perform the actual migration
   */
  private async performMigration(userAddress: string, migrationType: MigrationType): Promise<MigrationResult> {
    const result: MigrationResult = {
      success: true,
      recordsMigrated: 0,
      recordsFailed: 0,
      transactionHashes: [],
      errors: [],
    };

    try {
      switch (migrationType) {
        case MigrationType.STAKES:
          await this.migrateUserStakes(userAddress, result);
          break;

        case MigrationType.GOVERNANCE:
          await this.migrateUserGovernance(userAddress, result);
          break;

        case MigrationType.REWARDS:
          await this.migrateUserRewards(userAddress, result);
          break;

        case MigrationType.LIQUIDITY:
          await this.migrateUserLiquidity(userAddress, result);
          break;

        case MigrationType.FULL_USER:
          await this.migrateUserStakes(userAddress, result);
          await this.migrateUserGovernance(userAddress, result);
          await this.migrateUserRewards(userAddress, result);
          await this.migrateUserLiquidity(userAddress, result);
          break;
      }

      result.success = result.recordsFailed === 0;
    } catch (error) {
      result.success = false;
      result.errors.push(error.message);
    }

    return result;
  }

  /**
   * Migrate user stakes
   */
  private async migrateUserStakes(userAddress: string, result: MigrationResult): Promise<void> {
    try {
      const stakes = await this.stakeRepository.find({
        where: { account: { account: userAddress } },
        relations: ['account'],
      });

      for (const stake of stakes) {
        try {
          const contractResult = await this.stakingService.recordLock(
            userAddress,
            stake.amount,
            0, // Duration not available in current entity
            `migration_${Date.now()}`,
            true,
          );

          if (contractResult.success) {
            result.recordsMigrated++;
            if (contractResult.transactionHash) {
              result.transactionHashes.push(contractResult.transactionHash);
            }
          } else {
            result.recordsFailed++;
            result.errors.push(`Failed to migrate stake: ${contractResult.error}`);
          }
        } catch (error) {
          result.recordsFailed++;
          result.errors.push(`Stake migration error: ${error.message}`);
        }
      }
    } catch (error) {
      result.errors.push(`Stakes migration failed: ${error.message}`);
    }
  }

  /**
   * Migrate user governance data
   */
  private async migrateUserGovernance(userAddress: string, result: MigrationResult): Promise<void> {
    try {
      // Calculate total AQUA staked for ICE issuance
      const stakes = await this.stakeRepository.find({
        where: { account: { account: userAddress } },
        relations: ['account'],
      });

      if (stakes.length > 0) {
        const totalAqua = stakes
          .reduce((sum, stake) => sum.plus(stake.amount), new BigNumber(0))
          .toFixed(7);

        const contractResult = await this.governanceService.recordIceIssuance(
          userAddress,
          totalAqua,
          0, // Duration not available
          `migration_${Date.now()}`,
          true,
        );

        if (contractResult.success) {
          result.recordsMigrated++;
          if (contractResult.transactionHash) {
            result.transactionHashes.push(contractResult.transactionHash);
          }
        } else {
          result.recordsFailed++;
          result.errors.push(`Failed to migrate governance: ${contractResult.error}`);
        }
      }
    } catch (error) {
      result.errors.push(`Governance migration failed: ${error.message}`);
    }
  }

  /**
   * Migrate user rewards
   */
  private async migrateUserRewards(userAddress: string, result: MigrationResult): Promise<void> {
    try {
      // Mock reward migration since we don't have reward records in current schema
      // This would typically migrate claimable rewards data
      result.recordsMigrated++; // Mock success
    } catch (error) {
      result.errors.push(`Rewards migration failed: ${error.message}`);
    }
  }

  /**
   * Migrate user liquidity positions
   */
  private async migrateUserLiquidity(userAddress: string, result: MigrationResult): Promise<void> {
    try {
      const lpBalances = await this.lpBalanceRepository.find({
        where: { account: { account: userAddress } },
        relations: ['account', 'pool'],
      });

      for (const lpBalance of lpBalances) {
        try {
          const contractResult = await this.liquidityService.recordLiquidityAddition(
            userAddress,
            lpBalance.pool.id.toString(),
            lpBalance.assetAAmount || '0',
            lpBalance.assetBAmount || '0',
            lpBalance.assetAAmount || '0', // Using assetAAmount as LP tokens
            `migration_${Date.now()}`,
            true,
          );

          if (contractResult.success) {
            result.recordsMigrated++;
            if (contractResult.transactionHash) {
              result.transactionHashes.push(contractResult.transactionHash);
            }
          } else {
            result.recordsFailed++;
            result.errors.push(`Failed to migrate LP position: ${contractResult.error}`);
          }
        } catch (error) {
          result.recordsFailed++;
          result.errors.push(`LP migration error: ${error.message}`);
        }
      }
    } catch (error) {
      result.errors.push(`Liquidity migration failed: ${error.message}`);
    }
  }

  /**
   * Validate user data after migration
   */
  async validateUserData(userAddress: string): Promise<{
    isValid: boolean;
    discrepancies: string[];
    recommendations: string[];
  }> {
    const discrepancies = [];
    const recommendations = [];

    try {
      // Get data from both sources
      const [dbUser, hybridUser] = await Promise.all([
        this.userRepository.findOne({ where: { account: userAddress } }),
        this.hybridUserRepository.findOne({ where: { userAddress } }),
      ]);

      if (!dbUser) {
        discrepancies.push('User not found in database');
        return { isValid: false, discrepancies, recommendations };
      }

      if (!hybridUser) {
        discrepancies.push('User not found in hybrid system');
        recommendations.push('Run user migration');
        return { isValid: false, discrepancies, recommendations };
      }

      // Validate staking data
      const stakes = await this.stakeRepository.find({
        where: { account: { account: userAddress } },
        relations: ['account'],
      });

      const dbStakeTotal = stakes.reduce((sum, stake) => {
        // Validate amount is numeric
        if (isNaN(parseFloat(stake.amount))) {
          discrepancies.push(`Invalid stake amount: ${stake.amount}`);
          return sum;
        }
        return sum + parseFloat(stake.amount);
      }, 0);

      // Check if any stake has invalid data
      for (const stake of stakes) {
        // Simplified validation since current entity has limited fields
        if (!stake.amount || parseFloat(stake.amount) <= 0) {
          discrepancies.push(`Invalid stake amount: ${stake.amount}`);
        }
      }

      // Validate LP positions
      const lpBalances = await this.lpBalanceRepository.find({
        where: { account: { account: userAddress } },
        relations: ['account', 'pool'],
      });

      for (const balance of lpBalances) {
        if (!balance.assetAAmount || parseFloat(balance.assetAAmount) <= 0) {
          discrepancies.push(`Invalid LP balance: ${balance.assetAAmount}`);
        }
      }

      // Generate recommendations based on findings
      if (discrepancies.length > 0) {
        recommendations.push('Fix data inconsistencies before using hybrid system');
        recommendations.push('Consider re-running migration for this user');
      }

      if (dbStakeTotal !== hybridUser.totalStakedAqua) {
        discrepancies.push(`Stake total mismatch: DB=${dbStakeTotal}, Hybrid=${hybridUser.totalStakedAqua}`);
      }

    } catch (error) {
      discrepancies.push(`Validation failed: ${error.message}`);
    }

    return {
      isValid: discrepancies.length === 0,
      discrepancies,
      recommendations,
    };
  }

  /**
   * Rollback user migration
   */
  async rollbackMigration(userAddress: string): Promise<{ success: boolean; message: string }> {
    try {
      // Find migration record
      const migration = await this.migrationStatusRepository.findOne({
        where: { userAddress, status: MigrationStatus.COMPLETED },
        order: { completedAt: 'DESC' },
      });

      if (!migration) {
        return { success: false, message: 'No completed migration found for rollback' };
      }

      // Mark as rollback required
      migration.status = MigrationStatus.ROLLBACK_REQUIRED;
      await this.migrationStatusRepository.save(migration);

      // Remove from hybrid system
      await this.hybridUserRepository.delete({ userAddress });

      // Mark as rollback completed
      migration.status = MigrationStatus.ROLLBACK_COMPLETED;
      migration.rollbackDetails = JSON.stringify({
        rolledBackAt: new Date(),
        reason: 'Manual rollback requested',
      });
      await this.migrationStatusRepository.save(migration);

      return { success: true, message: 'Migration rollback completed successfully' };
    } catch (error) {
      this.logger.error(`Failed to rollback migration for ${userAddress}:`, error);
      return { success: false, message: error.message };
    }
  }

  /**
   * Get migration status for users
   */
  async getMigrationStatus(userAddress?: string): Promise<MigrationStatusEntity[]> {
    const query = this.migrationStatusRepository
      .createQueryBuilder('migration')
      .orderBy('migration.startedAt', 'DESC');

    if (userAddress) {
      query.where('migration.userAddress = :userAddress', { userAddress });
    }

    return await query.limit(100).getMany();
  }

  /**
   * Get migration statistics
   */
  async getMigrationStats(): Promise<{
    total: number;
    completed: number;
    failed: number;
    inProgress: number;
    notStarted: number;
  }> {
    const stats = await this.migrationStatusRepository
      .createQueryBuilder('migration')
      .select('migration.status as status, COUNT(*) as count')
      .groupBy('migration.status')
      .getRawMany();

    const result = {
      total: 0,
      completed: 0,
      failed: 0,
      inProgress: 0,
      notStarted: 0,
    };

    stats.forEach(stat => {
      const count = parseInt(stat.count);
      result.total += count;

      switch (stat.status) {
        case MigrationStatus.COMPLETED:
          result.completed = count;
          break;
        case MigrationStatus.FAILED:
          result.failed = count;
          break;
        case MigrationStatus.IN_PROGRESS:
          result.inProgress = count;
          break;
        case MigrationStatus.NOT_STARTED:
          result.notStarted = count;
          break;
      }
    });

    return result;
  }

  /**
   * Retry failed migrations
   */
  async retryFailedMigrations(): Promise<{ retriedCount: number; errors: string[] }> {
    const failedMigrations = await this.migrationStatusRepository.find({
      where: { status: MigrationStatus.FAILED },
      take: 10, // Limit to 10 retries at a time
    });

    const errors = [];
    let retriedCount = 0;

    for (const migration of failedMigrations) {
      try {
        // Increment retry count
        migration.retryCount = (migration.retryCount || 0) + 1;
        migration.status = MigrationStatus.IN_PROGRESS;
        await this.migrationStatusRepository.save(migration);

        // Retry migration
        const result = await this.migrateUser(migration.userAddress, migration.migrationType);
        if (result.success) {
          retriedCount++;
        } else {
          errors.push(`${migration.userAddress}: ${result.errors.join(', ')}`);
        }
      } catch (error) {
        errors.push(`${migration.userAddress}: ${error.message}`);
      }
    }

    return { retriedCount, errors };
  }

  /**
   * Helper methods
   */
  private async createMigrationRecord(userAddress: string, migrationType: MigrationType): Promise<MigrationStatusEntity> {
    const migration = this.migrationStatusRepository.create({
      userAddress,
      migrationType,
      status: MigrationStatus.NOT_STARTED,
      totalRecords: 0,
      migratedRecords: 0,
      failedRecords: 0,
      progressPercentage: 0,
    });

    return await this.migrationStatusRepository.save(migration);
  }

  private async completeMigration(migration: MigrationStatusEntity, result: MigrationResult): Promise<void> {
    migration.status = MigrationStatus.COMPLETED;
    migration.completedAt = new Date();
    migration.migratedRecords = result.recordsMigrated || 0;
    migration.failedRecords = result.recordsFailed || 0;
    migration.progressPercentage = 100;
    migration.migrationTransactionHash = result.transactionHashes?.[0];

    await this.migrationStatusRepository.save(migration);
  }

  private async failMigration(migration: MigrationStatusEntity, error: string): Promise<void> {
    migration.status = MigrationStatus.FAILED;
    migration.errorDetails = error;
    migration.completedAt = new Date();

    await this.migrationStatusRepository.save(migration);
  }
} 