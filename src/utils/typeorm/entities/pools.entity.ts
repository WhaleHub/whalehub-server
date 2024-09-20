import { Column, Entity, JoinColumn, ManyToOne, OneToMany } from 'typeorm';
import { BaseEntity } from './base.entity';
import { UserEntity } from './user.entity';
import { StakeEntity } from './stake.entity';
import { ClaimableRecordsEntity } from './claimableRecords.entity';
import { DepositType } from '@/utils/models/enums';
import { LpBalanceEntity } from './lp-balances.entity';

@Entity({ name: 'pools' })
export class PoolsEntity extends BaseEntity {
  @ManyToOne(() => UserEntity, (user) => user.account)
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

  @Column()
  poolHash: string;

  @Column({ default: 10 })
  fee: number;

  @Column()
  txnHash: string;

  @Column()
  senderPublicKey: string;

  @Column({
    type: 'enum',
    enum: DepositType,
    default: DepositType.LOCKER,
  })
  depositType: DepositType;

  @OneToMany(() => LpBalanceEntity, (lpBalance) => lpBalance.account)
  lpBalances: LpBalanceEntity[];
}
