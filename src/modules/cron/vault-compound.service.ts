import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import * as StellarSdk from '@stellar/stellar-sdk';
import {
  Keypair,
  Networks,
  BASE_FEE,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

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
  @Cron('0 0,6,12,18 * * *', {
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
   * Compound a single pool
   */
  private async compoundPool(poolId: number): Promise<void> {
    this.logger.log(`Compounding pool ${poolId}...`);

    const contract = new StellarSdk.Contract(this.stakingContractId);
    const poolIdU32 = StellarSdk.nativeToScVal(poolId, { type: 'u32' });

    const operation = contract.call('claim_and_compound', poolIdU32);

    const tx = await this.buildAndSignTransaction(operation);
    const response = await this.server.sendTransaction(tx);

    const confirmed = await this.pollTransactionStatus(response.hash);

    // Parse events to check if swap is needed
    const events = this.parseCompoundEvents(confirmed);

    if (events.needSwap) {
      this.logger.log(`Pool ${poolId} requires token swap: ${events.swapType}`);
      await this.handleTokenSwap(poolId, events);

      // Call claim_and_compound again after swap to complete deposit
      this.logger.log(`Re-compounding pool ${poolId} after swap...`);
      await this.compoundPool(poolId);
    } else if (events.compounded) {
      this.logger.log(
        `Pool ${poolId} compounded: ${events.lpSharesMinted} LP shares, ` +
          `Total: ${events.totalLp}, Rewards: ${events.totalRewards}`,
      );
    } else if (events.noReward) {
      this.logger.log(`Pool ${poolId}: No rewards to claim`);
    }
  }

  /**
   * Handle token swaps for non-AQUA pairs
   * This function performs swaps via Aquarius AMM
   */
  private async handleTokenSwap(poolId: number, swapInfo: any): Promise<void> {
    this.logger.log(`Handling token swap for pool ${poolId}...`);

    const poolInfo = await this.getPoolInfo(poolId);
    const aquaAmount = swapInfo.aquaAmount;

    // Get Aquarius Router contract for swaps
    const routerContractId = this.configService.get<string>(
      'AQUARIUS_ROUTER_CONTRACT_ID',
    );

    if (swapInfo.swapType === 'to_a') {
      // Swap AQUA to token_a
      await this.swapTokens(
        routerContractId,
        this.configService.get<string>('AQUA_TOKEN_ID'),
        poolInfo.token_a,
        aquaAmount / 2, // Swap half
      );
    } else if (swapInfo.swapType === 'to_b') {
      // Swap AQUA to token_b
      await this.swapTokens(
        routerContractId,
        this.configService.get<string>('AQUA_TOKEN_ID'),
        poolInfo.token_b,
        aquaAmount / 2, // Swap half
      );
    } else if (swapInfo.swapType === 'to_both') {
      // Swap half AQUA to token_a, half to token_b
      await this.swapTokens(
        routerContractId,
        this.configService.get<string>('AQUA_TOKEN_ID'),
        poolInfo.token_a,
        aquaAmount / 2,
      );

      await this.swapTokens(
        routerContractId,
        this.configService.get<string>('AQUA_TOKEN_ID'),
        poolInfo.token_b,
        aquaAmount / 2,
      );
    }

    this.logger.log(`Token swap completed for pool ${poolId}`);
  }

  /**
   * Swap tokens via Aquarius Router
   */
  private async swapTokens(
    routerContractId: string,
    fromTokenId: string,
    toTokenId: string,
    amount: number,
  ): Promise<void> {
    const routerContract = new StellarSdk.Contract(routerContractId);

    const amountI128 = StellarSdk.nativeToScVal(Math.floor(amount * 1e7), {
      type: 'i128',
    });
    const minAmount = StellarSdk.nativeToScVal(0, { type: 'i128' }); // Allow any slippage for auto-compound

    // Build path: [fromToken, toToken]
    const path = StellarSdk.nativeToScVal([fromTokenId, toTokenId], {
      type: 'vec',
    });

    const operation = routerContract.call(
      'swap_exact_tokens_for_tokens',
      amountI128,
      minAmount,
      path,
      StellarSdk.nativeToScVal(this.stakingContractId, { type: 'address' }),
      StellarSdk.nativeToScVal(Math.floor(Date.now() / 1000) + 300, {
        type: 'u64',
      }), // 5 min deadline
    );

    const tx = await this.buildAndSignTransaction(operation);
    const response = await this.server.sendTransaction(tx);

    await this.pollTransactionStatus(response.hash);
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

  /**
   * Parse compound events from transaction result
   *
   * According to Stellar's getTransaction API, events are at the top level:
   * - txResult.events.contractEventsXdr: Array of base64-encoded ContractEvent
   * - txResult.events.transactionEventsXdr: Array of base64-encoded TransactionEvent
   *
   * @see https://developers.stellar.org/docs/data/apis/rpc/api-reference/methods/getTransaction
   */
  private parseCompoundEvents(txResult: any): any {
    const events = {
      needSwap: false,
      swapType: null,
      aquaAmount: 0,
      compounded: false,
      lpSharesMinted: 0,
      totalLp: 0,
      totalRewards: 0,
      noReward: false,
    };

    try {
      // Method 1: Parse from top-level events (new API structure)
      const contractEventsXdr = txResult.events?.contractEventsXdr || [];

      if (contractEventsXdr.length > 0) {
        for (const eventXdr of contractEventsXdr) {
          try {
            // Decode base64 XDR to ContractEvent
            const contractEvent = StellarSdk.xdr.ContractEvent.fromXDR(
              eventXdr,
              'base64',
            );

            const body = contractEvent.body();
            if (!body) continue;

            // Try to access v0 - will throw if not v0 type
            let v0;
            try {
              v0 = body.v0();
            } catch {
              continue; // Skip non-v0 events
            }
            const topics = v0.topics();
            if (!topics || topics.length === 0) continue;

            // Get first topic as event name (symbol)
            const eventName = StellarSdk.scValToNative(topics[0]);

            // Parse event data
            const eventData = v0.data();
            const data = eventData ? StellarSdk.scValToNative(eventData) : null;

            this.logger.debug(
              `Event: ${eventName}, Data: ${JSON.stringify(data)}`,
            );

            // Handle different event types from claim_and_compound
            this.processEventData(eventName, data, events);
          } catch (eventError) {
            this.logger.debug(
              `Failed to parse contract event: ${eventError.message}`,
            );
          }
        }
      }

      // Method 2: Fallback to resultMetaXdr parsing (legacy support)
      if (
        contractEventsXdr.length === 0 &&
        !events.needSwap &&
        !events.compounded &&
        !events.noReward
      ) {
        const resultMeta = txResult.resultMetaXdr;
        if (resultMeta) {
          try {
            // Check if resultMetaXdr is already parsed or needs decoding
            const meta =
              typeof resultMeta === 'string'
                ? StellarSdk.xdr.TransactionMeta.fromXDR(resultMeta, 'base64')
                : resultMeta;

            // Access v3 soroban meta if available (switch returns number directly)
            const metaSwitch = meta.switch() as unknown as number;
            if (metaSwitch >= 3) {
              const metaValue = meta.value();
              const sorobanMeta = metaValue.sorobanMeta?.() || null;

              if (sorobanMeta) {
                const sorobanEvents = sorobanMeta.events?.() || [];

                for (const contractEvent of sorobanEvents) {
                  try {
                    const body = contractEvent.body();
                    if (!body) continue;

                    // Try to access v0 - will throw if not v0 type
                    let v0;
                    try {
                      v0 = body.v0();
                    } catch {
                      continue;
                    }
                    const topics = v0.topics();
                    if (!topics || topics.length === 0) continue;

                    const eventName = StellarSdk.scValToNative(topics[0]);
                    const eventData = v0.data();
                    const data = eventData
                      ? StellarSdk.scValToNative(eventData)
                      : null;

                    this.logger.debug(
                      `Event (meta): ${eventName}, Data: ${JSON.stringify(data)}`,
                    );

                    this.processEventData(eventName, data, events);
                  } catch (innerError) {
                    this.logger.debug(
                      `Failed to parse meta event: ${innerError.message}`,
                    );
                  }
                }
              }
            }
          } catch (metaError) {
            this.logger.debug(
              `Failed to parse resultMetaXdr: ${metaError.message}`,
            );
          }
        }
      }

      // If no events found but transaction succeeded, assume compounded
      if (!events.needSwap && !events.compounded && !events.noReward) {
        events.compounded = true;
      }
    } catch (error) {
      this.logger.warn(`Failed to parse compound events: ${error.message}`);
      // Default to compounded on parse error (transaction likely succeeded)
      events.compounded = true;
    }

    return events;
  }

  /**
   * Process event data and update events object
   */
  private processEventData(eventName: string, data: any, events: any): void {
    switch (eventName) {
      case 'need_swap':
        events.needSwap = true;
        if (data) {
          events.swapType = data.swap_type || data[0];
          events.aquaAmount = Number(data.amount || data[1] || 0);
        }
        break;

      case 'compound':
      case 'compounded':
        events.compounded = true;
        if (data) {
          events.lpSharesMinted = Number(data.lp_minted || data[0] || 0);
          events.totalLp = Number(data.total_lp || data[1] || 0);
          events.totalRewards = Number(data.rewards || data[2] || 0);
        }
        break;

      case 'no_reward':
      case 'no_rewards':
        events.noReward = true;
        break;
    }
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  private async simulateTransaction(
    operation: StellarSdk.xdr.Operation,
  ): Promise<any> {
    const account = await this.server.getAccount(this.adminKeypair.publicKey());

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
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
      fee: BASE_FEE,
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
      const status = await this.server.getTransaction(hash);

      if (status.status === 'SUCCESS') {
        return status;
      }

      if (status.status === 'FAILED') {
        throw new Error(`Transaction failed: ${hash}`);
      }

      await this.sleep(2000);
    }

    throw new Error(`Transaction timeout: ${hash}`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
