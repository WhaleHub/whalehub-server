import { Column, Entity, OneToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { UserEntity } from './user.entity';

@Entity({ name: 'pools' })
export class PoolsEntity extends BaseEntity {
  @OneToOne(() => UserEntity, (user) => user.account)
  account: UserEntity;

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

  @Column({ default: 10 })
  fee: number;

  @Column()
  txnHash: string;

  @Column()
  poolHash: string;
}
