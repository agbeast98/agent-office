// Tells the person on their phone when something waits for them (an approval, a task to review), so they
// needn't keep the office open and watch it. Telegram only for now: a bot token and the chat to write to
// are put by the person in `notify.json` in the floor's data folder, never typed by an agent:
//   { "telegramToken": "123:abc…", "chatId": "123456789" }
// With no file it does nothing, and a message that can't be sent is never a reason to stop the team.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean }>;

const SAME_TEXT_MS = 5 * 60_000;
const MAX_TEXT = 1000;

export class Notifier {
  private file: string;
  private sent = new Map<string, number>();

  constructor(dataDir: string, private fetcher: Fetch = (url, init) => fetch(url, init)) {
    this.file = path.join(dataDir, 'notify.json');
  }

  /** Re-read each time, so the person can fill the file in while the office runs. */
  private config(): { token: string; chat: string } | undefined {
    if (!existsSync(this.file)) return undefined;
    try {
      const c = JSON.parse(readFileSync(this.file, 'utf8')) as { telegramToken?: unknown; chatId?: unknown };
      const token = typeof c.telegramToken === 'string' ? c.telegramToken.trim() : '';
      const chat = typeof c.chatId === 'string' || typeof c.chatId === 'number' ? String(c.chatId).trim() : '';
      return token && chat ? { token, chat } : undefined;
    } catch {
      return undefined;
    }
  }

  get configured() {
    return !!this.config();
  }

  /** Sends `text` unless the same one went in the last few minutes. Resolves to whether it was sent. */
  async send(text: string): Promise<boolean> {
    const c = this.config();
    const clean = text.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
    if (!c || !clean) return false;
    const now = Date.now();
    if ((this.sent.get(clean) ?? 0) > now - SAME_TEXT_MS) return false;
    this.sent.set(clean, now);
    for (const [k, at] of this.sent) if (at < now - SAME_TEXT_MS) this.sent.delete(k);
    try {
      const res = await this.fetcher(`https://api.telegram.org/bot${c.token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: c.chat, text: clean }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
