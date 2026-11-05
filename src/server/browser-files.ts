// What the worker browsers keep on disk beside their profiles (see worker-browser.ts): the log of what each did, the
// page each was last on, which were open, and the logins copied to them.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface Last {
  url: string;
  at: number;
}
export interface Activity {
  at: string;
  actor: 'agent' | 'person';
  action: string;
  detail?: string;
  url?: string;
}

export class BrowserFiles {
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }

  /** One folder per worker (a hash of its id): Chrome's own profile. */
  profile(workerId: string) {
    return path.join(this.root, createHash('sha256').update(workerId).digest('hex').slice(0, 32));
  }
  has(workerId: string) {
    return existsSync(this.profile(workerId));
  }
  cookieFile(workerId: string) {
    return `${this.profile(workerId)}.cookies.json`;
  }
  loginFile(workerId: string) {
    return `${this.profile(workerId)}.logins.json`;
  }
  private logFile(workerId: string) {
    return `${this.profile(workerId)}.log.jsonl`;
  }
  private lastFile(workerId: string) {
    return `${this.profile(workerId)}.last.json`;
  }

  /** One line of what happened in a browser, for whoever wants to check on it later. Typed text is never written down. */
  note(workerId: string, actor: 'agent' | 'person', action: string, detail = '', url = '') {
    try {
      appendFileSync(this.logFile(workerId), `${JSON.stringify({ at: new Date().toISOString(), actor, action, detail: detail.slice(0, 200), url: url.slice(0, 300) })}\n`, { mode: 0o600 });
    } catch {
      // A log that can't be written is not a reason to stop the page.
    }
  }

  /** The last lines of a browser's log. */
  lines(workerId: string, count = 100): string[] {
    try {
      return readFileSync(this.logFile(workerId), 'utf8').trim().split('\n').slice(-count);
    } catch {
      return [];
    }
  }

  activity(workerId: string, count = 100): Activity[] {
    return this.lines(workerId, count).flatMap((line) => {
      try {
        return [JSON.parse(line) as Activity];
      } catch {
        return [];
      }
    });
  }

  /** The page a browser was last on (a web page, not about:blank), kept so it can be shown again after it was closed. */
  last(workerId: string): Last | undefined {
    try {
      const v = JSON.parse(readFileSync(this.lastFile(workerId), 'utf8')) as Last;
      return typeof v.url === 'string' && /^https?:/i.test(v.url) ? v : undefined;
    } catch {
      return undefined;
    }
  }
  remember(workerId: string, url: string) {
    if (!/^https?:/i.test(url)) return;
    try {
      writeFileSync(this.lastFile(workerId), JSON.stringify({ url, at: Date.now() }), { mode: 0o600 });
    } catch {
      // The page is still there; only the memory of it is behind.
    }
  }

  /** The workers whose browser was open when the office last ran: they are opened again, on the page they were on. */
  wasOpen(): string[] {
    try {
      const v = JSON.parse(readFileSync(path.join(this.root, 'open.json'), 'utf8'));
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }
  markOpen(workerId: string, open: boolean) {
    const now = new Set(this.wasOpen());
    if (open) now.add(workerId);
    else now.delete(workerId);
    try {
      writeFileSync(path.join(this.root, 'open.json'), JSON.stringify([...now]), { mode: 0o600 });
    } catch {
      // The next change writes it again.
    }
  }
}
