import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, Index } from 'typeorm';

export enum EventType {
  LOCK_RECORDED = 'lock_recorded',
  UNLOCK_RECORDED = 'unlock_recorded',
  ICE_ISSUED = 'ice_issued',
  POL_CONTRIBUTION = 'pol_contribution',
  POL_REWARDS_CLAIMED = 'pol_rewards_claimed',
  REWARD_CLAIMED = 'reward_claimed',
  REWARD_FUNDED = 'reward_funded',
  POOL_REGISTERED = 'pool_registered',
  LIQUIDITY_RECORDED = 'liquidity_recorded',
  FEES_COLLECTED = 'fees_collected',
  GOVERNANCE_VOTE = 'governance_vote',
  ADMIN_ACTION = 'admin_action',
}

@Entity('contract_event_logs')
@Index(['contractType', 'eventType'])
@Index(['userAddress', 'eventType'])
@Index(['transactionHash'])
@Index(['timestamp'])
export class ContractEventLogEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 50 })
  contractType: string;

  @Column({
    type: 'enum',
    enum: EventType,
  })
  eventType: EventType;

  @Column({ type: 'varchar', length: 64 })
  transactionHash: string;

  @Column({ type: 'bigint' })
  ledger: number;

  @Column({ type: 'varchar', length: 48, nullable: true })
  userAddress: string;

  @Column({ type: 'text' })
  eventData: string;

  @Column({ type: 'decimal', precision: 20, scale: 7, nullable: true })
  amount: number;

  @Column({ type: 'varchar', length: 20, nullable: true })
  assetCode: string;

  @Column({ type: 'boolean', default: false })
  processed: boolean;

  @Column({ type: 'timestamp', nullable: true })
  processedAt: Date;

  @Column({ type: 'text', nullable: true })
  processedBy: string;

  @CreateDateColumn()
  timestamp: Date;

  @Column({ type: 'text', nullable: true })
  metadata: string;

  @Column({ type: 'integer', default: 0 })
  retryCount: number;

  @Column({ type: 'text', nullable: true })
  processingErrors: string;
} 