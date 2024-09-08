import { Column, Entity, ManyToOne, OneToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { UserEntity } from './user.entity';

@Entity({ name: 'claimable-records' })
export class ClaimableRecordsEntity extends BaseEntity {
  @ManyToOne(() => UserEntity, (user) => user.stakes, { onDelete: 'CASCADE' })
  account: UserEntity;

  @Column()
  balanceId: string;

  @Column()
  amount: string;
}
