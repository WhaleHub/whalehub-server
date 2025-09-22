import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SorobanCoreService } from './soroban-core.service';
import { StakingContractService } from './staking-contract.service';
import { GovernanceContractService } from './governance-contract.service';
import { RewardsContractService } from './rewards-contract.service';
import { LiquidityContractService } from './liquidity-contract.service';
import { UserEntity } from '@/utils/typeorm/entities/user.entity';
import { StakeEntity } from '@/utils/typeorm/entities/stake.entity';
import { ContractSyncStatusEntity, SyncStatus, SyncType } from '../entities/contract-sync-status.entity';
import { HybridUserDataEntity } from '../entities/hybrid-user-data.entity';

export interface SyncResult {
  success: boolean;
  recordsProcessed: number;
  recordsFailed: number;
  message: string;
  details?: any;
}

@Injectable()
export class ContractSyncService {
  private readonly logger = new Logger(ContractSyncService.name);
  private isSyncing = false;

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
    @InjectRepository(ContractSyncStatusEntity)
    private syncStatusRepository: Repository<ContractSyncStatusEntity>,
    @InjectRepository(HybridUserDataEntity)
    private hybridUserRepository: Repository<HybridUserDataEntity>,
  ) {}

  /**
   * Sync all contracts (scheduled task)
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async scheduledSync(): Promise<void> {
    if (this.isSyncing) {
      this.logger.warn('Sync already in progress, skipping scheduled sync');
      return;
    }

    this.logger.log('Starting scheduled contract synchronization');
    await this.syncAllContracts();
  }

  /**
   * Sync all contracts
   */
  async syncAllContracts(): Promise<SyncResult> {
    if (this.isSyncing) {
      return {
        success: false,
        recordsProcessed: 0,
        recordsFailed: 0,
        message: 'Sync already in progress',
      };
    }

    this.isSyncing = true;
    
    try {
      const results = await Promise.allSettled([
        this.syncContractType('staking'),
        this.syncContractType('governance'),
        this.syncContractType('rewards'),
        this.syncContractType('liquidity'),
      ]);

      let totalProcessed = 0;
      let totalFailed = 0;
      const failedContracts = [];

      results.forEach((result, index) => {
        const contractTypes = ['staking', 'governance', 'rewards', 'liquidity'];
        const contractType = contractTypes[index];

        if (result.status === 'fulfilled') {
          totalProcessed += result.value.recordsProcessed;
          totalFailed += result.value.recordsFailed;
        } else {
          this.logger.error(`Failed to sync ${contractType}:`, result.reason);
          failedContracts.push(contractType);
          totalFailed++;
        }
      });

      return {
        success: failedContracts.length === 0,
        recordsProcessed: totalProcessed,
        recordsFailed: totalFailed,
        message: failedContracts.length === 0 
          ? 'All contracts synced successfully'
          : `Failed to sync: ${failedContracts.join(', ')}`,
        details: { failedContracts },
      };
    } catch (error) {
      this.logger.error('Error during contract sync:', error);
      return {
        success: false,
        recordsProcessed: 0,
        recordsFailed: 1,
        message: `Sync failed: ${error.message}`,
      };
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Sync specific contract type
   */
  async syncContractType(contractType: 'staking' | 'governance' | 'rewards' | 'liquidity'): Promise<SyncResult> {
    const syncRecord = await this.createSyncRecord(contractType, SyncType.INCREMENTAL);
    
    try {
      await this.updateSyncStatus(syncRecord.id, SyncStatus.IN_PROGRESS);

      const users = await this.userRepository.find({
        select: ['account'],
      });

      let processedCount = 0;
      let failedCount = 0;

      for (const user of users) {
        try {
          const userSync = await this.syncUser(user.account, contractType);
          if (userSync.success) {
            processedCount++;
          } else {
            failedCount++;
          }
        } catch (error) {
          this.logger.error(`Failed to sync user ${user.account} for ${contractType}:`, error);
          failedCount++;
        }
      }

      await this.completeSyncRecord(syncRecord.id, processedCount, failedCount);

      return {
        success: failedCount === 0,
        recordsProcessed: processedCount,
        recordsFailed: failedCount,
        message: `${contractType} sync completed: ${processedCount} processed, ${failedCount} failed`,
      };
    } catch (error) {
      await this.failSyncRecord(syncRecord.id, error.message);
      throw error;
    }
  }

  /**
   * Force sync all users for all contracts
   */
  async forceSyncAll(): Promise<SyncResult> {
    const syncRecord = await this.createSyncRecord('all', SyncType.FULL_SYNC);

    try {
      await this.updateSyncStatus(syncRecord.id, SyncStatus.IN_PROGRESS);

      const users = await this.userRepository.find({
        select: ['account'],
      });

      let processedCount = 0;
      let failedCount = 0;

      for (const user of users) {
        try {
          const userSync = await this.syncUser(user.account);
          if (userSync.success) {
            processedCount++;
          } else {
            failedCount++;
          }
        } catch (error) {
          this.logger.error(`Failed to sync user ${user.account}:`, error);
          failedCount++;
        }
      }

      await this.completeSyncRecord(syncRecord.id, processedCount, failedCount);

      return {
        success: failedCount === 0,
        recordsProcessed: processedCount,
        recordsFailed: failedCount,
        message: `Force sync completed: ${processedCount} processed, ${failedCount} failed`,
      };
    } catch (error) {
      await this.failSyncRecord(syncRecord.id, error.message);
      throw error;
    }
  }

  /**
   * Sync specific user across all contracts
   */
  async syncUser(
    userAddress: string, 
    specificContract?: 'staking' | 'governance' | 'rewards' | 'liquidity'
  ): Promise<SyncResult> {
    try {
      const contracts = specificContract 
        ? [specificContract] 
        : ['staking' as const, 'governance' as const, 'rewards' as const, 'liquidity' as const];
      const results = [];

      for (const contractType of contracts) {
        try {
          const result = await this.syncUserContract(userAddress, contractType);
          results.push(result);
        } catch (error) {
          this.logger.error(`Failed to sync ${userAddress} for ${contractType}:`, error);
          results.push({ success: false, error: error.message });
        }
      }

      const successCount = results.filter(r => r.success).length;
      const failedCount = results.length - successCount;

      return {
        success: failedCount === 0,
        recordsProcessed: successCount,
        recordsFailed: failedCount,
        message: `User sync completed: ${successCount} successful, ${failedCount} failed`,
      };
    } catch (error) {
      this.logger.error(`Failed to sync user ${userAddress}:`, error);
      return {
        success: false,
        recordsProcessed: 0,
        recordsFailed: 1,
        message: error.message,
      };
    }
  }

  /**
   * Sync user data for specific contract
   */
  private async syncUserContract(
    userAddress: string,
    contractType: 'staking' | 'governance' | 'rewards' | 'liquidity'
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    try {
      switch (contractType) {
        case 'staking':
          const stakingData = await this.syncUserStaking(userAddress);
          return { success: true, data: stakingData };

        case 'governance':
          const governanceData = await this.syncUserGovernance(userAddress);
          return { success: true, data: governanceData };

        case 'rewards':
          const rewardsData = await this.syncUserRewards(userAddress);
          return { success: true, data: rewardsData };

        case 'liquidity':
          const liquidityData = await this.syncUserLiquidity(userAddress);
          return { success: true, data: liquidityData };

        default:
          throw new Error(`Unknown contract type: ${contractType}`);
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Sync user staking data
   */
  private async syncUserStaking(userAddress: string): Promise<any> {
    // Get data from both contract and database
    const [contractData, dbData] = await Promise.all([
      this.stakingService.getUserLockInfo(userAddress, true),
      this.stakeRepository.find({
        where: { account: { account: userAddress } },
        relations: ['account'],
      }),
    ]);

    // Update hybrid user data
    await this.updateHybridUserData(userAddress, {
      totalStakedAqua: dbData.reduce((sum, stake) => sum + parseFloat(stake.amount), 0),
      activeStakeCount: dbData.length,
      lastDbSync: new Date(),
      lastContractSync: contractData.success ? new Date() : null,
    });

    return { contractData, dbData };
  }

  /**
   * Sync user governance data
   */
  private async syncUserGovernance(userAddress: string): Promise<any> {
    const contractData = await this.governanceService.getUserGovernance(userAddress, true);
    
    if (contractData.success && contractData.data) {
      await this.updateHybridUserData(userAddress, {
        iceTokenBalance: parseFloat(contractData.data.iceAmount),
        votingPower: parseFloat(contractData.data.votingPower),
        lastContractSync: new Date(),
      });
    }

    return contractData;
  }

  /**
   * Sync user rewards data
   */
  private async syncUserRewards(userAddress: string): Promise<any> {
    const contractData = await this.rewardsService.getUserRewardInfo(userAddress, undefined, true);
    
    if (contractData.success && contractData.data) {
      const rewardInfo = Array.isArray(contractData.data) ? contractData.data[0] : contractData.data;
      
      await this.updateHybridUserData(userAddress, {
        claimableRewards: parseFloat(rewardInfo?.claimableRewards || '0'),
        totalRewardsClaimed: parseFloat(rewardInfo?.totalClaimed || '0'),
        lastContractSync: new Date(),
      });
    }

    return contractData;
  }

  /**
   * Sync user liquidity data
   */
  private async syncUserLiquidity(userAddress: string): Promise<any> {
    const contractData = await this.liquidityService.getUserLpPositions(userAddress, true);
    
    if (contractData.success && contractData.data) {
      await this.updateHybridUserData(userAddress, {
        activeLpPositions: contractData.data.length,
        lastContractSync: new Date(),
      });
    }

    return contractData;
  }

  /**
   * Update hybrid user data
   */
  private async updateHybridUserData(
    userAddress: string,
    updates: Partial<HybridUserDataEntity>
  ): Promise<void> {
    try {
      let hybridUser = await this.hybridUserRepository.findOne({
        where: { userAddress },
      });

      if (!hybridUser) {
        hybridUser = this.hybridUserRepository.create({
          userAddress,
          primaryDataSource: 'hybrid' as any,
          ...updates,
        });
      } else {
        Object.assign(hybridUser, updates);
      }

      hybridUser.syncRequired = false;
      await this.hybridUserRepository.save(hybridUser);
    } catch (error) {
      this.logger.error(`Failed to update hybrid user data for ${userAddress}:`, error);
    }
  }

  /**
   * Create sync record
   */
  private async createSyncRecord(contractType: string, syncType: SyncType): Promise<ContractSyncStatusEntity> {
    const syncRecord = this.syncStatusRepository.create({
      contractType,
      syncType,
      status: SyncStatus.PENDING,
      recordsProcessed: 0,
      recordsFailed: 0,
      progressPercentage: 0,
    });

    return await this.syncStatusRepository.save(syncRecord);
  }

  /**
   * Update sync status
   */
  private async updateSyncStatus(syncId: string, status: SyncStatus, progress?: number): Promise<void> {
    await this.syncStatusRepository.update(syncId, {
      status,
      progressPercentage: progress || 0,
    });
  }

  /**
   * Complete sync record
   */
  private async completeSyncRecord(syncId: string, processed: number, failed: number): Promise<void> {
    await this.syncStatusRepository.update(syncId, {
      status: failed === 0 ? SyncStatus.COMPLETED : SyncStatus.PARTIAL,
      recordsProcessed: processed,
      recordsFailed: failed,
      progressPercentage: 100,
      completedAt: new Date(),
    });
  }

  /**
   * Fail sync record
   */
  private async failSyncRecord(syncId: string, error: string): Promise<void> {
    await this.syncStatusRepository.update(syncId, {
      status: SyncStatus.FAILED,
      errorDetails: error,
      completedAt: new Date(),
    });
  }

  /**
   * Get sync status
   */
  async getSyncStatus(contractType?: string): Promise<ContractSyncStatusEntity[]> {
    const query = this.syncStatusRepository
      .createQueryBuilder('sync')
      .orderBy('sync.startedAt', 'DESC')
      .limit(50);

    if (contractType) {
      query.where('sync.contractType = :contractType', { contractType });
    }

    return await query.getMany();
  }

  /**
   * Get sync health report
   */
  async getSyncHealthReport(): Promise<{
    overall: string;
    contracts: Record<string, { status: string; lastSync: Date | null; issues: string[] }>;
    recommendations: string[];
  }> {
    const contracts = ['staking', 'governance', 'rewards', 'liquidity'];
    const report = {
      overall: 'healthy',
      contracts: {} as any,
      recommendations: [] as string[],
    };

    for (const contractType of contracts) {
      const latestSync = await this.syncStatusRepository.findOne({
        where: { contractType },
        order: { startedAt: 'DESC' },
      });

      const issues = [];
      let status = 'healthy';

      if (!latestSync) {
        status = 'unknown';
        issues.push('No sync records found');
      } else {
        if (latestSync.status === SyncStatus.FAILED) {
          status = 'failed';
          issues.push(`Last sync failed: ${latestSync.errorDetails}`);
        } else if (latestSync.recordsFailed > 0) {
          status = 'partial';
          issues.push(`${latestSync.recordsFailed} records failed in last sync`);
        }

        // Check if sync is stale (older than 1 hour)
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
        if (latestSync.completedAt && latestSync.completedAt < oneHourAgo) {
          status = 'stale';
          issues.push('Sync data is stale (older than 1 hour)');
        }
      }

      report.contracts[contractType] = {
        status,
        lastSync: latestSync?.completedAt || null,
        issues,
      };

      if (status !== 'healthy') {
        report.overall = 'degraded';
      }
    }

    // Generate recommendations
    if (report.overall !== 'healthy') {
      report.recommendations.push('Run force sync to resolve sync issues');
    }

    const failedContracts = Object.entries(report.contracts)
      .filter(([_, data]: [string, any]) => data.status === 'failed')
      .map(([contract]) => contract);

    if (failedContracts.length > 0) {
      report.recommendations.push(`Check ${failedContracts.join(', ')} contract connectivity`);
    }

    return report;
  }
} 