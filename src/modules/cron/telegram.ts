import axios from 'axios';

/**
 * Minimal Telegram Bot API sender for the "Whalehub Status" channel.
 *
 * Telegram allows ~20 messages/minute into one channel, so every send goes
 * through a single serial queue spaced SEND_SPACING_MS apart, and a 429 is
 * retried after the `retry_after` the API hands back. A send that still fails
 * is logged and dropped — notifications must never block or crash a cron.
 */

const SEND_SPACING_MS = 3_100; // ≈ 19 msgs/min, just under the channel limit
const MAX_MESSAGE_CHARS = 4_000; // hard API cap is 4096
const MAX_ATTEMPTS = 3;

export class TelegramClient {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly token: string | undefined,
    private readonly chatId: string | undefined,
    private readonly log: (msg: string) => void,
  ) {}

  get enabled(): boolean {
    return !!this.token && !!this.chatId;
  }

  /** Queue an HTML message. Long text is split on line boundaries. */
  send(html: string): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    for (const chunk of splitMessage(html)) {
      this.queue = this.queue
        .then(() => this.post(chunk))
        .then(() => sleep(SEND_SPACING_MS));
    }
    return this.queue;
  }

  private async post(text: string): Promise<void> {
    const url = `https://api.telegram.org/bot${this.token}/sendMessage`;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        await axios.post(
          url,
          {
            chat_id: this.chatId,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          },
          { timeout: 15_000 },
        );
        return;
      } catch (err: any) {
        const status = err?.response?.status;
        const retryAfter = Number(err?.response?.data?.parameters?.retry_after);
        // Never log `url` — it carries the bot token.
        const desc = err?.response?.data?.description ?? err?.message;
        if (status === 429 && attempt < MAX_ATTEMPTS) {
          await sleep(((Number.isFinite(retryAfter) ? retryAfter : 5) + 1) * 1000);
          continue;
        }
        this.log(`Telegram send failed (${status ?? 'network'}): ${desc}`);
        return;
      }
    }
  }
}

function splitMessage(html: string): string[] {
  if (html.length <= MAX_MESSAGE_CHARS) return [html];
  const chunks: string[] = [];
  let current = '';
  for (const line of html.split('\n')) {
    if (current.length + line.length + 1 > MAX_MESSAGE_CHARS && current) {
      chunks.push(current);
      current = '';
    }
    current += (current ? '\n' : '') + line.slice(0, MAX_MESSAGE_CHARS);
  }
  if (current) chunks.push(current);
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
