import { Controller, Get, Post, Body, Query, Res } from '@nestjs/common';
import { CreateTokenDto } from './dto/create-token.dto';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CreateStakeDto } from './dto/create-stake.dto';
import { StellarService } from './stellar.service';
import { CreateAddLiquidityDto } from './dto/create-add-lp.dto';
import { UnlockAquaDto } from './dto/create-remove-lp.dto';

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
  removeLiquidity(@Body() unlockAquaDto: UnlockAquaDto, @Res() res) {
    return this.stellarService.unlockAqua(unlockAquaDto);
  }
}
