import { Column, Entity, OneToMany, OneToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { StakeEntity } from './stake.entity';

@Entity({ name: 'users' })
export class UserEntity extends BaseEntity {
  @Column({ nullable: false })
  account: string;

  @OneToOne(() => StakeEntity, (stake) => stake.account)
  stakes: StakeEntity[];
}
