import { Module } from '@nestjs/common';
import { TokenController } from './token.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserEntity } from '@/utils/typeorm/entities/user.entity';
import { StakeEntity } from '@/utils/typeorm/entities/stake.entity';
import { StellarService } from './stellar.service';
import { ClaimableRecordsEntity } from '@/utils/typeorm/entities/claimableRecords.entity';
import { SorobanService } from './soroban.service';
import { ConfigModule } from '@nestjs/config';
import { PoolsEntity } from '@/utils/typeorm/entities/pools.entity';
import { TokenEntity } from '@/utils/typeorm/entities/token.entity';
import { TreasuryDepositsEntity } from '@/utils/typeorm/entities/treasuryDeposits.entity';
import { LpBalanceEntity } from '@/utils/typeorm/entities/lp-balances.entity';
import { RewardClaimsEntity } from '@/utils/typeorm/entities/claimRecords.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      UserEntity,
      StakeEntity,
      PoolsEntity,
      TokenEntity,
      LpBalanceEntity,
      RewardClaimsEntity,
      ClaimableRecordsEntity,
      TreasuryDepositsEntity,
    ]),
    ConfigModule,
  ],
  controllers: [TokenController],
  providers: [StellarService, SorobanService],
})
export class TokenModule {}
