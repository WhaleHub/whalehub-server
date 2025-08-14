import { Controller, Get, Post, Body, Query, Res, HttpStatus, HttpException } from '@nestjs/common';
import { CreateTokenDto } from './dto/create-token.dto';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CreateStakeDto } from './dto/create-stake.dto';
import { StellarService } from './stellar.service';
import { CreateAddLiquidityDto } from './dto/create-add-lp.dto';
import { UnlockAquaDto } from './dto/create-remove-lp.dto';
import { StakeBlubDto } from './dto/stake-blub.dto';
import { Asset } from '@stellar/stellar-sdk';
import { MemoryMonitorService } from '../../helpers/memory-monitor.service';
import { Response } from 'express';
import { Logger } from '@nestjs/common';

@ApiTags('Token')
@Controller('token')
export class TokenController {
  private failedWallets = new Map<string, number>(); // Circuit breaker for problematic wallets
  private lastCleanup = Date.now();
  private readonly logger = new Logger(TokenController.name);

  constructor(
    private readonly stellarService: StellarService,
    private readonly memoryMonitorService: MemoryMonitorService
  ) {}

  @Post('lock')
  @ApiOperation({ summary: 'Lock AQUA tokens' })
  @ApiBody({
    type: CreateStakeDto,
    description: 'Data required to lock AQUA',
  })
  @ApiResponse({
    status: 201,
    description: 'Aqua locked successfully',
  })
  @ApiResponse({ status: 400, description: 'Invalid input, object invalid.' })
  lock(@Body() createStakeDto: CreateStakeDto) {
    return this.stellarService.lock(createStakeDto);
  }

  @Post('add-liquidity')
  @ApiOperation({ summary: 'Add liquidity to pools' })
  @ApiBody({
    type: CreateAddLiquidityDto,
    description: 'Data required to add liquidity to pools',
  })
  @ApiResponse({
    status: 201,
    description: 'Liquidity added successfully.',
  })
  @ApiResponse({ status: 400, description: 'Invalid input, object invalid.' })
  addLiquidity(@Body() createAddLiquidityDto: CreateAddLiquidityDto) {
    return this.stellarService.addLiquidity(createAddLiquidityDto);
  }

  @Get('user')
  @ApiOperation({ summary: 'Get user information' })
  @ApiResponse({ status: 200, description: 'User information retrieved successfully' })
  @ApiResponse({ status: 502, description: 'Bad Gateway - Heavy wallet detected' })
  async getUserInfo(@Query('userPublicKey') userPublicKey: string, @Res() res: Response) {
    // EMERGENCY: Block known heavy wallets immediately to prevent crashes
    const HEAVY_WALLETS = [
      'GCKTMO57VPZIOMFW47ZHXNWARPQRO4UGNNLHVFSEKDB2XKC74ZP4EKXD',
      // Add other problematic wallets here
    ];

    if (HEAVY_WALLETS.includes(userPublicKey)) {
      this.logger.warn(`🚨 EMERGENCY: Blocking heavy wallet ${userPublicKey} to prevent server crash`);
      return res.status(503).json({
        error: 'Service temporarily unavailable for this wallet',
        message: 'This wallet has extensive transaction history. Please try again later.',
        code: 'HEAVY_WALLET_BLOCKED',
        userPublicKey
      });
    }

    try {
      // Check memory before processing
      const memUsage = process.memoryUsage();
      const memUsagePercent = (memUsage.heapUsed / memUsage.heapTotal) * 100;
      
      if (memUsagePercent > 80) {
        this.logger.warn(`🚨 High memory usage: ${memUsagePercent.toFixed(2)}% - Blocking requests`);
        return res.status(503).json({
          error: 'Server under high memory load',
          message: 'Please try again in a few minutes',
          code: 'MEMORY_PROTECTION'
        });
      }

      // Monitor memory usage during processing
      const startMemory = process.memoryUsage().heapUsed;
      
      // Circuit breaker for known problematic wallets
      if (this.failedWallets.has(userPublicKey)) {
        const lastFail = this.failedWallets.get(userPublicKey);
        if (Date.now() - lastFail < 300000) { // 5 minutes
          this.logger.warn(`Circuit breaker active for ${userPublicKey}`);
          return res.status(503).json({
            error: 'Circuit breaker active',
            message: 'This wallet is temporarily blocked due to previous failures',
            code: 'CIRCUIT_BREAKER_ACTIVE'
          });
        }
      }

      // Set aggressive timeout
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Request timeout')), 15000); // 15 seconds max
      });

      // Wrap the main logic with timeout and memory monitoring
      const userInfoPromise = this.stellarService.getUser(userPublicKey);
      
      const result = await Promise.race([userInfoPromise, timeoutPromise]);

      // Check memory after processing
      const endMemory = process.memoryUsage().heapUsed;
      const memoryIncrease = endMemory - startMemory;
      
      if (memoryIncrease > 50 * 1024 * 1024) { // 50MB increase
        this.logger.warn(`Large memory increase detected: ${memoryIncrease / 1024 / 1024}MB for wallet ${userPublicKey}`);
        this.failedWallets.set(userPublicKey, Date.now());
      }

      return res.status(200).json(result);

    } catch (error) {
      this.logger.error(`Error fetching user ${userPublicKey}:`, error.message);
      
      // Add to failed wallets list
      this.failedWallets.set(userPublicKey, Date.now());
      
      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }

      if (error.message.includes('timeout') || error.message.includes('memory')) {
        return res.status(503).json({
          error: 'Service temporarily unavailable',
          message: 'Request timed out or exceeded memory limits',
          code: 'TIMEOUT_OR_MEMORY'
        });
      }

      return res.status(502).json({
        error: 'Bad Gateway',
        message: 'Unable to process request for this wallet',
        code: 'PROCESSING_ERROR'
      });
    }
  }

  @Get('user/staking-balance')
  @ApiOperation({ summary: 'Get user staking balance data (optimized for wallets with many transactions)' })
  @ApiResponse({
    status: 200,
    description: 'Staking balance data retrieved successfully',
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid user public key',
  })
  async getUserStakingBalance(@Query('userPublicKey') userPublicKey: string) {
    try {
      if (!userPublicKey || userPublicKey.trim() === '') {
        return {
          error: 'Invalid user public key',
          claimableRecords: [],
          pools: []
        };
      }
      const result = await this.stellarService.getUserStakingBalance(userPublicKey);
      return result;
    } catch (error) {
      console.error(`Error fetching staking balance for ${userPublicKey}:`, error);
      return {
        error: 'Failed to fetch staking balance',
        claimableRecords: [],
        pools: []
      };
    }
  }

  @Get('getLockedReward')
  @ApiOperation({ summary: 'Get public key locked rewards' })
  @ApiResponse({
    status: 200,
    description: 'Locked rewards retrieved successfully',
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid user public key',
  })
  async getPublicKeyLockedRewards(@Query('userPublicKey') userPublicKey: string) {
    try {
      if (!userPublicKey || userPublicKey.trim() === '') {
        return {
          error: 'Invalid user public key',
          lockedAquaRewardEstimation: '0.0000000'
        };
      }
      const result = await this.stellarService.getPublicKeyLockedRewards(userPublicKey);
      return result;
    } catch (error) {
      console.error(`Error fetching locked rewards for ${userPublicKey}:`, error);
      return {
        error: 'Failed to fetch locked rewards',
        lockedAquaRewardEstimation: '0.0000000'
      };
    }
  }

  @Get('auth/challenge')
  @ApiOperation({ summary: 'Issue a wallet ownership challenge (SEP-10 style)' })
  @ApiResponse({ status: 200, description: 'Returns a challenge transaction XDR to be signed by the wallet' })
  async getAuthChallenge(@Query('account') account: string) {
    if (!account) {
      throw new HttpException('Missing account', HttpStatus.BAD_REQUEST);
    }
    return await this.stellarService.createAuthChallenge(account);
  }

  @Post('unlock-aqua')
  @ApiOperation({ summary: 'Unlock AQUA to Public Key' })
  @ApiBody({
    type: UnlockAquaDto,
    description: 'Data required to unlock AQUA stakes',
  })
  @ApiResponse({
    status: 201,
    description: 'Liquidity successfully removed',
  })
  @ApiResponse({ status: 400, description: 'Invalid input, object invalid.' })
  async removeLiquidity(@Body() unlockAquaDto: UnlockAquaDto, @Res() res) {
    await this.stellarService.verifyAuthChallenge(unlockAquaDto.senderPublicKey, unlockAquaDto.signedChallengeXdr);
    await this.stellarService.unlockAqua(unlockAquaDto);
    res.status(200).send();
  }

  @Post('restake-blub')
  @ApiOperation({ summary: 'Stake Blub Tokens' })
  @ApiBody({
    type: UnlockAquaDto,
    description: 'Data required to stake Blub tokens',
  })
  @ApiResponse({
    status: 201,
    description: 'Staked Successful',
  })
  @ApiResponse({ status: 400, description: 'Invalid input, object invalid.' })
  async restakeBlub(@Body() stakeBlubDto: StakeBlubDto, @Res() res) {
    await this.stellarService.stakeBlub(stakeBlubDto);
    res.send().status(200);
  }

  @Post('issuer')
  async Issuer() {
    return await this.stellarService.assetIssuer();
  }

  @Post('establish-trust')
  async establishTrust() {
    return await this.stellarService.establishTrust();
  }

  @Get('set-stellar')
  async setStellar() {
    return await this.stellarService.setStellarAddress();
  }

  // @Post('transfer')
  // async transfer() {
  //   console.log(this.stellarService.lpSignerKeypair.publicKey());
  //   return await this.stellarService.transferAsset(
  //     this.stellarService.issuerKeypair,
  //     this.stellarService.lpSignerKeypair.publicKey(),
  //     '1',
  //     new Asset('BLUB', this.stellarService.issuerKeypair.publicKey()),
  //   );
  // }
}
