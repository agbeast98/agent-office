// What a person on the team does again and again, every so many hours, while the office is running (nothing
// runs when it isn't): a round of looking for something new, a check of a page. Each one names the person, the
// hours between two rounds and what to tell them; a round that came due while they were busy or the office
// was closed is told once, when they are free.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Floor } from './floor.js';
import { tell } from './hooks/office-tasks.js';

const HOUR_MS = 3_600_000;

export interface Repeat {
  id: string;
  /** The worker it is told to. */
  to: string;
  everyHours: number;
  text: string;
  enabled: boolean;
  /** When it was last told (ms). */
  lastRun?: number;
}

export class TeamRepeats {
  items: Repeat[] = [];
  private file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'team-repeats.json');
    if (!existsSync(this.file)) return;
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as Repeat[];
      this.items = (Array.isArray(saved) ? saved : []).filter((r) => r && typeof r.id === 'string' && typeof r.to === 'string' && typeof r.text === 'string' && r.everyHours >= 1);
    } catch {
      // Started over with none.
    }
  }

  private save() {
    const tmp = `${this.file}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(this.items, null, 1), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch {
      // Kept in memory until the next save works.
    }
  }

  /** Adds one (no `id`) or changes one; `remove` takes it away. Returns an error for something that makes no sense. */
  set(change: { id?: unknown; to?: unknown; everyHours?: unknown; text?: unknown; enabled?: unknown; remove?: unknown }, now = Date.now()): string | undefined {
    let item = this.items.find((r) => r.id === change.id);
    if (change.id !== undefined && !item) return 'No such item';
    if (item && change.remove === true) {
      this.items = this.items.filter((r) => r !== item);
      this.save();
      return undefined;
    }
    const hours = change.everyHours === undefined ? item?.everyHours : Number(change.everyHours);
    const text = change.text === undefined ? item?.text : String(change.text).trim().slice(0, 2000);
    const to = change.to === undefined ? item?.to : String(change.to);
    if (!hours || !Number.isFinite(hours) || hours < 1 || hours > 720) return 'The hours between two rounds are 1 to 720';
    if (!text) return 'What to tell them is missing';
    if (!to) return 'Who it is for is missing';
    if (!item) {
      item = { id: `E-${1 + Math.max(0, ...this.items.map((r) => Number(r.id.slice(2)) || 0))}`, to, everyHours: hours, text, enabled: true };
      this.items.push(item);
    } else {
      // A changed pace counts from now, so it never fires at once.
      if (hours !== item.everyHours) item.lastRun = now;
      Object.assign(item, { to, everyHours: hours, text });
    }
    if (change.enabled !== undefined) item.enabled = change.enabled === true;
    this.save();
    return undefined;
  }

  /** What is due at `now` for the people who are `free`, marked as told so it isn't repeated. The first round of a new one is due at once. */
  due(now: number, free: (worker: string) => boolean): Repeat[] {
    const out = this.items.filter((r) => r.enabled && now - (r.lastRun ?? 0) >= r.everyHours * HOUR_MS && free(r.to));
    for (const r of out) r.lastRun = now;
    if (out.length) this.save();
    return out;
  }
}

/** Once a minute: tells whoever a round that has come due is for, unless they are in the middle of something. */
export function runRepeats(floor: Floor, now = Date.now()) {
  const due = floor.teamRepeats.due(now, (id) => {
    const w = floor.workers.get(id);
    return !!w && w.kind === 'agent' && w.status !== 'working' && !floor.interviews.blocking(id);
  });
  tell(floor, due.map((r) => ({ to: r.to, text: `زمان‌بندی (هر ${r.everyHours} ساعت): ${r.text}` })), 'زمان‌بندی');
}
