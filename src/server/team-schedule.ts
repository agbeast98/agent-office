// What the team does on a timetable, while the office is running (nothing runs when it isn't): the
// interviewer's weekly interview, the manager's review of the day before, and the start of the working day.
// Each item has days of the week and a time; one that is due is told to the person it concerns once, and a
// day that started before the office did still gets it when the office opens (it catches up, once).
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { WorkerInfo } from '../shared/protocol.js';
import type { Floor } from './floor.js';
import { tell } from './hooks/office-tasks.js';
import type { Notice } from './team-tasks.js';

export const SCHEDULE_TICK_MS = 60_000;

export type ScheduleKind = 'interview' | 'review' | 'workday';

export interface ScheduleItem {
  id: ScheduleKind;
  title: string;
  enabled: boolean;
  /** 0 is Sunday, as in `Date.getDay()`; Saturday is 6. */
  days: number[];
  /** 'HH:MM' on the office computer's clock. */
  time: string;
  /** When it last ran (ms); not shown to the team. */
  lastRun?: number;
}

const DEFAULTS: ScheduleItem[] = [
  { id: 'interview', title: 'مصاحبه‌ی هفتگی با شما', enabled: false, days: [6], time: '09:00' },
  { id: 'review', title: 'بازبینی روز قبل (مدیر)', enabled: false, days: [0, 1, 2, 3, 4, 6], time: '09:00' },
  { id: 'workday', title: 'شروع روز کاری (مدیر)', enabled: false, days: [0, 1, 2, 3, 4, 6], time: '09:30' },
];

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Today's moment (ms) at `time`. */
export function momentOf(now: Date, time: string): number {
  const [h, m] = time.split(':').map(Number);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0, 0).getTime();
}

export class TeamSchedule {
  items: ScheduleItem[];
  private file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'team-schedule.json');
    this.items = DEFAULTS.map((d) => ({ ...d, days: [...d.days] }));
    if (!existsSync(this.file)) return;
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as ScheduleItem[];
      for (const s of Array.isArray(saved) ? saved : []) {
        const item = this.items.find((i) => i.id === s.id);
        if (!item) continue;
        item.enabled = s.enabled === true;
        if (typeof s.time === 'string' && TIME.test(s.time)) item.time = s.time;
        if (Array.isArray(s.days)) item.days = s.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
        if (typeof s.lastRun === 'number') item.lastRun = s.lastRun;
      }
    } catch {
      // Started over from the defaults (everything off).
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

  /** Changes one item; returns an error for something that makes no sense. */
  set(id: unknown, change: { enabled?: unknown; time?: unknown; days?: unknown }): string | undefined {
    const item = this.items.find((i) => i.id === id);
    if (!item) return 'No such item';
    if (change.time !== undefined) {
      if (typeof change.time !== 'string' || !TIME.test(change.time)) return 'The time is HH:MM';
      item.time = change.time;
    }
    if (change.days !== undefined) {
      if (!Array.isArray(change.days) || !change.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) return 'Days are 0 to 6';
      item.days = [...new Set(change.days as number[])].sort();
    }
    if (change.enabled !== undefined) item.enabled = change.enabled === true;
    // Turning it on (or moving it) mid-day must not fire what the time has already passed.
    item.lastRun = Date.now();
    this.save();
    return undefined;
  }

  /** What is due at `now`, marked as run so it isn't repeated. */
  due(now: Date): ScheduleItem[] {
    const out = this.items.filter((i) => i.enabled && i.days.includes(now.getDay()) && now.getTime() >= momentOf(now, i.time) && (i.lastRun ?? 0) < momentOf(now, i.time));
    for (const i of out) i.lastRun = now.getTime();
    if (out.length) this.save();
    return out;
  }
}

/** Who each kind of item concerns and what it asks of them. */
export function noticesFor(item: ScheduleItem, workers: WorkerInfo[], manager?: WorkerInfo): Notice[] {
  const agents = workers.filter((w) => w.kind === 'agent');
  if (item.id === 'interview') {
    const who = agents.find((w) => /مصاحبه/.test(w.role ?? ''));
    return who ? [{ to: who.id, text: 'زمان‌بندی: وقت مصاحبه‌ی هفتگی است. طبق نقشت، بخش «آخرین مصاحبه» در profile.md را ببین و اگر لازم بود از Mohammad سؤال‌ها را یکی‌یکی بپرس.' }] : [];
  }
  if (!manager) return [];
  if (item.id === 'review') return [{ to: manager.id, text: 'زمان‌بندی: روز کاری قبل را در days/ تحلیل کن (ارسال‌ها، پاسخ‌ها، علت بی‌پاسخی‌ها) و نتیجه را در LEARNINGS.md و daily.md بنویس. اگر چیزی نیاز به تأیید Mohammad دارد، فقط خلاصه‌اش را بگو.' }];
  return [{ to: manager.id, text: 'زمان‌بندی: روز کاری شروع شد. rules.md و profile.md را بخوان (خالی بودند: فقط به Mohammad خبر بده). بعد کارهای امروز را با create_task بین شکارچی، بررسی‌کننده و نویسنده پخش کن و یک گزارش کوتاه بده.' }];
}

/** Once a minute: tells whoever an item that has come due concerns. */
export function runSchedule(floor: Floor, now = new Date()) {
  const due = floor.teamSchedule.due(now);
  if (!due.length) return;
  const workers = floor.workers.list();
  const manager = floor.teamTasks.manager(workers.filter((w) => w.kind === 'agent'));
  for (const item of due) {
    const notices = noticesFor(item, workers, manager);
    tell(floor, notices, 'زمان‌بندی');
    void floor.notifier.send(`⏰ ${item.title}`);
  }
}
