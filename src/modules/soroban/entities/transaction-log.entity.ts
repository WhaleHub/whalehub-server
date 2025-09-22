import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm';

@Entity('transaction_logs')
@Index(['contractType', 'timestamp'])
@Index(['transactionHash'])
@Index(['success', 'timestamp'])
export class TransactionLogEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 50 })
  contractType: string;

  @Column({ type: 'varchar', length: 100 })
  method: string;

  @Column({ type: 'text', nullable: true })
  args: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  transactionHash: string;

  @Column({ type: 'bigint', nullable: true })
  ledger: number;

  @Column({ type: 'boolean', default: false })
  success: boolean;

  @Column({ type: 'text', nullable: true })
  result: string;

  @Column({ type: 'text', nullable: true })
  error: string;

  @Column({ type: 'varchar', length: 48, nullable: true })
  userAddress: string;

  @Column({ type: 'decimal', precision: 20, scale: 7, nullable: true })
  gasUsed: number;

  @Column({ type: 'decimal', precision: 20, scale: 7, nullable: true })
  feeCharged: number;

  @CreateDateColumn()
  timestamp: Date;

  @Column({ type: 'text', nullable: true })
  metadata: string;
} 