import { Module } from '@nestjs/common';
import { TokenService } from './token.service';
import { TokenController } from './token.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserEntity } from '@/utils/typeorm/entities/user.entity';
import { StakeEntity } from '@/utils/typeorm/entities/stake.entity';

@Module({
  imports: [TypeOrmModule.forFeature([UserEntity, StakeEntity])],
  controllers: [TokenController],
  providers: [TokenService],
})
export class TokenModule {}
