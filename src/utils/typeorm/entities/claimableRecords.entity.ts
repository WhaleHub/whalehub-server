import { Column, Entity, JoinColumn, ManyToOne, OneToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { UserEntity } from './user.entity';
import { PoolsEntity } from './pools.entity';

@Entity({ name: 'claimablerecords' })
export class ClaimableRecordsEntity extends BaseEntity {
  @ManyToOne(() => UserEntity, (user) => user.stakes, { onDelete: 'CASCADE' })
  @JoinColumn()
  account: UserEntity;

  @Column()
  balanceId: string;

  @Column()
  amount: string;

  // @OneToOne(() => PoolsEntity, (pool) => pool.stakes)
  // @JoinColumn()
  // pool: PoolsEntity;
}
