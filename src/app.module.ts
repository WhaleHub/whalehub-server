import { Module, NestModule, MiddlewareConsumer, RequestMethod } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TokenModule } from './modules/token/token.module';
import { SorobanModule } from './modules/soroban/soroban.module';
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

@Module({
  imports: [
    TypeOrmModule.forFeature([
      UserEntity,
      StakeEntity,
      TokenEntity,
      PoolsEntity,
      LpBalanceEntity,
      ClaimableRecordsEntity,
    ]),
    TypeOrmModule.forRootAsync({
      useFactory: async (configService: ConfigService) =>
        await typeOrmConfig(configService),
      inject: [ConfigService],
      dataSourceFactory: async (options) => {
        try {
          console.log('[TypeOrmModule] Attempting to connect to database...');
          const dataSource = new DataSource(options as DataSourceOptions);
          const initializedDataSource = await dataSource.initialize();
          console.log('[TypeOrmModule] Database connection established successfully');
          return initializedDataSource;
        } catch (error) {
          console.error('[TypeOrmModule] Database connection failed:', error);
          
          // Log detailed error information
          if (error.code === 'ECONNREFUSED') {
            console.error('[TypeOrmModule] Connection refused - Database server may not be running or accessible');
            console.error(`[TypeOrmModule] Host: ${(options as any).host}:${(options as any).port}`);
          } else if (error.code === 'ENOTFOUND') {
            console.error('[TypeOrmModule] Host not found - Check database host configuration');
          } else if (error.code === 'ECONNRESET') {
            console.error('[TypeOrmModule] Connection reset - Network or authentication issue');
          }
          
          // Re-throw the error to prevent application startup with invalid database state
          throw new Error(`Database connection failed: ${error.message}`);
        }
      },
    }),
    ConfigModule.forRoot({ isGlobal: true }),
    TokenModule,
    SorobanModule,
    ScheduleModule.forRoot(),
  ],
  controllers: [AppController],
  providers: [AppService, MemoryMonitorService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(UnlockAquaSecurityMiddleware)
      .forRoutes({ path: 'token/unlock-aqua', method: RequestMethod.POST });
  }
}
