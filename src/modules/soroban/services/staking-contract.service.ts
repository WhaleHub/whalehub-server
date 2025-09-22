import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SorobanCoreService, ContractCallResult } from './soroban-core.service';
import { UserEntity } from '@/utils/typeorm/entities/user.entity';
import { StakeEntity } from '@/utils/typeorm/entities/stake.entity';
import { HybridUserDataEntity } from '../entities/hybrid-user-data.entity';
import { ContractEventLogEntity, EventType } from '../entities/contract-event-log.entity';
import BigNumber from 'bignumber.js';

export interface LockInfo {
  user: string;
  amount: string;
  lockTimestamp: number;
  durationDays: number;
  rewardMultiplier: number;
  txHash: string;
  polContributed: string;
  isActive: boolean;
}

export interface StakeStats {
  totalStakes: number;
  activeStakes: number;
  totalAmount: string;
  activeAmount: string;
  polContribution: string;
}

export interface PolInfo {
  totalAqua: string;
  totalBlub: string;
  lpPosition: string;
  rewardsEarned: string;
  iceVotingPower: string;
}

@Injectable()
export class StakingContractService {
  private readonly logger = new Logger(StakingContractService.name);

  constructor(
    private sorobanCore: SorobanCoreService,
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
    @InjectRepository(StakeEntity)
    private stakeRepository: Repository<StakeEntity>,
    @InjectRepository(HybridUserDataEntity)
    private hybridUserRepository: Repository<HybridUserDataEntity>,
    @InjectRepository(ContractEventLogEntity)
    private eventLogRepository: Repository<ContractEventLogEntity>,
  ) {}

  /**
   * Record AQUA lock with POL contribution
   */
  async recordLock(
    userAddress: string,
    amount: string,
    durationDays: number,
    txHash: string,
    useContract: boolean = true,
  ): Promise<ContractCallResult> {
    try {
      // Calculate POL contribution (10% of locked AQUA)
      const polContribution = new BigNumber(amount).multipliedBy(0.1).toFixed(7);
      const rewardMultiplier = this.calculateRewardMultiplier(durationDays);

      let contractResult: ContractCallResult = { success: true };

      // Record in contract if enabled
      if (useContract) {
        contractResult = await this.sorobanCore.callContract(
          'staking',
          'record_lock',
          [
            userAddress,
            amount,
            durationDays,
            rewardMultiplier,
            txHash,
          ],
          true,
        );

        if (contractResult.success && contractResult.transactionHash) {
          // Log lock event
          await this.logContractEvent({
            eventType: EventType.LOCK_RECORDED,
            userAddress,
            amount: parseFloat(amount),
            transactionHash: contractResult.transactionHash,
            eventData: JSON.stringify({
              durationDays,
              polContribution,
              rewardMultiplier,
              originalTxHash: txHash,
            }),
          });

          // Log POL contribution event
          await this.logContractEvent({
            eventType: EventType.POL_CONTRIBUTION,
            userAddress,
            amount: parseFloat(polContribution),
            transactionHash: contractResult.transactionHash,
            eventData: JSON.stringify({
              aquaLocked: amount,
              contributionPercentage: 10,
            }),
          });
        }
      }

      // Store in database
      await this.createStakeRecord(userAddress, amount, durationDays, txHash, rewardMultiplier, polContribution);

      // Update hybrid user data
      await this.updateUserStakingData(userAddress, {
        totalStakedAqua: parseFloat(amount),
        activeStakeCount: 1,
        polContribution: parseFloat(polContribution),
      });

      return contractResult;
    } catch (error) {
      this.logger.error('Failed to record AQUA lock:', error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Record AQUA unlock
   */
  async recordUnlock(
    userAddress: string,
    lockId: number,
    amount: string,
    txHash: string,
    useContract: boolean = true,
  ): Promise<ContractCallResult> {
    try {
      let contractResult: ContractCallResult = { success: true };

      // Record unlock in contract
      if (useContract) {
        contractResult = await this.sorobanCore.callContract(
          'staking',
          'record_unlock',
          [userAddress, lockId, amount, txHash],
          true,
        );

        if (contractResult.success && contractResult.transactionHash) {
          // Log unlock event
          await this.logContractEvent({
            eventType: EventType.UNLOCK_RECORDED,
            userAddress,
            amount: parseFloat(amount),
            transactionHash: contractResult.transactionHash,
            eventData: JSON.stringify({
              lockId,
              originalTxHash: txHash,
            }),
          });
        }
      }

      // Update database record - mark as unlocked
      const stakeRecord = await this.stakeRepository.findOne({
        where: { id: lockId.toString(), account: { account: userAddress } },
        relations: ['account'],
      });

      if (stakeRecord) {
        // Note: Current entity doesn't have isWithdrawn field, so we might delete or leave as is
        await this.stakeRepository.save(stakeRecord);
      }

      // Update hybrid user data
      await this.updateUserStakingData(userAddress, {
        totalStakedAqua: -parseFloat(amount),
        activeStakeCount: -1,
      });

      return contractResult;
    } catch (error) {
      this.logger.error('Failed to record AQUA unlock:', error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Record BLUB restake
   */
  async recordBlubRestake(
    userAddress: string,
    amount: string,
    txHash: string,
    useContract: boolean = true,
  ): Promise<ContractCallResult> {
    try {
      let contractResult: ContractCallResult = { success: true };

      // Record in contract
      if (useContract) {
        contractResult = await this.sorobanCore.callContract(
          'staking',
          'record_blub_restake',
          [userAddress, amount, txHash],
          true,
        );

        if (contractResult.success && contractResult.transactionHash) {
          // Log restake event
          await this.logContractEvent({
            eventType: EventType.LOCK_RECORDED,
            userAddress,
            amount: parseFloat(amount),
            transactionHash: contractResult.transactionHash,
            eventData: JSON.stringify({
              stakeType: 'BLUB',
              originalTxHash: txHash,
            }),
          });
        }
      }

      // Store BLUB stake in database
      await this.createBlubStakeRecord(userAddress, amount, txHash);

      // Update hybrid user data
      await this.updateUserStakingData(userAddress, {
        totalStakedBlub: parseFloat(amount),
        activeStakeCount: 1,
      });

      return contractResult;
    } catch (error) {
      this.logger.error('Failed to record BLUB restake:', error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Record POL rewards claimed
   */
  async recordPolRewards(
    aquaRewards: string,
    blubRewards: string,
    distributionTxHash: string,
    useContract: boolean = true,
  ): Promise<ContractCallResult> {
    try {
      let contractResult: ContractCallResult = { success: true };

      if (useContract) {
        contractResult = await this.sorobanCore.callContract(
          'staking',
          'record_pol_rewards',
          [aquaRewards, blubRewards, distributionTxHash],
          true,
        );

        if (contractResult.success && contractResult.transactionHash) {
          // Log POL rewards event
          await this.logContractEvent({
            eventType: EventType.POL_REWARDS_CLAIMED,
            userAddress: 'system',
            amount: parseFloat(aquaRewards) + parseFloat(blubRewards),
            transactionHash: contractResult.transactionHash,
            eventData: JSON.stringify({
              aquaRewards,
              blubRewards,
              distributionTxHash,
            }),
          });
        }
      }

      return contractResult;
    } catch (error) {
      this.logger.error('Failed to record POL rewards:', error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Get user's lock information
   */
  async getUserLockInfo(
    userAddress: string,
    useContract: boolean = true,
  ): Promise<ContractCallResult<LockInfo[]>> {
    try {
      if (useContract) {
        // Try contract first
        const contractResult = await this.sorobanCore.callContract(
          'staking',
          'get_user_locks',
          [userAddress],
          false,
        );

        if (contractResult.success) {
          return contractResult;
        }
      }

      // Fallback to database
      const stakes = await this.stakeRepository.find({
        where: { 
          account: { account: userAddress },
        },
        relations: ['account'],
        order: { createdAt: 'DESC' },
      });

      const lockInfo: LockInfo[] = stakes.map(stake => ({
        user: userAddress,
        amount: stake.amount.toString(),
        lockTimestamp: Math.floor(stake.createdAt.getTime() / 1000),
        durationDays: 0, // Current entity doesn't have duration
        rewardMultiplier: this.calculateRewardMultiplier(0),
        txHash: '', // Current entity doesn't have txHash
        polContributed: new BigNumber(stake.amount.toString()).multipliedBy(0.1).toFixed(7),
        isActive: true, // Assume active since no isWithdrawn field
      }));

      return { success: true, data: lockInfo };
    } catch (error) {
      this.logger.error('Failed to get user lock info:', error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Get Protocol Owned Liquidity information
   */
  async getProtocolOwnedLiquidity(useContract: boolean = true): Promise<ContractCallResult<PolInfo>> {
    try {
      if (useContract) {
        return await this.sorobanCore.callContract(
          'staking',
          'get_protocol_owned_liquidity',
          [],
          false,
        );
      }

      // Calculate from database
      const totalStakes = await this.stakeRepository
        .createQueryBuilder('stake')
        .select('SUM(stake.amount)', 'totalAqua')
        .getRawOne();

      const totalPolContribution = new BigNumber(totalStakes.totalAqua || '0')
        .multipliedBy(0.1)
        .toFixed(7);

      return {
        success: true,
        data: {
          totalAqua: totalPolContribution,
          totalBlub: '0', // TODO: Calculate from BLUB stakes
          lpPosition: '0', // TODO: Calculate LP position
          rewardsEarned: '0', // TODO: Calculate from rewards
          iceVotingPower: '0', // TODO: Calculate from governance
        },
      };
    } catch (error) {
      this.logger.error('Failed to get POL info:', error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Get staking statistics
   */
  async getStakeStats(userAddress?: string): Promise<ContractCallResult<StakeStats>> {
    try {
      const query = this.stakeRepository.createQueryBuilder('stake')
        .leftJoin('stake.account', 'account');

      if (userAddress) {
        query.where('account.account = :userAddress', { userAddress });
      }

      const [totalStakes, totalAmount] = await Promise.all([
        query.getCount(),
        query.select('SUM(stake.amount)', 'total').getRawOne(),
      ]);

      return {
        success: true,
        data: {
          totalStakes,
          activeStakes: totalStakes, // Assume all are active
          totalAmount: totalAmount.total || '0',
          activeAmount: totalAmount.total || '0',
          polContribution: new BigNumber(totalAmount.total || '0').multipliedBy(0.1).toFixed(7),
        },
      };
    } catch (error) {
      this.logger.error('Failed to get stake stats:', error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  /**
   * Create stake record in database
   */
  private async createStakeRecord(
    userAddress: string,
    amount: string,
    durationDays: number,
    txHash: string,
    rewardMultiplier: number,
    polContribution: string,
  ): Promise<boolean> {
    try {
      // Find or create user
      let user = await this.userRepository.findOne({
        where: { account: userAddress },
      });

      if (!user) {
        user = this.userRepository.create({
          account: userAddress,
        });
        user = await this.userRepository.save(user);
      }

      // Create stake record (simplified to match current entity)
      const stake = this.stakeRepository.create({
        account: user,
        amount: amount,
      });

      await this.stakeRepository.save(stake);
      return true;
    } catch (error) {
      this.logger.error('Failed to create stake record:', error);
      return false;
    }
  }

  /**
   * Create BLUB stake record
   */
  private async createBlubStakeRecord(
    userAddress: string,
    amount: string,
    txHash: string,
  ): Promise<boolean> {
    try {
      // Find or create user
      let user = await this.userRepository.findOne({
        where: { account: userAddress },
      });

      if (!user) {
        user = this.userRepository.create({
          account: userAddress,
        });
        user = await this.userRepository.save(user);
      }

      // Create BLUB stake record
      const stake = this.stakeRepository.create({
        account: user,
        amount: amount,
      });

      await this.stakeRepository.save(stake);
      return true;
    } catch (error) {
      this.logger.error('Failed to create BLUB stake record:', error);
      return false;
    }
  }

  /**
   * Calculate reward multiplier based on lock duration
   */
  private calculateRewardMultiplier(durationDays: number): number {
    // Base multiplier is 1.0 (10000 basis points)
    // Max multiplier is 2.0 for 365 days
    const maxDuration = 365;
    const baseMultiplier = 1.0;
    const maxBonus = 1.0;
    
    const durationMultiplier = Math.min(durationDays / maxDuration, 1);
    return baseMultiplier + (maxBonus * durationMultiplier);
  }

  /**
   * Update user's staking data in hybrid storage
   */
  private async updateUserStakingData(
    userAddress: string,
    updates: {
      totalStakedAqua?: number;
      totalStakedBlub?: number;
      activeStakeCount?: number;
      polContribution?: number;
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

      // Apply updates (additive for amounts)
      if (updates.totalStakedAqua !== undefined) {
        hybridUser.totalStakedAqua = (hybridUser.totalStakedAqua || 0) + updates.totalStakedAqua;
      }
      if (updates.totalStakedBlub !== undefined) {
        hybridUser.totalStakedBlub = (hybridUser.totalStakedBlub || 0) + updates.totalStakedBlub;
      }
      if (updates.activeStakeCount !== undefined) {
        hybridUser.activeStakeCount = (hybridUser.activeStakeCount || 0) + updates.activeStakeCount;
      }
      if (updates.polContribution !== undefined) {
        hybridUser.polContribution = (hybridUser.polContribution || 0) + updates.polContribution;
      }

      hybridUser.lastContractSync = new Date();
      await this.hybridUserRepository.save(hybridUser);
    } catch (error) {
      this.logger.error('Failed to update user staking data:', error);
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
        contractType: 'staking',
        eventType: eventData.eventType,
        userAddress: eventData.userAddress,
        amount: eventData.amount,
        transactionHash: eventData.transactionHash,
        eventData: eventData.eventData,
        ledger: 0, // TODO: Get actual ledger number
        processed: false,
      });

      await this.eventLogRepository.save(event);
    } catch (error) {
      this.logger.error('Failed to log staking contract event:', error);
    }
  }

  /**
   * Simulate staking action
   */
  async simulateStakingAction(
    action: string,
    parameters: any[],
  ): Promise<ContractCallResult> {
    try {
      return await this.sorobanCore.callContract(
        'staking',
        action,
        parameters,
        false, // Read-only simulation
      );
    } catch (error) {
      this.logger.error('Failed to simulate staking action:', error);
      return {
        success: false,
        error: error.message,
      };
    }
  }
} 