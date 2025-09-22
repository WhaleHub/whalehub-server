import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

export enum DataSource {
  DATABASE = 'database',
  CONTRACT = 'contract',
  HYBRID = 'hybrid',
}

@Entity('hybrid_user_data')
@Index(['userAddress'])
@Index(['dataSource'])
@Index(['isActive'])
export class HybridUserDataEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 48, unique: true })
  userAddress: string;

  @Column({
    type: 'enum',
    enum: DataSource,
    default: DataSource.DATABASE,
  })
  primaryDataSource: DataSource;

  @Column({ type: 'boolean', default: true })
  isActive: boolean;

  @Column({ type: 'boolean', default: false })
  isMigrated: boolean;

  // Staking data
  @Column({ type: 'decimal', precision: 20, scale: 7, default: 0 })
  totalStakedAqua: number;

  @Column({ type: 'decimal', precision: 20, scale: 7, default: 0 })
  totalStakedBlub: number;

  @Column({ type: 'integer', default: 0 })
  activeStakeCount: number;

  @Column({ type: 'decimal', precision: 20, scale: 7, default: 0 })
  polContribution: number;

  // Governance data
  @Column({ type: 'decimal', precision: 20, scale: 7, default: 0 })
  iceTokenBalance: number;

  @Column({ type: 'decimal', precision: 20, scale: 7, default: 0 })
  votingPower: number;

  @Column({ type: 'integer', default: 0 })
  governanceParticipation: number;

  // Rewards data
  @Column({ type: 'decimal', precision: 20, scale: 7, default: 0 })
  claimableRewards: number;

  @Column({ type: 'decimal', precision: 20, scale: 7, default: 0 })
  totalRewardsClaimed: number;

  @Column({ type: 'decimal', precision: 20, scale: 7, default: 0 })
  lifetimeRewards: number;

  // Liquidity data
  @Column({ type: 'decimal', precision: 20, scale: 7, default: 0 })
  lpTokenBalance: number;

  @Column({ type: 'decimal', precision: 20, scale: 7, default: 0 })
  lpFeesEarned: number;

  @Column({ type: 'integer', default: 0 })
  activeLpPositions: number;

  // Sync status
  @Column({ type: 'timestamp', nullable: true })
  lastDbSync: Date;

  @Column({ type: 'timestamp', nullable: true })
  lastContractSync: Date;

  @Column({ type: 'boolean', default: true })
  syncRequired: boolean;

  @Column({ type: 'text', nullable: true })
  syncErrors: string;

  // Data validation
  @Column({ type: 'boolean', default: false })
  dataValidated: boolean;

  @Column({ type: 'timestamp', nullable: true })
  lastValidation: Date;

  @Column({ type: 'text', nullable: true })
  validationErrors: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @Column({ type: 'text', nullable: true })
  metadata: string;
} 