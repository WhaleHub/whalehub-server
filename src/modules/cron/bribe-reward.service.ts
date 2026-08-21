import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
// Kept while the @Cron decorator(s) below are commented out (crons paused).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { Cron } from '@nestjs/schedule';
import * as StellarSdk from '@stellar/stellar-sdk';
import { Keypair, Networks, TransactionBuilder } from '@stellar/stellar-sdk';
import * as fs from 'fs';
import * as path from 'path';
import {
  acquireWalletLock,
  releaseWalletLock,
  iceReservedStroops,
} from './wallet-coordination';

// Use max fee to avoid transaction failures during network congestion.
const MAX_FEE = '1000000'; // 0.1 XLM

/** Result of one three-way harvest split. All amounts in stroops. */
interface SplitOutcome {
  totalAqua: bigint;
  stakerAqua: bigint;
  vaultAqua: bigint;
  polAqua: bigint;
  blubToStakers: bigint;
  vaultLpMinted: bigint;
  polAquaDeposited: bigint;
  polBlubDeposited: bigint;
  /** Streams that failed; their AQUA stays in the manager wallet. */
  errors: string[];
}

/** Which streams have completed on-chain within the current batch. */
interface StreamProgress {
  stakers: boolean;
  vault: boolean;
  pol: boolean;
}

/**
 * Bribe Reward Distribution Service
 * ---------------------------------
 *
 * Background (2026-06): Pool 0 (BLUB-AQUA) was de-whitelisted by Aquarius, so it
 * emits 0 AQUA. WhaleHub redirected its upvote-ICE votes to the top AQUA pair and
 * now earns **Aquarius bribes** — confirmed ~50-55K AQUA/day arriving as plain
 * classic Stellar payments from the Aquarius bribe collection address.
 *
 * SELF-POWERED REWARD ENGINE (2026-08): the harvest no longer goes 100% to
 * stakers. Each batch is split three ways (bps configurable, must sum to 10000):
 *
 *   Stream A — stakers, 50%  (BRIBE_STAKER_BPS)
 *       AQUA -> BLUB on the Aquarius router, then add_rewards() on the staking
 *       contract (Synthetix-style payout). Open-market buy pressure, half throttle.
 *
 *   Stream B — AQUA/BLUB vault LPs, 30%  (BRIBE_VAULT_BPS)
 *       Half the tranche is swapped to BLUB, then admin_compound_deposit(pool 0)
 *       mints LP into the vault. That call raises `pool_info.total_lp_tokens`
 *       WITHOUT minting vault shares, so every existing depositor's position
 *       (shares x total_lp / total_shares) grows pro-rata. No claims, no sell
 *       pressure — the reward becomes depth.
 *
 *   Stream C — protocol-owned liquidity, 20%  (BRIBE_POL_BPS)
 *       Half swapped to BLUB, both legs transferred to the staking contract,
 *       then manual_deposit_pol(). POL LP is tracked in
 *       `ProtocolOwnedLiquidity.aqua_blub_lp_position`, which is NOT part of
 *       `total_lp_tokens`, so POL earns nothing from Stream B. The
 *       "POL is excluded from LP rewards" rule is enforced by architecture.
 *
 * Pipeline per batch:
 *   1. Detect new bribe payments from the bribe sender (Horizon payments cursor).
 *   2. Split the FULL batch A/B/C — no treasury cut is taken on bribe income —
 *      and run each stream independently: one failing stream never blocks the
 *      others, and its AQUA simply stays in the manager wallet.
 *
 * --- Why this design (see commit context / project memory) ---
 *
 * Wallet commingling: bribes land in the SAME manager wallet used by
 * claim_and_compound, POL deposits, and (formerly) ICE locking. We therefore do
 * NOT read the wallet balance to size distribution — we track payments FROM the
 * bribe sender via a persisted Horizon paging_token cursor and route exactly the
 * AQUA that arrived as bribes. This mirrors the event/exact-amount pattern used
 * for POL deposits.
 *
 * ICE-locking conflict: ICE-locking's Step 0b used to sweep ALL admin-wallet AQUA
 * into 5-year ICE locks every 4h, which would have eaten the bribes. As of
 * 2026-06-08 the auto ICE-locking cron is PAUSED (see ice-locking.service.ts), so
 * the manager wallet's classic AQUA is this service's to manage.
 *
 * No database: TypeORM is disabled in this server (app.module.ts). For
 * restart-safety and dual-instance (PM2) safety we persist the cursor to a small
 * JSON file guarded by an exclusive lock file. A two-phase cursor (pending vs
 * confirmed) means that if the process dies mid-distribution we refuse to
 * auto-replay — a human must resolve, preventing a silent double add_rewards.
 */
@Injectable()
export class BribeRewardService {
  private readonly logger = new Logger(BribeRewardService.name);
  private readonly server: StellarSdk.SorobanRpc.Server;
  // Separate RPC for WRITES + their confirmation. sorobanrpc.com reliably TIMES
  // OUT submitting complex txs (e.g. the Aquarius router swap) — it returns a
  // hash but the tx is never included, so polling times out. The gateway.fm RPC
  // handles write submission reliably (documented project pattern). Reads/sims
  // stay on `server` (sorobanrpc.com).
  private readonly sendServer: StellarSdk.SorobanRpc.Server;
  private readonly horizonServer: StellarSdk.Horizon.Server;
  private readonly adminKeypair: Keypair;
  private readonly stakingContractId: string;
  private readonly aquaTokenId: string;
  private readonly blubTokenId: string;
  private readonly routerContractId: string;

  // Aquarius bribe collection address — confirmed on-chain as the sender of the
  // daily AQUA bribe payments into the manager wallet. Override via env if the
  // collector address ever changes.
  private readonly bribeSender: string;

  // Three-way split of the FULL harvest (basis points, must sum to 10000).
  // There is no treasury cut on bribe income — 100% is recycled:
  //   staker -> AQUA swapped to BLUB -> add_rewards
  //   vault  -> half swapped to BLUB -> admin_compound_deposit(pool 0)
  //   pol    -> half swapped to BLUB -> manual_deposit_pol
  private readonly bribeStakerBps: number;
  private readonly bribeVaultBps: number;
  private readonly bribePolBps: number;

  // Vault pool that receives Stream B and Stream C: pool 0 = BLUB-AQUA.
  // In PoolInfo(0), token_a = BLUB and token_b = AQUA.
  private static readonly POOL0_ID = 0;

  // BLUB-AQUA pool index for the Aquarius router swap (same pool the staking
  // reward service uses). Hex bytes from pool creation.
  private readonly poolIndexHex: string;

  // Per-swap chunk size (AQUA stroops). Large single swaps move the stableswap
  // and incur slippage; we split into chunks to limit price impact.
  private readonly swapChunkAqua: bigint;

  // Hard cap on BLUB distributed per run (stroops). Belt-and-braces against a
  // mispriced swap. Configurable; default 200,000 BLUB.
  private readonly maxBlubPerRun: bigint;

  // Minimum AQUA (stroops) worth distributing — below this we just advance the
  // cursor and skip. 10 AQUA.
  private static readonly MIN_AQUA_THRESHOLD = 100_000_000n;

  // Auto-cron threshold: wait for a real bribe (>= 5,000 AQUA) before the daily
  // balance-based cron distributes, so dust / partial balances don't trigger a
  // run. Bribes are ~50K AQUA.
  private static readonly AUTO_MIN_AQUA = 50_000_000_000n;

  // Smallest tranche worth running as its own stream (20 AQUA). Below this the
  // swap + deposit transactions cost more than the tranche is worth, so the
  // tranche folds back into the staker stream.
  private static readonly MIN_STREAM_AQUA = 200_000_000n;

  // Contract-side cap inside add_rewards: 100,000 BLUB (7 dp) per call. Anything
  // larger reverts with InvalidInput (#4), so the staker stream is chunked.
  private static readonly MAX_BLUB_PER_ADD_REWARDS = 1_000_000_000_000n;

  // State + lock file paths.
  private readonly stateFile: string;
  private readonly lockFile: string;

  // Treat a lock older than this as stale (previous holder crashed).
  private static readonly LOCK_STALE_MS = 15 * 60 * 1000;

  constructor(private configService: ConfigService) {
    const rpcUrl = this.configService.get<string>('SOROBAN_RPC_URL');
    this.server = new StellarSdk.SorobanRpc.Server(rpcUrl);

    // Writes go through the gateway.fm RPC (same as the working frontend/vault
    // swap path). sorobanrpc.com hands back a tx hash but never includes complex
    // router swaps -> polling times out. Configurable via SOROBAN_SEND_RPC_URL.
    const sendRpcUrl =
      this.configService.get<string>('SOROBAN_SEND_RPC_URL') ||
      'https://soroban-rpc.mainnet.stellar.gateway.fm';
    this.sendServer = new StellarSdk.SorobanRpc.Server(sendRpcUrl);

    const horizonUrl = this.configService.get<string>('STELLAR_HORIZON_URL');
    this.horizonServer = new StellarSdk.Horizon.Server(horizonUrl);

    const adminSecret = this.configService.get<string>('ADMIN_SECRET_KEY');
    this.adminKeypair = Keypair.fromSecret(adminSecret);

    this.stakingContractId = this.configService.get<string>(
      'STAKING_CONTRACT_ID',
    );
    this.aquaTokenId = this.configService.get<string>('AQUA_TOKEN_ID');
    this.blubTokenId = this.configService.get<string>('BLUB_TOKEN_ID');
    this.routerContractId = this.configService.get<string>(
      'AQUARIUS_ROUTER_CONTRACT_ID',
    );

    this.bribeSender =
      this.configService.get<string>('BRIBE_SENDER_ADDRESS') ||
      'GAORXNBAWRIOJ7HRMCTWW2MIB6PYWSC7OKHGIXWTJXYRTZRSHP356TW3';

    // Three-way split of the FULL harvest. Defaults are the Self-Powered Reward
    // Engine ratios: 50% stakers / 30% vault LPs / 20% POL. No treasury cut is
    // taken on bribe income (since 2026-07), and BRIBE_TREASURY_BPS is no longer
    // read — a treasury line would have to be reintroduced in code.
    let stakerBps = Number(
      this.configService.get<string>('BRIBE_STAKER_BPS') ?? '5000',
    );
    let vaultBps = Number(
      this.configService.get<string>('BRIBE_VAULT_BPS') ?? '3000',
    );
    let polBps = Number(
      this.configService.get<string>('BRIBE_POL_BPS') ?? '2000',
    );
    const bpsValid =
      [stakerBps, vaultBps, polBps].every(
        (v) => Number.isFinite(v) && v >= 0 && v <= 10000,
      ) && stakerBps + vaultBps + polBps === 10000;
    if (!bpsValid) {
      // Never guess at a split. Fall back to the previous behaviour (everything
      // to stakers), which is safe and reversible, and say so loudly.
      this.logger.error(
        `Invalid bribe split (staker=${stakerBps} vault=${vaultBps} pol=${polBps}); ` +
          `must be 0..10000 and sum to 10000. Falling back to 100% stakers.`,
      );
      stakerBps = 10000;
      vaultBps = 0;
      polBps = 0;
    }
    this.bribeStakerBps = stakerBps;
    this.bribeVaultBps = vaultBps;
    this.bribePolBps = polBps;

    this.poolIndexHex =
      this.configService.get<string>('AQUA_BLUB_POOL_INDEX_HEX') ||
      '0240dd5b4021e9373c226b8810d95628a38fa8e46a6356c57655688f0f62b5cf';

    this.swapChunkAqua = BigInt(
      this.configService.get<string>('BRIBE_SWAP_CHUNK_AQUA_STROOPS') ||
        '100000000000', // 10,000 AQUA
    );
    this.maxBlubPerRun = BigInt(
      this.configService.get<string>('BRIBE_MAX_BLUB_PER_RUN_STROOPS') ||
        '2000000000000', // 200,000 BLUB
    );

    const stateDir =
      this.configService.get<string>('BRIBE_STATE_DIR') ||
      path.join(process.cwd(), '.whalehub-state');
    this.stateFile = path.join(stateDir, 'bribe-cursor.json');
    this.lockFile = path.join(stateDir, 'bribe-reward.lock');

    try {
      fs.mkdirSync(stateDir, { recursive: true });
    } catch (e) {
      this.logger.warn(`Could not create state dir ${stateDir}: ${e.message}`);
    }

    this.logger.log(
      `BribeRewardService ready. manager=${this.adminKeypair.publicKey()} ` +
        `sender=${this.bribeSender} treasury=none ` +
        `split=${this.bribeStakerBps}/${this.bribeVaultBps}/${this.bribePolBps} ` +
        `(stakers/vault/POL) state=${this.stateFile}`,
    );
  }

  // ==========================================================================
  // Cron entrypoint
  // ==========================================================================

  /**
   * Daily bribe distribution — runs every 6h (catches a bribe within 6h of it
   * landing). BALANCE-BASED (not cursor-based) so it is safe across
   * DigitalOcean's 2 instances: once one instance drains the wallet AQUA, the
   * other and all later ticks read ~0 and skip. Layered defenses against a
   * simultaneous cross-instance double-run:
   *   1. random 0-60s startup jitter so the two instances desync — the leader
   *      drains the wallet before the follower reads the balance;
   *   2. per-instance file lock (same-instance overlap);
   *   3. Stellar sequence-number collision (only one tx with a given seq lands).
   * For 100% safety run the backend as a SINGLE instance — then the file lock is
   * authoritative. A real daily bribe (>= AUTO_MIN_AQUA) is distributed; dust is
   * ignored. The batch is then split three ways — stakers / vault LPs / POL —
   * by `runSplit`.
   */
  // PAUSED 2026-07-27 — all transacting crons stopped (see ice-locking.service.ts).
  // Bribe AQUA now accumulates in the manager wallet until this is uncommented
  // or POST /test/bribe-reward is called manually.
  @Cron('0 */6 * * *', { name: 'bribe-reward-distribution', timeZone: 'UTC' })
  async handleBribeRewardDistribution(): Promise<void> {
    // De-sync the two DO instances so the leader drains the wallet first.
    await this.sleep(Math.floor(Math.random() * 60000));

    if (!this.acquireLock()) {
      this.logger.debug(
        'Bribe distribution lock held by another run, skipping',
      );
      return;
    }

    // Cross-cron mutex: do not touch wallet AQUA while the ICE cron is moving it.
    if (!acquireWalletLock('bribe-reward')) {
      this.logger.log(
        'Wallet lock held by the ICE cron; skipping this bribe tick.',
      );
      this.releaseLock();
      return;
    }

    try {
      const walletBalance = await this.getManagerAquaBalance();
      // Subtract any AQUA reserved for an in-flight (or halted) ICE lock so we never
      // swap ICE-destined AQUA to stakers. See wallet-coordination.ts.
      const iceReserved = iceReservedStroops();
      const balance =
        walletBalance > iceReserved ? walletBalance - iceReserved : 0n;
      this.logger.log(
        `Bribe cron: wallet AQUA ${walletBalance}, ICE-reserved ${iceReserved}, ` +
          `distributable ${balance}`,
      );
      if (balance < BribeRewardService.AUTO_MIN_AQUA) {
        this.logger.log(
          `Distributable ${balance} below auto threshold ${BribeRewardService.AUTO_MIN_AQUA}; nothing to distribute`,
        );
        return;
      }

      const outcome = await this.runSplit(balance, 'cron');

      const state = this.loadState();
      state.lastDistributedAt = new Date().toISOString();
      state.lastBlub = outcome.blubToStakers.toString();
      state.lastAqua = balance.toString();
      state.lastSplit = this.describeOutcome(outcome);
      this.saveState(state);
    } catch (error) {
      this.logger.error(
        `Bribe reward distribution failed: ${error.message}`,
        error.stack,
      );
    } finally {
      releaseWalletLock();
      this.releaseLock();
    }
  }

  private async runDistribution(): Promise<void> {
    const state = this.loadState();

    // Crash-safety: a non-null `pending` means a prior run set the new cursor and
    // started distributing but never confirmed. We must NOT auto-replay — that
    // could double add_rewards. Surface loudly and require manual resolution
    // (POST /test/bribe-reward/resolve once the on-chain state is confirmed).
    if (state.pending) {
      this.logger.error(
        '==================================================================\n' +
          `❌ BRIBE DISTRIBUTION HALTED: a prior run crashed mid-distribution.\n` +
          `   pendingCursor=${state.pending} pendingAmount=${state.pendingAmount} ` +
          `at=${state.pendingAt}\n` +
          `   Check whether add_rewards landed on-chain, then resolve via ` +
          `POST /test/bribe-reward/resolve?committed=true|false.\n` +
          '==================================================================',
      );
      return;
    }

    // First-ever run: initialise the cursor to the latest payment so we only
    // process bribes that arrive AFTER deploy (never replay pre-deploy history,
    // which may already have been swept into ICE or otherwise handled).
    if (!state.cursor) {
      const latest = await this.getLatestPagingToken();
      state.cursor = latest;
      this.saveState(state);
      this.logger.log(
        `Initialised bribe cursor to latest paging_token=${latest}. ` +
          `Only bribes arriving after now will be distributed.`,
      );
      return;
    }

    // Collect new bribe AQUA since the cursor.
    const { totalAqua, newCursor } = await this.collectNewBribes(state.cursor);

    if (newCursor === state.cursor) {
      this.logger.debug('No new payments since last cursor');
      return;
    }

    if (totalAqua < BribeRewardService.MIN_AQUA_THRESHOLD) {
      // There were payments, but no/insufficient bribe AQUA — just advance.
      this.logger.log(
        `New payments seen but bribe AQUA (${totalAqua}) below threshold; ` +
          `advancing cursor ${state.cursor} -> ${newCursor}`,
      );
      state.cursor = newCursor;
      this.saveState(state);
      return;
    }

    this.logger.log(
      `New bribe AQUA detected: ${totalAqua} (cursor ${state.cursor} -> ${newCursor})`,
    );

    // Phase 1: record the in-flight batch BEFORE moving any funds.
    state.pending = newCursor;
    state.pendingAmount = totalAqua.toString();
    state.pendingAt = new Date().toISOString();
    this.saveState(state);

    // Three-way split of the full batch. Each stream records
    // its progress into the pending marker, so a crash mid-run is diagnosable:
    // `getStatus` / `resolvePending` show exactly which streams landed on-chain.
    const outcome = await this.runSplit(totalAqua, 'cursor', (progress) => {
      state.pendingStreams = progress;
      this.saveState(state);
    });

    // Phase 2: commit the cursor and clear the pending marker.
    state.cursor = newCursor;
    state.pending = null;
    state.pendingAmount = null;
    state.pendingAt = null;
    state.pendingStreams = null;
    state.lastDistributedAt = new Date().toISOString();
    state.lastBlub = outcome.blubToStakers.toString();
    state.lastAqua = totalAqua.toString();
    state.lastSplit = this.describeOutcome(outcome);
    this.saveState(state);
  }

  // ==========================================================================
  // Self-Powered Reward Engine — three-way harvest split
  // ==========================================================================

  /**
   * Split one harvest batch across the three streams and execute each.
   *
   * Streams run independently: a failure in one is logged, recorded in
   * `outcome.errors`, and does NOT abort the others. A failed stream's AQUA
   * simply stays in the manager wallet (it is never sent anywhere), so nothing
   * is lost — the next balance-based run picks it up.
   *
   * `onProgress` is called after each stream that lands on-chain, so the caller
   * can persist which streams already executed (crash-safety for the cursor path).
   */
  private async runSplit(
    totalAqua: bigint,
    label: string,
    onProgress?: (progress: StreamProgress) => void,
  ): Promise<SplitOutcome> {
    const outcome: SplitOutcome = {
      totalAqua,
      stakerAqua: 0n,
      vaultAqua: 0n,
      polAqua: 0n,
      blubToStakers: 0n,
      vaultLpMinted: 0n,
      polAquaDeposited: 0n,
      polBlubDeposited: 0n,
      errors: [],
    };
    const progress: StreamProgress = {
      stakers: false,
      vault: false,
      pol: false,
    };

    // ---- Step 1: no treasury cut ------------------------------------------
    // The harvest is recycled in full: 100% of every bribe batch is split across
    // the three streams. There is deliberately no treasury line here, and no env
    // var that can introduce one — reinstating a cut is a code change.
    const distributable = totalAqua;

    // ---- Step 2: compute the three tranches -------------------------------
    let vaultAqua = (distributable * BigInt(this.bribeVaultBps)) / 10000n;
    let polAqua = (distributable * BigInt(this.bribePolBps)) / 10000n;

    // A tranche too small to split-and-pair is not worth two transactions and
    // a pool deposit; fold it into the staker stream instead of dusting.
    if (vaultAqua > 0n && vaultAqua < BribeRewardService.MIN_STREAM_AQUA) {
      this.logger.log(
        `[${label}] Vault tranche ${vaultAqua} below ${BribeRewardService.MIN_STREAM_AQUA}; folding into stakers`,
      );
      vaultAqua = 0n;
    }
    if (polAqua > 0n && polAqua < BribeRewardService.MIN_STREAM_AQUA) {
      this.logger.log(
        `[${label}] POL tranche ${polAqua} below ${BribeRewardService.MIN_STREAM_AQUA}; folding into stakers`,
      );
      polAqua = 0n;
    }
    // Stakers take the remainder, so integer-division dust is never stranded.
    const stakerAqua = distributable - vaultAqua - polAqua;

    outcome.stakerAqua = stakerAqua;
    outcome.vaultAqua = vaultAqua;
    outcome.polAqua = polAqua;

    this.logger.log(
      `[${label}] Split ${distributable} AQUA -> stakers ${stakerAqua} ` +
        `(${this.bribeStakerBps}bps), vault ${vaultAqua} (${this.bribeVaultBps}bps), ` +
        `POL ${polAqua} (${this.bribePolBps}bps)`,
    );

    // ---- Stream A: stakers — AQUA -> BLUB -> add_rewards ------------------
    if (stakerAqua > 0n) {
      try {
        let blub = await this.swapAquaToBlub(stakerAqua);

        const sanityCap = stakerAqua * 10n;
        if (blub > sanityCap) {
          this.logger.error(
            `[${label}] BLUB out ${blub} exceeds sanity cap ${sanityCap}; capping`,
          );
          blub = sanityCap;
        }
        if (blub > this.maxBlubPerRun) {
          this.logger.error(
            `[${label}] BLUB out ${blub} exceeds hard cap ${this.maxBlubPerRun}; capping`,
          );
          blub = this.maxBlubPerRun;
        }
        if (blub <= 0n) {
          throw new Error('swap produced 0 BLUB; not calling add_rewards');
        }

        const { distributed, error } =
          await this.addRewardsToStakingContract(blub);
        outcome.blubToStakers = distributed;
        if (error) {
          // Report the partial that DID land before failing the stream.
          throw new Error(
            `${error} (distributed ${distributed} of ${blub} BLUB)`,
          );
        }
        progress.stakers = true;
        onProgress?.({ ...progress });
        this.logger.log(
          `[${label}] Stream A done: ${stakerAqua} AQUA -> ${distributed} BLUB to stakers`,
        );
      } catch (err) {
        this.logger.error(
          `[${label}] Stream A (stakers) failed: ${err.message}`,
        );
        outcome.errors.push(`stakers: ${err.message}`);
      }
    }

    // ---- Stream B: vault LPs — half -> BLUB, admin_compound_deposit -------
    if (vaultAqua > 0n) {
      try {
        const lpMinted = await this.compoundIntoVault(vaultAqua, label);
        outcome.vaultLpMinted = lpMinted;
        progress.vault = true;
        onProgress?.({ ...progress });
      } catch (err) {
        this.logger.error(`[${label}] Stream B (vault) failed: ${err.message}`);
        outcome.errors.push(`vault: ${err.message}`);
      }
    }

    // ---- Stream C: POL — half -> BLUB, manual_deposit_pol ------------------
    if (polAqua > 0n) {
      try {
        const { aqua, blub } = await this.depositPolFromAqua(polAqua, label);
        outcome.polAquaDeposited = aqua;
        outcome.polBlubDeposited = blub;
        progress.pol = true;
        onProgress?.({ ...progress });
      } catch (err) {
        this.logger.error(`[${label}] Stream C (POL) failed: ${err.message}`);
        outcome.errors.push(`pol: ${err.message}`);
      }
    }

    this.logger.log(
      `[${label}] Harvest split complete: ${JSON.stringify(this.describeOutcome(outcome))}`,
    );
    return outcome;
  }

  /**
   * Stream B — grow the AQUA/BLUB vault position.
   *
   * Swaps half the tranche to BLUB (swapping half is the correct pool-ratio
   * pairing: at the margin the router rate equals the reserve ratio), then calls
   * `admin_compound_deposit(pool 0, BLUB, AQUA)`.
   *
   * That contract call adds the minted LP to `pool_info.total_lp_tokens` WITHOUT
   * minting vault shares, so each depositor's LP (shares x total_lp / total_shares)
   * grows pro-rata. Protocol-owned LP is tracked separately in
   * `aqua_blub_lp_position` and is NOT part of `total_lp_tokens`, so POL earns
   * nothing here — the POL-exclusion rule is structural, not a filter.
   *
   * Returns the LP shares minted.
   */
  private async compoundIntoVault(
    aquaTranche: bigint,
    label: string,
  ): Promise<bigint> {
    const aquaLeg = aquaTranche / 2n;
    const aquaToSwap = aquaTranche - aquaLeg;
    if (aquaLeg <= 0n || aquaToSwap <= 0n) {
      throw new Error(`tranche ${aquaTranche} too small to pair`);
    }

    const blubLeg = await this.swapAquaToBlub(aquaToSwap);
    if (blubLeg <= 0n) {
      throw new Error('swap produced 0 BLUB; nothing deposited');
    }
    // Do not cap-and-continue here: the BLUB is a deposit leg, so capping would
    // strand it in the manager wallet. An implausible rate aborts the stream.
    if (blubLeg > aquaToSwap * 10n) {
      throw new Error(
        `BLUB out ${blubLeg} exceeds sanity cap (10x ${aquaToSwap}); aborting vault deposit`,
      );
    }

    // Pool 0: token_a = BLUB, token_b = AQUA.
    let lpMinted: bigint;
    try {
      lpMinted = await this.adminCompoundDeposit(
        BribeRewardService.POOL0_ID,
        blubLeg,
        aquaLeg,
      );
    } catch (err: any) {
      // "Bad union switch: 1" = the RPC returned SorobanTransactionData ext v1
      // (Protocol 23 auto-restore of an ARCHIVED entry) and stellar-sdk 12 cannot
      // parse that union. The archived entry is PoolCompoundStats(pool_id), which
      // only admin_compound_deposit touches — it expired while pool 0 emitted
      // nothing. Restoring it makes the simulation plain again.
      if (err?.message?.includes('Bad union switch')) {
        throw new Error(
          'admin_compound_deposit blocked: an archived ledger entry ' +
            `(PoolCompoundStats(${BribeRewardService.POOL0_ID})) forces a Protocol 23 ` +
            'restore that stellar-sdk 12 cannot parse. Restore it once with: ' +
            'stellar contract restore --id <staking> --key-xdr ' +
            'AAAAEAAAAAEAAAACAAAADwAAABFQb29sQ29tcG91bmRTdGF0cwAAAAAAAAMAAAAA ' +
            '--durability persistent (see docs). Original: ' +
            err.message,
        );
      }
      throw err;
    }
    this.logger.log(
      `[${label}] Stream B done: ${blubLeg} BLUB + ${aquaLeg} AQUA -> ${lpMinted} LP ` +
        `into the vault (pool ${BribeRewardService.POOL0_ID})`,
    );
    return lpMinted;
  }

  /**
   * Stream C — add protocol-owned liquidity from the harvest.
   *
   * Same half-and-half pairing as Stream B, but the LP lands on the POL side:
   * both legs are transferred to the staking contract (which is what
   * `manual_deposit_pol` spends — it reads the CONTRACT's balances, not the
   * manager's), then deposited. The contract credits
   * `ProtocolOwnedLiquidity.aqua_blub_lp_position`, leaving vault accounting
   * untouched.
   */
  private async depositPolFromAqua(
    aquaTranche: bigint,
    label: string,
  ): Promise<{ aqua: bigint; blub: bigint }> {
    const aquaLeg = aquaTranche / 2n;
    const aquaToSwap = aquaTranche - aquaLeg;
    if (aquaLeg <= 0n || aquaToSwap <= 0n) {
      throw new Error(`tranche ${aquaTranche} too small to pair`);
    }

    const blubLeg = await this.swapAquaToBlub(aquaToSwap);
    if (blubLeg <= 0n) {
      throw new Error('swap produced 0 BLUB; nothing deposited');
    }
    if (blubLeg > aquaToSwap * 10n) {
      throw new Error(
        `BLUB out ${blubLeg} exceeds sanity cap (10x ${aquaToSwap}); aborting POL deposit`,
      );
    }

    // Stage both legs inside the contract, then deposit. Three txs: Soroban
    // allows one InvokeHostFunction per transaction.
    await this.transferFromManagerToContract(this.aquaTokenId, aquaLeg);
    await this.transferFromManagerToContract(this.blubTokenId, blubLeg);
    await this.manualDepositPol(aquaLeg, blubLeg);

    this.logger.log(
      `[${label}] Stream C done: ${aquaLeg} AQUA + ${blubLeg} BLUB deposited as POL`,
    );
    return { aqua: aquaLeg, blub: blubLeg };
  }

  /** `admin_compound_deposit(manager, pool_id, amount_a, amount_b)` -> LP minted. */
  private async adminCompoundDeposit(
    poolId: number,
    amountA: bigint,
    amountB: bigint,
  ): Promise<bigint> {
    const stakingContract = new StellarSdk.Contract(this.stakingContractId);
    const operation = stakingContract.call(
      'admin_compound_deposit',
      StellarSdk.nativeToScVal(this.adminKeypair.publicKey(), {
        type: 'address',
      }),
      StellarSdk.nativeToScVal(poolId, { type: 'u32' }),
      StellarSdk.nativeToScVal(amountA, { type: 'i128' }),
      StellarSdk.nativeToScVal(amountB, { type: 'i128' }),
    );

    const tx = await this.buildAndSignTransaction(operation);
    const response = await this.sendServer.sendTransaction(tx);
    const confirmed = await this.pollTransactionStatus(response.hash);

    try {
      if (confirmed?.returnValue) {
        return BigInt(StellarSdk.scValToNative(confirmed.returnValue) || 0);
      }
    } catch (e) {
      this.logger.warn(
        `Could not parse admin_compound_deposit return: ${e.message}`,
      );
    }
    return 0n;
  }

  /** `manual_deposit_pol(manager, aqua, blub)` — legs must already be in the contract. */
  private async manualDepositPol(
    aquaAmount: bigint,
    blubAmount: bigint,
  ): Promise<void> {
    const stakingContract = new StellarSdk.Contract(this.stakingContractId);
    const operation = stakingContract.call(
      'manual_deposit_pol',
      StellarSdk.nativeToScVal(this.adminKeypair.publicKey(), {
        type: 'address',
      }),
      StellarSdk.nativeToScVal(aquaAmount, { type: 'i128' }),
      StellarSdk.nativeToScVal(blubAmount, { type: 'i128' }),
    );
    const tx = await this.buildAndSignTransaction(operation);
    const response = await this.sendServer.sendTransaction(tx);
    await this.pollTransactionStatus(response.hash);
  }

  /** SAC transfer from the manager wallet to the staking contract. */
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
    const response = await this.sendServer.sendTransaction(tx);
    await this.pollTransactionStatus(response.hash);
  }

  /** JSON-safe view of a split, for the state file and the status endpoint. */
  private describeOutcome(o: SplitOutcome): Record<string, string | string[]> {
    return {
      totalAqua: o.totalAqua.toString(),
      stakerAqua: o.stakerAqua.toString(),
      vaultAqua: o.vaultAqua.toString(),
      polAqua: o.polAqua.toString(),
      blubToStakers: o.blubToStakers.toString(),
      vaultLpMinted: o.vaultLpMinted.toString(),
      polAquaDeposited: o.polAquaDeposited.toString(),
      polBlubDeposited: o.polBlubDeposited.toString(),
      errors: o.errors,
    };
  }

  // ==========================================================================
  // Horizon payment scanning
  // ==========================================================================

  /**
   * Sum AQUA received from the bribe sender after `cursor`, returning the total
   * (stroops) and the newest paging_token seen (so the cursor advances past
   * non-bribe payments too). Pages through Horizon until exhausted.
   */
  private async collectNewBribes(
    cursor: string,
  ): Promise<{ totalAqua: bigint; newCursor: string }> {
    const aquaIssuer = this.configService.get<string>('AQUA_ISSUER');
    const manager = this.adminKeypair.publicKey();
    let total = 0n;
    let newCursor = cursor;
    const LIMIT = 200;

    let page = await this.horizonServer
      .payments()
      .forAccount(manager)
      .cursor(cursor)
      .order('asc')
      .limit(LIMIT)
      .call();

    while (page.records.length > 0) {
      for (const rec of page.records as any[]) {
        newCursor = rec.paging_token || newCursor;

        const isPayment =
          rec.type === 'payment' ||
          rec.type === 'path_payment_strict_receive' ||
          rec.type === 'path_payment_strict_send';
        if (!isPayment) continue;
        if (rec.to !== manager) continue;
        if (rec.from !== this.bribeSender) continue;
        if (rec.asset_code !== 'AQUA') continue;
        if (aquaIssuer && rec.asset_issuer !== aquaIssuer) continue;

        const stroops = this.toStroops(rec.amount);
        total += stroops;
        this.logger.log(
          `Bribe payment: ${rec.amount} AQUA (${rec.created_at}) token=${rec.paging_token}`,
        );
      }

      if (page.records.length < LIMIT) break;
      page = await page.next();
    }

    return { totalAqua: total, newCursor };
  }

  /** Latest paging_token on the manager account (used to seed the cursor). */
  private async getLatestPagingToken(): Promise<string> {
    const manager = this.adminKeypair.publicKey();
    const page = await this.horizonServer
      .payments()
      .forAccount(manager)
      .order('desc')
      .limit(1)
      .call();
    if (page.records.length > 0) {
      return (page.records[0] as any).paging_token;
    }
    return '0';
  }

  /** Convert a Horizon decimal amount string (7 dp) to bigint stroops. */
  private toStroops(amount: string): bigint {
    const [whole, frac = ''] = String(amount).split('.');
    const fracPadded = (frac + '0000000').slice(0, 7);
    return BigInt(whole || '0') * 10_000_000n + BigInt(fracPadded || '0');
  }

  // ==========================================================================
  // On-chain operations (swap, add_rewards)
  // ==========================================================================

  /**
   * Swap AQUA to BLUB via the Aquarius router.
   * Simulates first for the real expected output, then submits with 5% slippage.
   */
  private async swapAquaToBlub(aquaAmount: bigint): Promise<bigint> {
    const routerContract = new StellarSdk.Contract(this.routerContractId);

    const tokensVec = StellarSdk.xdr.ScVal.scvVec([
      StellarSdk.nativeToScVal(this.aquaTokenId, { type: 'address' }),
      StellarSdk.nativeToScVal(this.blubTokenId, { type: 'address' }),
    ]);
    const poolIndex = Buffer.from(this.poolIndexHex, 'hex');

    const simulateOp = routerContract.call(
      'swap',
      StellarSdk.nativeToScVal(this.adminKeypair.publicKey(), {
        type: 'address',
      }),
      tokensVec,
      StellarSdk.nativeToScVal(this.aquaTokenId, { type: 'address' }),
      StellarSdk.nativeToScVal(this.blubTokenId, { type: 'address' }),
      StellarSdk.nativeToScVal(poolIndex, { type: 'bytes' }),
      StellarSdk.nativeToScVal(aquaAmount, { type: 'u128' }),
      StellarSdk.nativeToScVal(0n, { type: 'u128' }),
    );

    let minBlubOut = 1n;
    let simulatedExpectedOut = 0n;
    try {
      const simResult = await this.simulateTransaction(simulateOp);
      const expectedOut = BigInt(
        StellarSdk.scValToNative(simResult.result.retval) || 0,
      );
      if (expectedOut > 0n) {
        simulatedExpectedOut = expectedOut;
        minBlubOut = (expectedOut * 95n) / 100n; // 5% slippage
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
      StellarSdk.nativeToScVal(this.adminKeypair.publicKey(), {
        type: 'address',
      }),
      tokensVec,
      StellarSdk.nativeToScVal(this.aquaTokenId, { type: 'address' }),
      StellarSdk.nativeToScVal(this.blubTokenId, { type: 'address' }),
      StellarSdk.nativeToScVal(poolIndex, { type: 'bytes' }),
      StellarSdk.nativeToScVal(aquaAmount, { type: 'u128' }),
      StellarSdk.nativeToScVal(minBlubOut, { type: 'u128' }),
    );

    const tx = await this.buildAndSignTransaction(operation);
    const response = await this.sendServer.sendTransaction(tx);
    const confirmed = await this.pollTransactionStatus(response.hash);

    const parsed = this.parseSwapOutput(confirmed);
    if (parsed > 0n) return parsed;
    if (simulatedExpectedOut > 0n) {
      const conservative = (simulatedExpectedOut * 95n) / 100n;
      this.logger.warn(
        `Using simulation estimate as fallback: ${conservative} BLUB`,
      );
      return conservative;
    }
    this.logger.error(
      'Could not determine BLUB received from swap — returning 0',
    );
    return 0n;
  }

  /** Parse router swap output [inAmount, outAmount]; 0 on failure. */
  private parseSwapOutput(txResult: any): bigint {
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
    return 0n;
  }

  /**
   * Distribute BLUB to stakers in calls the contract will actually accept.
   *
   * `add_rewards` rejects anything above 100,000 BLUB with InvalidInput (#4), so
   * a large harvest MUST be chunked — a 155K AQUA day swaps to ~200K BLUB and was
   * silently failing the whole staker stream. Returns how much was distributed;
   * on a failed chunk it stops and reports the partial rather than retrying
   * blindly, leaving the remaining BLUB in the manager wallet.
   */
  private async addRewardsToStakingContract(
    blubAmount: bigint,
  ): Promise<{ distributed: bigint; error?: string }> {
    const cap = BribeRewardService.MAX_BLUB_PER_ADD_REWARDS;
    let remaining = blubAmount;
    let distributed = 0n;
    let chunkNo = 0;

    while (remaining > 0n) {
      const chunk = remaining > cap ? cap : remaining;
      chunkNo++;
      if (blubAmount > cap) {
        this.logger.log(
          `add_rewards chunk ${chunkNo}: ${chunk} BLUB (${remaining} of ${blubAmount} left)`,
        );
      }
      try {
        await this.addRewardsChunk(chunk);
      } catch (err: any) {
        this.logger.error(
          `add_rewards chunk ${chunkNo} failed after ${distributed} BLUB distributed: ${err.message}`,
        );
        return { distributed, error: err.message };
      }
      distributed += chunk;
      remaining -= chunk;
      if (remaining > 0n) await this.sleep(3000);
    }
    return { distributed };
  }

  /** Approve + add_rewards for a single chunk (<= the contract's per-call cap). */
  private async addRewardsChunk(blubAmount: bigint): Promise<void> {
    const stakingContract = new StellarSdk.Contract(this.stakingContractId);
    const blubContract = new StellarSdk.Contract(this.blubTokenId);

    const withRetry = async <T>(
      fn: () => Promise<T>,
      label: string,
      maxTries = 3,
    ): Promise<T> => {
      for (let i = 1; i <= maxTries; i++) {
        try {
          return await fn();
        } catch (err: any) {
          const is429 =
            err?.response?.status === 429 || err?.message?.includes('429');
          if (is429 && i < maxTries) {
            const delay = 5000 * i;
            this.logger.warn(
              `${label}: 429 rate limit, retrying in ${delay}ms (${i}/${maxTries})`,
            );
            await this.sleep(delay);
            continue;
          }
          throw err;
        }
      }
    };

    const latestLedger = await withRetry(
      () => this.server.getLatestLedger().then((r) => r.sequence),
      'getLatestLedger',
    );
    const approveOp = blubContract.call(
      'approve',
      StellarSdk.nativeToScVal(this.adminKeypair.publicKey(), {
        type: 'address',
      }),
      StellarSdk.nativeToScVal(this.stakingContractId, { type: 'address' }),
      StellarSdk.nativeToScVal(blubAmount, { type: 'i128' }),
      StellarSdk.nativeToScVal(latestLedger + 720, { type: 'u32' }),
    );
    const approveTx = await withRetry(
      () => this.buildAndSignTransaction(approveOp),
      'approve-build',
    );
    const approveResponse = await withRetry(
      () => this.sendServer.sendTransaction(approveTx),
      'approve-send',
    );
    await this.pollTransactionStatus(approveResponse.hash);

    await this.sleep(3000);

    const addRewardsOp = stakingContract.call(
      'add_rewards',
      StellarSdk.nativeToScVal(this.adminKeypair.publicKey(), {
        type: 'address',
      }),
      StellarSdk.nativeToScVal(blubAmount, { type: 'i128' }),
    );
    const tx = await this.buildAndSignTransaction(addRewardsOp);
    const response = await this.sendServer.sendTransaction(tx);
    await this.pollTransactionStatus(response.hash);
    this.logger.log(
      `add_rewards submitted: ${blubAmount} BLUB tx=${response.hash}`,
    );
  }

  // ==========================================================================
  // State file + lock
  // ==========================================================================

  private loadState(): any {
    try {
      if (fs.existsSync(this.stateFile)) {
        return JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      }
    } catch (e) {
      this.logger.warn(`Failed to read state file: ${e.message}`);
    }
    return {
      cursor: null,
      pending: null,
      pendingAmount: null,
      pendingAt: null,
    };
  }

  private saveState(state: any): void {
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
    } catch (e) {
      this.logger.error(`Failed to write state file: ${e.message}`);
    }
  }

  /**
   * Acquire an exclusive lock by atomically creating the lock file (O_EXCL).
   * Steals a stale lock (holder crashed). Returns true if acquired.
   */
  private acquireLock(): boolean {
    try {
      const fd = fs.openSync(this.lockFile, 'wx');
      fs.writeSync(
        fd,
        JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
      );
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') {
        this.logger.warn(`Lock acquire error: ${e.message}`);
        return false;
      }
      // Lock exists — check staleness.
      try {
        const stat = fs.statSync(this.lockFile);
        if (Date.now() - stat.mtimeMs > BribeRewardService.LOCK_STALE_MS) {
          this.logger.warn('Stale bribe lock detected; stealing it');
          fs.unlinkSync(this.lockFile);
          return this.acquireLock();
        }
      } catch {
        /* race: someone removed it; fall through to "not acquired" */
      }
      return false;
    }
  }

  private releaseLock(): void {
    try {
      if (fs.existsSync(this.lockFile)) fs.unlinkSync(this.lockFile);
    } catch (e) {
      this.logger.warn(`Lock release error: ${e.message}`);
    }
  }

  // ==========================================================================
  // Manual triggers (test controller)
  // ==========================================================================

  async manualTrigger(): Promise<{ success: boolean; message: string }> {
    try {
      await this.handleBribeRewardDistribution();
      return { success: true, message: 'Bribe reward distribution completed' };
    } catch (error) {
      return { success: false, message: error.message };
    }
  }

  /**
   * One-off operational trigger for AQUA sitting in the manager wallet — used to
   * drain leftover/backlog AQUA that the cursor-based cron won't pick up.
   *
   * By default it runs the SAME three-way split as the cron, so a manual drain
   * cannot silently divert the vault and POL streams back to stakers. Pass
   * `stakersOnly = true` for the old behaviour (100% swapped to BLUB for stakers).
   *
   * `aquaStroops` omitted -> uses the entire current wallet AQUA balance.
   *
   * Afterwards it resets the cursor to the latest paging_token so the auto-cron
   * does NOT later reprocess any bribe whose AQUA we just drained from the wallet.
   *
   * NOTE: safe to call on a multi-instance deploy because it's a single request
   * handled by one instance; the AUTO cron, however, needs a single instance to
   * avoid double distribution (file state is not shared across instances).
   */
  async distributeNow(
    aquaStroops?: bigint,
    stakersOnly = false,
  ): Promise<{
    success: boolean;
    message: string;
    aqua?: string;
    blub?: string;
    split?: Record<string, string | string[]>;
  }> {
    if (!this.acquireLock()) {
      return {
        success: false,
        message: 'Another bribe run holds the lock; try again shortly',
      };
    }
    try {
      const amount = aquaStroops ?? (await this.getManagerAquaBalance());
      if (amount < BribeRewardService.MIN_AQUA_THRESHOLD) {
        return {
          success: false,
          message: `Wallet AQUA ${amount} below threshold; nothing to swap`,
        };
      }

      let blub = 0n;
      let split: Record<string, string | string[]> | undefined;

      if (stakersOnly) {
        this.logger.log(
          `distributeNow: swapping ${amount} AQUA (stakersOnly, no split) -> BLUB -> stakers`,
        );

        blub = await this.swapAquaToBlub(amount);
        const sanityCap = amount * 10n;
        if (blub > sanityCap) {
          this.logger.error(
            `BLUB out ${blub} exceeds sanity cap ${sanityCap}; capping`,
          );
          blub = sanityCap;
        }
        if (blub > this.maxBlubPerRun) {
          this.logger.error(
            `BLUB out ${blub} exceeds hard cap ${this.maxBlubPerRun}; capping`,
          );
          blub = this.maxBlubPerRun;
        }
        if (blub <= 0n) {
          return {
            success: false,
            message: 'Swap produced 0 BLUB; nothing added to stakers',
          };
        }

        const res = await this.addRewardsToStakingContract(blub);
        blub = res.distributed;
        if (res.error) {
          return {
            success: false,
            message: `add_rewards failed after ${res.distributed} BLUB: ${res.error}`,
            aqua: amount.toString(),
            blub: res.distributed.toString(),
          };
        }
      } else {
        const outcome = await this.runSplit(amount, 'distributeNow');
        blub = outcome.blubToStakers;
        split = this.describeOutcome(outcome);
        if (outcome.errors.length > 0) {
          this.logger.error(
            `distributeNow: ${outcome.errors.length} stream(s) failed: ${outcome.errors.join('; ')}`,
          );
        }
      }

      // Reset cursor forward so the auto-cron starts fresh from now and won't
      // reprocess any bribe whose AQUA we just drained.
      const latest = await this.getLatestPagingToken();
      const state = this.loadState();
      state.cursor = latest;
      state.pending = null;
      state.pendingAmount = null;
      state.pendingAt = null;
      state.pendingStreams = null;
      state.lastDistributedAt = new Date().toISOString();
      state.lastBlub = blub.toString();
      state.lastAqua = amount.toString();
      if (split) state.lastSplit = split;
      this.saveState(state);

      this.logger.log(
        `distributeNow complete: ${amount} AQUA processed ` +
          `(${stakersOnly ? 'stakersOnly' : 'split'}), ${blub} BLUB to stakers`,
      );
      return {
        success: true,
        message: stakersOnly
          ? `Swapped ${amount} AQUA -> ${blub} BLUB and added to stakers`
          : `Split ${amount} AQUA across stakers/vault/POL`,
        aqua: amount.toString(),
        blub: blub.toString(),
        split,
      };
    } catch (error) {
      this.logger.error(`distributeNow failed: ${error.message}`, error.stack);
      return { success: false, message: error.message };
    } finally {
      this.releaseLock();
    }
  }

  /** AQUA SAC balance of the manager wallet (stroops). */
  private async getManagerAquaBalance(): Promise<bigint> {
    try {
      const c = new StellarSdk.Contract(this.aquaTokenId);
      const op = c.call(
        'balance',
        StellarSdk.nativeToScVal(this.adminKeypair.publicKey(), {
          type: 'address',
        }),
      );
      const r = await this.simulateTransaction(op);
      return BigInt(StellarSdk.scValToNative(r.result.retval) || 0);
    } catch (e) {
      this.logger.warn(`getManagerAquaBalance failed: ${e.message}`);
      return 0n;
    }
  }

  /**
   * Manually resolve a halted run (pending cursor set but never confirmed).
   * `committed=true`  -> the add_rewards landed on-chain: commit the cursor.
   * `committed=false` -> it did not land: roll back the pending marker so the
   *                      next run reprocesses the batch.
   */
  async resolvePending(
    committed: boolean,
  ): Promise<{ success: boolean; message: string }> {
    const state = this.loadState();
    if (!state.pending) {
      return { success: false, message: 'No pending batch to resolve' };
    }
    if (committed) {
      state.cursor = state.pending;
      state.lastDistributedAt = new Date().toISOString();
    }
    const resolved = state.pending;
    const streams = state.pendingStreams
      ? JSON.stringify(state.pendingStreams)
      : 'unknown';
    state.pending = null;
    state.pendingAmount = null;
    state.pendingAt = null;
    state.pendingStreams = null;
    this.saveState(state);
    return {
      success: true,
      message:
        `Pending ${resolved} resolved as committed=${committed} ` +
        `(streams that had landed: ${streams})`,
    };
  }

  async getStatus(): Promise<any> {
    const state = this.loadState();
    return {
      manager: this.adminKeypair.publicKey(),
      bribeSender: this.bribeSender,
      treasury: 'none — 100% of the harvest is recycled',
      split: {
        stakerBps: this.bribeStakerBps,
        vaultBps: this.bribeVaultBps,
        polBps: this.bribePolBps,
      },
      cursor: state.cursor,
      pending: state.pending,
      pendingAmount: state.pendingAmount,
      lastDistributedAt: state.lastDistributedAt || null,
      lastBlub: state.lastBlub || null,
      lastAqua: state.lastAqua || null,
      lastSplit: state.lastSplit || null,
      pendingStreams: state.pendingStreams || null,
    };
  }

  // ==========================================================================
  // Stellar helpers (mirror staking-reward.service.ts)
  // ==========================================================================

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

  /**
   * Last-resort check when RPC polling runs out: ask Horizon whether the
   * transaction actually made it into a ledger. A slow RPC must not be reported
   * as a failed stream — that is how a landed POL deposit gets counted as a loss.
   */
  private async verifyOnHorizon(
    hash: string,
  ): Promise<'success' | 'failed' | 'unknown'> {
    for (let i = 0; i < 3; i++) {
      try {
        const tx: any = await this.horizonServer
          .transactions()
          .transaction(hash)
          .call();
        return tx.successful ? 'success' : 'failed';
      } catch (err: any) {
        const notFound =
          err?.response?.status === 404 || err?.message?.includes('not found');
        if (!notFound) {
          this.logger.warn(`Horizon lookup for ${hash} failed: ${err.message}`);
          return 'unknown';
        }
        await this.sleep(5000);
      }
    }
    return 'unknown';
  }

  private async pollTransactionStatus(
    hash: string,
    maxAttempts = 90,
  ): Promise<any> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        // Poll on the send server (gateway.fm) — it's the node that has the tx.
        const status = await this.sendServer.getTransaction(hash);
        if (status.status === 'SUCCESS') return status;
        if (status.status === 'FAILED')
          throw new Error(`Transaction failed: ${hash}`);
        await this.sleep(2000);
      } catch (error) {
        if (
          error.message?.includes('not found') ||
          error.message?.includes('NOT_FOUND')
        ) {
          await this.sleep(2000);
          continue;
        }
        if (error.message?.includes('Bad union switch')) {
          this.logger.warn(
            `XDR parse error (Bad union switch) for ${hash}, assuming success`,
          );
          return { status: 'SUCCESS', hash };
        }
        throw error;
      }
    }
    // RPC never showed it. Before calling this a failure, ask Horizon — the tx
    // may well have been included while the RPC lagged.
    const onChain = await this.verifyOnHorizon(hash);
    if (onChain === 'success') {
      this.logger.warn(
        `RPC polling timed out for ${hash}, but Horizon shows it SUCCEEDED; continuing`,
      );
      return { status: 'SUCCESS', hash };
    }
    if (onChain === 'failed') {
      throw new Error(`Transaction failed (per Horizon): ${hash}`);
    }
    throw new Error(`Transaction timeout, not found on Horizon: ${hash}`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
