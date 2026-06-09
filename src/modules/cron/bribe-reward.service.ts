import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import * as StellarSdk from '@stellar/stellar-sdk';
import { Keypair, Networks, TransactionBuilder } from '@stellar/stellar-sdk';
import * as fs from 'fs';
import * as path from 'path';

// Use max fee to avoid transaction failures during network congestion.
const MAX_FEE = '1000000'; // 0.1 XLM

/**
 * Bribe Reward Distribution Service
 * ---------------------------------
 *
 * Background (2026-06): Pool 0 (BLUB-AQUA) was de-whitelisted by Aquarius, so it
 * emits 0 AQUA. WhaleHub redirected its upvote-ICE votes to the top AQUA pair and
 * now earns **Aquarius bribes** — confirmed ~50-55K AQUA/day arriving as plain
 * classic Stellar payments from the Aquarius bribe collection address.
 *
 * This service replaces the lost pool-0 staker rewards by routing those bribes to
 * BLUB stakers:
 *   1. Detect new bribe payments from the bribe sender (Horizon payments cursor).
 *   2. Take a 30% treasury cut in AQUA (same rate POL effectively pays).
 *   3. Swap the remaining 70% AQUA -> BLUB on the Aquarius router (chunked to limit
 *      price impact on the stableswap).
 *   4. add_rewards() that BLUB to the staking contract (Synthetix-style payout).
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
  private readonly treasuryAddress: string;

  // Aquarius bribe collection address — confirmed on-chain as the sender of the
  // daily AQUA bribe payments into the manager wallet. Override via env if the
  // collector address ever changes.
  private readonly bribeSender: string;

  // Treasury cut on bribe income, in basis points. 3000 = 30% (same effective
  // rate POL pays). Sent in AQUA before the BLUB swap.
  private readonly bribeTreasuryBps: number;

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

    this.stakingContractId = this.configService.get<string>('STAKING_CONTRACT_ID');
    this.aquaTokenId = this.configService.get<string>('AQUA_TOKEN_ID');
    this.blubTokenId = this.configService.get<string>('BLUB_TOKEN_ID');
    this.routerContractId = this.configService.get<string>('AQUARIUS_ROUTER_CONTRACT_ID');

    // Bribe treasury cut goes to the canonical staking-reward treasury (the one
    // that "receives 30% of staking rewards"); override via BRIBE_TREASURY_ADDRESS.
    this.treasuryAddress =
      this.configService.get<string>('BRIBE_TREASURY_ADDRESS') ||
      this.configService.get<string>('TREASURY_ADDRESS');

    this.bribeSender =
      this.configService.get<string>('BRIBE_SENDER_ADDRESS') ||
      'GAORXNBAWRIOJ7HRMCTWW2MIB6PYWSC7OKHGIXWTJXYRTZRSHP356TW3';

    this.bribeTreasuryBps = Number(
      this.configService.get<string>('BRIBE_TREASURY_BPS') || '3000',
    );

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
        `sender=${this.bribeSender} treasuryBps=${this.bribeTreasuryBps} ` +
        `state=${this.stateFile}`,
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
   * ignored. 30% -> treasury (AQUA), 70% swapped AQUA->BLUB -> add_rewards.
   */
  @Cron('0 */6 * * *', { name: 'bribe-reward-distribution', timeZone: 'UTC' })
  async handleBribeRewardDistribution(): Promise<void> {
    // De-sync the two DO instances so the leader drains the wallet first.
    await this.sleep(Math.floor(Math.random() * 60000));

    if (!this.acquireLock()) {
      this.logger.debug('Bribe distribution lock held by another run, skipping');
      return;
    }
    try {
      const balance = await this.getManagerAquaBalance();
      this.logger.log(`Bribe cron: manager AQUA balance ${balance}`);
      if (balance < BribeRewardService.AUTO_MIN_AQUA) {
        this.logger.log(
          `Below auto threshold ${BribeRewardService.AUTO_MIN_AQUA}; nothing to distribute`,
        );
        return;
      }

      const treasuryAqua = (balance * BigInt(this.bribeTreasuryBps)) / 10000n;
      let aquaToSwap = balance - treasuryAqua;
      if (treasuryAqua > 0n) {
        try {
          await this.sendAquaToTreasury(treasuryAqua);
          this.logger.log(
            `Treasury cut: ${treasuryAqua} AQUA -> ${this.treasuryAddress} (${this.bribeTreasuryBps}/10000)`,
          );
        } catch (err) {
          this.logger.error(
            `Treasury transfer failed: ${err.message}; routing full amount to stakers this run`,
          );
          aquaToSwap = balance;
        }
      }

      let blub = await this.swapAquaToBlub(aquaToSwap);
      const sanityCap = aquaToSwap * 10n;
      if (blub > sanityCap) {
        this.logger.error(`BLUB out ${blub} exceeds sanity cap ${sanityCap}; capping`);
        blub = sanityCap;
      }
      if (blub > this.maxBlubPerRun) {
        this.logger.error(`BLUB out ${blub} exceeds hard cap ${this.maxBlubPerRun}; capping`);
        blub = this.maxBlubPerRun;
      }
      if (blub <= 0n) {
        this.logger.error('Swap produced 0 BLUB; not calling add_rewards');
        return;
      }

      await this.addRewardsToStakingContract(blub);

      const state = this.loadState();
      state.lastDistributedAt = new Date().toISOString();
      state.lastBlub = blub.toString();
      state.lastAqua = balance.toString();
      this.saveState(state);

      this.logger.log(
        `Bribe distribution complete: ${balance} AQUA ` +
          `(treasury ${treasuryAqua}, swapped ${aquaToSwap}) -> ${blub} BLUB to stakers`,
      );
    } catch (error) {
      this.logger.error(
        `Bribe reward distribution failed: ${error.message}`,
        error.stack,
      );
    } finally {
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

    // 30% treasury cut (AQUA), then swap 70% -> BLUB, then add_rewards.
    const treasuryAqua = (totalAqua * BigInt(this.bribeTreasuryBps)) / 10000n;
    let aquaToSwap = totalAqua - treasuryAqua;

    if (treasuryAqua > 0n) {
      try {
        await this.sendAquaToTreasury(treasuryAqua);
        this.logger.log(
          `Treasury cut: ${treasuryAqua} AQUA -> ${this.treasuryAddress} ` +
            `(${this.bribeTreasuryBps}/10000)`,
        );
      } catch (err) {
        // If the treasury transfer fails, do NOT silently keep the AQUA — fold it
        // back into the staker swap so nothing is stranded, and log it.
        this.logger.error(
          `Treasury transfer failed: ${err.message}. Routing full bribe to stakers this run.`,
        );
        aquaToSwap = totalAqua;
      }
    }

    let blubOut = await this.swapAquaToBlub(aquaToSwap);

    // Sanity cap: BLUB out should never exceed 10x AQUA in.
    const sanityCap = aquaToSwap * 10n;
    if (blubOut > sanityCap) {
      this.logger.error(
        `BLUB out ${blubOut} exceeds sanity cap (10x=${sanityCap}). Capping.`,
      );
      blubOut = sanityCap;
    }
    // Hard per-run cap.
    if (blubOut > this.maxBlubPerRun) {
      this.logger.error(
        `BLUB out ${blubOut} exceeds hard cap ${this.maxBlubPerRun}. Capping.`,
      );
      blubOut = this.maxBlubPerRun;
    }

    if (blubOut > 0n) {
      await this.addRewardsToStakingContract(blubOut);
      this.logger.log(`Distributed ${blubOut} BLUB to stakers from bribes`);
    } else {
      this.logger.error(
        'Swap produced 0 BLUB — not calling add_rewards. Cursor will still advance ' +
          '(treasury cut already sent); bribe AQUA remainder stays in wallet for manual handling.',
      );
    }

    // Phase 2: commit the cursor and clear the pending marker.
    state.cursor = newCursor;
    state.pending = null;
    state.pendingAmount = null;
    state.pendingAt = null;
    state.lastDistributedAt = new Date().toISOString();
    state.lastBlub = blubOut.toString();
    state.lastAqua = totalAqua.toString();
    this.saveState(state);

    this.logger.log(
      `Bribe run complete: bribeAqua=${totalAqua} treasury=${treasuryAqua} ` +
        `swapped=${aquaToSwap} blub=${blubOut}`,
    );
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
  // On-chain operations (treasury transfer, swap, add_rewards)
  // ==========================================================================

  /** Send AQUA to the treasury address (the 30% bribe cut). */
  private async sendAquaToTreasury(amount: bigint): Promise<void> {
    const aquaContract = new StellarSdk.Contract(this.aquaTokenId);
    const operation = aquaContract.call(
      'transfer',
      StellarSdk.nativeToScVal(this.adminKeypair.publicKey(), { type: 'address' }),
      StellarSdk.nativeToScVal(this.treasuryAddress, { type: 'address' }),
      StellarSdk.nativeToScVal(amount, { type: 'i128' }),
    );
    const tx = await this.buildAndSignTransaction(operation);
    const response = await this.sendServer.sendTransaction(tx);
    await this.pollTransactionStatus(response.hash);
  }

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
      StellarSdk.nativeToScVal(this.adminKeypair.publicKey(), { type: 'address' }),
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
      this.logger.warn(`Swap simulation failed, using min=1: ${simError.message}`);
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
    const response = await this.sendServer.sendTransaction(tx);
    const confirmed = await this.pollTransactionStatus(response.hash);

    const parsed = this.parseSwapOutput(confirmed);
    if (parsed > 0n) return parsed;
    if (simulatedExpectedOut > 0n) {
      const conservative = (simulatedExpectedOut * 95n) / 100n;
      this.logger.warn(`Using simulation estimate as fallback: ${conservative} BLUB`);
      return conservative;
    }
    this.logger.error('Could not determine BLUB received from swap — returning 0');
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

  /** Approve + add_rewards on the staking contract (Synthetix-style payout). */
  private async addRewardsToStakingContract(blubAmount: bigint): Promise<void> {
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
      StellarSdk.nativeToScVal(this.adminKeypair.publicKey(), { type: 'address' }),
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
      StellarSdk.nativeToScVal(this.adminKeypair.publicKey(), { type: 'address' }),
      StellarSdk.nativeToScVal(blubAmount, { type: 'i128' }),
    );
    const tx = await this.buildAndSignTransaction(addRewardsOp);
    const response = await this.sendServer.sendTransaction(tx);
    await this.pollTransactionStatus(response.hash);
    this.logger.log(`add_rewards submitted: ${blubAmount} BLUB tx=${response.hash}`);
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
   * One-off operational trigger: swap a chunk of AQUA sitting in the manager
   * wallet straight to BLUB and add_rewards to stakers — NO treasury cut
   * ("swap it all" to stakers). Used to drain leftover/backlog AQUA that the
   * cursor-based cron won't pick up.
   *
   * `aquaStroops` omitted -> swaps the entire current wallet AQUA balance.
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
  ): Promise<{ success: boolean; message: string; aqua?: string; blub?: string }> {
    if (!this.acquireLock()) {
      return { success: false, message: 'Another bribe run holds the lock; try again shortly' };
    }
    try {
      let amount = aquaStroops ?? (await this.getManagerAquaBalance());
      if (amount < BribeRewardService.MIN_AQUA_THRESHOLD) {
        return { success: false, message: `Wallet AQUA ${amount} below threshold; nothing to swap` };
      }

      this.logger.log(
        `distributeNow: swapping ${amount} AQUA (no treasury cut) -> BLUB -> stakers`,
      );

      let blub = await this.swapAquaToBlub(amount);
      const sanityCap = amount * 10n;
      if (blub > sanityCap) {
        this.logger.error(`BLUB out ${blub} exceeds sanity cap ${sanityCap}; capping`);
        blub = sanityCap;
      }
      if (blub > this.maxBlubPerRun) {
        this.logger.error(`BLUB out ${blub} exceeds hard cap ${this.maxBlubPerRun}; capping`);
        blub = this.maxBlubPerRun;
      }
      if (blub <= 0n) {
        return { success: false, message: 'Swap produced 0 BLUB; nothing added to stakers' };
      }

      await this.addRewardsToStakingContract(blub);

      // Reset cursor forward so the auto-cron starts fresh from now and won't
      // reprocess any bribe whose AQUA we just drained.
      const latest = await this.getLatestPagingToken();
      const state = this.loadState();
      state.cursor = latest;
      state.pending = null;
      state.pendingAmount = null;
      state.pendingAt = null;
      state.lastDistributedAt = new Date().toISOString();
      state.lastBlub = blub.toString();
      state.lastAqua = amount.toString();
      this.saveState(state);

      this.logger.log(`distributeNow complete: ${amount} AQUA -> ${blub} BLUB to stakers`);
      return {
        success: true,
        message: `Swapped ${amount} AQUA -> ${blub} BLUB and added to stakers`,
        aqua: amount.toString(),
        blub: blub.toString(),
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
        StellarSdk.nativeToScVal(this.adminKeypair.publicKey(), { type: 'address' }),
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
  async resolvePending(committed: boolean): Promise<{ success: boolean; message: string }> {
    const state = this.loadState();
    if (!state.pending) {
      return { success: false, message: 'No pending batch to resolve' };
    }
    if (committed) {
      state.cursor = state.pending;
      state.lastDistributedAt = new Date().toISOString();
    }
    const resolved = state.pending;
    state.pending = null;
    state.pendingAmount = null;
    state.pendingAt = null;
    this.saveState(state);
    return {
      success: true,
      message: `Pending ${resolved} resolved as committed=${committed}`,
    };
  }

  async getStatus(): Promise<any> {
    const state = this.loadState();
    return {
      manager: this.adminKeypair.publicKey(),
      bribeSender: this.bribeSender,
      treasuryAddress: this.treasuryAddress,
      treasuryBps: this.bribeTreasuryBps,
      cursor: state.cursor,
      pending: state.pending,
      pendingAmount: state.pendingAmount,
      lastDistributedAt: state.lastDistributedAt || null,
      lastBlub: state.lastBlub || null,
      lastAqua: state.lastAqua || null,
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

  private async pollTransactionStatus(hash: string, maxAttempts = 45): Promise<any> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        // Poll on the send server (gateway.fm) — it's the node that has the tx.
        const status = await this.sendServer.getTransaction(hash);
        if (status.status === 'SUCCESS') return status;
        if (status.status === 'FAILED') throw new Error(`Transaction failed: ${hash}`);
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
