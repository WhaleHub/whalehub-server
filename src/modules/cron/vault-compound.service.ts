import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as StellarSdk from '@stellar/stellar-sdk';
import { Keypair, Networks, TransactionBuilder } from '@stellar/stellar-sdk';

// Use max fee to avoid transaction failures during network congestion
const MAX_FEE = '1000000'; // 0.1 XLM max fee

/**
 * Vault Compound Cron Service
 *
 * Runs 4 times daily (0:00, 6:00, 12:00, 18:00 UTC) to:
 * 1. Claim boosted rewards from each active vault pool
 * 2. Split rewards: 30% to treasury, 70% auto-compound
 * 3. Handle token swaps if needed (for non-AQUA pairs)
 * 4. Auto-compound by adding liquidity back to pools
 */
@Injectable()
export class VaultCompoundService {
  private readonly logger = new Logger(VaultCompoundService.name);
  private readonly server: StellarSdk.SorobanRpc.Server;
  private readonly adminKeypair: Keypair;
  private readonly stakingContractId: string;

  constructor(private configService: ConfigService) {
    const rpcUrl = this.configService.get<string>('SOROBAN_RPC_URL');
    this.server = new StellarSdk.SorobanRpc.Server(rpcUrl);

    const adminSecret = this.configService.get<string>('ADMIN_SECRET_KEY');
    this.adminKeypair = Keypair.fromSecret(adminSecret);

    this.stakingContractId = this.configService.get<string>(
      'STAKING_CONTRACT_ID',
    );
  }

  /**
   * Runs at 00:00, 06:00, 12:00, 18:00 UTC
   */
  @Cron(CronExpression.EVERY_6_HOURS, {
    name: 'vault-compound-4x-daily',
    timeZone: 'UTC',
  })
  async handleVaultCompound() {
    this.logger.log('Starting vault compound process...');

    try {
      // Get total number of vault pools
      const poolCount = await this.getPoolCount();
      this.logger.log(`Total vault pools: ${poolCount}`);

      if (poolCount === 0) {
        this.logger.log('No vault pools configured. Skipping...');
        return;
      }

      // Process each pool
      let successCount = 0;
      let failCount = 0;

      for (let poolId = 0; poolId < poolCount; poolId++) {
        try {
          await this.compoundPool(poolId);
          successCount++;
        } catch (error) {
          this.logger.error(
            `Failed to compound pool ${poolId}: ${error.message}`,
          );
          failCount++;
        }
      }

      this.logger.log(
        `Vault compound completed: ${successCount} succeeded, ${failCount} failed`,
      );
    } catch (error) {
      this.logger.error(
        `Vault compound process failed: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Get total number of vault pools
   */
  private async getPoolCount(): Promise<number> {
    const contract = new StellarSdk.Contract(this.stakingContractId);
    const operation = contract.call('get_pool_count');

    const result = await this.simulateTransaction(operation);
    const count = StellarSdk.scValToNative(result.result.retval);

    return Number(count);
  }

  /**
   * Compound a single pool:
   * 1. Call claim_and_compound on contract (claims AQUA, sends 30% to treasury, 70% to admin)
   * 2. Swap the AQUA in admin wallet to both pool tokens
   * 3. Call admin_compound_deposit to deposit both tokens back into the pool
   */
  private async compoundPool(poolId: number, maxRetries = 3): Promise<void> {
    this.logger.log(`Compounding pool ${poolId}...`);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // STEP 1: Claim rewards — contract sends 70% AQUA to admin wallet
        const contract = new StellarSdk.Contract(this.stakingContractId);
        const poolIdU32 = StellarSdk.nativeToScVal(poolId, { type: 'u32' });

        const operation = contract.call('claim_and_compound', poolIdU32);
        const tx = await this.buildAndSignTransaction(operation);
        const response = await this.server.sendTransaction(tx);
        const confirmed = await this.pollTransactionStatus(response.hash);

        // Parse return value: (total_rewards, treasury_amount, compound_amount)
        const returnValue = this.parseClaimReturnValue(confirmed);

        if (returnValue.totalRewards <= 0n) {
          this.logger.log(`Pool ${poolId}: No rewards to claim`);
          return;
        }

        this.logger.log(
          `Pool ${poolId} claimed: total=${returnValue.totalRewards}, ` +
            `treasury=${returnValue.treasuryAmount}, compound=${returnValue.compoundAmount}`,
        );

        if (returnValue.compoundAmount <= 0n) {
          this.logger.log(`Pool ${poolId}: No compound amount after treasury split`);
          return;
        }

        // STEP 2: Get pool info to know which tokens to swap to
        const poolInfo = await this.getPoolInfo(poolId);
        const aquaTokenId = this.configService.get<string>('AQUA_TOKEN_ID');
        const routerContractId = this.configService.get<string>('AQUARIUS_ROUTER_CONTRACT_ID');

        const tokenAIsAqua = poolInfo.token_a === aquaTokenId;
        const tokenBIsAqua = poolInfo.token_b === aquaTokenId;

        let amountA = 0n;
        let amountB = 0n;

        if (tokenAIsAqua && tokenBIsAqua) {
          // Both tokens are AQUA (shouldn't happen)
          amountA = returnValue.compoundAmount / 2n;
          amountB = returnValue.compoundAmount - amountA;
        } else if (tokenAIsAqua) {
          // token_a is AQUA — keep half, swap half to token_b
          amountA = returnValue.compoundAmount / 2n;
          const swapAmount = returnValue.compoundAmount - amountA;
          amountB = await this.swapTokens(routerContractId, aquaTokenId, poolInfo.token_b, swapAmount);
        } else if (tokenBIsAqua) {
          // token_b is AQUA — keep half, swap half to token_a
          amountB = returnValue.compoundAmount / 2n;
          const swapAmount = returnValue.compoundAmount - amountB;
          amountA = await this.swapTokens(routerContractId, aquaTokenId, poolInfo.token_a, swapAmount);
        } else {
          // Neither token is AQUA — swap half to each
          const halfAmount = returnValue.compoundAmount / 2n;
          const otherHalf = returnValue.compoundAmount - halfAmount;
          amountA = await this.swapTokens(routerContractId, aquaTokenId, poolInfo.token_a, halfAmount);
          amountB = await this.swapTokens(routerContractId, aquaTokenId, poolInfo.token_b, otherHalf);
        }

        this.logger.log(
          `Pool ${poolId} swapped: amountA=${amountA}, amountB=${amountB}`,
        );

        // STEP 3: Deposit both tokens back into the pool via contract
        const lpMinted = await this.adminCompoundDeposit(poolId, amountA, amountB);
        this.logger.log(
          `Pool ${poolId} compound complete: ${lpMinted} LP shares minted`,
        );

        return; // Success
      } catch (error) {
        const isTimeout = error.message?.includes('timeout');
        if (isTimeout && attempt < maxRetries) {
          this.logger.warn(
            `Compound pool ${poolId} attempt ${attempt} timed out, retrying...`,
          );
          await this.sleep(3000);
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * Parse the return value from claim_and_compound: (total_rewards, treasury_amount, compound_amount)
   */
  private parseClaimReturnValue(txResult: any): {
    totalRewards: bigint;
    treasuryAmount: bigint;
    compoundAmount: bigint;
  } {
    try {
      if (txResult.returnValue) {
        const value = StellarSdk.scValToNative(txResult.returnValue);
        if (Array.isArray(value) && value.length >= 3) {
          return {
            totalRewards: BigInt(value[0] || 0),
            treasuryAmount: BigInt(value[1] || 0),
            compoundAmount: BigInt(value[2] || 0),
          };
        }
      }
    } catch (error) {
      this.logger.warn(`Failed to parse claim return value: ${error.message}`);
    }
    return { totalRewards: 0n, treasuryAmount: 0n, compoundAmount: 0n };
  }

  /**
   * Swap tokens via Aquarius Router
   * Returns the amount of output tokens received
   */
  private async swapTokens(
    routerContractId: string,
    fromTokenId: string,
    toTokenId: string,
    amount: bigint,
    maxRetries = 3,
  ): Promise<bigint> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const routerContract = new StellarSdk.Contract(routerContractId);

        // Build token pair vec
        const tokensVec = StellarSdk.xdr.ScVal.scvVec([
          StellarSdk.nativeToScVal(fromTokenId, { type: 'address' }),
          StellarSdk.nativeToScVal(toTokenId, { type: 'address' }),
        ]);

        // Pool index for the pair
        const poolIndex = Buffer.from(
          '0240dd5b4021e9373c226b8810d95628a38fa8e46a6356c57655688f0f62b5cf',
          'hex',
        );

        // Allow 3% slippage for auto-compound
        const minOut = (amount * 97n) / 100n;

        const operation = routerContract.call(
          'swap',
          StellarSdk.nativeToScVal(this.adminKeypair.publicKey(), { type: 'address' }),
          tokensVec,
          StellarSdk.nativeToScVal(fromTokenId, { type: 'address' }),
          StellarSdk.nativeToScVal(toTokenId, { type: 'address' }),
          StellarSdk.nativeToScVal(poolIndex, { type: 'bytes' }),
          StellarSdk.nativeToScVal(amount, { type: 'u128' }),
          StellarSdk.nativeToScVal(minOut, { type: 'u128' }),
        );

        const tx = await this.buildAndSignTransaction(operation);
        const response = await this.server.sendTransaction(tx);
        const confirmed = await this.pollTransactionStatus(response.hash);

        // Parse output amount
        return this.parseSwapOutput(confirmed, amount);
      } catch (error) {
        const isTimeout = error.message?.includes('timeout');
        if (isTimeout && attempt < maxRetries) {
          this.logger.warn(`Swap attempt ${attempt} timed out, retrying...`);
          await this.sleep(3000);
          continue;
        }
        throw error;
      }
    }
    return 0n;
  }

  /**
   * Parse swap output amount from transaction result
   */
  private parseSwapOutput(txResult: any, inputAmount: bigint): bigint {
    try {
      if (txResult.returnValue) {
        const value = StellarSdk.scValToNative(txResult.returnValue);
        if (Array.isArray(value) && value.length >= 2) {
          return BigInt(value[value.length - 1] || 0);
        }
        return BigInt(value || 0);
      }
    } catch (error) {
      this.logger.warn(`Failed to parse swap output: ${error.message}`);
    }
    // Fallback: assume 1:1 (will be corrected by actual balance)
    return inputAmount;
  }

  /**
   * Call admin_compound_deposit on the staking contract to deposit
   * both tokens into the Aquarius pool on behalf of the contract.
   * Returns LP shares minted.
   */
  private async adminCompoundDeposit(
    poolId: number,
    amountA: bigint,
    amountB: bigint,
  ): Promise<bigint> {
    const contract = new StellarSdk.Contract(this.stakingContractId);

    const operation = contract.call(
      'admin_compound_deposit',
      StellarSdk.nativeToScVal(poolId, { type: 'u32' }),
      StellarSdk.nativeToScVal(amountA, { type: 'i128' }),
      StellarSdk.nativeToScVal(amountB, { type: 'i128' }),
    );

    const tx = await this.buildAndSignTransaction(operation);
    const response = await this.server.sendTransaction(tx);
    const confirmed = await this.pollTransactionStatus(response.hash);

    try {
      if (confirmed.returnValue) {
        const value = StellarSdk.scValToNative(confirmed.returnValue);
        return BigInt(value || 0);
      }
    } catch (error) {
      this.logger.warn(`Failed to parse compound deposit return: ${error.message}`);
    }
    return 0n;
  }

  /**
   * Get pool information
   */
  private async getPoolInfo(poolId: number): Promise<any> {
    const contract = new StellarSdk.Contract(this.stakingContractId);
    const poolIdU32 = StellarSdk.nativeToScVal(poolId, { type: 'u32' });

    const operation = contract.call('get_pool_info', poolIdU32);

    const result = await this.simulateTransaction(operation);
    return StellarSdk.scValToNative(result.result.retval);
  }


  // ============================================================================
  // Helper Methods
  // ============================================================================

  private async simulateTransaction(
    operation: StellarSdk.xdr.Operation,
  ): Promise<any> {
    const account = await this.server.getAccount(this.adminKeypair.publicKey());

    const tx = new TransactionBuilder(account, {
      fee: MAX_FEE,
      networkPassphrase: Networks.PUBLIC,
    })
      .addOperation(operation)
      .setTimeout(180)
      .build();

    const simulated = await this.server.simulateTransaction(tx);

    if (StellarSdk.SorobanRpc.Api.isSimulationError(simulated)) {
      throw new Error(`Simulation failed: ${simulated.error}`);
    }

    return simulated;
  }

  private async buildAndSignTransaction(
    operation: StellarSdk.xdr.Operation,
  ): Promise<StellarSdk.Transaction> {
    const account = await this.server.getAccount(this.adminKeypair.publicKey());

    let tx = new TransactionBuilder(account, {
      fee: MAX_FEE,
      networkPassphrase: Networks.PUBLIC,
    })
      .addOperation(operation)
      .setTimeout(180)
      .build();

    const simulated = await this.server.simulateTransaction(tx);

    if (StellarSdk.SorobanRpc.Api.isSimulationError(simulated)) {
      throw new Error(`Simulation failed: ${simulated.error}`);
    }

    tx = StellarSdk.SorobanRpc.assembleTransaction(tx, simulated).build();
    tx.sign(this.adminKeypair);

    return tx;
  }

  private async pollTransactionStatus(
    hash: string,
    maxAttempts = 30,
  ): Promise<any> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const status = await this.server.getTransaction(hash);

        if (status.status === 'SUCCESS') {
          return status;
        }

        if (status.status === 'FAILED') {
          throw new Error(`Transaction failed: ${hash}`);
        }

        await this.sleep(2000);
      } catch (error) {
        if (error.message?.includes('not found') || error.message?.includes('NOT_FOUND')) {
          // Transaction not yet confirmed, keep polling
          await this.sleep(2000);
          continue;
        }
        throw error;
      }
    }

    throw new Error(`Transaction timeout: ${hash}`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
