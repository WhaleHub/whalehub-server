import { Column, Entity, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { UserEntity } from './user.entity';
import { CLAIMS } from '@/utils/models/enums';

@Entity({ name: 'claimablerecords' })
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
