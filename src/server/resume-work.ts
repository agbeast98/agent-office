// After the office starts again, the agents come back at their prompt and wait for somebody to say something, so a task that was
// `doing` stood still until the person remembered to tell the manager. This tells each agent that is running and has open work what
// it had, once, shortly after the start; it never wakes an agent that is not running (that would spend tokens for nothing).
import type { Floor } from './floor.js';

const START_DELAY_MS = 45_000;

/** The one line an agent is told about the work it was in the middle of, or undefined when it has none. */
export function openWorkNote(tasks: { id: string; title: string; status: string; assignee?: { id: string } }[], worker: string): string | undefined {
  const mine = tasks.filter((t) => t.assignee?.id === worker && t.status === 'doing');
  if (!mine.length) return undefined;
  const list = mine.slice(0, 5).map((t) => `${t.id} «${t.title.slice(0, 80)}»`).join('، ');
  return `دفتر دوباره راه افتاد. کارهای در حال انجام تو: ${list}. از همان‌جا که بودی ادامه بده (یادداشت‌های تسک را بخوان)، و اگر مانعی هست با ask_manager بگو. اگر تمام شده‌اند وضعیت را به review ببر.`;
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
