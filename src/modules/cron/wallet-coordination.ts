import * as fs from 'fs';
import * as path from 'path';

/**
 * Cross-cron coordination for the manager (admin) wallet's classic AQUA balance.
 *
 * Two crons contend for the same wallet AQUA:
 *   - ice-locking.service.ts   transfers `pending_aqua_for_ice` out of the staking
 *                              contract into the wallet, then locks it into a 5-yr
 *                              Aquarius claimable balance (ICE).
 *   - bribe-reward.service.ts  drains the wallet AQUA (>= threshold) and swaps it to
 *                              BLUB for stakers.
 *
 * Without coordination the bribe cron would swap ICE-destined AQUA to stakers (and,
 * before the Step 0b fix, the ICE cron would lock bribe AQUA into a 5-yr CB). Two
 * primitives keep them apart:
 *
 *   1. A shared "wallet busy" lock. Whichever cron is actively moving wallet AQUA
 *      holds it; the other skips its run rather than touch the wallet concurrently.
 *   2. An ICE reservation marker. While the ICE cron has AQUA parked in the wallet
 *      mid-lock (or a lock attempt has halted for manual resolution), the marker
 *      records exactly how many stroops are ICE-reserved. The bribe cron subtracts
 *      that from the balance it is allowed to distribute, so it never sweeps
 *      ICE AQUA even if the two ever overlap or the ICE run left AQUA behind.
 *
 * NOTE: the state dir is a local filesystem path and is NOT shared across
 * DigitalOcean's 2 app instances — same accepted limitation as the bribe cursor
 * (see bribe-reward.service.ts). Within a single instance these are authoritative;
 * across instances the Stellar sequence-number collision is the backstop. Run the
 * backend as a single instance for 100% safety.
 */

const STATE_DIR =
  process.env.WHALEHUB_STATE_DIR ||
  process.env.BRIBE_STATE_DIR ||
  path.join(process.cwd(), '.whalehub-state');

const ICE_MARKER_FILE = path.join(STATE_DIR, 'ice-lock-pending.json');
const WALLET_LOCK_FILE = path.join(STATE_DIR, 'wallet-aqua.lock');

// A wallet operation should never legitimately run longer than this; a lock older
// than this is treated as a crashed holder and stolen.
const WALLET_LOCK_STALE_MS = 30 * 60 * 1000; // 30 minutes

function ensureDir(): void {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  } catch {
    /* best-effort; callers tolerate a missing dir */
  }
}

export interface IceMarker {
  amountStroops: string; // ICE-reserved AQUA, in stroops (1 AQUA = 1e7)
  at: string; // ISO timestamp the marker was written
}

/** Read the ICE reservation marker, or null if none is pending. */
export function readIceMarker(): IceMarker | null {
  try {
    if (fs.existsSync(ICE_MARKER_FILE)) {
      const m = JSON.parse(fs.readFileSync(ICE_MARKER_FILE, 'utf8'));
      if (m && m.amountStroops) return m as IceMarker;
    }
  } catch {
    /* treat unreadable marker as none */
  }
  return null;
}

/** Record that `amountStroops` of wallet AQUA is reserved for an in-flight ICE lock. */
export function writeIceMarker(amountStroops: bigint): void {
  ensureDir();
  const marker: IceMarker = {
    amountStroops: amountStroops.toString(),
    at: new Date().toISOString(),
  };
  fs.writeFileSync(ICE_MARKER_FILE, JSON.stringify(marker, null, 2));
}

/** Clear the ICE reservation marker once the lock has been created (or resolved). */
export function clearIceMarker(): void {
  try {
    if (fs.existsSync(ICE_MARKER_FILE)) fs.unlinkSync(ICE_MARKER_FILE);
  } catch {
    /* best-effort */
  }
}

/** Stroops of wallet AQUA currently reserved for ICE (0 if no marker). */
export function iceReservedStroops(): bigint {
  const m = readIceMarker();
  if (!m) return 0n;
  try {
    return BigInt(m.amountStroops);
  } catch {
    return 0n;
  }
}

/**
 * Try to take the shared wallet lock. Returns true if acquired. Steals a stale
 * lock whose holder appears to have crashed. `owner` is recorded for debugging.
 */
export function acquireWalletLock(owner: string): boolean {
  ensureDir();
  try {
    const fd = fs.openSync(WALLET_LOCK_FILE, 'wx');
    fs.writeSync(
      fd,
      JSON.stringify({ owner, pid: process.pid, at: new Date().toISOString() }),
    );
    fs.closeSync(fd);
    return true;
  } catch (e: any) {
    if (e.code !== 'EEXIST') return false;
    // Lock exists — steal it if stale.
    try {
      const stat = fs.statSync(WALLET_LOCK_FILE);
      if (Date.now() - stat.mtimeMs > WALLET_LOCK_STALE_MS) {
        fs.unlinkSync(WALLET_LOCK_FILE);
        return acquireWalletLock(owner);
      }
    } catch {
      /* race: someone removed it; report not-acquired and let caller retry next tick */
    }
    return false;
  }
}

/** Release the shared wallet lock. Safe to call even if not held. */
export function releaseWalletLock(): void {
  try {
    if (fs.existsSync(WALLET_LOCK_FILE)) fs.unlinkSync(WALLET_LOCK_FILE);
  } catch {
    /* best-effort */
  }
}

/** True if another cron currently holds the wallet lock (ignoring stale locks). */
export function isWalletLocked(): boolean {
  try {
    if (!fs.existsSync(WALLET_LOCK_FILE)) return false;
    const stat = fs.statSync(WALLET_LOCK_FILE);
    return Date.now() - stat.mtimeMs <= WALLET_LOCK_STALE_MS;
  } catch {
    return false;
  }
}
