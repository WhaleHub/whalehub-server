import { Controller, Get, Post, Body } from '@nestjs/common';
import { CreateTokenDto } from './dto/create-token.dto';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CreateStakeDto } from './dto/create-stake.dto';
import { StellarService } from './stellar.service';

@ApiTags('Token')
@Controller('token')
export class TokenController {
  constructor(private readonly stellarService: StellarService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new token' })
  @ApiBody({
    type: CreateTokenDto,
    description: 'Data required to create a new token',
  })
  @ApiResponse({
    status: 201,
    description: 'The token has been successfully created.',
  })
  @ApiResponse({ status: 400, description: 'Invalid input, object invalid.' })
  create(@Body() createTokenDto: CreateTokenDto) {
    return this.stellarService.create(createTokenDto);
  }

  @Post('stake')
  @ApiOperation({ summary: 'Stake a new token' })
  @ApiBody({
    type: CreateStakeDto,
    description: 'Data required to stake a new token',
  })
  @ApiResponse({
    status: 201,
    description: 'The token has been successfully staked.',
  })
  @ApiResponse({ status: 400, description: 'Invalid input, object invalid.' })
  stake(@Body() createStakeDto: CreateStakeDto) {
    return this.stellarService.stake(createStakeDto);
  }
}
