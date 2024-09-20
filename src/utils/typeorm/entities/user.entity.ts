import { Column, Entity, JoinColumn, OneToMany, OneToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { StakeEntity } from './stake.entity';
import { TreasuryDepositsEntity } from './treasuryDeposits.entity';
import { ClaimableRecordsEntity } from './claimableRecords.entity';
import { PoolsEntity } from './pools.entity';
import { LpBalanceEntity } from './lp-balances.entity';

@Entity({ name: 'users' })
export class UserEntity extends BaseEntity {
  @Column({ nullable: false })
  account: string;

  @OneToMany(() => StakeEntity, (stake) => stake.account)
  stakes: StakeEntity[];

  @OneToMany(() => TreasuryDepositsEntity, (treasury) => treasury.account)
  treasurydeposits: TreasuryDepositsEntity[];

  @OneToMany(
    () => ClaimableRecordsEntity,
    (claimableRecords) => claimableRecords.account,
  )
  claimableRecords: ClaimableRecordsEntity[];

  @OneToMany(() => PoolsEntity, (pools) => pools.account)
  pools: PoolsEntity[];

  @OneToMany(() => LpBalanceEntity, (lpBalance) => lpBalance.account)
  lpBalances: LpBalanceEntity[];
}
