import { Column, Entity, JoinColumn, OneToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { UserEntity } from './user.entity';

@Entity({ name: 'tokens' })
export class TokenEntity extends BaseEntity {
  @OneToOne(() => UserEntity, (user) => user.account, { onDelete: 'CASCADE' })
  @JoinColumn()
  account: UserEntity;

  @Column()
  code: string;

  @Column()
  issuer: string;

  @Column()
  sacAddress: string;
}
