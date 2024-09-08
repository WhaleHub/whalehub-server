import { Column, Entity, OneToMany, OneToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { StakeEntity } from './stake.entity';
import { TreasuryDepositsEntity } from './treasuryDeposits.entity';
import { ClaimableRecordsEntity } from './claimableRecords.entity';
import { PoolsEntity } from './pools.entity';

@Entity({ name: 'users' })
export class UserEntity extends BaseEntity {
  @Column({ nullable: false })
  account: string;

  @OneToOne(() => StakeEntity, (stake) => stake.account)
  stakes: StakeEntity[];

  @OneToOne(() => TreasuryDepositsEntity, (treasury) => treasury.account)
  treasurydeposits: TreasuryDepositsEntity[];

  @OneToOne(
    () => ClaimableRecordsEntity,
    (claimableRecords) => claimableRecords.account,
  )
  claimableRecords: ClaimableRecordsEntity[];

  @OneToOne(() => PoolsEntity, (stake) => stake.account)
  pools: PoolsEntity[];
}
