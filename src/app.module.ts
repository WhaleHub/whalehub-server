import { Module, NestModule, MiddlewareConsumer, RequestMethod } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TokenModule } from './modules/token/token.module';
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
          const dataSource = new DataSource(options as DataSourceOptions);
          return await dataSource.initialize();
        } catch (error) {
          const sqliteOptions: DataSourceOptions = {
            type: 'sqlite',
            database: ':memory:',
            entities: (options as DataSourceOptions).entities,
            synchronize: true,
            logging: false,
            name: (options as any).name || 'default',
          };
          // eslint-disable-next-line no-console
          console.warn('[TypeOrmModule] Database connection failed; automatically starting with in-memory SQLite fallback');
          const sqliteDataSource = new DataSource(sqliteOptions);
          return await sqliteDataSource.initialize();
        }
      },
    }),
    ConfigModule.forRoot({ isGlobal: true }),
    TokenModule,
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
