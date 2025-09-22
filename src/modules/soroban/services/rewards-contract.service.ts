import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SorobanCoreService, ContractCallResult } from './soroban-core.service';
import { UserEntity } from '@/utils/typeorm/entities/user.entity';
import { HybridUserDataEntity } from '../entities/hybrid-user-data.entity';
import { ContractEventLogEntity, EventType } from '../entities/contract-event-log.entity';
import BigNumber from 'bignumber.js';

export interface RewardPool {
  poolId: string;
  assetCode: string;
  totalFunded: string;
  dailyDistribution: string;
  startDate: number;
  endDate: number;
  isActive: boolean;
}

export interface UserRewardInfo {
  user: string;
  poolId: string;
  claimableRewards: string;
  totalClaimed: string;
  lastClaimTimestamp: number;
  rewardShare: string;
}

export interface RewardStats {
  totalPools: number;
  activePools: number;
  totalFunded: string;
  totalClaimed: string;
  dailyDistribution: string;
}

@Injectable()
export class RewardsContractService {
  private readonly logger = new Logger(RewardsContractService.name);

  constructor(
    private sorobanCore: SorobanCoreService,
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
    @InjectRepository(HybridUserDataEntity)
    private hybridUserRepository: Repository<HybridUserDataEntity>,
    @InjectRepository(ContractEventLogEntity)
    private eventLogRepository: Repository<ContractEventLogEntity>,
  ) {}

  /**
   * Fund a reward pool
   */
  async fundRewardPool(
    poolId: string,
    assetCode: string,
    amount: string,
    distributionDays: number,
    txHash: string,
    useContract: boolean = true,
  ): Promise<ContractCallResult> {
    try {
      const dailyDistribution = new BigNumber(amount)
        .dividedBy(distributionDays)
        .toFixed(7);

      let contractResult: ContractCallResult = { success: true };

      if (useContract) {
        contractResult = await this.sorobanCore.callContract(
          'rewards',
          'fund_reward_pool',
          [poolId, assetCode, amount, distributionDays, txHash],
          true,
        );

        if (contractResult.success && contractResult.transactionHash) {
          await this.logContractEvent({
            eventType: EventType.REWARD_FUNDED,
            userAddress: 'admin',
            amount: parseFloat(amount),
            transactionHash: contractResult.transactionHash,
            eventData: JSON.stringify({
              poolId,
              assetCode,
              distributionDays,
              dailyDistribution,
              fundingTxHash: txHash,
            }),
          });
        }
      }

      return contractResult;
    } catch (error) {
      this.logger.error('Failed to fund reward pool:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Estimate user rewards
   */
  async estimateUserRewards(
    userAddress: string,
    poolId: string,
    useContract: boolean = true,
  ): Promise<ContractCallResult<string>> {
    try {
      if (useContract) {
        return await this.sorobanCore.callContract(
          'rewards',
          'estimate_user_rewards',
          [userAddress, poolId],
          false,
        );
      }

      // Fallback calculation from hybrid data
      const hybridUser = await this.hybridUserRepository.findOne({
        where: { userAddress },
      });

      if (!hybridUser) {
        return { success: true, data: '0' };
      }

      // Simple estimation based on user's staking position
      const estimatedRewards = new BigNumber(hybridUser.totalStakedAqua)
        .multipliedBy(0.001) // 0.1% daily reward estimation
        .toFixed(7);

      return { success: true, data: estimatedRewards };
    } catch (error) {
      this.logger.error('Failed to estimate user rewards:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Process batch rewards
   */
  async processBatchRewards(
    poolId: string,
    userAddresses: string[],
    amounts: string[],
    txHash: string,
    useContract: boolean = true,
  ): Promise<ContractCallResult> {
    try {
      let contractResult: ContractCallResult = { success: true };

      if (useContract) {
        contractResult = await this.sorobanCore.callContract(
          'rewards',
          'process_batch_rewards',
          [poolId, userAddresses, amounts, txHash],
          true,
        );

        if (contractResult.success && contractResult.transactionHash) {
          await this.logContractEvent({
            eventType: EventType.REWARD_CLAIMED,
            userAddress: 'batch',
            amount: amounts.reduce((sum, amt) => sum + parseFloat(amt), 0),
            transactionHash: contractResult.transactionHash,
            eventData: JSON.stringify({
              poolId,
              userCount: userAddresses.length,
              batchTxHash: txHash,
            }),
          });
        }
      }

      // Update hybrid user data for each user
      for (let i = 0; i < userAddresses.length; i++) {
        await this.updateUserRewardData(userAddresses[i], {
          claimableRewards: -parseFloat(amounts[i]),
          totalRewardsClaimed: parseFloat(amounts[i]),
          lifetimeRewards: parseFloat(amounts[i]),
        });
      }

      return contractResult;
    } catch (error) {
      this.logger.error('Failed to process batch rewards:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Claim rewards for a user
   */
  async claimRewards(
    userAddress: string,
    poolId: string,
    amount: string,
    txHash: string,
    useContract: boolean = true,
  ): Promise<ContractCallResult> {
    try {
      let contractResult: ContractCallResult = { success: true };

      if (useContract) {
        contractResult = await this.sorobanCore.callContract(
          'rewards',
          'claim_rewards',
          [userAddress, poolId, amount, txHash],
          true,
        );

        if (contractResult.success && contractResult.transactionHash) {
          await this.logContractEvent({
            eventType: EventType.REWARD_CLAIMED,
            userAddress,
            amount: parseFloat(amount),
            transactionHash: contractResult.transactionHash,
            eventData: JSON.stringify({
              poolId,
              claimTxHash: txHash,
            }),
          });
        }
      }

      // Update hybrid user data
      await this.updateUserRewardData(userAddress, {
        claimableRewards: -parseFloat(amount),
        totalRewardsClaimed: parseFloat(amount),
        lifetimeRewards: parseFloat(amount),
      });

      return contractResult;
    } catch (error) {
      this.logger.error('Failed to claim rewards:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get user reward information
   */
  async getUserRewardInfo(
    userAddress: string,
    poolId?: string,
    useContract: boolean = true,
  ): Promise<ContractCallResult<UserRewardInfo | UserRewardInfo[]>> {
    try {
      if (useContract) {
        const method = poolId ? 'get_user_reward_info' : 'get_user_all_rewards';
        const args = poolId ? [userAddress, poolId] : [userAddress];
        
        return await this.sorobanCore.callContract(
          'rewards',
          method,
          args,
          false,
        );
      }

      // Fallback to hybrid data
      const hybridUser = await this.hybridUserRepository.findOne({
        where: { userAddress },
      });

      if (!hybridUser) {
        const emptyInfo: UserRewardInfo = {
          user: userAddress,
          poolId: poolId || 'default',
          claimableRewards: '0',
          totalClaimed: '0',
          lastClaimTimestamp: 0,
          rewardShare: '0',
        };
        return { success: true, data: emptyInfo };
      }

      const userInfo: UserRewardInfo = {
        user: userAddress,
        poolId: poolId || 'default',
        claimableRewards: hybridUser.claimableRewards.toString(),
        totalClaimed: hybridUser.totalRewardsClaimed.toString(),
        lastClaimTimestamp: hybridUser.updatedAt ? Math.floor(hybridUser.updatedAt.getTime() / 1000) : 0,
        rewardShare: '0', // TODO: Calculate based on staking position
      };

      return { success: true, data: userInfo };
    } catch (error) {
      this.logger.error('Failed to get user reward info:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get reward pool information
   */
  async getRewardPool(
    poolId: string,
    useContract: boolean = true,
  ): Promise<ContractCallResult<RewardPool>> {
    try {
      if (useContract) {
        return await this.sorobanCore.callContract(
          'rewards',
          'get_reward_pool',
          [poolId],
          false,
        );
      }

      // Mock pool info since we don't have pool storage in current schema
      const mockPool: RewardPool = {
        poolId,
        assetCode: 'AQUA',
        totalFunded: '0',
        dailyDistribution: '0',
        startDate: Math.floor(Date.now() / 1000),
        endDate: Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60), // 30 days
        isActive: true,
      };

      return { success: true, data: mockPool };
    } catch (error) {
      this.logger.error('Failed to get reward pool:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get reward statistics
   */
  async getRewardStats(useContract: boolean = true): Promise<ContractCallResult<RewardStats>> {
    try {
      if (useContract) {
        return await this.sorobanCore.callContract(
          'rewards',
          'get_global_stats',
          [],
          false,
        );
      }

      // Calculate from hybrid data
      const stats = await this.hybridUserRepository
        .createQueryBuilder('hybrid')
        .select([
          'SUM(hybrid.claimableRewards) as totalClaimable',
          'SUM(hybrid.totalRewardsClaimed) as totalClaimed',
          'SUM(hybrid.lifetimeRewards) as totalLifetime',
          'COUNT(DISTINCT hybrid.userAddress) as totalUsers',
        ])
        .getRawOne();

      const rewardStats: RewardStats = {
        totalPools: 1, // Mock value
        activePools: 1, // Mock value
        totalFunded: stats.totalLifetime || '0',
        totalClaimed: stats.totalClaimed || '0',
        dailyDistribution: '1000', // Mock daily distribution
      };

      return { success: true, data: rewardStats };
    } catch (error) {
      this.logger.error('Failed to get reward stats:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Update user's reward data in hybrid storage
   */
  private async updateUserRewardData(
    userAddress: string,
    updates: {
      claimableRewards?: number;
      totalRewardsClaimed?: number;
      lifetimeRewards?: number;
    },
  ): Promise<void> {
    try {
      let hybridUser = await this.hybridUserRepository.findOne({
        where: { userAddress },
      });

      if (!hybridUser) {
        hybridUser = this.hybridUserRepository.create({
          userAddress,
          primaryDataSource: 'hybrid' as any,
        });
      }

      // Apply updates
      if (updates.claimableRewards !== undefined) {
        hybridUser.claimableRewards = Math.max(0, (hybridUser.claimableRewards || 0) + updates.claimableRewards);
      }
      if (updates.totalRewardsClaimed !== undefined) {
        hybridUser.totalRewardsClaimed = (hybridUser.totalRewardsClaimed || 0) + updates.totalRewardsClaimed;
      }
      if (updates.lifetimeRewards !== undefined) {
        hybridUser.lifetimeRewards = (hybridUser.lifetimeRewards || 0) + updates.lifetimeRewards;
      }

      hybridUser.lastContractSync = new Date();
      await this.hybridUserRepository.save(hybridUser);
    } catch (error) {
      this.logger.error('Failed to update user reward data:', error);
    }
  }

  /**
   * Log contract event
   */
  private async logContractEvent(eventData: {
    eventType: EventType;
    userAddress: string;
    amount: number;
    transactionHash: string;
    eventData: string;
  }): Promise<void> {
    try {
      const event = this.eventLogRepository.create({
        contractType: 'rewards',
        eventType: eventData.eventType,
        userAddress: eventData.userAddress,
        amount: eventData.amount,
        transactionHash: eventData.transactionHash,
        eventData: eventData.eventData,
        ledger: 0,
        processed: false,
      });

      await this.eventLogRepository.save(event);
    } catch (error) {
      this.logger.error('Failed to log rewards contract event:', error);
    }
  }

  /**
   * Simulate reward action
   */
  async simulateRewardAction(
    action: string,
    parameters: any[],
  ): Promise<ContractCallResult> {
    try {
      return await this.sorobanCore.callContract(
        'rewards',
        action,
        parameters,
        false,
      );
    } catch (error) {
      this.logger.error('Failed to simulate reward action:', error);
      return { success: false, error: error.message };
    }
  }
} 