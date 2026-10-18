import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import * as StellarSdk from '@stellar/stellar-sdk';
import { Keypair, Networks, TransactionBuilder } from '@stellar/stellar-sdk';
import { acquireWalletLock, releaseWalletLock } from './wallet-coordination';

// Use max fee to avoid transaction failures during network congestion.
const MAX_FEE = '1000000'; // 0.1 XLM
const PAGE = 50;

/** Outcome of one user's run within a sweep. Amounts in stroops (as strings for JSON). */
interface RunResult {
  user: string;
  status: 'compounded' | 'skipped' | 'failed';
  reason?: string;
  total?: string;
  toLock?: string;
  toVault?: string;
  minVaultShares?: string;
  hash?: string;
}

/**
 * Auto-compound keeper (staking contract, auto-compound phase 2)
 * ---------------------------------------------------------------
 *
 * Stakers opt in on-chain with `set_auto_compound(user, true)`. Once their 7-day
 * claim cooldown has passed, this keeper calls `auto_compound(manager, user,
 * min_vault_shares)` for them: the contract settles their pending AQUA like a
 * claim and splits it — `lock_bps` into their rolling lock entry (all of it to the
 * ICE queue, 1 BLUB per AQUA) and the rest single-sided into the vault bucket as
 * shares in their name. Nothing passes through the manager wallet; the manager only
 * pays the fee. The 70% then reaches ICE through the existing ICE-locking flow.
 *
 * Safety:
 * - The contract decides everything (opt-in, eligibility, due-ness, dust). The read
 *   side filter here only avoids failed simulations; a run that is not due returns
 *   (0, 0, 0), so a repeated or doubled sweep (two DigitalOcean instances) is harmless.
 * - `min_vault_shares` is the pool's live `calc_token_amount` quote for the vault leg
 *   minus DEPOSIT_SLIPPAGE_BPS. A stale quote makes the whole run revert on-chain
 *   (nothing half-applied); the next sweep retries.
 * - Every transaction is confirmed by polling, never assumed from the submit hash.
 * - Off by default: AUTO_COMPOUND_ENABLED must be "true", and the contract's own
 *   feature switch (`set_auto_compound_config`, multisig) must be on.
 *
 * Env: AUTO_COMPOUND_ENABLED (default false), AUTO_COMPOUND_CRON (default
 * '0 3 * * *', read at boot), DEPOSIT_SLIPPAGE_BPS (shared with Stream B).
 */
@Injectable()
export class AutoCompoundService {
  private readonly logger = new Logger(AutoCompoundService.name);
  private readonly server: StellarSdk.SorobanRpc.Server;
  private readonly sendServer: StellarSdk.SorobanRpc.Server;
  private readonly horizonServer: StellarSdk.Horizon.Server;
  private readonly adminKeypair: Keypair;
  private readonly stakingContractId: string;
  private readonly enabled: boolean;
  private readonly depositSlippageBps: number;

  private running = false;
  private lastRun: {
    startedAt: string;
    finishedAt?: string;
    trigger: string;
    results: RunResult[];
    note?: string;
  } | null = null;
  /** Consecutive failed runs per user; three in a row is flagged in the log. */
  private readonly failures = new Map<string, number>();

  constructor(private configService: ConfigService) {
    this.server = new StellarSdk.SorobanRpc.Server(
      this.configService.get<string>('SOROBAN_RPC_URL'),
    );
    this.sendServer = new StellarSdk.SorobanRpc.Server(
      this.configService.get<string>('SOROBAN_SEND_RPC_URL') ||
        'https://soroban-rpc.mainnet.stellar.gateway.fm',
    );
    this.horizonServer = new StellarSdk.Horizon.Server(
      this.configService.get<string>('STELLAR_HORIZON_URL'),
    );
    this.adminKeypair = Keypair.fromSecret(
      this.configService.get<string>('ADMIN_SECRET_KEY'),
    );
    this.stakingContractId = this.configService.get<string>(
      'STAKING_CONTRACT_ID',
    );
    this.enabled =
      (this.configService.get<string>('AUTO_COMPOUND_ENABLED') ?? 'false') ===
      'true';
    const slip = Number(
      this.configService.get<string>('DEPOSIT_SLIPPAGE_BPS') ?? '100',
    );
    this.depositSlippageBps =
      Number.isFinite(slip) && slip >= 0 && slip < 10000 ? slip : 100;
  }

  @Cron(process.env.AUTO_COMPOUND_CRON || '0 3 * * *', {
    name: 'auto-compound',
    timeZone: 'UTC',
  })
  async handleAutoCompound(): Promise<void> {
    if (!this.enabled) return;
    await this.sweep('cron');
  }

  /** POST /test/auto-compound — optional `user` runs a single wallet. */
  async manualTrigger(user?: string) {
    return this.sweep(user ? `manual:${user}` : 'manual', user);
  }

  getStatus() {
    return {
      enabled: this.enabled,
      schedule: process.env.AUTO_COMPOUND_CRON || '0 3 * * *',
      running: this.running,
      lastRun: this.lastRun,
      flaggedUsers: [...this.failures.entries()]
        .filter(([, n]) => n >= 3)
        .map(([user, n]) => ({ user, consecutiveFailures: n })),
    };
  }

  /** GET /public/auto-compound/stats — totals from the last sweep. */
  getPublicStats() {
    const r = this.lastRun?.results ?? [];
    const sum = (k: 'total' | 'toLock' | 'toVault') =>
      r.reduce((acc, x) => acc + BigInt(x[k] ?? '0'), 0n).toString();
    return {
      lastRun: this.lastRun?.finishedAt ?? null,
      users: r.length,
      compounded: r.filter((x) => x.status === 'compounded').length,
      failed: r.filter((x) => x.status === 'failed').length,
      aquaRouted: sum('total'),
      aquaToLock: sum('toLock'),
      aquaToVault: sum('toVault'),
    };
  }

  private async sweep(trigger: string, onlyUser?: string) {
    if (this.running) return { message: 'auto-compound sweep already running' };
    this.running = true;
    const run = {
      startedAt: new Date().toISOString(),
      trigger,
      results: [] as RunResult[],
    };
    this.lastRun = run;
    // Serialise with the other manager-wallet crons so their transactions never
    // collide on the account sequence number.
    if (!acquireWalletLock('auto-compound')) {
      this.running = false;
      this.lastRun = {
        ...run,
        finishedAt: new Date().toISOString(),
        note: 'manager wallet busy; skipped',
      };
      return this.lastRun;
    }
    try {
      const cfg = await this.view('get_auto_compound_config');
      const policy = await this.view('get_reward_policy');
      const payout = Array.isArray(policy.payout_token)
        ? policy.payout_token[0]
        : policy.payout_token;
      if (!cfg.enabled || cfg.paused || payout !== 'Aqua') {
        this.lastRun = {
          ...run,
          finishedAt: new Date().toISOString(),
          note: `not running: enabled=${cfg.enabled} paused=${cfg.paused} payout=${payout}`,
        };
        return this.lastRun;
      }
      const users = onlyUser ? [onlyUser] : await this.allUsers();
      const pool = await this.view(
        'get_pool_info',
        StellarSdk.nativeToScVal(cfg.vault_pool_id, { type: 'u32' }),
      );
      const now = BigInt(Math.floor(Date.now() / 1000));

      for (const user of users) {
        run.results.push(await this.runOne(user, cfg, pool, now));
      }
      const done = run.results.filter((r) => r.status === 'compounded').length;
      this.logger.log(
        `[auto-compound] ${trigger}: ${users.length} user(s), ${done} compounded, ` +
          `${run.results.filter((r) => r.status === 'failed').length} failed`,
      );
      this.lastRun = { ...run, finishedAt: new Date().toISOString() };
      return this.lastRun;
    } catch (e: any) {
      this.logger.error(`[auto-compound] sweep aborted: ${e.message}`);
      this.lastRun = {
        ...run,
        finishedAt: new Date().toISOString(),
        note: `aborted: ${e.message}`,
      };
      return this.lastRun;
    } finally {
      releaseWalletLock();
      this.running = false;
    }
  }

  private async runOne(
    user: string,
    cfg: any,
    pool: any,
    now: bigint,
  ): Promise<RunResult> {
    try {
      const info = await this.view(
        'get_auto_compound_info',
        StellarSdk.nativeToScVal(StellarSdk.Address.fromString(user)),
      );
      const pending = BigInt(info.pending_aqua);
      const due = BigInt(info.due_at);
      if (!info.enabled)
        return { user, status: 'skipped', reason: 'switch off' };
      if (!info.eligible)
        return { user, status: 'skipped', reason: 'below minimum stake' };
      if (due > 0n && now < due)
        return { user, status: 'skipped', reason: `not due until ${due}` };
      if (pending <= 0n || pending < BigInt(cfg.min_compound_aqua)) {
        return { user, status: 'skipped', reason: 'below dust floor' };
      }

      const toVault = (pending * BigInt(10000 - cfg.lock_bps)) / 10000n;
      const minShares =
        toVault > 0n ? await this.quoteSingleSidedAqua(pool, toVault) : 0n;

      const op = new StellarSdk.Contract(this.stakingContractId).call(
        'auto_compound',
        StellarSdk.nativeToScVal(
          StellarSdk.Address.fromString(this.adminKeypair.publicKey()),
        ),
        StellarSdk.nativeToScVal(StellarSdk.Address.fromString(user)),
        StellarSdk.nativeToScVal(minShares, { type: 'u128' }),
      );
      const tx = await this.buildAndSignTransaction(op);
      const sent = await this.sendServer.sendTransaction(tx);
      if (sent.status === 'ERROR')
        throw new Error(`send failed: ${JSON.stringify(sent.errorResult)}`);
      const confirmed = await this.pollTransactionStatus(sent.hash);
      const [total, toLock, toVaultOut] = confirmed.returnValue
        ? (StellarSdk.scValToNative(confirmed.returnValue) as bigint[])
        : [0n, 0n, 0n];
      this.failures.delete(user);
      if (BigInt(total) === 0n) {
        return {
          user,
          status: 'skipped',
          reason: 'contract skipped (not due / dust)',
          hash: sent.hash,
        };
      }
      this.logger.log(
        `[auto-compound] ${user}: ${total} AQUA -> lock ${toLock} + vault ${toVaultOut} (min shares ${minShares}) ${sent.hash}`,
      );
      return {
        user,
        status: 'compounded',
        total: String(total),
        toLock: String(toLock),
        toVault: String(toVaultOut),
        minVaultShares: String(minShares),
        hash: sent.hash,
      };
    } catch (e: any) {
      const n = (this.failures.get(user) ?? 0) + 1;
      this.failures.set(user, n);
      const flag =
        n >= 3
          ? ' — FLAGGED: 3+ consecutive failures (stale quote or inactive vault pool?)'
          : '';
      this.logger.error(
        `[auto-compound] ${user} failed (${n}x): ${e.message}${flag}`,
      );
      return { user, status: 'failed', reason: e.message };
    }
  }

  private async allUsers(): Promise<string[]> {
    const out: string[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const page: string[] = await this.view(
        'get_auto_compound_users',
        StellarSdk.nativeToScVal(offset, { type: 'u32' }),
        StellarSdk.nativeToScVal(PAGE, { type: 'u32' }),
      );
      out.push(...page);
      if (page.length < PAGE) return out;
    }
  }

  /**
   * Minimum LP for a single-sided AQUA deposit, from the vault pool's own
   * `calc_token_amount`, cut by DEPOSIT_SLIPPAGE_BPS. Amounts go in the POOL's token
   * order (read from `get_tokens`, not assumed). Never 0 for a positive amount.
   */
  private async quoteSingleSidedAqua(
    pool: any,
    aquaAmount: bigint,
  ): Promise<bigint> {
    const aquaToken = this.configService.get<string>('AQUA_TOKEN_ID');
    const amm = new StellarSdk.Contract(pool.pool_address);
    const tokens: string[] = StellarSdk.scValToNative(
      (await this.simulate(amm.call('get_tokens'))).result.retval,
    );
    const amounts = tokens.map((t) =>
      StellarSdk.nativeToScVal(t === aquaToken ? aquaAmount : 0n, {
        type: 'u128',
      }),
    );
    const sim = await this.simulate(
      amm.call(
        'calc_token_amount',
        StellarSdk.xdr.ScVal.scvVec(amounts),
        StellarSdk.nativeToScVal(true),
      ),
    );
    const quoted = BigInt(StellarSdk.scValToNative(sim.result.retval));
    if (quoted <= 0n)
      throw new Error(
        `calc_token_amount quoted ${quoted} LP; refusing to deposit blind`,
      );
    return (quoted * BigInt(10000 - this.depositSlippageBps)) / 10000n;
  }

  // ==========================================================================
  // Stellar helpers (mirror bribe-reward.service.ts)
  // ==========================================================================

  private async view(
    fn: string,
    ...args: StellarSdk.xdr.ScVal[]
  ): Promise<any> {
    const sim = await this.simulate(
      new StellarSdk.Contract(this.stakingContractId).call(fn, ...args),
    );
    return StellarSdk.scValToNative(sim.result.retval);
  }

  private async simulate(operation: StellarSdk.xdr.Operation): Promise<any> {
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
    maxAttempts = 90,
  ): Promise<any> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const status = await this.sendServer.getTransaction(hash);
        if (status.status === 'SUCCESS') return status;
        if (status.status === 'FAILED')
          throw new Error(`Transaction failed: ${hash}`);
      } catch (error: any) {
        if (
          !(
            error.message?.includes('not found') ||
            error.message?.includes('NOT_FOUND')
          )
        ) {
          throw error;
        }
      }
      await this.sleep(2000);
    }
    // RPC never showed it: ask Horizon before calling it a failure.
    try {
      const tx: any = await this.horizonServer
        .transactions()
        .transaction(hash)
        .call();
      if (tx.successful) return { status: 'SUCCESS', hash };
      throw new Error(`Transaction failed (per Horizon): ${hash}`);
    } catch (e: any) {
      if (e.message?.includes('per Horizon')) throw e;
      throw new Error(`Transaction timeout, not found on Horizon: ${hash}`);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
