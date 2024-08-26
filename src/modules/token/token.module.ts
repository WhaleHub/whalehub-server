import { Module } from '@nestjs/common';
import { TokenController } from './token.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserEntity } from '@/utils/typeorm/entities/user.entity';
import { StakeEntity } from '@/utils/typeorm/entities/stake.entity';
import { StellarService } from './stellar.service';
import { ClaimableRecordsEntity } from '@/utils/typeorm/entities/claimableRecords.entity';
import { SorobanService } from './soroban.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([UserEntity, StakeEntity, ClaimableRecordsEntity]),
  ],
  controllers: [TokenController],
  providers: [StellarService, SorobanService],
})
export class TokenModule {}
