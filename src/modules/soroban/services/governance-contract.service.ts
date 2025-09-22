import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SorobanCoreService, ContractCallResult } from './soroban-core.service';
import { UserEntity } from '@/utils/typeorm/entities/user.entity';
import { HybridUserDataEntity } from '../entities/hybrid-user-data.entity';
import { ContractEventLogEntity, EventType } from '../entities/contract-event-log.entity';
import BigNumber from 'bignumber.js';

export interface GovernanceRecord {
  user: string;
  aquaLocked: string;
  iceAmount: string;
  votingPower: string;
  lockTimestamp: number;
  lockDuration: number;
}

export interface GovernanceStats {
  totalIceSupply: string;
  totalVotingPower: string;
  totalParticipants: number;
  polVotingAllocation: string;
}

export interface IceIssuanceResult {
  success: boolean;
  iceAmount?: string;
  votingPower?: string;
  transactionHash?: string;
  error?: string;
}

@Injectable()
export class GovernanceContractService {
  private readonly logger = new Logger(GovernanceContractService.name);

  constructor(
    private sorobanCore: SorobanCoreService,
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
    @InjectRepository(HybridUserDataEntity)
    private hybridUserRepository: Repository<HybridUserDataEntity>,
    @InjectRepository(ContractEventLogEntity)
    private eventLogRepository: Repository<ContractEventLogEntity>,
  ) {}

  /**
   * Record ICE token issuance when AQUA is locked
   */
  async recordIceIssuance(
    userAddress: string,
    aquaAmount: string,
    lockDurationDays: number,
    txHash: string,
    useContract: boolean = true,
  ): Promise<IceIssuanceResult> {
    try {
      const iceAmount = this.calculateIceAmount(aquaAmount, lockDurationDays);
      const votingPower = this.calculateVotingPower(iceAmount, lockDurationDays);

      let transactionHash: string | undefined;

      if (useContract) {
        const contractResult = await this.sorobanCore.callContract(
          'governance',
          'record_ice_issuance',
          [userAddress, aquaAmount, iceAmount, lockDurationDays, txHash],
          true,
        );

        if (contractResult.success) {
          transactionHash = contractResult.transactionHash;
          
          await this.logContractEvent({
            eventType: EventType.ICE_ISSUED,
            userAddress,
            amount: parseFloat(iceAmount),
            transactionHash: contractResult.transactionHash,
            eventData: JSON.stringify({
              aquaLocked: aquaAmount,
              lockDuration: lockDurationDays,
              votingPower,
              stakeTxHash: txHash,
            }),
          });
        }
      }

      await this.updateUserGovernanceData(userAddress, {
        iceTokenBalance: parseFloat(iceAmount),
        votingPower: parseFloat(votingPower),
        governanceParticipation: 1,
      });

      return {
        success: true,
        iceAmount,
        votingPower,
        transactionHash,
      };
    } catch (error) {
      this.logger.error('Failed to record ICE issuance:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get user's governance information
   */
  async getUserGovernance(
    userAddress: string,
    useContract: boolean = true,
  ): Promise<ContractCallResult<GovernanceRecord>> {
    try {
      if (useContract) {
        const contractResult = await this.sorobanCore.callContract(
          'governance',
          'get_user_governance',
          [userAddress],
          false,
        );

        if (contractResult.success) {
          return contractResult;
        }
      }

      const hybridUser = await this.hybridUserRepository.findOne({
        where: { userAddress },
      });

      if (!hybridUser) {
        return {
          success: true,
          data: {
            user: userAddress,
            aquaLocked: '0',
            iceAmount: '0',
            votingPower: '0',
            lockTimestamp: 0,
            lockDuration: 0,
          },
        };
      }

      return {
        success: true,
        data: {
          user: userAddress,
          aquaLocked: hybridUser.totalStakedAqua.toString(),
          iceAmount: hybridUser.iceTokenBalance.toString(),
          votingPower: hybridUser.votingPower.toString(),
          lockTimestamp: Math.floor(hybridUser.createdAt.getTime() / 1000),
          lockDuration: 0,
        },
      };
    } catch (error) {
      this.logger.error('Failed to get user governance:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get global governance statistics
   */
  async getGlobalStats(useContract: boolean = true): Promise<ContractCallResult<GovernanceStats>> {
    try {
      if (useContract) {
        const contractResult = await this.sorobanCore.callContract(
          'governance',
          'get_global_stats',
          [],
          false,
        );

        if (contractResult.success) {
          return contractResult;
        }
      }

      const stats = await this.hybridUserRepository
        .createQueryBuilder('hybrid')
        .select([
          'SUM(hybrid.iceTokenBalance) as totalIceSupply',
          'SUM(hybrid.votingPower) as totalVotingPower',
          'COUNT(DISTINCT hybrid.userAddress) as totalParticipants',
        ])
        .where('hybrid.iceTokenBalance > 0')
        .getRawOne();

      return {
        success: true,
        data: {
          totalIceSupply: stats.totalIceSupply || '0',
          totalVotingPower: stats.totalVotingPower || '0',
          totalParticipants: parseInt(stats.totalParticipants) || 0,
          polVotingAllocation: '0',
        },
      };
    } catch (error) {
      this.logger.error('Failed to get global governance stats:', error);
      return { success: false, error: error.message };
    }
  }

  private calculateIceAmount(aquaAmount: string, durationDays: number): string {
    const baseAmount = new BigNumber(aquaAmount);
    const maxDuration = 365;
    const timeMultiplier = Math.min(durationDays / maxDuration, 1);
    const bonusMultiplier = timeMultiplier;
    const totalIce = baseAmount.multipliedBy(1 + bonusMultiplier);
    return totalIce.toFixed(7);
  }

  private calculateVotingPower(iceAmount: string, lockDurationDays: number): string {
    const iceAmountBN = new BigNumber(iceAmount);
    const maxDuration = 365;
    const durationMultiplier = Math.min(lockDurationDays / maxDuration, 1);
    const votingPowerMultiplier = 1 + durationMultiplier;
    const votingPower = iceAmountBN.multipliedBy(votingPowerMultiplier);
    return votingPower.toFixed(7);
  }

  private async updateUserGovernanceData(
    userAddress: string,
    updates: {
      iceTokenBalance?: number;
      votingPower?: number;
      governanceParticipation?: number;
    },
  ): Promise<void> {
    try {
      let hybridUser = await this.hybridUserRepository.findOne({
        where: { userAddress },
      });

      if (!hybridUser) {
        hybridUser = this.hybridUserRepository.create({
          userAddress,
          primaryDataSource: 'hybrid' as any,
        });
      }

      if (updates.iceTokenBalance !== undefined) {
        hybridUser.iceTokenBalance = (hybridUser.iceTokenBalance || 0) + updates.iceTokenBalance;
      }
      if (updates.votingPower !== undefined) {
        hybridUser.votingPower = updates.votingPower;
      }
      if (updates.governanceParticipation !== undefined) {
        hybridUser.governanceParticipation = 
          (hybridUser.governanceParticipation || 0) + updates.governanceParticipation;
      }

      hybridUser.lastContractSync = new Date();
      await this.hybridUserRepository.save(hybridUser);
    } catch (error) {
      this.logger.error('Failed to update user governance data:', error);
    }
  }

  private async logContractEvent(eventData: {
    eventType: EventType;
    userAddress: string;
    amount: number;
    transactionHash: string;
    eventData: string;
  }): Promise<void> {
    try {
      const event = this.eventLogRepository.create({
        contractType: 'governance',
        eventType: eventData.eventType,
        userAddress: eventData.userAddress,
        amount: eventData.amount,
        transactionHash: eventData.transactionHash,
        eventData: eventData.eventData,
        ledger: 0,
        processed: false,
      });

      await this.eventLogRepository.save(event);
    } catch (error) {
      this.logger.error('Failed to log governance contract event:', error);
    }
  }
} 