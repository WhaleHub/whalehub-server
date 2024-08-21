import { Column, Entity, OneToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { UserEntity } from './user.entity';

@Entity({ name: 'user' })
export class TokenEntity extends BaseEntity {
  @OneToOne(() => UserEntity, (user) => user.account)
  account: UserEntity;
}
