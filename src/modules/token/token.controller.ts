import { Controller, Get, Post, Body, Query, Res } from '@nestjs/common';
import { CreateTokenDto } from './dto/create-token.dto';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CreateStakeDto } from './dto/create-stake.dto';
import { StellarService } from './stellar.service';
import { CreateAddLiquidityDto } from './dto/create-add-lp.dto';
import { UnlockAquaDto } from './dto/create-remove-lp.dto';
import { StakeBlubDto } from './dto/stake-blub.dto';
import { Asset } from '@stellar/stellar-sdk';

@ApiTags('Token')
@Controller('token')
export class TokenController {
  constructor(private readonly stellarService: StellarService) {}

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
  @ApiOperation({ summary: 'Get user public key records' })
  @ApiResponse({
    status: 201,
    description: 'Public key records not found',
  })
  getUserInfo(@Query('userPublicKey') userPublicKey: string) {
    return this.stellarService.getUser(userPublicKey);
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
  getUserStakingBalance(@Query('userPublicKey') userPublicKey: string) {
    if (!userPublicKey || userPublicKey.trim() === '') {
      throw new Error('Invalid user public key');
    }
    return this.stellarService.getUserStakingBalance(userPublicKey);
  }

  @Get('getLockedReward')
  @ApiOperation({ summary: 'Get public key locked rewards' })
  @ApiResponse({
    status: 201,
    description: 'Public key locked rewards not available',
  })
  getPublicKeyLockedRewards(@Query('userPublicKey') userPublicKey: string) {
    return this.stellarService.getPublicKeyLockedRewards(userPublicKey);
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
    await this.stellarService.unlockAqua(unlockAquaDto);
    res.send().status(200);
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
