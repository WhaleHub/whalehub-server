import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as StellarSdk from '@stellar/stellar-sdk';

/**
 * Staking APY Indexer
 *
 * Indexes `rwd_add` events from the staking contract and exposes a rolling
 * 7-day APY. This replaces the frontend's lifetime-ratio `calculateAPY`, which
 * overstated APY by `protocol_age_days / 7` because it divided cumulative
 * `total_rewards_added` by the 7-day floor clamp.
 *
 * Correct rate: Σ(rewards in last 7d) / avg(total_staked in window)
 * annualized by multiplying by 365.25 / window_days.
 *
 * No DB — keeps events in memory. On cold start, backfills from
 * `(latest_ledger - 7d)` worth of ledgers via `getEvents`. Events are self-contained
 * (amount, total_staked_snapshot, timestamp), so replays are idempotent.
 */

const YEAR_SECONDS = 365.25 * 24 * 3600;
const DEFAULT_WINDOW_SECONDS = 7 * 24 * 3600;
const POLL_INTERVAL_MS = 60_000;
const LEDGER_SECONDS = 5; // conservative Soroban ledger cadence
const BACKFILL_LEDGERS = Math.ceil((DEFAULT_WINDOW_SECONDS * 1.2) / LEDGER_SECONDS); // 7d + 20% headroom
const MAX_BACKFILL_LEDGERS = 120_000; // RPC retention horizon
// Expected cadence of `add_rewards` calls from StakingRewardService
// (every 30 minutes via `handleStakingRewardDistribution`).
// Each event represents rewards accrued over the preceding interval, so we
// use this as the divisor contribution for the most recent event.
const TYPICAL_REWARD_INTERVAL_SECONDS = 30 * 60;
// Base64 of "rwd_add" as SCV_SYMBOL — copied from existing event polling pattern in staking-reward.service
const RWD_ADD_TOPIC = 'AAAADwAAAAdyd2RfYWRkAA==';

interface RewardEvent {
  timestamp: number; // unix seconds
  amount: bigint; // BLUB stroops
  totalStaked: bigint; // BLUB stroops at time of emission
  ledger: number;
  id: string;
}

export interface ApyWindowResult {
  windowDays: number;
  eventCount: number;
  rewardsInWindow: string; // BLUB (token units)
  avgTotalStaked: string; // BLUB
  apy: string; // percentage (e.g. "18.25")
  oldestEventTs: number | null;
  latestEventTs: number | null;
  lastUpdated: number;
}

@Injectable()
export class StakingApyIndexerService implements OnModuleInit {
  private readonly logger = new Logger(StakingApyIndexerService.name);
  private readonly server: StellarSdk.SorobanRpc.Server;
  private readonly stakingContractId: string;

  private events: RewardEvent[] = [];
  private lastSeenLedger = 0;
  private lastUpdated = 0;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(private readonly configService: ConfigService) {
    const rpcUrl = this.configService.get<string>('SOROBAN_RPC_URL');
    this.server = new StellarSdk.SorobanRpc.Server(rpcUrl);
    this.stakingContractId = this.configService.get<string>('STAKING_CONTRACT_ID');
  }

  async onModuleInit() {
    try {
      await this.backfill();
    } catch (err: any) {
      this.logger.warn(`Backfill failed, will catch up on first poll: ${err.message}`);
    }
    this.pollTimer = setInterval(() => {
      this.poll().catch((err) =>
        this.logger.debug(`APY poll error: ${err.message}`),
      );
    }, POLL_INTERVAL_MS);
  }

  /**
   * Rolling APY over the most recent `windowDays` days.
   * Annualization: APY = (rewards_in_window / avg_total_staked) * (YEAR / divisor) * 100.
   *
   * Divisor picks:
   *   - If the indexer has collected at least `windowDays` of events, divide by the
   *     full window → honest rolling rate.
   *   - Otherwise the window isn't full yet (cold start / recent deploy): divide by
   *     the observed span + one expected-interval tick, floored at MIN_DIVISOR.
   *     This reports the implied rate from the events we do have, instead of reading
   *     0% until the buffer fills.
   */
  getApyWindow(windowDays = 7): ApyWindowResult {
    const now = Math.floor(Date.now() / 1000);
    const windowSeconds = windowDays * 24 * 3600;
    const cutoff = now - windowSeconds;
    const inWindow = this.events.filter((e) => e.timestamp >= cutoff);

    if (inWindow.length === 0) {
      return {
        windowDays,
        eventCount: 0,
        rewardsInWindow: '0',
        avgTotalStaked: '0',
        apy: '--',
        oldestEventTs: null,
        latestEventTs: null,
        lastUpdated: this.lastUpdated,
      };
    }

    let totalRewards = 0n;
    let stakedSum = 0n;
    for (const e of inWindow) {
      totalRewards += e.amount;
      stakedSum += e.totalStaked;
    }
    const avgStaked = stakedSum / BigInt(inWindow.length);

    const oldestTs = inWindow[0].timestamp;
    const latestTs = inWindow[inWindow.length - 1].timestamp;
    const observedSpan = latestTs - oldestTs;
    const isWindowFull = observedSpan >= windowSeconds * 0.9;
    // observedSpan spans the first event to the last; each event covers one
    // cadence interval of accumulation, so add one interval to the span.
    const divisorSeconds = isWindowFull
      ? windowSeconds
      : observedSpan + TYPICAL_REWARD_INTERVAL_SECONDS;

    let apy = '--';
    if (avgStaked > 0n && divisorSeconds > 0) {
      // Use floating point for the final ratio — precision loss here is fine for display.
      const rewardsF = Number(totalRewards);
      const stakedF = Number(avgStaked);
      const rate = (rewardsF / stakedF) * (YEAR_SECONDS / divisorSeconds);
      apy = (rate * 100).toFixed(2);
    }

    return {
      windowDays,
      eventCount: inWindow.length,
      rewardsInWindow: (Number(totalRewards) / 1e7).toFixed(7),
      avgTotalStaked: (Number(avgStaked) / 1e7).toFixed(2),
      apy,
      oldestEventTs: inWindow[0].timestamp,
      latestEventTs: inWindow[inWindow.length - 1].timestamp,
      lastUpdated: this.lastUpdated,
    };
  }

  private async backfill(): Promise<void> {
    const latest = (await this.server.getLatestLedger()).sequence;
    const startLedger = Math.max(1, latest - Math.min(BACKFILL_LEDGERS, MAX_BACKFILL_LEDGERS));
    this.logger.log(
      `APY backfill: scanning rwd_add from ledger ${startLedger} → ${latest}`,
    );
    await this.fetchAndIngest(startLedger);
    this.pruneOld();
    this.logger.log(
      `APY backfill complete: ${this.events.length} events in buffer`,
    );
  }

  private async poll(): Promise<void> {
    const startLedger = this.lastSeenLedger > 0 ? this.lastSeenLedger + 1 : undefined;
    if (!startLedger) return;
    await this.fetchAndIngest(startLedger);
    this.pruneOld();
  }

  private async fetchAndIngest(startLedger: number): Promise<void> {
    let cursor: string | undefined;
    let totalIngested = 0;
    // getEvents returns up to 100 per page — paginate via cursor.
    for (let i = 0; i < 50; i++) {
      const resp: any = await this.server.getEvents({
        startLedger,
        filters: [
          {
            type: 'contract',
            contractIds: [this.stakingContractId],
            topics: [[RWD_ADD_TOPIC]],
          },
        ],
        limit: 100,
        cursor,
      });

      if (!resp.events || resp.events.length === 0) {
        if (resp.latestLedger) this.lastSeenLedger = resp.latestLedger;
        break;
      }

      for (const ev of resp.events) {
        try {
          const parsed = this.parseEvent(ev);
          if (parsed) {
            if (!this.events.some((e) => e.id === parsed.id)) {
              this.events.push(parsed);
              totalIngested++;
            }
          }
        } catch (err: any) {
          this.logger.debug(`Skipping malformed rwd_add: ${err.message}`);
        }
      }

      if (resp.latestLedger) this.lastSeenLedger = resp.latestLedger;
      // If fewer than page size returned, we're caught up.
      if (resp.events.length < 100) break;
      cursor = resp.cursor;
      if (!cursor) break;
    }
    if (totalIngested > 0) {
      this.events.sort((a, b) => a.timestamp - b.timestamp);
      this.lastUpdated = Math.floor(Date.now() / 1000);
      this.logger.debug(`APY indexer ingested ${totalIngested} new events`);
    }
  }

  private parseEvent(ev: any): RewardEvent | null {
    const native = StellarSdk.scValToNative(ev.value);
    // RewardsAddedEvent { amount, total_staked, reward_per_token, timestamp }
    const amount = BigInt(native.amount ?? native[0] ?? 0);
    const totalStaked = BigInt(native.total_staked ?? native[1] ?? 0);
    const timestamp = Number(native.timestamp ?? native[3] ?? 0);
    if (amount <= 0n || timestamp <= 0) return null;
    return {
      amount,
      totalStaked,
      timestamp,
      ledger: ev.ledger,
      id: ev.id ?? `${ev.ledger}-${ev.txHash ?? ev.transactionHash ?? Math.random()}`,
    };
  }

  private pruneOld(): void {
    // Keep a little more than the default window so longer queries (e.g. 14d) still work.
    const cutoff = Math.floor(Date.now() / 1000) - DEFAULT_WINDOW_SECONDS * 3;
    this.events = this.events.filter((e) => e.timestamp >= cutoff);
  }
}
