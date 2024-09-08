import { Column, Entity, JoinColumn, OneToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { UserEntity } from './user.entity';

@Entity({ name: 'treasurydeposits' })
export class TreasuryDepositsEntity extends BaseEntity {
  @OneToOne(() => UserEntity, (user) => user.account, { onDelete: 'CASCADE' })
  @JoinColumn()
  account: UserEntity;

  @Column({ nullable: true })
  amount: string;
}
