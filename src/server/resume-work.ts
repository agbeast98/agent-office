// After the office starts again, the agents come back at their prompt and wait for somebody to say something, so a task that was
// `doing` stood still until the person remembered to tell the manager, and one handed over just before the restart (`todo`) was
// lost with the message that carried it. This tells each running agent what it had open, once, shortly after the start; it never
// wakes an agent that is not running (that would spend tokens for nothing), and a `todo` older than a day is left alone.
import type { Floor } from './floor.js';

const START_DELAY_MS = 45_000;
const TODO_MAX_AGE_MS = 24 * 60 * 60_000;

interface Open {
  id: string;
  title: string;
  status: string;
  updatedAt?: number;
  assignee?: { id: string };
}

const list = (tasks: Open[]) => tasks.slice(0, 5).map((t) => `${t.id} «${t.title.slice(0, 80)}»`).join('، ');

/** The one line an agent is told about the work it was in the middle of or was just given, or undefined when it has none. */
export function openWorkNote(tasks: Open[], worker: string, now = Date.now()): string | undefined {
  const mine = tasks.filter((t) => t.assignee?.id === worker);
  const doing = mine.filter((t) => t.status === 'doing');
  const todo = mine.filter((t) => t.status === 'todo' && now - (t.updatedAt ?? now) < TODO_MAX_AGE_MS);
  if (!doing.length && !todo.length) return undefined;
  const parts = [
    doing.length ? `کارهای در حال انجام تو: ${list(doing)}. از همان‌جا که بودی ادامه بده (یادداشت‌های تسک را بخوان)، و اگر تمام شده‌اند وضعیت را به review ببر.` : '',
    todo.length ? `کارهایی که به تو سپرده شده و هنوز شروع نکرده‌ای: ${list(todo)}. همین حالا شروع کن (وضعیت را doing کن).` : '',
  ].filter(Boolean);
  return `دفتر دوباره راه افتاد. ${parts.join(' ')} اگر مانعی هست با ask_manager بگو.`;
}

export function nudgeOpenWork(floor: Floor) {
  const timer = setTimeout(() => {
    const tasks = floor.teamTasks.all();
    for (const w of floor.workers.list()) {
      if (w.kind !== 'agent') continue;
      const note = openWorkNote(tasks, w.id);
      // `prompt` answers with an error when the worker is not running: then it is left asleep.
      if (note) floor.workers.prompt(w.id, note, 'office');
    }
  }, START_DELAY_MS);
  timer.unref();
}

// ---- The watchdog: work that stands still is noticed without the person asking ----
// A task sat for hours: a `todo` nobody started, a `doing` the agent left mid-way, a `blocked` nobody unblocked. Every few
// minutes this looks once: an idle agent with a task that has not moved is told to carry on (once), then its manager is
// told (once), and a task blocked for long goes to the manager. Each says it once in a while, so it never becomes noise,
// and an agent that is working is left alone.

const WATCH_EVERY_MS = 10 * 60_000;
const STALL_MS = 40 * 60_000;
const BLOCKED_MS = 2 * 60 * 60_000;
const QUIET_MS = 3 * 60 * 60_000;
const MAX_PER_ROUND = 6;

export interface WatchTask extends Open {
  updatedAt: number;
}
export interface WatchState {
  /** task id → when its agent was last told, and whether its manager was told after that */
  told: Map<string, { agent?: number; manager?: number; at: number }>;
}

/** What to say, and to whom, about work that stood still: pure, so it can be tested. */
export function stalledWork(
  tasks: WatchTask[],
  idle: (worker: string) => boolean,
  managerOf: (worker: string) => string | undefined,
  state: WatchState,
  now = Date.now(),
): { to: string; text: string }[] {
  const out: { to: string; text: string }[] = [];
  for (const t of tasks) {
    if (out.length >= MAX_PER_ROUND) break;
    const who = t.assignee?.id;
    if (!who) continue;
    const seen = state.told.get(t.id);
    // The task moved since we last spoke: start over.
    if (seen && t.updatedAt > seen.at) state.told.delete(t.id);
    const told = state.told.get(t.id) ?? { at: t.updatedAt };
    const still = now - t.updatedAt;
    const manager = managerOf(who);
    if (t.status === 'blocked') {
      if (still < BLOCKED_MS || !manager || manager === who || (told.manager && now - told.manager < QUIET_MS)) continue;
      out.push({ to: manager, text: `پیگیری خودکار دفتر: تسک ${t.id} «${t.title.slice(0, 80)}» حدود ${Math.round(still / 3_600_000)} ساعت است blocked مانده. مانع را بخوان و حلش کن (کار را به کس دیگری بده، تصمیم بگیر، یا اگر فقط مدیرعامل می‌تواند، یک درخواست ask_ceo واحد بساز). منتظر نمان.` });
      state.told.set(t.id, { ...told, manager: now, at: told.at });
      continue;
    }
    if (t.status !== 'doing' && t.status !== 'todo') continue;
    if (still < STALL_MS || !idle(who)) continue;
    if (!told.agent || (now - told.agent >= QUIET_MS && !told.manager)) {
      if (told.agent && now - told.agent < QUIET_MS) continue;
      out.push({ to: who, text: `پیگیری خودکار دفتر: تسک ${t.id} «${t.title.slice(0, 80)}» حدود ${Math.round(still / 60_000)} دقیقه است جلو نرفته. ${t.status === 'todo' ? 'همین حالا شروع کن و وضعیت را doing کن.' : 'از همان‌جا ادامه بده.'} اگر تمام شده وضعیت را review کن؛ اگر مانع داری blocked کن و دلیل را با add_task_note بنویس. وسط کار نایست.` });
      state.told.set(t.id, { ...told, agent: now, at: told.at });
    } else if (!told.manager && now - told.agent >= STALL_MS && manager && manager !== who && idle(manager)) {
      out.push({ to: manager, text: `پیگیری خودکار دفتر: تسک ${t.id} «${t.title.slice(0, 80)}» با وجود یادآوری هنوز جلو نرفته. پیگیری کن: از مسئولش بپرس چه مانده، یا کار را جابه‌جا کن. اگر فقط مدیرعامل می‌تواند، یک درخواست ask_ceo واحد بساز.` });
      state.told.set(t.id, { ...told, manager: now, at: told.at });
    }
  }
  return out;
}

export function watchStalledWork(floor: Floor) {
  const state: WatchState = { told: new Map() };
  const timer = setInterval(() => {
    const workers = new Map(floor.workers.list().map((w) => [w.id, w]));
    const idle = (id: string) => {
      const w = workers.get(id);
      return !!w && w.kind === 'agent' && w.status !== 'working' && w.status !== 'starting';
    };
    const managerOf = (id: string) => floor.teams.teamOf(id)?.manager;
    const tasks = floor.teamTasks.all().filter((t): t is typeof t & { updatedAt: number } => typeof t.updatedAt === 'number');
    for (const n of stalledWork(tasks, idle, managerOf, state)) floor.workers.prompt(n.to, n.text, 'office');
  }, WATCH_EVERY_MS);
  timer.unref();
}
