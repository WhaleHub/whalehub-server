import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
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
 * Three main responsibilities:
 *
 * 1. POL Deposit Handler (runs every 30 seconds):
 *    - Polls for pol_dep events from staking contract
 *    - When user locks AQUA, contract sends 10% AQUA + BLUB to admin
 *    - This service deposits those tokens to AQUA/BLUB pool (with ICE boost)
 *
 * 2. Pool 0 Reward Claim & Split (runs every 30 minutes):
 *    - Claims all AQUA rewards from pool 0 (BLUB-AQUA) via claim_and_compound
 *    - Contract sends 30% to treasury, 70% to manager
 *    - Splits the 70% proportionally between POL LP and vault LP:
 *      a) POL share → swap to BLUB → add_rewards() (staker distribution)
 *      b) Vault share → swap half to BLUB, keep half AQUA → admin_compound_deposit()
 *    - POL LP = total contract shares - PoolInfo.total_lp_tokens (vault)
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
  private readonly pool0ShareTokenId: string;

  // Track last processed event cursor to avoid duplicates
  private lastEventLedger: number = 0;
  private processedTxHashes: Set<string> = new Set();

  // Set to true by IceLockingService while an ICE lock is in progress.
  // POL deposit is paused during this window to prevent it from consuming
  // the AQUA that was just transferred from the contract for ICE locking.
  public isIceLockingActive = false;

  // Set to true while reward distribution is running so the POL deposit
  // fallback cron does not re-deposit claimed AQUA before it can be distributed.
  private isDistributing = false;

  // Tracks BLUB swapped but not yet distributed (for resume if add_rewards fails).
  // NEVER use getTokenBalance(blubTokenId) for this — blub-issuer-v2 is the SAC issuer
  // and balance() returns i64::MAX as a sentinel for the issuer account.
  private pendingBlubDistribution = 0n;

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
    this.pool0ShareTokenId = this.configService.get<string>('POOL0_SHARE_TOKEN_ID') || 'CDMRHKJCYYHZTRQVR7NY43PR7ISMRBYC2O57IMVAQ7B7P2I2XGIZLI5E';

    // Start event polling
    this.startEventPolling();
  }

  /**
   * Start polling for pol_dep events from staking contract
   */
  private startEventPolling() {
    this.logger.log('Starting POL deposit event polling...');

    setInterval(async () => {
      if (this.isIceLockingActive) {
        this.logger.debug('ICE locking in progress, skipping POL event poll');
        return;
      }
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
            topics: [['AAAADwAAAAdwb2xfZGVwAA==']], // "pol_dep" as SCVal symbol (SCV_SYMBOL, XDR-padded)
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
        } catch (error) {
          this.logger.error(
            `Failed to process event ${eventId}: ${error.message}`,
          );
        }

        // Mark as processed regardless of success/failure to prevent infinite retries
        // (e.g. admin has 0 AQUA — retrying won't help)
        this.processedTxHashes.add(eventId);

        // Keep set size manageable
        if (this.processedTxHashes.size > 10000) {
          const entries = Array.from(this.processedTxHashes);
          this.processedTxHashes = new Set(entries.slice(-5000));
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

      // Check admin AQUA balance before attempting deposit
      const aquaTokenId = this.configService.get<string>('AQUA_TOKEN_ID');
      const aquaContract = new StellarSdk.Contract(aquaTokenId);
      const balanceOp = aquaContract.call(
        'balance',
        StellarSdk.nativeToScVal(this.adminKeypair.publicKey(), { type: 'address' }),
      );
      const balanceResult = await this.simulateTransaction(balanceOp);
      const adminAqua = BigInt(StellarSdk.scValToNative(balanceResult.result.retval) || 0);

      if (adminAqua < aquaAmount) {
        this.logger.warn(
          `Insufficient AQUA for POL deposit: need=${aquaAmount}, have=${adminAqua}. Skipping.`,
        );
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
   * Deposit AQUA + BLUB as protocol-owned liquidity.
   *
   * LP shares accrue to the staking contract and are tracked in
   * `ProtocolOwnedLiquidity.aqua_blub_lp_position`. Vault accounting
   * (`pool_info.total_lp_tokens`) is untouched.
   *
   * Three txs: transfer AQUA, transfer BLUB, manual_deposit_pol.
   * We cannot bundle because Soroban allows only one InvokeHostFunction per tx,
   * and `manual_deposit_pol` reads the contract's token balance (not manager's).
   */
  private async depositToPool(
    aquaAmount: bigint,
    blubAmount: bigint,
  ): Promise<void> {
    await this.transferFromManagerToContract(this.aquaTokenId, aquaAmount);
    await this.transferFromManagerToContract(this.blubTokenId, blubAmount);

    const stakingContract = new StellarSdk.Contract(this.stakingContractId);
    const managerScVal = StellarSdk.nativeToScVal(
      this.adminKeypair.publicKey(),
      { type: 'address' },
    );

    const operation = stakingContract.call(
      'manual_deposit_pol',
      managerScVal,
      StellarSdk.nativeToScVal(aquaAmount, { type: 'i128' }),
      StellarSdk.nativeToScVal(blubAmount, { type: 'i128' }),
    );

    const tx = await this.buildAndSignTransaction(operation);
    const response = await this.server.sendTransaction(tx);
    await this.pollTransactionStatus(response.hash);

    this.logger.log(
      `POL deposited into staking contract: aqua=${aquaAmount} blub=${blubAmount} tx=${response.hash}`,
    );
  }

  /**
   * SAC transfer from the manager wallet to the staking contract.
   * Used to stage tokens before calling `manual_deposit_pol`, which expects
   * them to already be in the contract's balance.
   */
  private async transferFromManagerToContract(
    tokenId: string,
    amount: bigint,
  ): Promise<void> {
    const tokenContract = new StellarSdk.Contract(tokenId);
    const operation = tokenContract.call(
      'transfer',
      StellarSdk.nativeToScVal(this.adminKeypair.publicKey(), {
        type: 'address',
      }),
      StellarSdk.nativeToScVal(this.stakingContractId, { type: 'address' }),
      StellarSdk.nativeToScVal(amount, { type: 'i128' }),
    );
    const tx = await this.buildAndSignTransaction(operation);
    const response = await this.server.sendTransaction(tx);
    await this.pollTransactionStatus(response.hash);
    this.logger.debug(
      `Manager → contract transfer: token=${tokenId} amount=${amount} tx=${response.hash}`,
    );
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
  @Cron(CronExpression.EVERY_5_MINUTES, {
    name: 'pol-deposit-check',
    timeZone: 'UTC',
  })
  async handlePolDepositCheck() {
    if (this.isIceLockingActive) {
      this.logger.debug('ICE locking in progress, skipping POL deposit check');
      return;
    }
    if (this.isDistributing) {
      this.logger.debug('Reward distribution in progress, skipping POL deposit check');
      return;
    }
    try {
      await this.checkAndDepositPendingPol();
    } catch (error) {
      this.logger.error(`POL deposit check failed: ${error.message}`);
    }
  }

  /**
   * Check admin wallet balances and deposit any pending AQUA/BLUB to pool.
   *
   * Hard cap (`MAX_FALLBACK_AQUA`) prevents the SAC issuer-balance sentinel from
   * causing an uncapped BLUB mint if this fallback ever fires on AQUA that
   * `handleStakingRewardDistribution` should have processed itself. (Apr 2026
   * incident: ~36k BLUB silently minted into POL across ~90 missed runs because
   * the manager wallet *is* the BLUB issuer, so its `balance()` returns
   * `i128::MAX` and the previous 1:1 match line minted whatever AQUA happened
   * to be sitting there.)
   */
  private async checkAndDepositPendingPol(): Promise<void> {
    const MIN_AQUA_THRESHOLD = 1000000n; // 0.1 AQUA (7 decimals)
    // Per-run cap on AQUA (and matched BLUB) the fallback may deposit. Sized to
    // cover the largest expected single pol_dep event (10% AQUA from a user
    // lock). Anything larger almost certainly came from a missed reward claim
    // and should be handled by the reward distribution path, not minted as POL.
    const MAX_FALLBACK_AQUA = 100_000_000_000n; // 10,000 AQUA

    try {
      const aquaBalance = await this.getTokenBalance(this.aquaTokenId);

      this.logger.debug(`Admin AQUA balance: ${aquaBalance}`);

      if (aquaBalance < MIN_AQUA_THRESHOLD) {
        return; // Not enough to deposit
      }

      // We deliberately do NOT read BLUB balance: blub-issuer-v2 is the SAC
      // issuer and `balance()` returns the i128::MAX sentinel — meaningless for
      // sizing a deposit. The matched BLUB is minted by the issuer transfer.
      let depositAqua = aquaBalance;
      if (depositAqua > MAX_FALLBACK_AQUA) {
        this.logger.warn(
          `POL fallback: AQUA balance ${depositAqua} exceeds cap ${MAX_FALLBACK_AQUA}. Capping. ` +
            `Excess likely belongs to reward distribution, not POL.`,
        );
        depositAqua = MAX_FALLBACK_AQUA;
      }
      const depositBlub = depositAqua; // 1:1 match (issuer mints to pair)

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
   * Runs every 30 minutes to handle pool 0 (BLUB-AQUA) rewards.
   *
   * Pool 0 contains both POL LP and vault user LP. claim_and_compound claims
   * all rewards at once (30% treasury handled by contract, 70% sent to manager).
   * We split the 70% proportionally:
   *   - POL share → swap to BLUB → add_rewards (staker distribution)
   *   - Vault share → swap half to BLUB, keep half AQUA → admin_compound_deposit
   */
  @Cron('*/30 * * * *', {
    name: 'staking-reward-distribution',
    timeZone: 'UTC',
  })
  async handleStakingRewardDistribution() {
    this.logger.log('Starting pool 0 reward claim & split...');
    this.isDistributing = true;

    try {
      // Step 0: Resume guard — use in-memory state ONLY.
      // WARNING: Do NOT check BLUB token balance here. blub-issuer-v2 is the SAC issuer
      // and balance() returns i64::MAX (9223372036854775807) as a sentinel → catastrophic.
      if (this.pendingBlubDistribution > 0n) {
        this.logger.log(`Resume: distributing ${this.pendingBlubDistribution} BLUB from interrupted run`);
        await this.addRewardsToStakingContract(this.pendingBlubDistribution);
        this.pendingBlubDistribution = 0n;
        this.logger.log('Resume complete');
        return;
      }

      // Step 1: Check pending rewards for the contract's pool 0 LP position.
      const MIN_REWARD_THRESHOLD = 100_000_000n; // 10 AQUA (7 decimals)

      const contractRewards = await this.getPendingRewardsFor(this.stakingContractId);
      this.logger.log(`Pending pool 0 rewards: ${contractRewards}`);

      if (contractRewards < MIN_REWARD_THRESHOLD) {
        this.logger.log(`Rewards below threshold (${MIN_REWARD_THRESHOLD}). Skipping...`);
        return;
      }

      // Step 2: Get LP ratio BEFORE claiming (POL LP vs vault LP).
      // Total contract shares = share token balance of the staking contract.
      // Vault LP = PoolInfo.total_lp_tokens (tracked by contract on vault deposits).
      // POL LP = total - vault.
      const { polShare, vaultShare } = await this.getPool0LpRatio();
      this.logger.log(`LP ratio — POL: ${polShare}/10000, Vault: ${vaultShare}/10000`);

      // Step 3: Claim via claim_and_compound (30% treasury, 70% to manager).
      // The contract returns the compound_amount in its tuple — use that directly
      // rather than a balance delta, which races with stale Soroban simulation state.
      const receivedAqua = await this.claimViaStakingContract();
      this.logger.log(`AQUA received from claim: ${receivedAqua}`);

      if (receivedAqua < MIN_REWARD_THRESHOLD) {
        this.logger.log(`AQUA received (${receivedAqua}) below threshold. Skipping...`);
        return;
      }

      // Step 4: Split received AQUA proportionally.
      const polAqua = (receivedAqua * BigInt(polShare)) / 10000n;
      const vaultAqua = receivedAqua - polAqua;
      this.logger.log(`Split — POL: ${polAqua} AQUA, Vault: ${vaultAqua} AQUA`);

      // Step 5a: POL share → swap ALL to BLUB → add_rewards (staker distribution).
      if (polAqua > 0n) {
        let blubAmount = await this.swapAquaToBlub(polAqua);

        // Sanity cap: BLUB out should never exceed 10× AQUA in.
        const sanityCap = polAqua * 10n;
        if (blubAmount > sanityCap) {
          this.logger.error(
            `BLUB amount ${blubAmount} exceeds sanity cap (10× polAqua=${sanityCap}). Capping.`,
          );
          blubAmount = polAqua;
        }

        // Hard cap per run.
        const MAX_BLUB_PER_RUN = 1_000_000_000_000n; // 100,000 BLUB
        if (blubAmount > MAX_BLUB_PER_RUN) {
          this.logger.error(`BLUB ${blubAmount} exceeds hard cap ${MAX_BLUB_PER_RUN}. Capping.`);
          blubAmount = MAX_BLUB_PER_RUN;
        }

        if (blubAmount > 0n) {
          this.pendingBlubDistribution = blubAmount;
          await this.addRewardsToStakingContract(blubAmount);
          this.pendingBlubDistribution = 0n;
          this.logger.log(`POL: Added ${blubAmount} BLUB rewards to stakers`);
        }
      }

      // Step 5b: Vault share → swap half to BLUB (token_a), keep half AQUA (token_b)
      //          → admin_compound_deposit to grow vault LP.
      if (vaultAqua > 0n) {
        const aquaForCompound = vaultAqua / 2n;
        const aquaToSwap = vaultAqua - aquaForCompound;

        if (aquaToSwap > 0n && aquaForCompound > 0n) {
          const blubForCompound = await this.swapAquaToBlub(aquaToSwap);
          if (blubForCompound > 0n) {
            // Pool 0: token_a = BLUB, token_b = AQUA
            await this.adminCompoundDeposit(0, blubForCompound, aquaForCompound);
            this.logger.log(
              `Vault: Compounded ${blubForCompound} BLUB + ${aquaForCompound} AQUA into pool 0`,
            );
          }
        }
      }

      this.logger.log(
        `Pool 0 complete: received=${receivedAqua}, polAqua=${polAqua}, vaultAqua=${vaultAqua}`,
      );
    } catch (error) {
      this.logger.error(
        `Pool 0 reward claim & split failed: ${error.message}`,
        error.stack,
      );
    } finally {
      this.isDistributing = false;
    }
  }

  /**
   * Get pending rewards from AQUA/BLUB pool for a specific address (admin or staking contract).
   */
  private async getPendingRewardsFor(address: string): Promise<bigint> {
    try {
      const poolContract = new StellarSdk.Contract(this.aquaBlubPoolId);
      const userAddress = StellarSdk.nativeToScVal(address, { type: 'address' });
      const operation = poolContract.call('get_user_reward', userAddress);
      const result = await this.simulateTransaction(operation);
      const rewardAmount = StellarSdk.scValToNative(result.result.retval);
      return BigInt(rewardAmount || 0);
    } catch (error) {
      this.logger.debug(`getPendingRewardsFor(${address}): ${error.message}`);
      return 0n;
    }
  }

  /**
   * Claim rewards when LP is in the staking contract.
   * Calls claim_and_compound on the staking contract (pool_id=0 = BLUB-AQUA).
   * Contract claims AQUA from Aquarius, sends 30% to treasury, 70% to manager,
   * and returns `(total_rewards, treasury_amount, compound_amount)`.
   *
   * Returns the `compound_amount` (AQUA sent to manager). Reading the tuple
   * directly avoids a stale-balance-delta race: a post-claim simulated
   * `balance()` can return pre-claim state for several seconds, which previously
   * caused `add_rewards` to be skipped while the POL fallback re-injected
   * the AQUA as fresh LP (minting matching BLUB).
   */
  private async claimViaStakingContract(): Promise<bigint> {
    const stakingContract = new StellarSdk.Contract(this.stakingContractId);
    const managerScVal = StellarSdk.nativeToScVal(this.adminKeypair.publicKey(), { type: 'address' });
    const poolIdScVal = StellarSdk.nativeToScVal(0, { type: 'u32' }); // pool 0 = BLUB-AQUA

    // Snapshot manager AQUA BEFORE submitting the claim so the fallback
    // delta-read has a real baseline. Reading after confirmation gives a
    // baseline that already includes the claimed AQUA → delta=0 → cron
    // skipped add_rewards and the POL fallback re-injected the AQUA as LP.
    const preClaimAqua = await this.getTokenBalance(this.aquaTokenId);

    const operation = stakingContract.call('claim_and_compound', managerScVal, poolIdScVal);
    const tx = await this.buildAndSignTransaction(operation);
    const response = await this.server.sendTransaction(tx);
    const confirmed = await this.pollTransactionStatus(response.hash);

    this.logger.log(`claim_and_compound submitted: tx=${response.hash}`);

    const compoundAmount = this.parseClaimCompoundReturn(confirmed);
    if (compoundAmount > 0n) {
      this.logger.log(`claim_and_compound: manager received ${compoundAmount} AQUA (from tuple return)`);
      return compoundAmount;
    }

    // Return-value parse failed (e.g. SDK XDR "Bad union switch" — pollTransactionStatus
    // returns a synthetic SUCCESS without returnValue). Fall back to a retried balance
    // read so we still pick up the AQUA instead of skipping.
    return await this.readManagerAquaDelta(preClaimAqua);
  }

  /**
   * Parse the `(total_rewards, treasury_amount, compound_amount)` tuple
   * returned by `claim_and_compound`. Returns the manager-bound amount.
   */
  private parseClaimCompoundReturn(txResult: any): bigint {
    try {
      if (!txResult?.returnValue) return 0n;
      const value = StellarSdk.scValToNative(txResult.returnValue);
      if (Array.isArray(value) && value.length >= 3) {
        return BigInt(value[2] || 0);
      }
      // Older SDK shapes can decode the tuple as an object
      if (value && typeof value === 'object') {
        const candidate = (value as any)[2] ?? (value as any).compound_amount;
        if (candidate != null) return BigInt(candidate);
      }
    } catch (err: any) {
      this.logger.debug(`parseClaimCompoundReturn failed: ${err.message}`);
    }
    return 0n;
  }

  /**
   * Fallback when claim's tuple return is unavailable: read the manager's AQUA
   * delta against a baseline captured BEFORE the claim transaction was
   * submitted. Soroban simulated balance can lag a few seconds after a tx
   * confirms, so we retry until the delta materialises or we time out.
   */
  private async readManagerAquaDelta(baseline: bigint): Promise<bigint> {
    for (let i = 0; i < 8; i++) {
      const current = await this.getTokenBalance(this.aquaTokenId);
      if (current > baseline) {
        const delta = current - baseline;
        this.logger.log(`Manager AQUA delta observed after ${(i + 1) * 2.5}s: ${delta}`);
        return delta;
      }
      await this.sleep(2500);
    }
    this.logger.warn('Manager AQUA balance did not increase within retry window');
    return 0n;
  }

  /**
   * Get pool 0 LP ratio: how much is POL vs vault, in basis points (out of 10000).
   * POL LP = total contract share token balance - PoolInfo.total_lp_tokens (vault).
   */
  private async getPool0LpRatio(): Promise<{ polShare: number; vaultShare: number }> {
    // Get total LP shares held by the staking contract (share token balance)
    const shareTokenContract = new StellarSdk.Contract(this.pool0ShareTokenId);
    const balanceOp = shareTokenContract.call(
      'balance',
      StellarSdk.nativeToScVal(this.stakingContractId, { type: 'address' }),
    );
    const balanceResult = await this.simulateTransaction(balanceOp);
    const totalShares = BigInt(StellarSdk.scValToNative(balanceResult.result.retval) || 0);

    // Get vault LP from PoolInfo.total_lp_tokens
    const stakingContract = new StellarSdk.Contract(this.stakingContractId);
    const poolInfoOp = stakingContract.call(
      'get_pool_info',
      StellarSdk.nativeToScVal(0, { type: 'u32' }),
    );
    const poolInfoResult = await this.simulateTransaction(poolInfoOp);
    const poolInfo = StellarSdk.scValToNative(poolInfoResult.result.retval);
    const vaultLp = BigInt(poolInfo.total_lp_tokens || 0);

    if (totalShares <= 0n) {
      this.logger.warn('Total shares is 0, defaulting to 100% POL');
      return { polShare: 10000, vaultShare: 0 };
    }

    const polLp = totalShares > vaultLp ? totalShares - vaultLp : 0n;
    const polBps = Number((polLp * 10000n) / totalShares);
    const vaultBps = 10000 - polBps;

    return { polShare: polBps, vaultShare: vaultBps };
  }

  /**
   * Deposit tokens into pool 0 via the staking contract's admin_compound_deposit.
   * Pool 0: token_a = BLUB, token_b = AQUA.
   */
  private async adminCompoundDeposit(
    poolId: number,
    amountA: bigint,
    amountB: bigint,
  ): Promise<bigint> {
    const contract = new StellarSdk.Contract(this.stakingContractId);
    const managerScVal = StellarSdk.nativeToScVal(this.adminKeypair.publicKey(), { type: 'address' });

    const operation = contract.call(
      'admin_compound_deposit',
      managerScVal,
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
   * Swap AQUA to BLUB via Aquarius Router.
   * Simulates first to get the real expected output, then submits with 5% slippage.
   */
  private async swapAquaToBlub(aquaAmount: bigint): Promise<bigint> {
    const routerContract = new StellarSdk.Contract(this.routerContractId);

    // Router swap: swap(user, tokens, token_in, token_out, pool_index, in_amount, out_min)
    const tokensVec = StellarSdk.xdr.ScVal.scvVec([
      StellarSdk.nativeToScVal(this.aquaTokenId, { type: 'address' }),
      StellarSdk.nativeToScVal(this.blubTokenId, { type: 'address' }),
    ]);

    // Pool index from pool creation
    const poolIndex = Buffer.from(
      '0240dd5b4021e9373c226b8810d95628a38fa8e46a6356c57655688f0f62b5cf',
      'hex',
    );

    // Simulate with out_min=0 to get real expected output, then apply 5% slippage.
    // This avoids hardcoding a 1:1 AQUA:BLUB ratio assumption.
    const simulateOp = routerContract.call(
      'swap',
      StellarSdk.nativeToScVal(this.adminKeypair.publicKey(), { type: 'address' }),
      tokensVec,
      StellarSdk.nativeToScVal(this.aquaTokenId, { type: 'address' }),
      StellarSdk.nativeToScVal(this.blubTokenId, { type: 'address' }),
      StellarSdk.nativeToScVal(poolIndex, { type: 'bytes' }),
      StellarSdk.nativeToScVal(aquaAmount, { type: 'u128' }),
      StellarSdk.nativeToScVal(0n, { type: 'u128' }),
    );

    let minBlubOut = 1n; // fallback: accept any output
    let simulatedExpectedOut = 0n; // track for fallback — prefer over inputAmount
    try {
      const simResult = await this.simulateTransaction(simulateOp);
      const expectedOut = BigInt(
        StellarSdk.scValToNative(simResult.result.retval) || 0,
      );
      if (expectedOut > 0n) {
        simulatedExpectedOut = expectedOut;
        minBlubOut = (expectedOut * 95n) / 100n; // 5% slippage on real price
        this.logger.log(
          `Swap simulation: expected ${expectedOut} BLUB, min ${minBlubOut} BLUB`,
        );
      }
    } catch (simError) {
      this.logger.warn(
        `Swap simulation failed, using min=1: ${simError.message}`,
      );
    }

    const operation = routerContract.call(
      'swap',
      StellarSdk.nativeToScVal(this.adminKeypair.publicKey(), { type: 'address' }),
      tokensVec,
      StellarSdk.nativeToScVal(this.aquaTokenId, { type: 'address' }),
      StellarSdk.nativeToScVal(this.blubTokenId, { type: 'address' }),
      StellarSdk.nativeToScVal(poolIndex, { type: 'bytes' }),
      StellarSdk.nativeToScVal(aquaAmount, { type: 'u128' }),
      StellarSdk.nativeToScVal(minBlubOut, { type: 'u128' }),
    );

    const tx = await this.buildAndSignTransaction(operation);
    const response = await this.server.sendTransaction(tx);
    const confirmed = await this.pollTransactionStatus(response.hash);

    // Parse BLUB amount received from swap.
    // Pass 0n as the fallback indicator — if parsing fails we use the simulation estimate.
    // NEVER fall back to aquaAmount: BLUB and AQUA are different tokens with different prices.
    const parsed = this.parseSwapOutput(confirmed, 0n);
    if (parsed > 0n) {
      return parsed;
    }
    if (simulatedExpectedOut > 0n) {
      // Apply conservative 5% discount to simulation estimate
      const conservative = (simulatedExpectedOut * 95n) / 100n;
      this.logger.warn(`Using simulation estimate as fallback: ${conservative} BLUB`);
      return conservative;
    }
    // Last resort: 0 (caller will skip distribution)
    this.logger.error('Could not determine BLUB received from swap — returning 0 to skip distribution');
    return 0n;
  }

  /**
   * Parse swap output amount from transaction result.
   * Returns 0n if parsing fails — caller must handle the fallback, NOT this method.
   * Never assume 1:1 between input and output tokens.
   */
  private parseSwapOutput(txResult: any, _fallback: bigint): bigint {
    try {
      if (txResult.returnValue) {
        const value = StellarSdk.scValToNative(txResult.returnValue);
        // Router returns array of amounts [inputAmount, outputAmount]
        if (Array.isArray(value) && value.length >= 2) {
          return BigInt(value[value.length - 1] || 0);
        }
        return BigInt(value || 0);
      }
    } catch (error) {
      this.logger.warn(`Failed to parse swap output: ${error.message}`);
    }
    return 0n; // Caller decides the fallback
  }

  /**
   * Add BLUB rewards to staking contract
   * This calls the add_rewards function which distributes rewards to all stakers
   */
  private async addRewardsToStakingContract(blubAmount: bigint): Promise<void> {
    const stakingContract = new StellarSdk.Contract(this.stakingContractId);
    const blubContract = new StellarSdk.Contract(this.blubTokenId);

    // Retry helper for 429 rate-limit errors
    const withRetry = async <T>(fn: () => Promise<T>, label: string, maxTries = 3): Promise<T> => {
      for (let i = 1; i <= maxTries; i++) {
        try {
          return await fn();
        } catch (err: any) {
          const is429 = err?.response?.status === 429 || err?.message?.includes('429');
          if (is429 && i < maxTries) {
            const delay = 5000 * i;
            this.logger.warn(`${label}: 429 rate limit, retrying in ${delay}ms (attempt ${i}/${maxTries})`);
            await this.sleep(delay);
            continue;
          }
          throw err;
        }
      }
    };

    // Approve staking contract to spend BLUB.
    // expiry_ledger is a ledger number; ~720 ledgers ≈ 1 hour at 5s/ledger.
    const latestLedger = await withRetry(
      () => this.server.getLatestLedger().then(r => r.sequence),
      'getLatestLedger',
    );
    const approveOp = blubContract.call(
      'approve',
      StellarSdk.nativeToScVal(this.adminKeypair.publicKey(), { type: 'address' }),
      StellarSdk.nativeToScVal(this.stakingContractId, { type: 'address' }),
      StellarSdk.nativeToScVal(blubAmount, { type: 'i128' }),
      StellarSdk.nativeToScVal(latestLedger + 720, { type: 'u32' }),
    );

    const approveTx = await withRetry(() => this.buildAndSignTransaction(approveOp), 'approve-build');
    const approveResponse = await withRetry(() => this.server.sendTransaction(approveTx), 'approve-send');
    await this.pollTransactionStatus(approveResponse.hash);

    // Small delay between approve and add_rewards to stay under rate limit
    await this.sleep(3000);

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

          let v0: StellarSdk.xdr.ContractEventV0;
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
    const pendingRewards = await this.getPendingRewardsFor(this.stakingContractId);
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
        if (error.message?.includes('not found') || error.message?.includes('NOT_FOUND')) {
          // Transaction not yet confirmed, keep polling
          await this.sleep(2000);
          continue;
        }
        if (error.message?.includes('Bad union switch')) {
          // Stellar SDK XDR parse bug — transaction succeeded on-chain but SDK can't parse result
          this.logger.warn(`XDR parse error (Bad union switch) for ${hash}, assuming success`);
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
