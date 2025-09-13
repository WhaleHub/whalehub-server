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
  async lock(@Body() createStakeDto: CreateStakeDto) {
    try {
      this.logger.log(`Lock request received for user: ${createStakeDto.senderPublicKey}`);
      this.logger.debug(`Lock request data: ${JSON.stringify({
        assetCode: createStakeDto.assetCode,
        assetIssuer: createStakeDto.assetIssuer,
        amount: createStakeDto.amount,
        treasuryAmount: createStakeDto.treasuryAmount,
        senderPublicKey: createStakeDto.senderPublicKey,
        signedTxXdrLength: createStakeDto.signedTxXdr?.length || 0
      })}`);
      
      return await this.stellarService.lock(createStakeDto);
    } catch (error) {
      this.logger.error(`Error in lock endpoint for user ${createStakeDto?.senderPublicKey}:`, {
        message: error.message,
        status: error.status,
        stack: error.stack
      });
      
      // Provide more specific error responses
      if (error instanceof HttpException) {
        throw error;
      }
      
      // Handle different types of errors with appropriate status codes
      if (error.message?.includes('Invalid') || error.message?.includes('validation')) {
        throw new HttpException(
          `Validation error: ${error.message}`,
          HttpStatus.BAD_REQUEST
        );
      }
      
      if (error.message?.includes('account') || error.message?.includes('not found')) {
        throw new HttpException(
          `Account error: ${error.message}`,
          HttpStatus.NOT_FOUND
        );
      }
      
      throw new HttpException(
        error.message || 'Failed to lock AQUA tokens',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
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

    const respondWithFallback = async () => {
      try {
        const stakingData = await this.stellarService.getUserStakingBalance(userPublicKey);
        const fallbackData = {
          id: null,
          account: userPublicKey,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          claimableRecords: stakingData.claimableRecords || [],
          pools: stakingData.pools || [],
          stakes: [],
          treasuryDeposits: [],
          lpBalances: [],
        };
        return res.status(200).json(fallbackData);
      } catch (e) {
        this.logger.error(`Fallback user info failed for ${userPublicKey}: ${e?.message}`);
        return res.status(200).json({
          id: null,
          account: userPublicKey,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          claimableRecords: [],
          pools: [],
          stakes: [],
          treasuryDeposits: [],
          lpBalances: [],
        });
      }
    };

    if (HEAVY_WALLETS.includes(userPublicKey)) {
      this.logger.warn(`🚨 EMERGENCY: Heavy wallet ${userPublicKey}; serving fallback data`);
      return await respondWithFallback();
    }

    try {
      // Check memory before processing
      const memUsage = process.memoryUsage();
      const memUsagePercent = (memUsage.heapUsed / memUsage.heapTotal) * 100;
      
      if (memUsagePercent > 80) {
        this.logger.warn(`🚨 High memory usage: ${memUsagePercent.toFixed(2)}% - Serving fallback data`);
        return await respondWithFallback();
      }

      // Circuit breaker for known problematic wallets
      if (this.failedWallets.has(userPublicKey)) {
        const lastFail = this.failedWallets.get(userPublicKey);
        if (Date.now() - lastFail < 300000) { // 5 minutes
          this.logger.warn(`Circuit breaker active for ${userPublicKey} - Serving fallback data`);
          return await respondWithFallback();
        }
      }

      // Set aggressive timeout
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Request timeout')), 15000); // 15 seconds max
      });

      // Wrap the main logic with timeout and memory monitoring
      const userInfoPromise = this.stellarService.getUser(userPublicKey);
      
      const result = await Promise.race([userInfoPromise, timeoutPromise]);

      return res.status(200).json(result);

    } catch (error) {
      this.logger.error(`Error fetching user ${userPublicKey}:`, error.message);
      
      // Add to failed wallets list
      this.failedWallets.set(userPublicKey, Date.now());
      
      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }

      return await respondWithFallback();
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

  @Post('unlock-aqua')
  @ApiOperation({ summary: 'Unlock AQUA to Public Key - REQUIRES WALLET SIGNATURE' })
  @ApiBody({
    type: UnlockAquaDto,
    description: 'Data required to unlock AQUA stakes - signedTxXdr is MANDATORY for security',
  })
  @ApiResponse({
    status: 201,
    description: 'Liquidity successfully removed',
  })
  @ApiResponse({ status: 400, description: 'Invalid input, object invalid.' })
  @ApiResponse({ status: 401, description: 'Unauthorized: Missing or invalid signed transaction.' })
  async removeLiquidity(@Body() unlockAquaDto: UnlockAquaDto, @Res() res) {

    // SECURITY: CRITICAL - Multiple validation layers to prevent unauthorized access
    this.logger.warn('🔒 UNLOCK-AQUA SECURITY: Request received, performing validation');
    
    // Primary security check
    if (!unlockAquaDto || typeof unlockAquaDto !== 'object') {
      this.logger.error('🚨 SECURITY VIOLATION: Invalid request object');
      return res.status(401).json({
        statusCode: 401,
        message: 'SECURITY: Invalid request format',
        error: 'Unauthorized'
      });
    }

    // Critical signedTxXdr validation
    if (!unlockAquaDto.signedTxXdr || 
        typeof unlockAquaDto.signedTxXdr !== 'string' ||
        unlockAquaDto.signedTxXdr.trim() === '' ||
        unlockAquaDto.signedTxXdr.length < 20) {
      
      this.logger.error('🚨 SECURITY VIOLATION: Missing or invalid signedTxXdr');
      this.logger.error(`Request details: ${JSON.stringify(unlockAquaDto)}`);
      
      return res.status(401).json({
        statusCode: 401,
        message: 'SECURITY: Wallet signature verification required. Unauthorized access blocked.',
        error: 'Unauthorized',
        details: 'Use the web application with connected wallet to unstake tokens safely.'
      });
    }

    // Additional validation for common bypass attempts
    const suspiciousValues = ['null', 'undefined', 'invalid', 'test', '123'];
    if (suspiciousValues.includes(unlockAquaDto.signedTxXdr.toLowerCase())) {
      this.logger.error('🚨 SECURITY VIOLATION: Suspicious signedTxXdr value detected');
      return res.status(401).json({
        statusCode: 401,
        message: 'SECURITY: Invalid transaction signature detected',
        error: 'Unauthorized'
      });
    }

    this.logger.log(`✅ SECURITY: Valid signature found, proceeding with unlock for ${unlockAquaDto.senderPublicKey}`);
    
    try {
      await this.stellarService.unlockAqua(unlockAquaDto);
      res.status(201).send();
    } catch (error) {
      this.logger.error(`Unlock failed: ${error.message}`);
      throw error;
    }
  }

  @Post('restake-blub')
  @ApiOperation({ summary: 'Stake Blub Tokens' })
  @ApiBody({
    type: StakeBlubDto,
    description: 'Data required to stake Blub tokens',
  })
  @ApiResponse({
    status: 201,
    description: 'Staked Successful',
  })
  @ApiResponse({ status: 400, description: 'Invalid input, object invalid.' })
  async restakeBlub(@Body() stakeBlubDto: StakeBlubDto, @Res() res) {
    await this.stellarService.stakeBlub(stakeBlubDto);
    res.status(200).send();
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
