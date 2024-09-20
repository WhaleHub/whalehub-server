import { Column, Entity, JoinColumn, ManyToOne, OneToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { UserEntity } from './user.entity';
import { PoolsEntity } from './pools.entity';

@Entity({ name: 'lp_balance' })
export class LpBalanceEntity extends BaseEntity {
  @ManyToOne(() => UserEntity, (user) => user.lpBalances)
  @JoinColumn()
  account: UserEntity;

  @ManyToOne(() => PoolsEntity, (pool) => pool.lpBalances)
  @JoinColumn()
  pool: PoolsEntity;

  @Column('jsonb')
  assetA: {
    code: string;
    issuer: string;
  };

  @Column('jsonb')
  assetB: {
    code: string;
    issuer: string;
  };

  @Column()
  assetAAmount: string;

  @Column()
  assetBAmount: string;

  @Column()
  senderPublicKey: string;
}
