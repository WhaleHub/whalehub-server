import { Module } from '@nestjs/common';
import { TokenController } from './token.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserEntity } from '@/utils/typeorm/entities/user.entity';
import { StakeEntity } from '@/utils/typeorm/entities/stake.entity';
import { StellarService } from './stellar.service';

@Module({
  imports: [TypeOrmModule.forFeature([UserEntity, StakeEntity])],
  controllers: [TokenController],
  providers: [StellarService],
})
export class TokenModule {}
