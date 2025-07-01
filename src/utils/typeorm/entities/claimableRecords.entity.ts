import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { UserEntity } from './user.entity';
import { CLAIMS } from '@/utils/models/enums';

@Entity({ name: 'claimablerecords' })
@Index(['account', 'claimed'])
@Index(['claimed'])
@Index(['createdAt'])
export class ClaimableRecordsEntity extends BaseEntity {
  @ManyToOne(() => UserEntity, (user) => user.stakes, { onDelete: 'CASCADE' })
  @JoinColumn()
  account: UserEntity;

  @Column()
  balanceId: string;

  @Column()
  amount: string;

  @Column({
    type: 'enum',
    enum: CLAIMS,
    default: CLAIMS.UNCLAIMED,
  })
  claimed: CLAIMS;
}
