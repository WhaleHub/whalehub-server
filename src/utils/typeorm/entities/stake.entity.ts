import { Column, Entity, ManyToOne, OneToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { UserEntity } from './user.entity';

@Entity({ name: 'stakes' })
export class StakeEntity extends BaseEntity {
  @ManyToOne(() => UserEntity, (user) => user.stakes, { onDelete: 'CASCADE' })
  account: UserEntity;

  @Column()
  amount: number;
}
