import { Column, Entity, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { UserEntity } from './user.entity';

@Entity({ name: 'reward_claims' })
export class RewardClaimsEntity extends BaseEntity {
  @ManyToOne(() => UserEntity, (user) => user.lpBalances)
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
  amount: number;
}
