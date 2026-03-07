import {
  Module,
  NestModule,
  MiddlewareConsumer,
  RequestMethod,
  Controller,
  Post,
  Get,
} from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TokenModule } from './modules/token/token.module';
import { CronModule } from './modules/cron/cron.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserEntity } from './utils/typeorm/entities/user.entity';
import { StakeEntity } from './utils/typeorm/entities/stake.entity';
import { TokenEntity } from './utils/typeorm/entities/token.entity';
import { typeOrmConfig } from './config/typeOrm.config';
import { ClaimableRecordsEntity } from './utils/typeorm/entities/claimableRecords.entity';
import { PoolsEntity } from './utils/typeorm/entities/pools.entity';
import { LpBalanceEntity } from './utils/typeorm/entities/lp-balances.entity';
import { ScheduleModule } from '@nestjs/schedule';
import { MemoryMonitorService } from './helpers/memory-monitor.service';
import { UnlockAquaSecurityMiddleware } from './middleware/unlock-aqua-security.middleware';
import { DataSource, DataSourceOptions } from 'typeorm';

// Import ICE locking, Vault compound, and Staking reward services
import { IceLockingService } from './modules/cron/ice-locking.service';
import { VaultCompoundService } from './modules/cron/vault-compound.service';
import { StakingRewardService } from './modules/cron/staking-reward.service';

// Test controller for manual trigger of cron services
@Controller('test')
class TestController {
  constructor(
    private readonly iceLockingService: IceLockingService,
    private readonly vaultCompoundService: VaultCompoundService,
    private readonly stakingRewardService: StakingRewardService,
  ) {}

  @Post('ice-locking')
  async triggerIceLocking() {
    console.log('[TestController] Manually triggering ICE locking...');
    await this.iceLockingService.handleDailyIceLocking();
    return { message: 'ICE locking completed' };
  }

  @Post('vault-compound')
  async triggerVaultCompound() {
    console.log('[TestController] Manually triggering vault compound...');
    await this.vaultCompoundService.handleVaultCompound();
    return { message: 'Vault compound completed' };
  }

  @Post('staking-reward')
  async triggerStakingReward() {
    console.log(
      '[TestController] Manually triggering staking reward distribution...',
    );
    const result = await this.stakingRewardService.manualTrigger();
    return result;
  }

  @Post('pol-deposit')
  async triggerPolDeposit() {
    console.log('[TestController] Manually triggering POL deposit...');
    const result = await this.stakingRewardService.manualPolDeposit();
    return result;
  }

  @Get('staking-reward/status')
  async getStakingRewardStatus() {
    return await this.stakingRewardService.getRewardStatus();
  }

  @Get('health')
  health() {
    return { status: 'ok', time: new Date().toISOString() };
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    // TypeOrmModule.forFeature([
    //   UserEntity,
    //   StakeEntity,
    //   TokenEntity,
    //   PoolsEntity,
    //   LpBalanceEntity,
    //   ClaimableRecordsEntity,
    // ]),
    // TypeOrmModule.forRootAsync({
    //   useFactory: async (configService: ConfigService) =>
    //     await typeOrmConfig(configService),
    //   inject: [ConfigService],
    //   dataSourceFactory: async (options) => {
    //     try {
    //       console.log('[TypeOrmModule] Attempting to connect to database...');
    //       const dataSource = new DataSource(options as DataSourceOptions);
    //       const initializedDataSource = await dataSource.initialize();
    //       console.log(
    //         '[TypeOrmModule] Database connection established successfully',
    //       );
    //       return initializedDataSource;
    //     } catch (error) {
    //       console.error('[TypeOrmModule] Database connection failed:', error);
    //       throw new Error(`Database connection failed: ${error.message}`);
    //     }
    //   },
    // }),
    // TokenModule,
    CronModule,
  ],
  controllers: [AppController, TestController],
  providers: [
    AppService,
    MemoryMonitorService,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(UnlockAquaSecurityMiddleware)
      .forRoutes({ path: 'token/unlock-aqua', method: RequestMethod.POST });
  }
}
