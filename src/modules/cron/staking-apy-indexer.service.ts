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
// Soroban mainnet RPC retains ~48k ledgers (~2.3d). Asking for more triggers
// "startLedger must be within the ledger range" (-32600), backfill explodes,
// and polling stalls forever. 36k ≈ 2d of headroom inside retention.
const MAX_BACKFILL_LEDGERS = 36_000;
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
      // poll() bails when lastSeenLedger=0, so we'd never recover.
      // Anchor to the current ledger so polling picks up new events.
      try {
        const latest = (await this.server.getLatestLedger()).sequence;
        this.lastSeenLedger = latest;
      } catch (e: any) {
        this.logger.warn(`Could not fetch latest ledger after backfill failure: ${e.message}`);
      }
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
   * Divisor: when at least 90% of the window is observed, use the full window;
   * otherwise use observed span + one expected interval. We require a minimum
   * observed span (`MIN_OBSERVED_SPAN_SECONDS`) before annualizing — otherwise
   * a single reward event extrapolates to absurd numbers (e.g. 160%+) because
   * `YEAR_SECONDS / 1800` is a ~17,500x multiplier.
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
    // Minimum observed span before we trust the rate enough to annualize.
    // 6h covers ~12 reward distributions at the 30min cadence — enough to
    // smooth single-event spikes that would otherwise project to >100% APY.
    const MIN_OBSERVED_SPAN_SECONDS = 6 * 3600;
    // Two divisor candidates:
    //   spanDivisor — actual wall time covered by the events. Counts cron
    //     outages as zero-reward time, dragging APY down (May 2026: a 43h
    //     cron gap inside a 7d window pushed APY from ~19% to ~6%).
    //   activeDivisor — each event treated as covering one expected interval,
    //     so gaps don't count. Reflects the rate stakers earn when the cron
    //     fires normally.
    // Use min() so historical outages don't depress the displayed rate.
    const spanDivisor = observedSpan + TYPICAL_REWARD_INTERVAL_SECONDS;
    const activeDivisor = inWindow.length * TYPICAL_REWARD_INTERVAL_SECONDS;
    const divisorSeconds = isWindowFull
      ? windowSeconds
      : Math.min(spanDivisor, activeDivisor);

    let apy = '--';
    const hasEnoughHistory = isWindowFull || observedSpan >= MIN_OBSERVED_SPAN_SECONDS;
    if (hasEnoughHistory && avgStaked > 0n && divisorSeconds > 0) {
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
    // The Soroban RPC server caps `getEvents` responses at ~24 events per call
    // regardless of the `limit` we pass, and chunks pagination by ledger range
    // — so intermediate pages can return 0 events while later pages still hold
    // matches. Empty-page-as-stop therefore drops events: in May 2026 it left
    // the indexer permanently 2 days behind because page 2 was empty but page
    // 3 had today's batch.
    //
    // Stop only when the cursor stops advancing. The 50-iteration cap is a
    // safety bound.
    for (let i = 0; i < 50; i++) {
      const params: any = {
        filters: [
          {
            type: 'contract',
            contractIds: [this.stakingContractId],
            topics: [[RWD_ADD_TOPIC]],
          },
        ],
        limit: 100,
      };
      // RPC requires either startLedger OR cursor, not both.
      if (cursor) params.cursor = cursor;
      else params.startLedger = startLedger;
      const resp: any = await this.server.getEvents(params);

      if (resp.latestLedger) this.lastSeenLedger = resp.latestLedger;

      const nextCursor: string | undefined = resp.cursor;
      const events = resp.events || [];

      for (const ev of events) {
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

      // Stop when the cursor doesn't advance — that means we've caught up.
      if (!nextCursor || nextCursor === cursor) break;
      cursor = nextCursor;
    }
    if (totalIngested > 0) {
      this.events.sort((a, b) => a.timestamp - b.timestamp);
      this.lastUpdated = Math.floor(Date.now() / 1000);
      this.logger.debug(`APY indexer ingested ${totalIngested} new events`);
    }
  }

  private parseEvent(ev: any): RewardEvent | null {
    // The Soroban RPC `getEvents` response delivers `value` as a base64-encoded
    // ScVal XDR string. `scValToNative` only accepts a parsed `xdr.ScVal` —
    // passing the string throws `scv.switch is not a function`, which the
    // outer debug-level catch swallows, dropping every event silently. Decode
    // the XDR first. Also tolerate the (rare) pre-parsed-object case.
    const raw = ev.valueXdr ?? ev.value;
    const sc =
      typeof raw === 'string'
        ? StellarSdk.xdr.ScVal.fromXDR(raw, 'base64')
        : raw;
    const native = StellarSdk.scValToNative(sc);
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
