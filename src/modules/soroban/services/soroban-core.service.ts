import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  SorobanRpc,
  Address,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  Operation,
  xdr,
  scValToNative,
  nativeToScVal,
} from '@stellar/stellar-sdk';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TransactionLogEntity } from '../entities/transaction-log.entity';

export interface ContractConfig {
  stakingContract: string;
  governanceContract: string;
  rewardsContract: string;
  liquidityContract: string;
  network: string;
  rpcUrl: string;
  adminKeypair: string;
}

export interface ContractCallResult<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  transactionHash?: string;
  ledger?: number;
}

@Injectable()
export class SorobanCoreService {
  private readonly logger = new Logger(SorobanCoreService.name);
  private server: SorobanRpc.Server;
  private adminKeypair: Keypair;
  private contractConfig: ContractConfig;

  constructor(
    private configService: ConfigService,
    @InjectRepository(TransactionLogEntity)
    private transactionLogRepository: Repository<TransactionLogEntity>,
  ) {
    this.initializeConfiguration();
    this.initializeSorobanConnection();
  }

  private initializeConfiguration() {
    this.contractConfig = {
      stakingContract: this.configService.get<string>('STAKING_CONTRACT_ID') || 
        'CDV5SQKDPAXMWNCX7ZQRW2W7JQ6JUKJ7PQJTLRWL6JLWVLZLVZ7LZLZL',
      governanceContract: this.configService.get<string>('GOVERNANCE_CONTRACT_ID') || 
        'CDV5SQKDPAXMWNCX7ZQRW2W7JQ6JUKJ7PQJTLRWL6JLWVLZLVZ7LZLZ2',
      rewardsContract: this.configService.get<string>('REWARDS_CONTRACT_ID') || 
        'CDV5SQKDPAXMWNCX7ZQRW2W7JQ6JUKJ7PQJTLRWL6JLWVLZLVZ7LZLZ3',
      liquidityContract: this.configService.get<string>('LIQUIDITY_CONTRACT_ID') || 
        'CDV5SQKDPAXMWNCX7ZQRW2W7JQ6JUKJ7PQJTLRWL6JLWVLZLVZ7LZLZ4',
      network: this.configService.get<string>('STELLAR_NETWORK') || 'testnet',
      rpcUrl: this.configService.get<string>('SOROBAN_RPC_URL') || 
        'https://soroban-testnet.stellar.org',
      adminKeypair: this.configService.get<string>('ADMIN_SECRET_KEY') || 
        'SCZEAASB6A6Q6LZQFXQGMJGOYAFGFRCW2MXMRFHSXMQFQAZCMGWB6VQM',
    };

    this.logger.log('Contract configuration initialized');
    this.logger.log(`Network: ${this.contractConfig.network}`);
    this.logger.log(`RPC URL: ${this.contractConfig.rpcUrl}`);
  }

  private initializeSorobanConnection() {
    try {
      this.server = new SorobanRpc.Server(this.contractConfig.rpcUrl);
      this.adminKeypair = Keypair.fromSecret(this.contractConfig.adminKeypair);
      
      this.logger.log('Soroban connection initialized successfully');
      this.logger.log(`Admin address: ${this.adminKeypair.publicKey()}`);
    } catch (error) {
      this.logger.error('Failed to initialize Soroban connection:', error);
      throw error;
    }
  }

  /**
   * Get contract instance for a specific contract
   */
  getContract(contractType: 'staking' | 'governance' | 'rewards' | 'liquidity'): Contract {
    const contractId = this.getContractId(contractType);
    return new Contract(contractId);
  }

  /**
   * Get contract ID for a specific contract type
   */
  getContractId(contractType: 'staking' | 'governance' | 'rewards' | 'liquidity'): string {
    switch (contractType) {
      case 'staking':
        return this.contractConfig.stakingContract;
      case 'governance':
        return this.contractConfig.governanceContract;
      case 'rewards':
        return this.contractConfig.rewardsContract;
      case 'liquidity':
        return this.contractConfig.liquidityContract;
      default:
        throw new Error(`Unknown contract type: ${contractType}`);
    }
  }

  /**
   * Execute a contract method call
   */
  async callContract<T = any>(
    contractType: 'staking' | 'governance' | 'rewards' | 'liquidity',
    method: string,
    args: any[] = [],
    isAdmin: boolean = true,
  ): Promise<ContractCallResult<T>> {
    try {
      const contract = this.getContract(contractType);
      const sourceAccount = await this.server.getAccount(this.adminKeypair.publicKey());
      
      // Build the contract call operation
      const operation = contract.call(method, ...args.map(arg => nativeToScVal(arg, this.inferScType(arg))));
      
      // Build transaction
      const transaction = new TransactionBuilder(sourceAccount, {
        fee: '10000',
        networkPassphrase: this.getNetworkPassphrase(),
      })
        .addOperation(operation)
        .setTimeout(30)
        .build();

      // Simulate the transaction first
      const simulationResponse = await this.server.simulateTransaction(transaction);
      
      if (SorobanRpc.Api.isSimulationError(simulationResponse)) {
        const error = `Simulation failed: ${simulationResponse.error}`;
        this.logger.error(error);
        return { success: false, error };
      }

      // Sign and submit if it's a mutation
      if (isAdmin && this.isWriteOperation(method)) {
        transaction.sign(this.adminKeypair);
        const submitResponse = await this.server.sendTransaction(transaction);
        
        if (submitResponse.status === 'PENDING') {
          // Wait for transaction to be confirmed
          let getResponse = await this.server.getTransaction(submitResponse.hash);
          while (getResponse.status === 'NOT_FOUND') {
            await new Promise(resolve => setTimeout(resolve, 1000));
            getResponse = await this.server.getTransaction(submitResponse.hash);
          }

          if (getResponse.status === 'SUCCESS') {
            const result = scValToNative(getResponse.returnValue);
            
            // Log the transaction
            await this.logTransaction({
              contractType,
              method,
              args,
              transactionHash: submitResponse.hash,
              ledger: getResponse.ledger,
              success: true,
              result,
            });

            return {
              success: true,
              data: result,
              transactionHash: submitResponse.hash,
              ledger: getResponse.ledger,
            };
          } else {
            const error = `Transaction failed: ${getResponse.status}`;
            this.logger.error(error);
            return { success: false, error };
          }
        } else {
          const error = `Transaction submission failed: ${submitResponse.status}`;
          this.logger.error(error);
          return { success: false, error };
        }
      } else {
        // For read-only operations, return simulation result
        const result = scValToNative(simulationResponse.result?.retval);
        return { success: true, data: result };
      }
    } catch (error) {
      this.logger.error(`Contract call failed for ${contractType}.${method}:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get current network passphrase
   */
  private getNetworkPassphrase(): string {
    return this.contractConfig.network === 'mainnet' 
      ? Networks.PUBLIC 
      : Networks.TESTNET;
  }

  /**
   * Infer ScVal type from native JavaScript value
   */
  private inferScType(value: any): any {
    if (typeof value === 'string') return { type: 'symbol' };
    if (typeof value === 'number') return { type: 'i64' };
    if (typeof value === 'boolean') return { type: 'bool' };
    if (Array.isArray(value)) return { type: 'vec' };
    return { type: 'instance' };
  }

  /**
   * Determine if a method is a write operation
   */
  private isWriteOperation(method: string): boolean {
    const readOnlyMethods = [
      'get_', 'query_', 'check_', 'calculate_', 'estimate_', 'view_'
    ];
    return !readOnlyMethods.some(prefix => method.startsWith(prefix));
  }

  /**
   * Log transaction to database
   */
  private async logTransaction(logData: {
    contractType: string;
    method: string;
    args: any[];
    transactionHash: string;
    ledger: number;
    success: boolean;
    result?: any;
    error?: string;
  }) {
    try {
      const transactionLog = this.transactionLogRepository.create({
        contractType: logData.contractType,
        method: logData.method,
        args: JSON.stringify(logData.args),
        transactionHash: logData.transactionHash,
        ledger: logData.ledger,
        success: logData.success,
        result: logData.result ? JSON.stringify(logData.result) : null,
        error: logData.error || null,
        timestamp: new Date(),
      });

      await this.transactionLogRepository.save(transactionLog);
    } catch (error) {
      this.logger.error('Failed to log transaction:', error);
    }
  }

  /**
   * Health check for contracts
   */
  async healthCheck(): Promise<{
    rpcConnection: boolean;
    contracts: Record<string, boolean>;
  }> {
    const result = {
      rpcConnection: false,
      contracts: {
        staking: false,
        governance: false,
        rewards: false,
        liquidity: false,
      },
    };

    try {
      // Test RPC connection
      await this.server.getLatestLedger();
      result.rpcConnection = true;

      // Test each contract (simplified check)
      for (const contractType of ['staking', 'governance', 'rewards', 'liquidity'] as const) {
        try {
          // Simple existence check
          result.contracts[contractType] = !!this.getContractId(contractType);
        } catch (error) {
          this.logger.warn(`Contract ${contractType} health check failed:`, error);
        }
      }
    } catch (error) {
      this.logger.error('RPC health check failed:', error);
    }

    return result;
  }

  /**
   * Get admin keypair
   */
  getAdminKeypair(): Keypair {
    return this.adminKeypair;
  }

  /**
   * Get Soroban server instance
   */
  getServer(): SorobanRpc.Server {
    return this.server;
  }

  /**
   * Get contract configuration
   */
  getContractConfig(): ContractConfig {
    return this.contractConfig;
  }
} 