import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

export enum MigrationStatus {
  NOT_STARTED = 'not_started',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  FAILED = 'failed',
  ROLLBACK_REQUIRED = 'rollback_required',
  ROLLBACK_COMPLETED = 'rollback_completed',
}

export enum MigrationType {
  STAKES = 'stakes',
  REWARDS = 'rewards',
  GOVERNANCE = 'governance',
  LIQUIDITY = 'liquidity',
  FULL_USER = 'full_user',
}

@Entity('migration_status')
@Index(['userAddress', 'status'])
@Index(['migrationType', 'status'])
@Index(['status', 'startedAt'])
export class MigrationStatusEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 48 })
  userAddress: string;

  @Column({
    type: 'enum',
    enum: MigrationStatus,
    default: MigrationStatus.NOT_STARTED,
  })
  status: MigrationStatus;

  @Column({
    type: 'enum',
    enum: MigrationType,
  })
  migrationType: MigrationType;

  @Column({ type: 'integer', default: 0 })
  totalRecords: number;

  @Column({ type: 'integer', default: 0 })
  migratedRecords: number;

  @Column({ type: 'integer', default: 0 })
  failedRecords: number;

  @Column({ type: 'decimal', precision: 5, scale: 2, default: 0 })
  progressPercentage: number;

  @Column({ type: 'text', nullable: true })
  migrationDetails: string;

  @Column({ type: 'text', nullable: true })
  errorDetails: string;

  @Column({ type: 'text', nullable: true })
  rollbackDetails: string;

  @CreateDateColumn()
  startedAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  completedAt: Date;

  @Column({ type: 'varchar', length: 64, nullable: true })
  migrationTransactionHash: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  rollbackTransactionHash: string;

  @Column({ type: 'text', nullable: true })
  preMigrationSnapshot: string;

  @Column({ type: 'text', nullable: true })
  postMigrationSnapshot: string;

  @Column({ type: 'boolean', default: false })
  verificationPassed: boolean;

  @Column({ type: 'text', nullable: true })
  verificationDetails: string;

  @Column({ type: 'integer', default: 0 })
  retryCount: number;
} 