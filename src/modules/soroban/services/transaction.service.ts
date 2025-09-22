import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between } from 'typeorm';
import { TransactionLogEntity } from '../entities/transaction-log.entity';
import { ContractEventLogEntity } from '../entities/contract-event-log.entity';

export interface TransactionStats {
  totalTransactions: number;
  successfulTransactions: number;
  failedTransactions: number;
  totalGasUsed: string;
  totalFeesCharged: string;
  averageGasPerTransaction: string;
  averageFeePerTransaction: string;
}

export interface TransactionSummary {
  transactionHash: string;
  contractType: string;
  method: string;
  success: boolean;
  userAddress: string;
  gasUsed: number;
  feeCharged: number;
  timestamp: Date;
}

@Injectable()
export class TransactionService {
  private readonly logger = new Logger(TransactionService.name);

  constructor(
    @InjectRepository(TransactionLogEntity)
    private transactionLogRepository: Repository<TransactionLogEntity>,
    @InjectRepository(ContractEventLogEntity)
    private eventLogRepository: Repository<ContractEventLogEntity>,
  ) {}

  /**
   * Get transaction statistics for a date range
   */
  async getTransactionStats(
    startDate?: Date,
    endDate?: Date,
    contractType?: string,
  ): Promise<TransactionStats> {
    try {
      const query = this.transactionLogRepository.createQueryBuilder('tx');

      if (startDate && endDate) {
        query.where('tx.timestamp BETWEEN :startDate AND :endDate', {
          startDate,
          endDate,
        });
      }

      if (contractType) {
        query.andWhere('tx.contractType = :contractType', { contractType });
      }

      const [transactions, totalCount] = await Promise.all([
        query.getMany(),
        query.getCount(),
      ]);

      const successfulCount = transactions.filter(tx => tx.success).length;
      const failedCount = totalCount - successfulCount;

      const totalGasUsed = transactions
        .reduce((sum, tx) => sum + (tx.gasUsed || 0), 0);
      
      const totalFees = transactions
        .reduce((sum, tx) => sum + (tx.feeCharged || 0), 0);

      const avgGas = totalCount > 0 ? totalGasUsed / totalCount : 0;
      const avgFee = totalCount > 0 ? totalFees / totalCount : 0;

      return {
        totalTransactions: totalCount,
        successfulTransactions: successfulCount,
        failedTransactions: failedCount,
        totalGasUsed: totalGasUsed.toString(),
        totalFeesCharged: totalFees.toString(),
        averageGasPerTransaction: avgGas.toFixed(2),
        averageFeePerTransaction: avgFee.toFixed(7),
      };
    } catch (error) {
      this.logger.error('Failed to get transaction stats:', error);
      throw error;
    }
  }

  /**
   * Get recent transactions
   */
  async getRecentTransactions(
    limit: number = 50,
    contractType?: string,
    userAddress?: string,
  ): Promise<TransactionSummary[]> {
    try {
      const query = this.transactionLogRepository
        .createQueryBuilder('tx')
        .orderBy('tx.timestamp', 'DESC')
        .limit(limit);

      if (contractType) {
        query.andWhere('tx.contractType = :contractType', { contractType });
      }

      if (userAddress) {
        query.andWhere('tx.userAddress = :userAddress', { userAddress });
      }

      const transactions = await query.getMany();

      return transactions.map(tx => ({
        transactionHash: tx.transactionHash,
        contractType: tx.contractType,
        method: tx.method,
        success: tx.success,
        userAddress: tx.userAddress,
        gasUsed: tx.gasUsed,
        feeCharged: tx.feeCharged,
        timestamp: tx.timestamp,
      }));
    } catch (error) {
      this.logger.error('Failed to get recent transactions:', error);
      throw error;
    }
  }

  /**
   * Get transaction by hash
   */
  async getTransactionByHash(transactionHash: string): Promise<TransactionLogEntity | null> {
    try {
      return await this.transactionLogRepository.findOne({
        where: { transactionHash },
      });
    } catch (error) {
      this.logger.error('Failed to get transaction by hash:', error);
      throw error;
    }
  }

  /**
   * Get user transaction history
   */
  async getUserTransactionHistory(
    userAddress: string,
    page: number = 1,
    limit: number = 20,
  ): Promise<{
    transactions: TransactionSummary[];
    total: number;
    page: number;
    totalPages: number;
  }> {
    try {
      const skip = (page - 1) * limit;

      const [transactions, total] = await this.transactionLogRepository.findAndCount({
        where: { userAddress },
        order: { timestamp: 'DESC' },
        skip,
        take: limit,
      });

      const totalPages = Math.ceil(total / limit);

      return {
        transactions: transactions.map(tx => ({
          transactionHash: tx.transactionHash,
          contractType: tx.contractType,
          method: tx.method,
          success: tx.success,
          userAddress: tx.userAddress,
          gasUsed: tx.gasUsed,
          feeCharged: tx.feeCharged,
          timestamp: tx.timestamp,
        })),
        total,
        page,
        totalPages,
      };
    } catch (error) {
      this.logger.error('Failed to get user transaction history:', error);
      throw error;
    }
  }

  /**
   * Get daily transaction metrics
   */
  async getDailyMetrics(days: number = 30): Promise<Array<{
    date: string;
    totalTransactions: number;
    successfulTransactions: number;
    failedTransactions: number;
    totalGasUsed: string;
    totalFees: string;
  }>> {
    try {
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(endDate.getDate() - days);

      const transactions = await this.transactionLogRepository.find({
        where: {
          timestamp: Between(startDate, endDate),
        },
        order: { timestamp: 'ASC' },
      });

      // Group transactions by date
      const dailyMetrics = new Map<string, {
        totalTransactions: number;
        successfulTransactions: number;
        failedTransactions: number;
        totalGasUsed: number;
        totalFees: number;
      }>();

      transactions.forEach(tx => {
        const dateKey = tx.timestamp.toISOString().split('T')[0];
        
        if (!dailyMetrics.has(dateKey)) {
          dailyMetrics.set(dateKey, {
            totalTransactions: 0,
            successfulTransactions: 0,
            failedTransactions: 0,
            totalGasUsed: 0,
            totalFees: 0,
          });
        }

        const metrics = dailyMetrics.get(dateKey)!;
        metrics.totalTransactions++;
        
        if (tx.success) {
          metrics.successfulTransactions++;
        } else {
          metrics.failedTransactions++;
        }

        metrics.totalGasUsed += tx.gasUsed || 0;
        metrics.totalFees += tx.feeCharged || 0;
      });

      // Convert to array and fill missing dates
      const result = [];
      for (let i = 0; i < days; i++) {
        const date = new Date(startDate);
        date.setDate(startDate.getDate() + i);
        const dateKey = date.toISOString().split('T')[0];

        const metrics = dailyMetrics.get(dateKey) || {
          totalTransactions: 0,
          successfulTransactions: 0,
          failedTransactions: 0,
          totalGasUsed: 0,
          totalFees: 0,
        };

        result.push({
          date: dateKey,
          totalTransactions: metrics.totalTransactions,
          successfulTransactions: metrics.successfulTransactions,
          failedTransactions: metrics.failedTransactions,
          totalGasUsed: metrics.totalGasUsed.toString(),
          totalFees: metrics.totalFees.toString(),
        });
      }

      return result;
    } catch (error) {
      this.logger.error('Failed to get daily metrics:', error);
      throw error;
    }
  }

  /**
   * Get contract performance metrics
   */
  async getContractPerformance(): Promise<Array<{
    contractType: string;
    totalTransactions: number;
    successRate: number;
    averageGasUsed: string;
    averageFee: string;
    mostUsedMethod: string;
  }>> {
    try {
      const result = await this.transactionLogRepository
        .createQueryBuilder('tx')
        .select([
          'tx.contractType as contractType',
          'COUNT(*) as totalTransactions',
          'AVG(CASE WHEN tx.success THEN 1.0 ELSE 0.0 END) as successRate',
          'AVG(tx.gasUsed) as averageGasUsed',
          'AVG(tx.feeCharged) as averageFee',
        ])
        .groupBy('tx.contractType')
        .getRawMany();

      // Get most used method for each contract
      const performanceData = await Promise.all(
        result.map(async (item) => {
          const methodResult = await this.transactionLogRepository
            .createQueryBuilder('tx')
            .select(['tx.method as method', 'COUNT(*) as count'])
            .where('tx.contractType = :contractType', { contractType: item.contractType })
            .groupBy('tx.method')
            .orderBy('count', 'DESC')
            .limit(1)
            .getRawOne();

          return {
            contractType: item.contractType,
            totalTransactions: parseInt(item.totalTransactions),
            successRate: parseFloat((parseFloat(item.successRate) * 100).toFixed(2)),
            averageGasUsed: parseFloat(item.averageGasUsed || '0').toFixed(2),
            averageFee: parseFloat(item.averageFee || '0').toFixed(7),
            mostUsedMethod: methodResult?.method || 'N/A',
          };
        })
      );

      return performanceData;
    } catch (error) {
      this.logger.error('Failed to get contract performance:', error);
      throw error;
    }
  }

  /**
   * Get error analysis
   */
  async getErrorAnalysis(contractType?: string): Promise<Array<{
    errorMessage: string;
    occurrences: number;
    lastOccurrence: Date;
    affectedMethods: string[];
  }>> {
    try {
      const query = this.transactionLogRepository
        .createQueryBuilder('tx')
        .where('tx.success = false')
        .andWhere('tx.error IS NOT NULL');

      if (contractType) {
        query.andWhere('tx.contractType = :contractType', { contractType });
      }

      const failedTransactions = await query.getMany();

      // Group by error message
      const errorGroups = new Map<string, {
        occurrences: number;
        lastOccurrence: Date;
        methods: Set<string>;
      }>();

      failedTransactions.forEach(tx => {
        const errorKey = tx.error || 'Unknown error';
        
        if (!errorGroups.has(errorKey)) {
          errorGroups.set(errorKey, {
            occurrences: 0,
            lastOccurrence: tx.timestamp,
            methods: new Set(),
          });
        }

        const group = errorGroups.get(errorKey)!;
        group.occurrences++;
        group.methods.add(tx.method);
        
        if (tx.timestamp > group.lastOccurrence) {
          group.lastOccurrence = tx.timestamp;
        }
      });

      return Array.from(errorGroups.entries()).map(([errorMessage, data]) => ({
        errorMessage,
        occurrences: data.occurrences,
        lastOccurrence: data.lastOccurrence,
        affectedMethods: Array.from(data.methods),
      })).sort((a, b) => b.occurrences - a.occurrences);
    } catch (error) {
      this.logger.error('Failed to get error analysis:', error);
      throw error;
    }
  }

  /**
   * Clean up old transaction logs
   */
  async cleanupOldLogs(daysToKeep: number = 90): Promise<number> {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

      const result = await this.transactionLogRepository
        .createQueryBuilder()
        .delete()
        .where('timestamp < :cutoffDate', { cutoffDate })
        .execute();

      this.logger.log(`Cleaned up ${result.affected} old transaction logs`);
      return result.affected || 0;
    } catch (error) {
      this.logger.error('Failed to cleanup old logs:', error);
      throw error;
    }
  }

  /**
   * Get event logs
   */
  async getEventLogs(
    contractType?: string,
    eventType?: string,
    userAddress?: string,
    limit: number = 50,
  ): Promise<ContractEventLogEntity[]> {
    try {
      const query = this.eventLogRepository
        .createQueryBuilder('event')
        .orderBy('event.timestamp', 'DESC')
        .limit(limit);

      if (contractType) {
        query.andWhere('event.contractType = :contractType', { contractType });
      }

      if (eventType) {
        query.andWhere('event.eventType = :eventType', { eventType });
      }

      if (userAddress) {
        query.andWhere('event.userAddress = :userAddress', { userAddress });
      }

      return await query.getMany();
    } catch (error) {
      this.logger.error('Failed to get event logs:', error);
      throw error;
    }
  }
} 