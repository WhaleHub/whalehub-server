import { Controller, Get, Post, Body, Query } from '@nestjs/common';
import { CreateTokenDto } from './dto/create-token.dto';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CreateStakeDto } from './dto/create-stake.dto';
import { StellarService } from './stellar.service';
import { CreateAddLiquidityDto } from './dto/create-add-lp.dto';
import { CreateRemoveLiquidityDto } from './dto/create-remove-lp.dto';

@ApiTags('Token')
@Controller('token')
export class TokenController {
  constructor(private readonly stellarService: StellarService) {}

  @Post('create')
  @ApiOperation({ summary: 'Create a new token' })
  @ApiBody({
    type: CreateTokenDto,
    description:
      'Data required to create a new token and deploy to stellar network',
  })
  @ApiResponse({
    status: 201,
    description: 'The token has been successfully created.',
  })
  @ApiResponse({ status: 400, description: 'Invalid input, object invalid.' })
  create(@Body() createTokenDto: CreateTokenDto) {
    // return this.stellarService.create(createTokenDto);
  }

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

  @Post('remove-liquidity')
  @ApiOperation({ summary: 'Remove liquidity to pool' })
  @ApiBody({
    type: CreateRemoveLiquidityDto,
    description: 'Data required to remove user tokens from pools',
  })
  @ApiResponse({
    status: 201,
    description: 'Liquidity successfully removed',
  })
  @ApiResponse({ status: 400, description: 'Invalid input, object invalid.' })
  removeLiquidity(@Body() createRemoveLiquidityDto: CreateRemoveLiquidityDto) {
    return this.stellarService.removeLiquidity(createRemoveLiquidityDto);
  }

  @Get('removeFlag')
  @ApiOperation({ summary: 'Remove flag wallet' })
  createTrustline(@Query('publicKey') publicKey: string) {
    return this.stellarService.removeFlag(publicKey);
  }
}
