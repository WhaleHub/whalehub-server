import { ConsoleLogger } from '@nestjs/common';
import { TelegramClient, escapeHtml } from './telegram';

/**
 * App-wide logger that also posts every error to Telegram.
 *
 * Installed in main.ts as the Nest logger, so every `this.logger.error(...)` in
 * every service lands here; `console.error` is wrapped too (some older code uses
 * it). Errors still go to stdout/stderr exactly as before.
 *
 * Noise control: errors are grouped by a signature (context + message with
 * numbers and hashes blanked). One signature is posted at most once per
 * DEDUP_WINDOW_MS; the next post says how many were held back. At most
 * MAX_POSTS_PER_HOUR posts go out in total, so a failing RPC can't flood the
 * channel.
 *
 * Env (read when the first error is posted, after ConfigModule has loaded .env):
 * TELEGRAM_BOT_TOKEN, TELEGRAM_ERROR_CHAT_ID (falls back to TELEGRAM_CHAT_ID),
 * TELEGRAM_ERRORS_ENABLED (default on; "false" turns it off).
 */

const DEDUP_WINDOW_MS = 60 * 60_000;
const MAX_POSTS_PER_HOUR = 30;
const MAX_BODY_CHARS = 1_500;

type Sender = (html: string) => void;

export class TelegramErrorLogger extends ConsoleLogger {
  private sender: Sender | null | undefined; // undefined = not resolved yet
  private readonly seen = new Map<string, { at: number; held: number }>();
  private hourStart = 0;
  private postsThisHour = 0;

  constructor(sender?: Sender) {
    super();
    if (sender) this.sender = sender;
  }

  error(message: any, ...optionalParams: any[]) {
    super.error(message, ...optionalParams);
    const { stack, context } = splitParams(optionalParams);
    this.report(context ?? this.context ?? 'app', message, stack);
  }

  /** Route `console.error` through `report` as well. Call once at boot. */
  captureConsoleErrors() {
    const original = console.error.bind(console);
    console.error = (...args: any[]) => {
      original(...args);
      this.report('console', args.map(stringify).join(' '));
    };
  }

  report(context: string, message: any, stack?: string) {
    try {
      const send = this.resolveSender();
      if (!send) return;
      const text = stringify(message);
      const now = Date.now();
      const key = `${context}|${signature(text)}`;
      const prev = this.seen.get(key);
      if (prev && now - prev.at < DEDUP_WINDOW_MS) {
        prev.held++;
        return;
      }
      if (now - this.hourStart >= 60 * 60_000) {
        this.hourStart = now;
        this.postsThisHour = 0;
      }
      if (this.postsThisHour >= MAX_POSTS_PER_HOUR) return;
      this.postsThisHour++;
      const held = prev?.held ?? 0;
      this.seen.set(key, { at: now, held: 0 });

      let body = scrub(text);
      if (stack && typeof stack === 'string' && !stack.includes(text)) {
        body += `\n${scrub(stack.split('\n').slice(0, 4).join('\n'))}`;
      }
      if (body.length > MAX_BODY_CHARS) body = body.slice(0, MAX_BODY_CHARS) + '…';
      const lines = [
        `<b>Backend error</b> · ${escapeHtml(context)}`,
        `<pre>${escapeHtml(body)}</pre>`,
      ];
      if (held > 0) lines.push(`(+${held} more like this in the last hour)`);
      send(lines.join('\n'));
    } catch {
      // Reporting must never throw into the code that logged the error.
    }
  }

  private resolveSender(): Sender | null {
    if (this.sender !== undefined) return this.sender;
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId =
      process.env.TELEGRAM_ERROR_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
    if (process.env.TELEGRAM_ERRORS_ENABLED === 'false' || !token || !chatId) {
      // Env may not be loaded yet during boot; look again on the next error.
      return null;
    }
    // Send failures are logged as warnings, never errors, so they can't loop back here.
    const client = new TelegramClient(token, chatId, (m) =>
      super.warn(m, 'TelegramErrorLogger'),
    );
    this.sender = (html) => void client.send(html);
    return this.sender;
  }
}

/** Nest passes (stack, context), (context) or (stack). */
function splitParams(params: any[]): { stack?: string; context?: string } {
  if (params.length === 0) return {};
  if (params.length === 1) {
    const p = params[0];
    return typeof p === 'string' && p.includes('\n') ? { stack: p } : { context: p };
  }
  return { stack: params[0], context: params[params.length - 1] };
}

function stringify(v: any): string {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.stack || v.message;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Blank out what varies between repeats of the same error. */
export function signature(text: string): string {
  return text
    .split('\n')[0]
    .replace(/\b[0-9a-f]{16,}\b/gi, '#')
    .replace(/\b[GC][A-Z2-7]{55}\b/g, 'ADDR')
    .replace(/\d+/g, 'N')
    .slice(0, 200);
}

/** Strip bot tokens and Stellar secret keys before anything leaves the server. */
export function scrub(text: string): string {
  return text
    .replace(/bot\d+:[A-Za-z0-9_-]{20,}/g, 'bot<redacted>')
    .replace(/\bS[A-Z2-7]{55}\b/g, '<secret>');
}
