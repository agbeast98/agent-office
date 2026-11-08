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
