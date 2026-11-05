// Small pieces of the workers manager that need nothing of it but the workers themselves: what a provider adapter
// is handed of a worker, seating a worker at the meeting table and back, and searching their terminals.
import { MEETING_SEATS } from '../../shared/layout.js';
import type { TerminalHit } from '../../shared/protocol.js';
import { searchTerminal } from '../history.js';
import type { Worker, WorkerHandle } from './types.js';

/** What the manager gives a handle besides the worker's own fields: the things only it can do for the worker. */
export type HandleCalls = Pick<WorkerHandle, 'setStatus' | 'emit' | 'persist' | 'notePrompt' | 'noteTool' | 'notePr' | 'clearTask' | 'scheduleScan' | 'prompt'>;

/** What a worker's provider adapter is handed of it (see WorkerHandle). */
export function workerHandle(w: Worker, calls: HandleCalls): WorkerHandle {
  return {
    get info() {
      return w.info;
    },
    get state() {
      return w.state;
    },
    get running() {
      return !!w.pty;
    },
    get bootBlocked() {
      return !!w.bootBlocked;
    },
    set bootBlocked(v) {
      w.bootBlocked = v;
    },
    get leftNeedsInputAt() {
      return w.leftNeedsInputAt;
    },
    set leftNeedsInputAt(v) {
      w.leftNeedsInputAt = v;
    },
    get failStreak() {
      return w.failStreak;
    },
    set failStreak(v) {
      w.failStreak = v;
    },
    get tracker() {
      return w.tracker;
    },
    get pendingPrompt() {
      return w.pendingPrompt;
    },
    set pendingPrompt(v) {
      w.pendingPrompt = v;
    },
    ...calls,
  };
}

/** An existing employee goes to a free chair at the meeting table: the worker, or why not. */
export function seatVisitor(workers: Map<string, Worker>, id: string): Worker | string {
  const w = workers.get(id);
  if (!w || w.info.kind !== 'agent') return 'این ایجنت در دسترس نیست.';
  if (w.info.meeting) return 'این صندلی برای جلسهٔ کاری دیگری رزرو شده است.';
  if (w.info.meetingOriginDesk) return `${w.info.name} از قبل در اتاق جلسه است.`;
  const chair = MEETING_SEATS.find((seat) => ![...workers.values()].some((x) => x.info.deskId === seat.id));
  if (!chair) return 'صندلی خالی در اتاق جلسه وجود ندارد.';
  w.info.meetingOriginDesk = w.info.deskId;
  w.info.deskId = chair.id;
  return w;
}

/** An invited employee goes back to the desk kept for them: the worker, or why not. */
export function unseatVisitor(workers: Map<string, Worker>, id: string): Worker | string {
  const w = workers.get(id);
  const origin = w?.info.meetingOriginDesk;
  if (!w || !origin) return 'این ایجنت مهمان جلسه نیست.';
  if ([...workers.values()].some((x) => x.info.id !== id && x.info.deskId === origin)) return 'میز اصلی این ایجنت فعلاً اشغال است.';
  w.info.deskId = origin;
  delete w.info.meetingOriginDesk;
  return w;
}

/** Every running terminal searched for a word, with the most hits each may give. */
export function searchWorkers(workers: Map<string, Worker>, needle: string, perWorker: number): { hits: TerminalHit[]; more: boolean } {
  const hits: TerminalHit[] = [];
  let more = false;
  for (const w of workers.values()) {
    if (!w.term) continue;
    const found = searchTerminal(w.term, needle, perWorker);
    more ||= found.more;
    for (const hit of found.hits) hits.push({ workerId: w.info.id, ...hit });
  }
  return { hits, more };
}
