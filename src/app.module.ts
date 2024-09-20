import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TokenModule } from './modules/token/token.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserEntity } from './utils/typeorm/entities/user.entity';
import { TokenEntity } from './utils/typeorm/entities/token.entity';
import { typeOrmConfig } from './config/typeOrm.config';
import { TreasuryDepositsEntity } from './utils/typeorm/entities/treasuryDeposits.entity';
import { ClaimableRecordsEntity } from './utils/typeorm/entities/claimableRecords.entity';
import { PoolsEntity } from './utils/typeorm/entities/pools.entity';
import { LpBalanceEntity } from './utils/typeorm/entities/lp-balances.entity';
import { ScheduleModule } from '@nestjs/schedule';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      UserEntity,
      TokenEntity,
      TreasuryDepositsEntity,
      ClaimableRecordsEntity,
      PoolsEntity,
      LpBalanceEntity,
    ]),
    TypeOrmModule.forRootAsync({
      useFactory: async (configService: ConfigService) =>
        await typeOrmConfig(configService),
      inject: [ConfigService],
    }),
    ConfigModule.forRoot({ isGlobal: true }),
    TokenModule,
    ScheduleModule.forRoot(),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
