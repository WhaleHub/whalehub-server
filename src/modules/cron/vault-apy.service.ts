import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as StellarSdk from '@stellar/stellar-sdk';

/**
 * Vault reward income for the APY card, read from Horizon.
 *
 * Stream B (bribe-reward.service) grows a vault bucket with
 * `admin_compound_deposit(manager, pool_id, amount_a, amount_b, min_lp_out)`:
 * the LP it mints is added to the bucket's `total_lp_tokens` without minting
 * shares, so it is pure yield for that bucket's depositors. The contract emits
 * no event for it, so this sums the call arguments of the manager's successful
 * transactions over the window. Stateless: a restart loses nothing.
 *
 * Amounts are raw token units in the bucket's token_a/token_b order; the
 * frontend values them with the prices it already shows.
 */
export interface VaultIncomeWindow {
  windowDays: number;
  from: string;
  to: string;
  pools: Record<string, { amountA: string; amountB: string; runs: number }>;
  complete: boolean;
}

const CACHE_MS = 10 * 60_000;
const MAX_PAGES = 20;

@Injectable()
export class VaultApyService {
  private readonly logger = new Logger(VaultApyService.name);
  private readonly horizonUrl: string;
  private readonly manager: string;
  private readonly stakingContract: string;
  private cache: { at: number; days: number; value: VaultIncomeWindow } | null = null;
  private inflight: Promise<VaultIncomeWindow> | null = null;

  constructor(private readonly configService: ConfigService) {
    this.horizonUrl = (
      this.configService.get<string>('HORIZON_URL') ?? 'https://horizon.stellar.org'
    ).replace(/\/$/, '');
    this.manager =
      this.configService.get<string>('MANAGER_PUBLIC_KEY') ??
      'GDERSSCKJQPPXUQOZIOXGRVAGNLVPVZCJ2MAX7RCMVMWGRPVAEG7XGTK';
    this.stakingContract =
      this.configService.get<string>('STAKING_CONTRACT_ID') ??
      'CC72BEVVKHQ57PB5FCKAZYRXCSR6DOQSTN46QR7RZMMM64YWNRPDS24S';
  }

  async getIncomeWindow(windowDays = 7): Promise<VaultIncomeWindow> {
    if (this.cache && this.cache.days === windowDays && Date.now() - this.cache.at < CACHE_MS) {
      return this.cache.value;
    }
    if (!this.inflight) {
      this.inflight = this.scan(windowDays)
        .then((value) => {
          this.cache = { at: Date.now(), days: windowDays, value };
          return value;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    try {
      return await this.inflight;
    } catch (err) {
      this.logger.warn(`vault income scan failed: ${err.message}`);
      if (this.cache) return this.cache.value;
      throw err;
    }
  }

  private async scan(windowDays: number): Promise<VaultIncomeWindow> {
    const to = new Date();
    const from = new Date(to.getTime() - windowDays * 86_400_000);
    const sums: Record<string, { a: bigint; b: bigint; runs: number }> = {};
    let url = `${this.horizonUrl}/accounts/${this.manager}/transactions?order=desc&limit=200`;
    let complete = false;

    for (let page = 0; page < MAX_PAGES && url; page++) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Horizon HTTP ${res.status}`);
      const body: any = await res.json();
      const records: any[] = body?._embedded?.records ?? [];
      if (records.length === 0) {
        complete = true;
        break;
      }
      for (const r of records) {
        if (new Date(r.created_at) < from) {
          complete = true;
          break;
        }
        if (!r.successful) continue;
        this.collect(r.envelope_xdr, sums);
      }
      if (complete) break;
      url = body?._links?.next?.href;
    }

    const pools: VaultIncomeWindow['pools'] = {};
    for (const [id, s] of Object.entries(sums)) {
      pools[id] = { amountA: s.a.toString(), amountB: s.b.toString(), runs: s.runs };
    }
    return { windowDays, from: from.toISOString(), to: to.toISOString(), pools, complete };
  }

  private collect(envelopeXdr: string, sums: Record<string, { a: bigint; b: bigint; runs: number }>) {
    let ops: any[];
    try {
      const env = StellarSdk.xdr.TransactionEnvelope.fromXDR(envelopeXdr, 'base64');
      if (env.switch().name !== 'envelopeTypeTx') return;
      ops = env.v1().tx().operations();
    } catch {
      return;
    }
    for (const op of ops) {
      try {
        if (op.body().switch().name !== 'invokeHostFunction') continue;
        const hf = op.body().invokeHostFunctionOp().hostFunction();
        if (hf.switch().name !== 'hostFunctionTypeInvokeContract') continue;
        const ic = hf.invokeContract();
        if (ic.functionName().toString() !== 'admin_compound_deposit') continue;
        const contract = StellarSdk.Address.fromScAddress(ic.contractAddress()).toString();
        if (contract !== this.stakingContract) continue;
        const args = ic.args().map((a: any) => StellarSdk.scValToNative(a));
        const id = String(args[1]);
        const s = (sums[id] ??= { a: 0n, b: 0n, runs: 0 });
        s.a += BigInt(args[2]);
        s.b += BigInt(args[3]);
        s.runs += 1;
      } catch {
        // not a call we can read; skip it
      }
    }
  }
}
