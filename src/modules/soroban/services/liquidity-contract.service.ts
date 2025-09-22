import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SorobanCoreService, ContractCallResult } from './soroban-core.service';
import { UserEntity } from '@/utils/typeorm/entities/user.entity';
import { PoolsEntity } from '@/utils/typeorm/entities/pools.entity';
import { LpBalanceEntity } from '@/utils/typeorm/entities/lp-balances.entity';
import { HybridUserDataEntity } from '../entities/hybrid-user-data.entity';
import { ContractEventLogEntity, EventType } from '../entities/contract-event-log.entity';
import BigNumber from 'bignumber.js';

export interface LiquidityPool {
  poolId: string;
  assetA: string;
  assetB: string;
  reserveA: string;
  reserveB: string;
  totalShares: string;
  feeRate: number;
  isActive: boolean;
}

export interface LPPosition {
  user: string;
  poolId: string;
  lpTokens: string;
  sharePercentage: string;
  assetAAmount: string;
  assetBAmount: string;
}

export interface LiquidityStats {
  totalPools: number;
  activePools: number;
  totalValueLocked: string;
  totalLpTokens: string;
  totalFees: string;
}

@Injectable()
export class LiquidityContractService {
  private readonly logger = new Logger(LiquidityContractService.name);

  constructor(
    private sorobanCore: SorobanCoreService,
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
    @InjectRepository(PoolsEntity)
    private poolsRepository: Repository<PoolsEntity>,
    @InjectRepository(LpBalanceEntity)
    private lpBalanceRepository: Repository<LpBalanceEntity>,
    @InjectRepository(HybridUserDataEntity)
    private hybridUserRepository: Repository<HybridUserDataEntity>,
    @InjectRepository(ContractEventLogEntity)
    private eventLogRepository: Repository<ContractEventLogEntity>,
  ) {}

  /**
   * Register a new liquidity pool
   */
  async registerPool(
    poolId: string,
    assetA: any,
    assetB: any,
    initialReserveA: string,
    initialReserveB: string,
    feeRate: number,
    txHash: string,
    useContract: boolean = true,
  ): Promise<ContractCallResult> {
    try {
      let contractResult: ContractCallResult = { success: true };

      if (useContract) {
        contractResult = await this.sorobanCore.callContract(
          'liquidity',
          'register_pool',
          [poolId, assetA, assetB, initialReserveA, initialReserveB, feeRate, txHash],
          true,
        );

        if (contractResult.success && contractResult.transactionHash) {
          await this.logContractEvent({
            eventType: EventType.POOL_REGISTERED,
            userAddress: 'admin',
            amount: parseFloat(initialReserveA) + parseFloat(initialReserveB),
            transactionHash: contractResult.transactionHash,
            eventData: JSON.stringify({
              poolId,
              assetA,
              assetB,
              initialReserveA,
              initialReserveB,
              feeRate,
              registrationTxHash: txHash,
            }),
          });
        }
      }

      return contractResult;
    } catch (error) {
      this.logger.error('Failed to register pool:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Record liquidity addition
   */
  async recordLiquidityAddition(
    userAddress: string,
    poolId: string,
    assetAAmount: string,
    assetBAmount: string,
    lpTokensIssued: string,
    txHash: string,
    useContract: boolean = true,
  ): Promise<ContractCallResult> {
    try {
      let contractResult: ContractCallResult = { success: true };

      if (useContract) {
        contractResult = await this.sorobanCore.callContract(
          'liquidity',
          'record_liquidity_addition',
          [userAddress, poolId, assetAAmount, assetBAmount, lpTokensIssued, txHash],
          true,
        );

        if (contractResult.success && contractResult.transactionHash) {
          await this.logContractEvent({
            eventType: EventType.LIQUIDITY_RECORDED,
            userAddress,
            amount: parseFloat(assetAAmount) + parseFloat(assetBAmount),
            transactionHash: contractResult.transactionHash,
            eventData: JSON.stringify({
              poolId,
              assetAAmount,
              assetBAmount,
              lpTokensIssued,
              liquidityTxHash: txHash,
            }),
          });
        }
      }

      // Update database records
      await this.updateLpBalance(userAddress, poolId, lpTokensIssued, 'add');

      // Update hybrid user data
      await this.updateUserLiquidityData(userAddress, {
        lpTokenBalance: parseFloat(lpTokensIssued),
        activeLpPositions: 1,
      });

      return contractResult;
    } catch (error) {
      this.logger.error('Failed to record liquidity addition:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Record liquidity removal
   */
  async recordLiquidityRemoval(
    userAddress: string,
    poolId: string,
    lpTokensToRemove: string,
    assetAReturned: string,
    assetBReturned: string,
    txHash: string,
    useContract: boolean = true,
  ): Promise<ContractCallResult> {
    try {
      let contractResult: ContractCallResult = { success: true };

      if (useContract) {
        contractResult = await this.sorobanCore.callContract(
          'liquidity',
          'record_liquidity_removal',
          [userAddress, poolId, lpTokensToRemove, assetAReturned, assetBReturned, txHash],
          true,
        );

        if (contractResult.success && contractResult.transactionHash) {
          await this.logContractEvent({
            eventType: EventType.LIQUIDITY_RECORDED,
            userAddress,
            amount: -(parseFloat(assetAReturned) + parseFloat(assetBReturned)),
            transactionHash: contractResult.transactionHash,
            eventData: JSON.stringify({
              poolId,
              lpTokensRemoved: lpTokensToRemove,
              assetAReturned,
              assetBReturned,
              removalTxHash: txHash,
            }),
          });
        }
      }

      // Update database records
      await this.updateLpBalance(userAddress, poolId, lpTokensToRemove, 'remove');

      // Update hybrid user data
      await this.updateUserLiquidityData(userAddress, {
        lpTokenBalance: -parseFloat(lpTokensToRemove),
        activeLpPositions: -1,
      });

      return contractResult;
    } catch (error) {
      this.logger.error('Failed to record liquidity removal:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get pool information
   */
  async getPool(
    poolId: string,
    useContract: boolean = true,
  ): Promise<ContractCallResult<LiquidityPool>> {
    try {
      if (useContract) {
        return await this.sorobanCore.callContract(
          'liquidity',
          'get_pool',
          [poolId],
          false,
        );
      }

      // Get from database
      const pool = await this.poolsRepository.findOne({
        where: { id: poolId },
      });

      if (!pool) {
        return { success: false, error: 'Pool not found' };
      }

      return {
        success: true,
        data: {
          poolId: pool.id.toString(),
          assetA: JSON.stringify(pool.assetA) || '',
          assetB: JSON.stringify(pool.assetB) || '',
          reserveA: pool.assetAAmount || '0',
          reserveB: pool.assetBAmount || '0',
          totalShares: '0', // Not available in current entity
          feeRate: pool.fee || 0,
          isActive: true, // Not available in current entity
        },
      };
    } catch (error) {
      this.logger.error('Failed to get pool:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get user's LP position
   */
  async getUserLpPosition(
    userAddress: string,
    poolId: string,
    useContract: boolean = true,
  ): Promise<ContractCallResult<LPPosition>> {
    try {
      if (useContract) {
        return await this.sorobanCore.callContract(
          'liquidity',
          'get_user_lp_position',
          [userAddress, poolId],
          false,
        );
      }

      // Get from database
      const lpBalance = await this.lpBalanceRepository.findOne({
        where: {
          account: { account: userAddress },
          pool: { id: poolId },
        },
        relations: ['account', 'pool'],
      });

      if (!lpBalance) {
        return {
          success: true,
          data: {
            user: userAddress,
            poolId,
            lpTokens: '0',
            sharePercentage: '0',
            assetAAmount: '0',
            assetBAmount: '0',
          },
        };
      }

      return {
        success: true,
        data: {
          user: userAddress,
          poolId,
          lpTokens: lpBalance.assetAAmount || '0', // Using assetAAmount as LP tokens
          sharePercentage: '0', // TODO: Calculate from pool data
          assetAAmount: lpBalance.assetAAmount || '0',
          assetBAmount: lpBalance.assetBAmount || '0',
        },
      };
    } catch (error) {
      this.logger.error('Failed to get user LP position:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get user's LP positions across all pools
   */
  async getUserLpPositions(
    userAddress: string,
    useContract: boolean = true,
  ): Promise<ContractCallResult<string[]>> {
    try {
      if (useContract) {
        return await this.sorobanCore.callContract(
          'liquidity',
          'get_user_pools',
          [userAddress],
          false,
        );
      }

      // Get from database
      const lpBalances = await this.lpBalanceRepository.find({
        where: {
          account: { account: userAddress },
        },
        relations: ['account', 'pool'],
      });

      const poolIds = lpBalances.map(balance => balance.pool.id);

      return {
        success: true,
        data: poolIds,
      };
    } catch (error) {
      this.logger.error('Failed to get user LP positions:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Calculate user's fee share
   */
  async calculateUserFeeShare(
    userAddress: string,
    poolId: string,
    useContract: boolean = true,
  ): Promise<ContractCallResult<string>> {
    try {
      if (useContract) {
        return await this.sorobanCore.callContract(
          'liquidity',
          'calculate_user_fee_share',
          [userAddress, poolId],
          false,
        );
      }

      // Simple calculation from database
      const lpPosition = await this.getUserLpPosition(userAddress, poolId, false);
      if (!lpPosition.success || !lpPosition.data) {
        return { success: true, data: '0' };
      }

      // Mock fee calculation (0.1% of LP tokens as fees)
      const feeShare = new BigNumber(lpPosition.data.lpTokens)
        .multipliedBy(0.001)
        .toFixed(7);

      return { success: true, data: feeShare };
    } catch (error) {
      this.logger.error('Failed to calculate user fee share:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get liquidity statistics
   */
  async getLiquidityStats(): Promise<ContractCallResult<LiquidityStats>> {
    try {
      const [poolCount, lpBalanceStats] = await Promise.all([
        this.poolsRepository.count(),
        this.lpBalanceRepository
          .createQueryBuilder('lp')
          .select([
            'COUNT(DISTINCT lp.id) as totalPositions',
            'SUM(lp.assetAAmount) as totalAssetA',
            'SUM(lp.assetBAmount) as totalAssetB',
          ])
          .getRawOne(),
      ]);

      const stats: LiquidityStats = {
        totalPools: poolCount,
        activePools: poolCount, // Assume all pools are active
        totalValueLocked: new BigNumber(lpBalanceStats.totalAssetA || '0')
          .plus(lpBalanceStats.totalAssetB || '0')
          .toFixed(7),
        totalLpTokens: lpBalanceStats.totalAssetA || '0', // Simplified
        totalFees: '0', // TODO: Calculate from fee collection events
      };

      return { success: true, data: stats };
    } catch (error) {
      this.logger.error('Failed to get liquidity stats:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Update LP balance in database
   */
  private async updateLpBalance(
    userAddress: string,
    poolId: string,
    lpTokens: string,
    operation: 'add' | 'remove',
  ): Promise<void> {
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

      // Find or create LP balance
      let lpBalance = await this.lpBalanceRepository.findOne({
        where: { account: { id: user.id }, pool: { id: poolId } },
        relations: ['account', 'pool'],
      });

      if (!lpBalance) {
        const pool = await this.poolsRepository.findOne({
          where: { id: poolId },
        });

        if (!pool) {
          throw new Error(`Pool ${poolId} not found`);
        }

        lpBalance = this.lpBalanceRepository.create({
          account: user,
          pool: pool,
          assetAAmount: '0',
          assetBAmount: '0',
          senderPublicKey: userAddress,
          depositType: 'LIQUIDITY_PROVISION' as any,
          assetA: { code: 'AQUA', issuer: '' },
          assetB: { code: 'BLUB', issuer: '' },
        });
      }

      // Update LP token balance (using assetAAmount as LP tokens)
      const currentBalance = new BigNumber(lpBalance.assetAAmount || '0');
      const changeAmount = new BigNumber(lpTokens);
      
      if (operation === 'add') {
        lpBalance.assetAAmount = currentBalance.plus(changeAmount).toFixed(7);
      } else {
        lpBalance.assetAAmount = currentBalance.minus(changeAmount).toFixed(7);
      }

      await this.lpBalanceRepository.save(lpBalance);
    } catch (error) {
      this.logger.error('Failed to update LP balance:', error);
    }
  }

  /**
   * Update user's liquidity data in hybrid storage
   */
  private async updateUserLiquidityData(
    userAddress: string,
    updates: {
      lpTokenBalance?: number;
      activeLpPositions?: number;
      lpFeesEarned?: number;
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
      if (updates.lpTokenBalance !== undefined) {
        hybridUser.lpTokenBalance = Math.max(0, (hybridUser.lpTokenBalance || 0) + updates.lpTokenBalance);
      }
      if (updates.activeLpPositions !== undefined) {
        hybridUser.activeLpPositions = Math.max(0, (hybridUser.activeLpPositions || 0) + updates.activeLpPositions);
      }
      if (updates.lpFeesEarned !== undefined) {
        hybridUser.lpFeesEarned = (hybridUser.lpFeesEarned || 0) + updates.lpFeesEarned;
      }

      hybridUser.lastContractSync = new Date();
      await this.hybridUserRepository.save(hybridUser);
    } catch (error) {
      this.logger.error('Failed to update user liquidity data:', error);
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
        contractType: 'liquidity',
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
      this.logger.error('Failed to log liquidity contract event:', error);
    }
  }

  /**
   * Simulate liquidity action
   */
  async simulateLiquidityAction(
    action: string,
    parameters: any[],
  ): Promise<ContractCallResult> {
    try {
      return await this.sorobanCore.callContract(
        'liquidity',
        action,
        parameters,
        false,
      );
    } catch (error) {
      this.logger.error('Failed to simulate liquidity action:', error);
      return { success: false, error: error.message };
    }
  }
} 