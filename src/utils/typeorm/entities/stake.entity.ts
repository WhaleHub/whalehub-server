import { Column, Entity, OneToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { UserEntity } from './user.entity';

@Entity({ name: 'user' })
export class StakeEntity extends BaseEntity {
  @OneToOne(() => UserEntity, (user) => user.account)
  account: UserEntity;

  @Column({ nullable: false })
  amount: number;
}
