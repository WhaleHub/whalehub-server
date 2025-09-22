import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';

export enum SyncStatus {
  PENDING = 'pending',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  FAILED = 'failed',
  PARTIAL = 'partial',
}

export enum SyncType {
  FULL_SYNC = 'full_sync',
  INCREMENTAL = 'incremental',
  USER_MIGRATION = 'user_migration',
  DATA_VALIDATION = 'data_validation',
  EMERGENCY_SYNC = 'emergency_sync',
}

@Entity('contract_sync_status')
@Index(['contractType', 'status'])
@Index(['userAddress', 'status'])
@Index(['syncType', 'status'])
export class ContractSyncStatusEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 50 })
  contractType: string;

  @Column({ type: 'varchar', length: 48, nullable: true })
  userAddress: string;

  @Column({
    type: 'enum',
    enum: SyncStatus,
    default: SyncStatus.PENDING,
  })
  status: SyncStatus;

  @Column({
    type: 'enum',
    enum: SyncType,
    default: SyncType.INCREMENTAL,
  })
  syncType: SyncType;

  @Column({ type: 'bigint', nullable: true })
  lastSyncedLedger: number;

  @Column({ type: 'varchar', length: 64, nullable: true })
  lastSyncedTransaction: string;

  @Column({ type: 'integer', default: 0 })
  recordsProcessed: number;

  @Column({ type: 'integer', default: 0 })
  recordsFailed: number;

  @Column({ type: 'decimal', precision: 5, scale: 2, default: 0 })
  progressPercentage: number;

  @Column({ type: 'text', nullable: true })
  errorDetails: string;

  @CreateDateColumn()
  startedAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  completedAt: Date;

  @Column({ type: 'text', nullable: true })
  metadata: string;

  @Column({ type: 'integer', default: 0 })
  retryCount: number;

  @Column({ type: 'timestamp', nullable: true })
  nextRetryAt: Date;
} 