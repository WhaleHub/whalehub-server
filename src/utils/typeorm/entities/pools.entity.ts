import { Column, Entity, JoinColumn, OneToMany, OneToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { UserEntity } from './user.entity';
import { StakeEntity } from './stake.entity';
import { ClaimableRecordsEntity } from './claimableRecords.entity';

@Entity({ name: 'pools' })
export class PoolsEntity extends BaseEntity {
  @OneToOne(() => UserEntity, (user) => user.account)
  @JoinColumn()
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

  @Column()
  senderPublicKey: string;
}
