import { Column, Entity, Index, JoinColumn, ManyToOne, OneToMany } from 'typeorm';
import { BaseEntity } from './base.entity';
import { UserEntity } from './user.entity';
import { StakeEntity } from './stake.entity';
import { ClaimableRecordsEntity } from './claimableRecords.entity';
import { CLAIMS, DepositType } from '@/utils/models/enums';
import { LpBalanceEntity } from './lp-balances.entity';

@Entity({ name: 'pools' })
@Index(['senderPublicKey', 'claimed', 'depositType']) // Composite index for common query pattern
@Index(['claimed']) // Index for filtering by claim status
@Index(['depositType']) // Index for filtering by deposit type
@Index(['senderPublicKey']) // Index for filtering by sender
@Index(['createdAt']) // Index for ordering by creation date
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

  @Column({
    type: 'enum',
    enum: CLAIMS,
    default: CLAIMS.UNCLAIMED,
  })
  claimed: CLAIMS;
}
