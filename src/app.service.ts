import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PoolsEntity } from './utils/typeorm/entities/pools.entity';
import { LpBalanceEntity } from './utils/typeorm/entities/lp-balances.entity';

@Injectable()
export class AppService {
  constructor(
    @InjectRepository(PoolsEntity)
    private poolRepository: Repository<PoolsEntity>,

    @InjectRepository(LpBalanceEntity)
    private lpRepository: Repository<LpBalanceEntity>,
  ) {}

  async getAppInfo() {
    const pools = await this.poolRepository.find();
    const lp_balances = await this.lpRepository.find();
    return { pools, lp_balances };
  }
}
