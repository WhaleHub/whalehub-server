import { Column, Entity, JoinColumn, ManyToOne, OneToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { UserEntity } from './user.entity';
import { PoolsEntity } from './pools.entity';

@Entity({ name: 'stakes' })
export class StakeEntity extends BaseEntity {
  @ManyToOne(() => UserEntity, (user) => user.stakes, { onDelete: 'CASCADE' })
  @JoinColumn()
  account: UserEntity;

  @Column()
  amount: string;

  @OneToOne(() => StakeEntity, (stakes) => stakes.pools)
  pools: StakeEntity[];

  // @OneToOne(() => PoolsEntity, (pool) => pool.stakes)
  // @JoinColumn()
  // pool: PoolsEntity;
}
