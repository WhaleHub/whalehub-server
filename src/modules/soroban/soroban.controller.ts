import { Controller, Get, Post, Put, Body, Param, Query, HttpException, HttpStatus } from '@nestjs/common';
import { SorobanCoreService } from './services/soroban-core.service';
import { StakingContractService } from './services/staking-contract.service';
import { GovernanceContractService } from './services/governance-contract.service';
import { RewardsContractService } from './services/rewards-contract.service';
import { LiquidityContractService } from './services/liquidity-contract.service';
import { ContractSyncService } from './services/contract-sync.service';
import { TransactionService } from './services/transaction.service';
import { MigrationService } from './services/migration.service';
import { MigrationType } from './entities/migration-status.entity';

// DTOs for request/response
interface StakingRequest {
  userAddress: string;
  amount: string;
  durationDays?: number;
  txHash: string;
}

interface UnstakingRequest {
  userAddress: string;
  lockId: number;
  amount: string;
  txHash: string;
}

interface LiquidityRequest {
  userAddress: string;
  poolId: string;
  assetAAmount: string;
  assetBAmount: string;
  lpTokens: string;
  txHash: string;
}

interface RewardPoolFundingRequest {
  poolId: string;
  assetCode: string;
  amount: string;
  distributionDays: number;
  txHash: string;
}

@Controller('api/soroban')
export class SorobanController {
  constructor(
    private sorobanCore: SorobanCoreService,
    private stakingService: StakingContractService,
    private governanceService: GovernanceContractService,
    private rewardsService: RewardsContractService,
    private liquidityService: LiquidityContractService,
    private syncService: ContractSyncService,
    private transactionService: TransactionService,
    private migrationService: MigrationService,
  ) {}

  // =================
  // HEALTH & STATUS
  // =================

  @Get('health')
  async getHealthStatus() {
    try {
      const health = await this.sorobanCore.healthCheck();
      return {
        status: 'success',
        data: health,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      throw new HttpException(
        { status: 'error', message: error.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('sync/status')
  async getSyncStatus(@Query('contractType') contractType?: string) {
    try {
      const status = await this.syncService.getSyncStatus(contractType);
      return { status: 'success', data: status };
    } catch (error) {
      throw new HttpException(
        { status: 'error', message: error.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('sync/health')
  async getSyncHealth() {
    try {
      const health = await this.syncService.getSyncHealthReport();
      return { status: 'success', data: health };
    } catch (error) {
      throw new HttpException(
        { status: 'error', message: error.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // =================
  // STAKING ENDPOINTS
  // =================

  @Post('staking/lock')
  async recordAquaLock(@Body() request: StakingRequest) {
    try {
      const result = await this.stakingService.recordLock(
        request.userAddress,
        request.amount,
        request.durationDays || 0,
        request.txHash,
      );
      return { status: 'success', data: result };
    } catch (error) {
      throw new HttpException(
        { status: 'error', message: error.message },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('staking/unlock')
  async recordAquaUnlock(@Body() request: UnstakingRequest) {
    try {
      const result = await this.stakingService.recordUnlock(
        request.userAddress,
        request.lockId,
        request.amount,
        request.txHash,
      );
      return { status: 'success', data: result };
    } catch (error) {
      throw new HttpException(
        { status: 'error', message: error.message },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('staking/blub-restake')
  async recordBlubRestake(@Body() request: Omit<StakingRequest, 'durationDays'>) {
    try {
      const result = await this.stakingService.recordBlubRestake(
        request.userAddress,
        request.amount,
        request.txHash,
      );
      return { status: 'success', data: result };
    } catch (error) {
      throw new HttpException(
        { status: 'error', message: error.message },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('staking/locks/:userAddress')
  async getUserLocks(@Param('userAddress') userAddress: string) {
    try {
      const result = await this.stakingService.getUserLockInfo(userAddress);
      return { status: 'success', data: result };
    } catch (error) {
      throw new HttpException(
        { status: 'error', message: error.message },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('staking/pol')
  async getProtocolOwnedLiquidity() {
    try {
      const result = await this.stakingService.getProtocolOwnedLiquidity();
      return { status: 'success', data: result };
    } catch (error) {
      throw new HttpException(
        { status: 'error', message: error.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('staking/stats')
  async getStakingStats(@Query('userAddress') userAddress?: string) {
    try {
      const result = await this.stakingService.getStakeStats(userAddress);
      return { status: 'success', data: result };
    } catch (error) {
      throw new HttpException(
        { status: 'error', message: error.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ===================
  // GOVERNANCE ENDPOINTS
  // ===================

  @Post('governance/ice-issuance')
  async recordIceIssuance(@Body() request: {
    userAddress: string;
    aquaAmount: string;
    lockDurationDays: number;
    txHash: string;
  }) {
    try {
      const result = await this.governanceService.recordIceIssuance(
        request.userAddress,
        request.aquaAmount,
        request.lockDurationDays,
        request.txHash,
      );
      return { status: 'success', data: result };
    } catch (error) {
      throw new HttpException(
        { status: 'error', message: error.message },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('governance/user/:userAddress')
  async getUserGovernance(@Param('userAddress') userAddress: string) {
    try {
      const result = await this.governanceService.getUserGovernance(userAddress);
      return { status: 'success', data: result };
    } catch (error) {
      throw new HttpException(
        { status: 'error', message: error.message },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('governance/stats')
  async getGovernanceStats() {
    try {
      const result = await this.governanceService.getGlobalStats();
      return { status: 'success', data: result };
    } catch (error) {
      throw new HttpException(
        { status: 'error', message: error.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ================
  // REWARDS ENDPOINTS
  // ================

  @Post('rewards/fund-pool')
  async fundRewardPool(@Body() request: RewardPoolFundingRequest) {
    try {
      const result = await this.rewardsService.fundRewardPool(
        request.poolId,
        request.assetCode,
        request.amount,
        request.distributionDays,
        request.txHash,
      );
      return { status: 'success', data: result };
    } catch (error) {
      throw new HttpException(
        { status: 'error', message: error.message },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('rewards/estimate/:userAddress/:poolId')
  async estimateUserRewards(
    @Param('userAddress') userAddress: string,
    @Param('poolId') poolId: string,
  ) {
    try {
      const result = await this.rewardsService.estimateUserRewards(userAddress, poolId);
      return { status: 'success', data: result };
    } catch (error) {
      throw new HttpException(
        { status: 'error', message: error.message },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('rewards/claim')
  async claimRewards(@Body() request: {
    userAddress: string;
    poolId: string;
    amount: string;
    txHash: string;
  }) {
    try {
      const result = await this.rewardsService.claimRewards(
        request.userAddress,
        request.poolId,
        request.amount,
        request.txHash,
      );
      return { status: 'success', data: result };
    } catch (error) {
      throw new HttpException(
        { status: 'error', message: error.message },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('rewards/batch-process')
  async processBatchRewards(@Body() request: {
    poolId: string;
    userAddresses: string[];
    amounts: string[];
    txHash: string;
  }) {
    try {
      const result = await this.rewardsService.processBatchRewards(
        request.poolId,
        request.userAddresses,
        request.amounts,
        request.txHash,
      );
      return { status: 'success', data: result };
    } catch (error) {
      throw new HttpException(
        { status: 'error', message: error.message },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('rewards/user/:userAddress')
  async getUserRewards(
    @Param('userAddress') userAddress: string,
    @Query('poolId') poolId?: string,
  ) {
    try {
      const result = await this.rewardsService.getUserRewardInfo(userAddress, poolId);
      return { status: 'success', data: result };
    } catch (error) {
      throw new HttpException(
        { status: 'error', message: error.message },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('rewards/pool/:poolId')
  async getRewardPool(@Param('poolId') poolId: string) {
    try {
      const result = await this.rewardsService.getRewardPool(poolId);
      return { status: 'success', data: result };
    } catch (error) {
      throw new HttpException(
        { status: 'error', message: error.message },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('rewards/stats')
  async getRewardStats() {
    try {
      const result = await this.rewardsService.getRewardStats();
      return { status: 'success', data: result };
    } catch (error) {
      throw new HttpException(
        { status: 'error', message: error.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ===================
  // LIQUIDITY ENDPOINTS
  // ===================

  @Post('liquidity/register-pool')
  async registerPool(@Body() request: {
    poolId: string;
    assetA: any;
    assetB: any;
    initialReserveA: string;
    initialReserveB: string;
    feeRate: number;
    txHash: string;
  }) {
    try {
      const result = await this.liquidityService.registerPool(
        request.poolId,
        request.assetA,
        request.assetB,
        request.initialReserveA,
        request.initialReserveB,
        request.feeRate,
        request.txHash,
      );
      return { status: 'success', data: result };
    } catch (error) {
      throw new HttpException(
        { status: 'error', message: error.message },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('liquidity/add')
  async recordLiquidityAddition(@Body() request: LiquidityRequest) {
    try {
      const result = await this.liquidityService.recordLiquidityAddition(
        request.userAddress,
        request.poolId,
        request.assetAAmount,
        request.assetBAmount,
        request.lpTokens,
        request.txHash,
      );
      return { status: 'success', data: result };
    } catch (error) {
      throw new HttpException(
        { status: 'error', message: error.message },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('liquidity/remove')
  async recordLiquidityRemoval(@Body() request: {
    userAddress: string;
    poolId: string;
    lpTokensToRemove: string;
    assetAReturned: string;
    assetBReturned: string;
    txHash: string;
  }) {
    try {
      const result = await this.liquidityService.recordLiquidityRemoval(
        request.userAddress,
        request.poolId,
        request.lpTokensToRemove,
        request.assetAReturned,
        request.assetBReturned,
        request.txHash,
      );
      return { status: 'success', data: result };
    } catch (error) {
      throw new HttpException(
        { status: 'error', message: error.message },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('liquidity/pool/:poolId')
  async getPool(@Param('poolId') poolId: string) {
    try {
      const result = await this.liquidityService.getPool(poolId);
      return { status: 'success', data: result };
    } catch (error) {
      throw new HttpException(
        { status: 'error', message: error.message },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('liquidity/user/:userAddress/position/:poolId')
  async getUserLpPosition(
    @Param('userAddress') userAddress: string,
    @Param('poolId') poolId: string,
  ) {
    try {
      const result = await this.liquidityService.getUserLpPosition(userAddress, poolId);
      return { status: 'success', data: result };
    } catch (error) {
      throw new HttpException(
        { status: 'error', message: error.message },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('liquidity/user/:userAddress/positions')
  async getUserLpPositions(@Param('userAddress') userAddress: string) {
    try {
      const result = await this.liquidityService.getUserLpPositions(userAddress);
      return { status: 'success', data: result };
    } catch (error) {
      throw new HttpException(
        { status: 'error', message: error.message },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('liquidity/stats')
  async getLiquidityStats() {
    try {
      const result = await this.liquidityService.getLiquidityStats();
      return { status: 'success', data: result };
    } catch (error) {
      throw new HttpException(
        { status: 'error', message: error.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // =====================
  // TRANSACTION ENDPOINTS
  // =====================

  @Get('transactions/stats')
  async getTransactionStats(
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('contractType') contractType?: string,
  ) {
    try {
      const start = startDate ? new Date(startDate) : undefined;
      const end = endDate ? new Date(endDate) : undefined;
      const stats = await this.transactionService.getTransactionStats(start, end, contractType);
      return { status: 'success', data: stats };
    } catch (error) {
      throw new HttpException(
        { status: 'error', message: error.message },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('transactions/recent')
  async getRecentTransactions(
    @Query('limit') limit?: number,
    @Query('contractType') contractType?: string,
    @Query('userAddress') userAddress?: string,
  ) {
    try {
      const transactions = await this.transactionService.getRecentTransactions(
        limit || 50,
        contractType,
        userAddress,
      );
      return { status: 'success', data: transactions };
    } catch (error) {
      throw new HttpException(
        { status: 'error', message: error.message },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('transactions/:hash')
  async getTransaction(@Param('hash') hash: string) {
    try {
      const transaction = await this.transactionService.getTransactionByHash(hash);
      return { status: 'success', data: transaction };
    } catch (error) {
      throw new HttpException(
        { status: 'error', message: error.message },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('transactions/user/:userAddress')
  async getUserTransactionHistory(
    @Param('userAddress') userAddress: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    try {
      const history = await this.transactionService.getUserTransactionHistory(
        userAddress,
        page || 1,
        limit || 20,
      );
      return { status: 'success', data: history };
    } catch (error) {
      throw new HttpException(
        { status: 'error', message: error.message },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  // ===================
  // MIGRATION ENDPOINTS
  // ===================

  @Post('migration/user/:userAddress')
  async migrateUser(
    @Param('userAddress') userAddress: string,
    @Body() request: { migrationType?: MigrationType },
  ) {
    try {
      const result = await this.migrationService.migrateUser(
        userAddress,
        request.migrationType || MigrationType.FULL_USER,
      );
      return { status: 'success', data: result };
    } catch (error) {
      throw new HttpException(
        { status: 'error', message: error.message },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('migration/batch')
  async migrateBatch(@Body() request: {
    userAddresses: string[];
    migrationType?: MigrationType;
  }) {
    try {
      const result = await this.migrationService.migrateBatch(
        request.userAddresses,
        request.migrationType || MigrationType.FULL_USER,
      );
      return { status: 'success', data: result };
    } catch (error) {
      throw new HttpException(
        { status: 'error', message: error.message },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('migration/plan/:userAddress')
  async getMigrationPlan(
    @Param('userAddress') userAddress: string,
    @Query('type') migrationType?: MigrationType,
  ) {
    try {
      const plan = await this.migrationService.createUserMigrationPlan(
        userAddress,
        migrationType || MigrationType.FULL_USER,
      );
      return { status: 'success', data: plan };
    } catch (error) {
      throw new HttpException(
        { status: 'error', message: error.message },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Get('migration/status')
  async getMigrationStatus(@Query('userAddress') userAddress?: string) {
    try {
      const status = await this.migrationService.getMigrationStatus(userAddress);
      return { status: 'success', data: status };
    } catch (error) {
      throw new HttpException(
        { status: 'error', message: error.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('migration/stats')
  async getMigrationStats() {
    try {
      const stats = await this.migrationService.getMigrationStats();
      return { status: 'success', data: stats };
    } catch (error) {
      throw new HttpException(
        { status: 'error', message: error.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('migration/validate/:userAddress')
  async validateUserData(@Param('userAddress') userAddress: string) {
    try {
      const validation = await this.migrationService.validateUserData(userAddress);
      return { status: 'success', data: validation };
    } catch (error) {
      throw new HttpException(
        { status: 'error', message: error.message },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('migration/rollback/:userAddress')
  async rollbackMigration(@Param('userAddress') userAddress: string) {
    try {
      const result = await this.migrationService.rollbackMigration(userAddress);
      return { status: 'success', data: result };
    } catch (error) {
      throw new HttpException(
        { status: 'error', message: error.message },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  // ===============
  // ADMIN ENDPOINTS
  // ===============

  @Post('admin/sync/force')
  async forceSync() {
    try {
      const result = await this.syncService.forceSyncAll();
      return { status: 'success', data: result };
    } catch (error) {
      throw new HttpException(
        { status: 'error', message: error.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('admin/sync/contract/:contractType')
  async syncContract(@Param('contractType') contractType: 'staking' | 'governance' | 'rewards' | 'liquidity') {
    try {
      const result = await this.syncService.syncContractType(contractType);
      return { status: 'success', data: result };
    } catch (error) {
      throw new HttpException(
        { status: 'error', message: error.message },
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  @Post('admin/migration/retry-failed')
  async retryFailedMigrations() {
    try {
      const result = await this.migrationService.retryFailedMigrations();
      return { status: 'success', data: result };
    } catch (error) {
      throw new HttpException(
        { status: 'error', message: error.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('admin/analytics/performance')
  async getContractPerformance() {
    try {
      const performance = await this.transactionService.getContractPerformance();
      return { status: 'success', data: performance };
    } catch (error) {
      throw new HttpException(
        { status: 'error', message: error.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('admin/analytics/errors')
  async getErrorAnalysis(@Query('contractType') contractType?: string) {
    try {
      const errors = await this.transactionService.getErrorAnalysis(contractType);
      return { status: 'success', data: errors };
    } catch (error) {
      throw new HttpException(
        { status: 'error', message: error.message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
} 