import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as StellarSdk from '@stellar/stellar-sdk';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { TelegramClient, escapeHtml } from './telegram';

/**
 * Protocol activity tracker + Telegram notifier.
 *
 * Polls EVERY contract event the staking contract emits (no topic filter), keeps
 * a rolling in-memory feed of recent activity (GET /public/activity), and posts
 * each one to the "Whalehub Status" Telegram channel.
 *
 * Three classes of message:
 *   - user     stake / lock / unstake / claim / vault deposit+withdraw / auto-compound
 *   - protocol reward adds, vault compounds, POL deposits, ICE locks (TELEGRAM_NOTIFY_PROTOCOL)
 *   - admin    config changes, manager/admin transfer, migrations, pool add/toggle,
 *              PLUS two out-of-band watches: the contract's wasm hash (upgrades emit
 *              no contract event) and the BLUB issuer's home_domain (see CLAUDE.md —
 *              it has been silently flipped to lobstr.co twice). Always posted.
 *
 * Read-only: this service never signs or submits anything.
 *
 * Restart / duplicate safety:
 *   - A persisted cursor (last notified ledger) lets a restart catch up on what it
 *     missed instead of re-posting or skipping. The first-ever start posts nothing
 *     historic; it only fills the feed.
 *   - Every event id is "claimed" with an O_EXCL file before posting, so two
 *     processes sharing the state dir can't both post it. Two DO containers with
 *     SEPARATE filesystems would still double-post — run the notifier in one place
 *     (TELEGRAM_NOTIFY_ENABLED=false on the other).
 */

const POLL_INTERVAL_MS = 30_000;
const WATCH_INTERVAL_MS = 5 * 60_000;
// Soroban RPC retains ~48k ledgers; stay well inside it (see staking-apy-indexer).
const MAX_BACKFILL_LEDGERS = 36_000;
const FEED_MAX = 500;
const CLAIM_TTL_MS = 4 * 24 * 3600 * 1000;
const STROOPS = 1e7;
const EXPERT = 'https://stellar.expert/explorer/public';
const EXPECTED_HOME_DOMAIN = 'whalehub.io';
const DEFAULT_BLUB_ISSUER = 'GDERSSCKJQPPXUQOZIOXGRVAGNLVPVZCJ2MAX7RCMVMWGRPVAEG7XGTK';

// Pool ids as configured on the staking contract.
const POOL_NAMES: Record<number, string> = { 0: 'BLUB/AQUA' };

// Emitted alongside a user action that already gets its own message, or purely
// internal bookkeeping — feed only, never posted.
const QUIET_TOPICS = new Set([
  'ice_xfer', // with a user topic: part of `lock`; with a lock id: covered by ice_auth
  'pol_pre',
  'cfg_tok',
  'tok_ord',
  'blub_1st',
  'pol',
  'ucred',
  'batch',
  'ice_sync',
  'rwd_swap',
]);

const ADMIN_TOPICS = new Set([
  'set_op',
  'adm_xfer',
  'migrated',
  'pool_add',
  'pool_upd',
  'cfg_upd',
  'rwd_pol',
  'ac_cfg',
  'ac_pause',
  'emrg_rst',
  'vfee_upd',
  'vtrs_upd',
  'liq_upd',
  'blub_upd',
  'ice_tl',
]);

export type ActivityKind = 'user' | 'protocol' | 'admin' | 'internal';

export interface ActivityItem {
  id: string;
  ledger: number;
  closedAt: string;
  txHash: string;
  topic: string;
  kind: ActivityKind;
  user: string | null;
  summary: string; // plain text
}

interface Formatted {
  kind: ActivityKind;
  user: string | null;
  html: string; // Telegram body (no header/footer)
  text: string; // plain-text summary for the feed
}

@Injectable()
export class ProtocolActivityService implements OnModuleInit {
  private readonly logger = new Logger(ProtocolActivityService.name);
  private readonly server: StellarSdk.SorobanRpc.Server;
  private readonly contractId: string;
  private readonly horizonUrl: string;
  private readonly blubIssuer: string;
  private readonly telegram: TelegramClient;
  private readonly notifyEnabled: boolean;
  private readonly notifyProtocol: boolean;
  private readonly stateFile: string;
  private readonly claimDir: string;
  private readonly feedFile: string;

  private feed: ActivityItem[] = [];
  private lastSeenLedger = 0;
  private lastNotifiedLedger = 0;
  private polling = false;
  private lastWasmHash: string | null = null;
  private lastHomeDomain: string | null = null;
  private stats = { eventsSeen: 0, posted: 0, lastPollAt: 0, lastError: '' };

  constructor(private readonly configService: ConfigService) {
    this.server = new StellarSdk.SorobanRpc.Server(
      this.configService.get<string>('SOROBAN_RPC_URL'),
    );
    this.contractId = this.configService.get<string>('STAKING_CONTRACT_ID');
    this.horizonUrl =
      this.configService.get<string>('STELLAR_HORIZON_URL') ||
      'https://horizon.stellar.org';
    this.blubIssuer =
      this.configService.get<string>('BLUB_ISSUER') || DEFAULT_BLUB_ISSUER;
    this.telegram = new TelegramClient(
      this.configService.get<string>('TELEGRAM_BOT_TOKEN'),
      this.configService.get<string>('TELEGRAM_CHAT_ID'),
      (m) => this.logger.warn(m),
    );
    this.notifyEnabled =
      this.configService.get<string>('TELEGRAM_NOTIFY_ENABLED') !== 'false' &&
      this.telegram.enabled;
    this.notifyProtocol =
      this.configService.get<string>('TELEGRAM_NOTIFY_PROTOCOL') !== 'false';

    const stateDir =
      process.env.WHALEHUB_STATE_DIR ||
      process.env.BRIBE_STATE_DIR ||
      path.join(process.cwd(), '.whalehub-state');
    this.stateFile = path.join(stateDir, 'activity-cursor.json');
    this.feedFile = path.join(stateDir, 'activity-feed.json');
    this.claimDir = path.join(stateDir, 'activity-claims');
  }

  async onModuleInit() {
    try {
      fs.mkdirSync(this.claimDir, { recursive: true });
    } catch {
      /* claims degrade to "post anyway"; see claim() */
    }
    this.lastNotifiedLedger = this.readCursor();
    // RPC only retains ~2 days of events; the saved feed keeps older history across restarts.
    try {
      this.feed = JSON.parse(fs.readFileSync(this.feedFile, 'utf8'));
    } catch {
      this.feed = [];
    }
    this.logger.log(
      `Activity tracker: telegram=${this.notifyEnabled ? 'ON' : 'OFF'}, ` +
        `protocol msgs=${this.notifyProtocol ? 'ON' : 'OFF'}, cursor=${this.lastNotifiedLedger || 'none'}`,
    );

    try {
      const latest = (await this.server.getLatestLedger()).sequence;
      await this.fetchAndProcess(Math.max(1, latest - MAX_BACKFILL_LEDGERS));
    } catch (err: any) {
      this.logger.warn(`Activity backfill failed: ${err.message}`);
      try {
        this.lastSeenLedger = (await this.server.getLatestLedger()).sequence;
      } catch {
        /* first poll retries */
      }
    }
    // First-ever start: anchor the cursor so history is never posted.
    if (!this.lastNotifiedLedger && this.lastSeenLedger) {
      this.lastNotifiedLedger = this.lastSeenLedger;
      this.writeCursor();
    }

    setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    setInterval(() => void this.runWatches(), WATCH_INTERVAL_MS);
    void this.runWatches();
  }

  // ───────────────────────────── public API ─────────────────────────────

  getFeed(limit = 50, kind?: string): ActivityItem[] {
    const items = kind ? this.feed.filter((i) => i.kind === kind) : this.feed;
    return items.slice(0, Math.min(Math.max(limit, 1), FEED_MAX));
  }

  getStatus() {
    return {
      telegram: this.notifyEnabled,
      protocolMessages: this.notifyProtocol,
      lastSeenLedger: this.lastSeenLedger,
      lastNotifiedLedger: this.lastNotifiedLedger,
      feedSize: this.feed.length,
      wasmHash: this.lastWasmHash,
      blubHomeDomain: this.lastHomeDomain,
      ...this.stats,
    };
  }

  /** Posts a test line, to confirm the bot can write to the channel. */
  async sendTest() {
    if (!this.telegram.enabled) {
      return { success: false, message: 'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set' };
    }
    await this.telegram.send('🐋 <b>WhaleHub tracker connected</b>\nProtocol activity will be posted here.');
    return { success: true };
  }

  // ───────────────────────────── polling ─────────────────────────────

  private async poll(): Promise<void> {
    if (this.polling || !this.lastSeenLedger) return;
    this.polling = true;
    try {
      await this.fetchAndProcess(this.lastSeenLedger + 1);
      this.stats.lastPollAt = Date.now();
    } catch (err: any) {
      this.stats.lastError = err.message;
      // Fell out of RPC retention (long outage) → re-anchor rather than stall forever.
      if (/ledger range/i.test(err.message)) {
        this.lastSeenLedger = (await this.server.getLatestLedger()).sequence;
        await this.postAdmin(
          `⚠️ Activity tracker fell outside RPC retention; events before ledger ${this.lastSeenLedger} were not posted.`,
        );
      } else {
        this.logger.debug(`Activity poll error: ${err.message}`);
      }
    } finally {
      this.polling = false;
    }
  }

  private async fetchAndProcess(startLedger: number): Promise<void> {
    let cursor: string | undefined;
    const fresh: ActivityItem[] = [];
    const toPost: { item: ActivityItem; html: string }[] = [];

    // Same pagination rule as the APY indexer: stop only when the cursor stops
    // advancing — empty intermediate pages are normal.
    for (let i = 0; i < 100; i++) {
      const params: any = {
        filters: [{ type: 'contract', contractIds: [this.contractId] }],
        limit: 100,
      };
      if (cursor) params.cursor = cursor;
      else params.startLedger = startLedger;
      const resp: any = await this.server.getEvents(params);
      if (resp.latestLedger) this.lastSeenLedger = resp.latestLedger;

      for (const ev of resp.events || []) {
        if (this.feed.some((f) => f.id === ev.id) || fresh.some((f) => f.id === ev.id)) continue;
        let parsed: { item: ActivityItem; html: string } | null = null;
        try {
          parsed = this.parse(ev);
        } catch (err: any) {
          this.logger.debug(`Unparseable event ${ev.id}: ${err.message}`);
        }
        if (!parsed) continue;
        fresh.push(parsed.item);
        this.stats.eventsSeen++;
        if (parsed.item.ledger > this.lastNotifiedLedger && this.shouldPost(parsed.item.kind)) {
          toPost.push(parsed);
        }
      }
      const next: string | undefined = resp.cursor;
      if (!next || next === cursor) break;
      cursor = next;
    }

    if (fresh.length) {
      this.feed = [...fresh.reverse(), ...this.feed]
        .sort((a, b) => b.ledger - a.ledger)
        .slice(0, FEED_MAX);
      try {
        fs.writeFileSync(this.feedFile, JSON.stringify(this.feed));
      } catch {
        /* feed is a convenience; memory copy still serves */
      }
    }

    if (this.lastNotifiedLedger) {
      for (const p of toPost) {
        if (!this.claim(p.item.id)) continue;
        await this.telegram.send(p.html);
        this.stats.posted++;
      }
      if (this.lastSeenLedger > this.lastNotifiedLedger) {
        this.lastNotifiedLedger = this.lastSeenLedger;
        this.writeCursor();
      }
    }
  }

  private shouldPost(kind: ActivityKind): boolean {
    if (!this.notifyEnabled) return false;
    if (kind === 'internal') return false;
    if (kind === 'protocol') return this.notifyProtocol;
    return true;
  }

  // ───────────────────────────── parsing ─────────────────────────────

  private parse(ev: any): { item: ActivityItem; html: string } | null {
    const topics: any[] = (ev.topic || []).map((t: any) => native(t));
    const topic = typeof topics[0] === 'string' ? topics[0] : String(topics[0]);
    const value = native(ev.valueXdr ?? ev.value);
    const txHash: string = ev.txHash ?? ev.transactionHash ?? '';

    const f = this.format(topic, topics, value);
    const item: ActivityItem = {
      id: ev.id,
      ledger: ev.ledger,
      closedAt: ev.ledgerClosedAt,
      txHash,
      topic,
      kind: f.kind,
      user: f.user,
      summary: f.text,
    };
    const footer = txHash ? `\n<a href="${EXPERT}/tx/${txHash}">tx ${txHash.slice(0, 8)}</a>` : '';
    return { item, html: f.html + footer };
  }

  private format(topic: string, topics: any[], v: any): Formatted {
    const userTopic = typeof topics[1] === 'string' && /^[GC]/.test(topics[1]) ? topics[1] : null;
    const u = (addr: string | null) => (addr ? acct(addr) : '');
    const user = (kind: ActivityKind, html: string, text: string, who: string | null): Formatted => ({
      kind,
      user: who,
      html,
      text,
    });

    switch (topic) {
      // ── user actions ──
      case 'lock': {
        const days = Math.round(Number(v.duration_minutes) / 1440);
        const amt = amount(v.amount);
        return user('user', `🔒 <b>${amt} AQUA locked</b> for ${days}d → BLUB\n${u(v.user)}`, `${amt} AQUA locked ${days}d`, v.user);
      }
      case 'blub_stk': {
        // The tuple form is the BLUB minted by `lock` — already announced above.
        if (Array.isArray(v)) return user('internal', '', `lock mint ${amount(v[0])} BLUB`, userTopic);
        const amt = amount(v);
        return user('user', `🐋 <b>${amt} BLUB staked</b>\n${u(userTopic)}`, `${amt} BLUB staked`, userTopic);
      }
      case 'unstake': {
        const amt = amount(v);
        return user('user', `📤 <b>${amt} BLUB unstaked</b>\n${u(userTopic)}`, `${amt} BLUB unstaked`, userTopic);
      }
      case 'unlock': {
        const amt = amount(v.amount);
        return user('user', `🔓 <b>${amt} unlocked</b>\n${u(v.user)}`, `${amt} unlocked`, v.user);
      }
      case 'rstk': {
        const amt = amount(v.amount);
        return user('user', `♻️ <b>${amt} BLUB restaked</b>\n${u(v.user)}`, `${amt} BLUB restaked`, v.user);
      }
      case 'rwd_clm': {
        const amt = amount(v.amount);
        return user('user', `🎁 <b>${amt} rewards claimed</b>\n${u(v.user)}`, `${amt} rewards claimed`, v.user);
      }
      case 'rwd_rstk': {
        const amt = amount(v);
        return user('user', `♻️ <b>${amt} rewards restaked</b>\n${u(userTopic)}`, `${amt} rewards restaked`, userTopic);
      }
      case 'ac_set': {
        const on = v === true;
        return user('user', `⚙️ Auto-compound <b>${on ? 'enabled' : 'disabled'}</b>\n${u(userTopic)}`, `auto-compound ${on ? 'on' : 'off'}`, userTopic);
      }
      case 'ac_cmp': {
        const [pending, toLock, toVault] = v;
        const text = `auto-compounded ${amount(pending)} (lock ${amount(toLock)}, vault ${amount(toVault)})`;
        return user('user', `🔁 <b>Auto-compounded ${amount(pending)}</b> — lock ${amount(toLock)} · vault ${amount(toVault)}\n${u(userTopic)}`, text, userTopic);
      }
      case 'ac_skip':
        return user('internal', '', `auto-compound skipped: ${v}`, userTopic);
      case 'vault_dep': {
        const [a, b] = v;
        const pool = poolName(topics[2]);
        const legs = BigInt(b) > 0n ? `${amount(a)} + ${amount(b)}` : `${amount(a)} single-sided`;
        return user('user', `🏦 <b>Vault deposit</b> ${pool}: ${legs}\n${u(userTopic)}`, `vault deposit ${pool} ${legs}`, userTopic);
      }
      case 'vault_wd': {
        const [lp, a, b] = v;
        const pool = poolName(topics[2]);
        return user('user', `🏧 <b>Vault withdraw</b> ${pool}: ${amount(a)} + ${amount(b)} (${amount(lp)} LP)\n${u(userTopic)}`, `vault withdraw ${pool} ${amount(lp)} LP`, userTopic);
      }
      case 'vlt_wd1': {
        const [lp, , out] = v;
        const pool = poolName(topics[2]);
        return user('user', `🏧 <b>Vault withdraw</b> ${pool}: ${amount(out)} single-sided (${amount(lp)} LP)\n${u(userTopic)}`, `vault withdraw ${pool} ${amount(lp)} LP`, userTopic);
      }
      case 'vlt_migr': {
        const [who, from, to, lp] = v;
        return user('user', `🔀 <b>Vault migrate</b> ${poolName(from)} → ${poolName(to)} (${amount(lp)} LP)\n${u(who)}`, `vault migrate ${amount(lp)} LP`, who);
      }
      case 'lpdep':
        return user('user', `🏦 <b>LP deposit recorded</b>\n${u(v.user ?? null)}`, 'LP deposit recorded', v.user ?? null);

      // ── protocol operations ──
      case 'rwd_add': {
        const amt = amount(v.amount);
        return user('protocol', `💰 <b>${amt} rewards added</b> for stakers (total staked ${amount(v.total_staked)})`, `rewards added ${amt}`, null);
      }
      case 'compound': {
        if (!Array.isArray(v)) return user('internal', '', `compound pool ${topics[1]}: ${v}`, null);
        const [total, fee, net] = v;
        const pool = poolName(topics[1]);
        return user('protocol', `🌀 <b>Vault compounded</b> ${pool}: ${amount(total)} claimed, ${amount(net)} reinvested, ${amount(fee)} fee`, `compound ${pool} ${amount(total)}`, null);
      }
      case 'cmp_dep': {
        const [minted] = v;
        return user('protocol', `🌀 Compound deposit ${poolName(topics[1])}: +${amount(minted)} LP`, `compound deposit +${amount(minted)} LP`, null);
      }
      case 'pol_dep': {
        const text = `POL deposit ${amount(v.aqua_amount)} AQUA + ${amount(v.blub_amount)} BLUB`;
        return user('protocol', `🧱 <b>${text}</b>`, text, null);
      }
      case 'man_pol': {
        const text = `POL deposit ${amount(v[0])} AQUA + ${amount(v[1])} BLUB`;
        return user('protocol', `🧱 <b>${text}</b> (manual)`, text, null);
      }
      case 'polrew':
      case 'pool_clm':
      case 'dist': {
        const amt = typeof v === 'object' && v !== null && 'amount' in v ? amount(v.amount) : typeof v === 'bigint' || typeof v === 'number' ? amount(v) : '';
        return user('protocol', `🌊 ${topic === 'pool_clm' ? 'POL rewards claimed' : topic === 'polrew' ? 'POL rewards' : 'Rewards distributed'}${amt ? ` ${amt}` : ''}`, `${topic} ${amt}`, null);
      }
      case 'ice_auth': {
        const [aqua, years] = v;
        return user('protocol', `🧊 <b>ICE lock authorized</b>: ${amount(aqua)} AQUA for ${years}y`, `ICE lock ${amount(aqua)} AQUA`, null);
      }
      case 'pol_wdrw':
      case 'pol_wd1':
        return user('admin', `🚨 <b>POL withdrawn</b> (${topic})\n<code>${escapeHtml(stringify(v))}</code>`, `POL withdrawn ${stringify(v)}`, null);
      case 'pol_err':
      case 'pol_warn':
        return user('protocol', `⚠️ <b>${topic}</b>: ${escapeHtml(stringify(v))}`, `${topic} ${stringify(v)}`, null);
    }

    if (QUIET_TOPICS.has(topic)) return user('internal', '', `${topic} ${stringify(v)}`, userTopic);
    if (ADMIN_TOPICS.has(topic)) {
      const extra = topics.slice(1).map(stringify).join(' ');
      return user('admin', `🛠 <b>Admin: ${escapeHtml(topic)}</b> ${escapeHtml(extra)}\n<code>${escapeHtml(stringify(v)).slice(0, 600)}</code>`, `admin ${topic} ${stringify(v)}`, null);
    }
    // Unknown topic — a new contract version added an event. Surface it rather than drop it.
    return user('admin', `❔ <b>New event: ${escapeHtml(topic)}</b>\n<code>${escapeHtml(stringify(v)).slice(0, 600)}</code>`, `${topic} ${stringify(v)}`, userTopic);
  }

  // ───────────────────────── out-of-band watches ─────────────────────────

  private async runWatches(): Promise<void> {
    await this.watchWasmHash().catch((e) => this.logger.debug(`wasm watch: ${e.message}`));
    await this.watchHomeDomain().catch((e) => this.logger.debug(`home_domain watch: ${e.message}`));
  }

  /** A contract upgrade emits no contract event — compare the instance's wasm hash. */
  private async watchWasmHash(): Promise<void> {
    const key = StellarSdk.xdr.LedgerKey.contractData(
      new StellarSdk.xdr.LedgerKeyContractData({
        contract: new StellarSdk.Address(this.contractId).toScAddress(),
        key: StellarSdk.xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: StellarSdk.xdr.ContractDataDurability.persistent(),
      }),
    );
    const resp = await this.server.getLedgerEntries(key);
    const entry = resp.entries?.[0];
    if (!entry) return;
    const hash = entry.val
      .contractData()
      .val()
      .instance()
      .executable()
      .wasmHash()
      .toString('hex');
    if (this.lastWasmHash && hash !== this.lastWasmHash) {
      await this.postAdmin(
        `🚨 <b>Staking contract UPGRADED</b>\n<code>${this.lastWasmHash.slice(0, 12)}</code> → <code>${hash.slice(0, 12)}</code>\n<a href="${EXPERT}/contract/${this.contractId}">contract</a>`,
      );
    }
    this.lastWasmHash = hash;
  }

  /** Wallets verify BLUB via the issuer's home_domain; it must stay whalehub.io. */
  private async watchHomeDomain(): Promise<void> {
    const { data } = await axios.get(`${this.horizonUrl}/accounts/${this.blubIssuer}`, {
      timeout: 15_000,
    });
    const domain: string = data.home_domain ?? '';
    const changed = this.lastHomeDomain !== null && domain !== this.lastHomeDomain;
    const wrongOnBoot = this.lastHomeDomain === null && domain !== EXPECTED_HOME_DOMAIN;
    if (changed || wrongOnBoot) {
      const icon = domain === EXPECTED_HOME_DOMAIN ? '✅' : '🚨';
      await this.postAdmin(
        `${icon} <b>BLUB issuer home_domain</b> is now <code>${escapeHtml(domain || '(empty)')}</code> (expected ${EXPECTED_HOME_DOMAIN})\n<a href="${EXPERT}/account/${this.blubIssuer}">issuer</a>`,
      );
    }
    this.lastHomeDomain = domain;
  }

  private async postAdmin(html: string): Promise<void> {
    this.logger.warn(html.replace(/<[^>]+>/g, ''));
    // Keyed on content, so a second process sharing the state dir doesn't repeat it.
    if (this.notifyEnabled && this.claim(`watch-${hashKey(html)}-${Math.floor(Date.now() / WATCH_INTERVAL_MS)}`)) {
      await this.telegram.send(html);
    }
  }

  // ───────────────────────────── state ─────────────────────────────

  /** Atomically claim an id; false if another process already posted it. */
  private claim(id: string): boolean {
    const file = path.join(this.claimDir, id.replace(/[^A-Za-z0-9_-]/g, '_'));
    try {
      fs.writeFileSync(file, '', { flag: 'wx' });
      this.pruneClaims();
      return true;
    } catch (err: any) {
      if (err.code === 'EEXIST') return false;
      return true; // state dir unusable → better a duplicate than a missed alert
    }
  }

  private lastPrune = 0;
  private pruneClaims(): void {
    if (Date.now() - this.lastPrune < 3600_000) return;
    this.lastPrune = Date.now();
    try {
      for (const f of fs.readdirSync(this.claimDir)) {
        const p = path.join(this.claimDir, f);
        if (Date.now() - fs.statSync(p).mtimeMs > CLAIM_TTL_MS) fs.unlinkSync(p);
      }
    } catch {
      /* best-effort */
    }
  }

  private readCursor(): number {
    try {
      return Number(JSON.parse(fs.readFileSync(this.stateFile, 'utf8')).lastNotifiedLedger) || 0;
    } catch {
      return 0;
    }
  }

  private writeCursor(): void {
    try {
      fs.writeFileSync(
        this.stateFile,
        JSON.stringify({ lastNotifiedLedger: this.lastNotifiedLedger, at: new Date().toISOString() }),
      );
    } catch (err: any) {
      this.logger.debug(`cursor write failed: ${err.message}`);
    }
  }
}

// ───────────────────────────── helpers ─────────────────────────────

function native(raw: any): any {
  if (raw === undefined || raw === null) return raw;
  const sc = typeof raw === 'string' ? StellarSdk.xdr.ScVal.fromXDR(raw, 'base64') : raw;
  return StellarSdk.scValToNative(sc);
}

function amount(stroops: any): string {
  const n = Number(BigInt(stroops ?? 0)) / STROOPS;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function acct(addr: string): string {
  return `<a href="${EXPERT}/account/${addr}">${addr.slice(0, 4)}…${addr.slice(-4)}</a>`;
}

function poolName(id: any): string {
  const n = Number(id);
  return POOL_NAMES[n] ?? `pool #${n}`;
}

function stringify(v: any): string {
  return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)) ?? String(v);
}

function hashKey(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
