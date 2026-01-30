import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import * as StellarSdk from '@stellar/stellar-sdk';
import { Keypair, Networks, TransactionBuilder } from '@stellar/stellar-sdk';

// Use max fee to avoid transaction failures during network congestion
const MAX_FEE = '1000000'; // 0.1 XLM max fee

// Treasury fee: 30% profit, 70% to stakers
const TREASURY_FEE_BPS = 3000; // 30%
// const STAKER_SHARE_BPS = 7000; // 70%

// Event polling interval (check for new events every 30 seconds)
const EVENT_POLL_INTERVAL_MS = 30000;

/**
 * Staking Reward Distribution Service
 *
 * Two main responsibilities:
 *
 * 1. POL Deposit Handler (runs every 30 seconds):
 *    - Polls for pol_dep events from staking contract
 *    - When user locks AQUA, contract sends 10% AQUA + BLUB to admin
 *    - This service deposits those tokens to AQUA/BLUB pool (with ICE boost)
 *
 * 2. Reward Distribution (runs 4x daily at 0, 6, 12, 18 UTC):
 *    - Claims AQUA rewards from AQUA/BLUB pool (admin wallet has ICE boost)
 *    - Sends 30% to treasury as profit
 *    - Swaps 70% AQUA to BLUB via Aquarius Router
 *    - Calls add_rewards() on staking contract to distribute to stakers
 */
@Injectable()
export class StakingRewardService {
  private readonly logger = new Logger(StakingRewardService.name);
  private readonly server: StellarSdk.SorobanRpc.Server;
  private readonly horizonServer: StellarSdk.Horizon.Server;
  private readonly adminKeypair: Keypair;
  private readonly stakingContractId: string;
  private readonly aquaBlubPoolId: string;
  private readonly aquaTokenId: string;
  private readonly blubTokenId: string;
  private readonly routerContractId: string;
  private readonly treasuryAddress: string;

  // Track last processed event cursor to avoid duplicates
  private lastEventLedger: number = 0;
  private processedTxHashes: Set<string> = new Set();

  constructor(private configService: ConfigService) {
    const rpcUrl = this.configService.get<string>('SOROBAN_RPC_URL');
    this.server = new StellarSdk.SorobanRpc.Server(rpcUrl);

    const horizonUrl = this.configService.get<string>('STELLAR_HORIZON_URL');
    this.horizonServer = new StellarSdk.Horizon.Server(horizonUrl);

    const adminSecret = this.configService.get<string>('ADMIN_SECRET_KEY');
    this.adminKeypair = Keypair.fromSecret(adminSecret);

    this.stakingContractId = this.configService.get<string>('STAKING_CONTRACT_ID');
    this.aquaBlubPoolId = this.configService.get<string>('AQUA_BLUB_POOL_ID');
    this.aquaTokenId = this.configService.get<string>('AQUA_TOKEN_ID');
    this.blubTokenId = this.configService.get<string>('BLUB_TOKEN_ID');
    this.routerContractId = this.configService.get<string>('AQUARIUS_ROUTER_CONTRACT_ID');
    this.treasuryAddress = this.configService.get<string>('TREASURY_ADDRESS');

    // Start event polling
    this.startEventPolling();
  }

  /**
   * Start polling for pol_dep events from staking contract
   */
  private startEventPolling() {
    this.logger.log('Starting POL deposit event polling...');

    setInterval(async () => {
      try {
        await this.pollAndProcessPolDepositEvents();
      } catch (error) {
        this.logger.error(`Event polling error: ${error.message}`);
      }
    }, EVENT_POLL_INTERVAL_MS);
  }

  /**
   * Poll for recent pol_dep events and process them
   */
  private async pollAndProcessPolDepositEvents(): Promise<void> {
    try {
      // Get recent events from the staking contract
      const events = await this.server.getEvents({
        startLedger:
          this.lastEventLedger || (await this.getCurrentLedger()) - 1000,
        filters: [
          {
            type: 'contract',
            contractIds: [this.stakingContractId],
            topics: [['AAAADwAAAAdwb2xfZGVw']], // "pol_dep" as SCVal symbol
          },
        ],
        limit: 100,
      });

      if (!events.events || events.events.length === 0) {
        return;
      }

      this.logger.debug(`Found ${events.events.length} pol_dep events`);

      for (const event of events.events) {
        // Skip if already processed
        const eventId = `${event.ledger}-${event.id}`;
        if (this.processedTxHashes.has(eventId)) {
          continue;
        }

        try {
          await this.processPolDepositEvent(event);
          this.processedTxHashes.add(eventId);

          // Keep set size manageable
          if (this.processedTxHashes.size > 10000) {
            const entries = Array.from(this.processedTxHashes);
            this.processedTxHashes = new Set(entries.slice(-5000));
          }
        } catch (error) {
          this.logger.error(
            `Failed to process event ${eventId}: ${error.message}`,
          );
        }
      }

      // Update last processed ledger
      if (events.latestLedger) {
        this.lastEventLedger = events.latestLedger;
      }
    } catch (error) {
      // Silently handle if getEvents not supported
      if (!error.message?.includes('not supported')) {
        this.logger.debug(`Event polling: ${error.message}`);
      }
    }
  }

  /**
   * Process a single pol_dep event
   * Deposits AQUA + BLUB from admin wallet to AQUA/BLUB pool
   */
  private async processPolDepositEvent(event: any): Promise<void> {
    try {
      // Parse event data
      const eventData = StellarSdk.scValToNative(event.value);
      const aquaAmount = BigInt(eventData.aqua_amount || eventData[1] || 0);
      const blubAmount = BigInt(eventData.blub_amount || eventData[2] || 0);
      const user = eventData.user || eventData[0];

      this.logger.log(
        `Processing POL deposit: user=${user}, aqua=${aquaAmount}, blub=${blubAmount}`,
      );

      if (aquaAmount <= 0n || blubAmount <= 0n) {
        this.logger.warn('Invalid POL deposit amounts, skipping');
        return;
      }

      // Deposit to AQUA/BLUB pool from admin wallet
      await this.depositToPool(aquaAmount, blubAmount);

      this.logger.log(
        `POL deposit completed: ${aquaAmount} AQUA + ${blubAmount} BLUB deposited to pool`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to process POL deposit event: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Deposit AQUA + BLUB to AQUA/BLUB pool from admin wallet
   */
  private async depositToPool(
    aquaAmount: bigint,
    blubAmount: bigint,
  ): Promise<void> {
    const poolContract = new StellarSdk.Contract(this.aquaBlubPoolId);

    // Build deposit amounts array [aqua, blub] - order depends on pool token order
    const amounts = [aquaAmount, blubAmount];

    const operation = poolContract.call(
      'deposit',
      StellarSdk.nativeToScVal(this.adminKeypair.publicKey(), {
        type: 'address',
      }),
      StellarSdk.nativeToScVal(
        amounts.map((a) => a.toString()),
        { type: 'vec' },
      ),
      StellarSdk.nativeToScVal(0, { type: 'u128' }), // min_shares = 0 (accept any)
    );

    const tx = await this.buildAndSignTransaction(operation);
    const response = await this.server.sendTransaction(tx);
    await this.pollTransactionStatus(response.hash);

    this.logger.log(`Deposited to pool: tx=${response.hash}`);
  }

  /**
   * Get current ledger number
   */
  private async getCurrentLedger(): Promise<number> {
    try {
      const health = (await this.server.getHealth()) as any;
      return health.latestLedger || health.latest_ledger || 0;
    } catch {
      return 0;
    }
  }

  // ============================================================================
  // POL DEPOSIT CRON (Fallback - checks balances every 5 minutes)
  // ============================================================================

  /**
   * Runs every 5 minutes to check for pending POL deposits
   * This is a fallback in case event polling misses something
   */
  @Cron('*/5 * * * *', {
    name: 'pol-deposit-check',
    timeZone: 'UTC',
  })
  async handlePolDepositCheck() {
    try {
      await this.checkAndDepositPendingPol();
    } catch (error) {
      this.logger.error(`POL deposit check failed: ${error.message}`);
    }
  }

  /**
   * Check admin wallet balances and deposit any pending AQUA/BLUB to pool
   * Minimum threshold to avoid dust deposits
   */
  private async checkAndDepositPendingPol(): Promise<void> {
    const MIN_AQUA_THRESHOLD = 1000000n; // 0.1 AQUA (7 decimals)
    const MIN_BLUB_THRESHOLD = 1000000n; // 0.1 BLUB (7 decimals)

    try {
      // Get admin wallet balances
      const aquaBalance = await this.getTokenBalance(this.aquaTokenId);
      const blubBalance = await this.getTokenBalance(this.blubTokenId);

      this.logger.debug(
        `Admin balances: AQUA=${aquaBalance}, BLUB=${blubBalance}`,
      );

      // Check if we have enough to deposit
      if (
        aquaBalance < MIN_AQUA_THRESHOLD ||
        blubBalance < MIN_BLUB_THRESHOLD
      ) {
        return; // Not enough to deposit
      }

      // Calculate deposit amounts (use the smaller ratio to balance)
      // Assume roughly 1:1 ratio for AQUA:BLUB in pool
      const depositAqua = aquaBalance < blubBalance ? aquaBalance : blubBalance;
      const depositBlub = depositAqua; // Match AQUA amount

      if (depositAqua < MIN_AQUA_THRESHOLD) {
        return;
      }

      this.logger.log(
        `Depositing pending POL: ${depositAqua} AQUA + ${depositBlub} BLUB`,
      );

      await this.depositToPool(depositAqua, depositBlub);

      this.logger.log('Pending POL deposit completed');
    } catch (error) {
      this.logger.debug(`POL deposit check: ${error.message}`);
    }
  }

  /**
   * Get token balance for admin wallet
   */
  private async getTokenBalance(tokenId: string): Promise<bigint> {
    try {
      const tokenContract = new StellarSdk.Contract(tokenId);
      const operation = tokenContract.call(
        'balance',
        StellarSdk.nativeToScVal(this.adminKeypair.publicKey(), { type: 'address' }),
      );

      const result = await this.simulateTransaction(operation);
      const balance = StellarSdk.scValToNative(result.result.retval);
      return BigInt(balance || 0);
    } catch (error) {
      this.logger.debug(
        `Failed to get balance for ${tokenId}: ${error.message}`,
      );
      return 0n;
    }
  }

  /**
   * Manual trigger for POL deposit (for testing)
   */
  async manualPolDeposit(): Promise<{ success: boolean; message: string }> {
    try {
      await this.checkAndDepositPendingPol();
      return { success: true, message: 'POL deposit check completed' };
    } catch (error) {
      return { success: false, message: error.message };
    }
  }

  /**
   * Runs at 00:00, 06:00, 12:00, 18:00 UTC (same schedule as vault compound)
   */
  @Cron('0 0,6,12,18 * * *', {
    name: 'staking-reward-distribution',
    timeZone: 'UTC',
  })
  async handleStakingRewardDistribution() {
    this.logger.log('Starting staking reward distribution...');

    try {
      // Step 1: Check pending rewards from AQUA/BLUB pool
      const pendingRewards = await this.getPendingRewards();
      this.logger.log(`Pending AQUA rewards: ${pendingRewards}`);

      if (pendingRewards <= 0) {
        this.logger.log('No rewards to claim. Skipping...');
        return;
      }

      // Step 2: Claim rewards from AQUA/BLUB pool
      const claimedAmount = await this.claimPoolRewards();
      this.logger.log(`Claimed AQUA amount: ${claimedAmount}`);

      if (claimedAmount <= 0) {
        this.logger.log('No rewards claimed. Skipping distribution...');
        return;
      }

      // Step 3: Calculate splits (30% treasury, 70% stakers)
      const treasuryAmount = (claimedAmount * BigInt(TREASURY_FEE_BPS)) / BigInt(10000);
      const stakerAmount = claimedAmount - treasuryAmount;

      this.logger.log(`Treasury (30%): ${treasuryAmount} AQUA`);
      this.logger.log(`Stakers (70%): ${stakerAmount} AQUA`);

      // Step 4: Send 30% to treasury
      if (treasuryAmount > 0n) {
        await this.sendToTreasury(treasuryAmount);
        this.logger.log(`Sent ${treasuryAmount} AQUA to treasury`);
      }

      // Step 5: Swap 70% AQUA to BLUB
      let blubAmount = 0n;
      if (stakerAmount > 0n) {
        blubAmount = await this.swapAquaToBlub(stakerAmount);
        this.logger.log(`Swapped to ${blubAmount} BLUB`);
      }

      // Step 6: Add rewards to staking contract
      if (blubAmount > 0n) {
        await this.addRewardsToStakingContract(blubAmount);
        this.logger.log(`Added ${blubAmount} BLUB rewards to staking contract`);
      }

      this.logger.log('Staking reward distribution completed successfully');

      // Emit summary event
      this.logger.log(
        `Distribution Summary: Claimed=${claimedAmount} AQUA, ` +
          `Treasury=${treasuryAmount} AQUA, Stakers=${blubAmount} BLUB`,
      );
    } catch (error) {
      this.logger.error(
        `Staking reward distribution failed: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Get pending rewards from AQUA/BLUB pool for admin wallet
   */
  private async getPendingRewards(): Promise<bigint> {
    try {
      const poolContract = new StellarSdk.Contract(this.aquaBlubPoolId);
      const userAddress = StellarSdk.nativeToScVal(
        this.adminKeypair.publicKey(),
        { type: 'address' },
      );

      const operation = poolContract.call('get_user_reward', userAddress);
      const result = await this.simulateTransaction(operation);

      const rewardInfo = StellarSdk.scValToNative(result.result.retval);

      // Return to_claim amount
      const toClaim = rewardInfo?.to_claim || rewardInfo || 0;
      return BigInt(toClaim);
    } catch (error) {
      this.logger.error(`Failed to get pending rewards: ${error.message}`);
      return 0n;
    }
  }

  /**
   * Claim rewards from AQUA/BLUB pool
   */
  private async claimPoolRewards(): Promise<bigint> {
    const poolContract = new StellarSdk.Contract(this.aquaBlubPoolId);
    const userAddress = StellarSdk.nativeToScVal(
      this.adminKeypair.publicKey(),
      { type: 'address' },
    );

    const operation = poolContract.call('claim', userAddress);

    const tx = await this.buildAndSignTransaction(operation);
    const response = await this.server.sendTransaction(tx);
    const confirmed = await this.pollTransactionStatus(response.hash);

    // Parse claimed amount from result
    const claimedAmount = this.parseClaimedAmount(confirmed);
    return claimedAmount;
  }

  /**
   * Parse claimed amount from transaction result
   */
  private parseClaimedAmount(txResult: any): bigint {
    try {
      // Try to get return value from result
      if (txResult.returnValue) {
        const value = StellarSdk.scValToNative(txResult.returnValue);
        return BigInt(value || 0);
      }

      // Fallback: parse from events
      const contractEventsXdr = txResult.events?.contractEventsXdr || [];
      for (const eventXdr of contractEventsXdr) {
        try {
          const contractEvent = StellarSdk.xdr.ContractEvent.fromXDR(eventXdr, 'base64');
          const body = contractEvent.body();
          if (!body) continue;

          let v0;
          try {
            v0 = body.v0();
          } catch {
            continue;
          }

          const topics = v0.topics();
          if (!topics || topics.length === 0) continue;

          const eventName = StellarSdk.scValToNative(topics[0]);
          if (String(eventName).toLowerCase().includes('claim')) {
            const eventData = v0.data();
            const data = eventData ? StellarSdk.scValToNative(eventData) : null;
            if (data) {
              // Return the claimed amount from event data
              const amount = Array.isArray(data) ? data[0] : data;
              return BigInt(amount || 0);
            }
          }
        } catch {
          continue;
        }
      }

      return 0n;
    } catch (error) {
      this.logger.warn(`Failed to parse claimed amount: ${error.message}`);
      return 0n;
    }
  }

  /**
   * Send AQUA to treasury address
   */
  private async sendToTreasury(amount: bigint): Promise<void> {
    // Use Soroban token transfer
    const aquaContract = new StellarSdk.Contract(this.aquaTokenId);

    const operation = aquaContract.call(
      'transfer',
      StellarSdk.nativeToScVal(this.adminKeypair.publicKey(), {
        type: 'address',
      }),
      StellarSdk.nativeToScVal(this.treasuryAddress, { type: 'address' }),
      StellarSdk.nativeToScVal(amount, { type: 'i128' }),
    );

    const tx = await this.buildAndSignTransaction(operation);
    const response = await this.server.sendTransaction(tx);
    await this.pollTransactionStatus(response.hash);
  }

  /**
   * Swap AQUA to BLUB via Aquarius Router
   */
  private async swapAquaToBlub(aquaAmount: bigint): Promise<bigint> {
    const routerContract = new StellarSdk.Contract(this.routerContractId);

    // Build swap path: AQUA -> BLUB
    const swapPath = [this.aquaTokenId, this.blubTokenId];

    // Allow 1% slippage
    const minBlubOut = (aquaAmount * 99n) / 100n;

    const operation = routerContract.call(
      'swap_exact_tokens_for_tokens',
      StellarSdk.nativeToScVal(aquaAmount, { type: 'i128' }),
      StellarSdk.nativeToScVal(minBlubOut, { type: 'i128' }),
      StellarSdk.nativeToScVal(swapPath, { type: 'vec' }),
      StellarSdk.nativeToScVal(this.adminKeypair.publicKey(), {
        type: 'address',
      }),
      StellarSdk.nativeToScVal(Math.floor(Date.now() / 1000) + 300, {
        type: 'u64',
      }), // 5 min deadline
    );

    const tx = await this.buildAndSignTransaction(operation);
    const response = await this.server.sendTransaction(tx);
    const confirmed = await this.pollTransactionStatus(response.hash);

    // Parse BLUB amount received from swap
    return this.parseSwapOutput(confirmed, aquaAmount);
  }

  /**
   * Parse swap output amount from transaction result
   */
  private parseSwapOutput(txResult: any, inputAmount: bigint): bigint {
    try {
      // Try return value first
      if (txResult.returnValue) {
        const value = StellarSdk.scValToNative(txResult.returnValue);
        // Router returns array of amounts [inputAmount, outputAmount]
        if (Array.isArray(value) && value.length >= 2) {
          return BigInt(value[value.length - 1] || 0);
        }
        return BigInt(value || 0);
      }

      // Fallback: assume 1:1 ratio (will be corrected by actual balance check)
      this.logger.warn(
        'Could not parse swap output, using input amount as estimate',
      );
      return inputAmount;
    } catch (error) {
      this.logger.warn(`Failed to parse swap output: ${error.message}`);
      return inputAmount;
    }
  }

  /**
   * Add BLUB rewards to staking contract
   * This calls the add_rewards function which distributes rewards to all stakers
   */
  private async addRewardsToStakingContract(blubAmount: bigint): Promise<void> {
    const stakingContract = new StellarSdk.Contract(this.stakingContractId);

    // First, transfer BLUB from admin to staking contract
    // The add_rewards function will handle the transfer internally,
    // but we need to approve the transfer first
    const blubContract = new StellarSdk.Contract(this.blubTokenId);

    // Approve staking contract to spend BLUB
    const approveOp = blubContract.call(
      'approve',
      StellarSdk.nativeToScVal(this.adminKeypair.publicKey(), {
        type: 'address',
      }),
      StellarSdk.nativeToScVal(this.stakingContractId, { type: 'address' }),
      StellarSdk.nativeToScVal(blubAmount, { type: 'i128' }),
      StellarSdk.nativeToScVal(Math.floor(Date.now() / 1000) + 3600, {
        type: 'u32',
      }), // 1 hour expiry
    );

    let approveTx = await this.buildAndSignTransaction(approveOp);
    let approveResponse = await this.server.sendTransaction(approveTx);
    await this.pollTransactionStatus(approveResponse.hash);

    // Call add_rewards on staking contract
    const addRewardsOp = stakingContract.call(
      'add_rewards',
      StellarSdk.nativeToScVal(this.adminKeypair.publicKey(), {
        type: 'address',
      }),
      StellarSdk.nativeToScVal(blubAmount, { type: 'i128' }),
    );

    const tx = await this.buildAndSignTransaction(addRewardsOp);
    const response = await this.server.sendTransaction(tx);
    const confirmed = await this.pollTransactionStatus(response.hash);

    // Log the event
    this.parseAddRewardsEvent(confirmed, blubAmount);
  }

  /**
   * Parse add_rewards event from transaction result
   */
  private parseAddRewardsEvent(txResult: any, amount: bigint): void {
    try {
      const contractEventsXdr = txResult.events?.contractEventsXdr || [];
      for (const eventXdr of contractEventsXdr) {
        try {
          const contractEvent = StellarSdk.xdr.ContractEvent.fromXDR(
            eventXdr,
            'base64',
          );
          const body = contractEvent.body();
          if (!body) continue;

          let v0;
          try {
            v0 = body.v0();
          } catch {
            continue;
          }

          const topics = v0.topics();
          if (!topics || topics.length === 0) continue;

          const eventName = StellarSdk.scValToNative(topics[0]);
          if (String(eventName) === 'rwd_add') {
            const eventData = v0.data();
            const data = eventData ? StellarSdk.scValToNative(eventData) : null;
            this.logger.log(`Rewards added event: ${JSON.stringify(data)}`);
            return;
          }
        } catch {
          continue;
        }
      }
    } catch (error) {
      this.logger.debug(`Failed to parse add_rewards event: ${error.message}`);
    }

    this.logger.log(`Added ${amount} BLUB rewards to staking contract`);
  }

  // ============================================================================
  // Manual Trigger (for testing)
  // ============================================================================

  /**
   * Manually trigger reward distribution (called from test controller)
   */
  async manualTrigger(): Promise<{ success: boolean; message: string }> {
    try {
      await this.handleStakingRewardDistribution();
      return {
        success: true,
        message: 'Staking reward distribution completed',
      };
    } catch (error) {
      return { success: false, message: error.message };
    }
  }

  /**
   * Get current reward status (for monitoring)
   */
  async getRewardStatus(): Promise<{
    pendingRewards: string;
    adminAddress: string;
    stakingContract: string;
  }> {
    const pendingRewards = await this.getPendingRewards();
    return {
      pendingRewards: pendingRewards.toString(),
      adminAddress: this.adminKeypair.publicKey(),
      stakingContract: this.stakingContractId,
    };
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
        // Handle "Bad union switch" - transaction succeeded but SDK can't parse
        if (error.message?.includes('Bad union switch')) {
          this.logger.warn(
            `XDR parse error for ${hash}, assuming success: ${error.message}`,
          );
          return { status: 'SUCCESS', hash };
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
