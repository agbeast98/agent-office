// The team's tasks, kept by the office: who is to do what, how far along it is, and what was said about it.
// The manager (a worker the office knows by id or by its role) hands tasks out; everyone else asks the
// manager for work and reports through it. The tools workers use are in bin/office-workers.js, the
// route they call is hooks/office-tasks.ts, and this is the store and the rules both lean on.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { WorkerInfo } from '../shared/protocol.js';
import { findWorker } from './office-workers.js';

export const TASK_STATUSES = ['todo', 'doing', 'review', 'done', 'blocked', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_PRIORITIES = ['low', 'normal', 'high'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export interface TaskNote {
  at: number;
  by: string;
  text: string;
}

export interface TeamTask {
  id: string;
  title: string;
  detail: string;
  status: TaskStatus;
  priority: TaskPriority;
  /** Whose it is: a worker's id and the name it had. */
  assignee?: { id: string; name: string };
  createdBy: string;
  /** Asked of the manager by someone who isn't it, rather than handed out. */
  request: boolean;
  createdAt: number;
  updatedAt: number;
  /** A day, YYYY-MM-DD, when it has to be done. */
  due?: string;
  notes: TaskNote[];
  /** The scenario run it is a step of (see team-flows.ts): that, not the manager worker, takes it from review. */
  flow?: string;
}

/** Who is acting: a worker, or the person at the manager's computer. */
export interface Actor {
  id?: string;
  name: string;
  /** The manager, or a person: allowed to hand out and change anything. */
  boss: boolean;
}

/** Something to tell a worker about a change, in words. */
export interface Notice {
  to: string;
  text: string;
}

export type Outcome = { ok: true; task?: TeamTask; tasks?: TeamTask[]; notices: Notice[] } | { ok: false; error: string };

export interface TaskInput {
  title?: unknown;
  detail?: unknown;
  assignee?: unknown;
  priority?: unknown;
  due?: unknown;
  status?: unknown;
  flow?: unknown;
}

export const MAX_TASKS = 500;
const MAX_NOTES = 100;
const TITLE_MAX = 120;
const DETAIL_MAX = 4000;
const NOTE_MAX = 2000;
const MANAGER_ROLE = /مدیر|manager/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').trim().slice(0, max) : '');
const oneOf = <T extends string>(list: readonly T[], v: unknown): T | undefined => (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : undefined);
const fail = (error: string): Outcome => ({ ok: false, error });

export class TeamTasks {
  /** Says why a worker can't be given work (a new hire still in its interview), or nothing. */
  blocked?: (workerId: string) => string | undefined;
  private tasks: TeamTask[] = [];
  private managerId?: string;
  private next = 1;
  private file: string;

  constructor(dataDir: string, public onChange: (tasks: TeamTask[]) => void = () => {}) {
    this.file = path.join(dataDir, 'team-tasks.json');
    this.load();
  }

  private load() {
    if (!existsSync(this.file)) return;
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as { tasks?: unknown; manager?: unknown; next?: unknown };
      if (Array.isArray(saved.tasks)) {
        this.tasks = saved.tasks.filter((t): t is TeamTask => !!t && typeof t === 'object' && typeof (t as TeamTask).id === 'string' && typeof (t as TeamTask).title === 'string').slice(-MAX_TASKS);
      }
      if (typeof saved.manager === 'string') this.managerId = saved.manager;
      this.next = Math.max(Number(saved.next) || 1, ...this.tasks.map((t) => Number(t.id.replace(/\D/g, '')) + 1));
    } catch {
      // A file that can't be read is started over rather than blocking the team.
    }
  }

  private save() {
    const tmp = `${this.file}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ manager: this.managerId, next: this.next, tasks: this.tasks }, null, 1), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch {
      // Still held in memory until the next save works.
    }
    this.onChange(this.tasks);
  }

  all(): TeamTask[] {
    return this.tasks;
  }

  get(id: string): TeamTask | undefined {
    const k = id.trim().toUpperCase();
    return this.tasks.find((t) => t.id.toUpperCase() === k);
  }

  /** The manager: the one chosen, or else the first worker whose role says it manages. */
  manager(workers: WorkerInfo[]): WorkerInfo | undefined {
    return workers.find((w) => w.id === this.managerId && w.kind === 'agent') ?? workers.find((w) => w.kind === 'agent' && !!w.role && MANAGER_ROLE.test(w.role));
  }

  setManager(id: string | undefined) {
    this.managerId = id;
    this.save();
  }

  /** Whether `worker` is the manager, so it may hand out and change anything. */
  actorOf(worker: WorkerInfo, workers: WorkerInfo[]): Actor {
    return { id: worker.id, name: worker.name, boss: this.manager(workers)?.id === worker.id };
  }

  list(filter: { assignee?: string; status?: string; mine?: string; open?: boolean } = {}): TeamTask[] {
    return this.tasks.filter((t) => {
      if (filter.mine && t.assignee?.id !== filter.mine) return false;
      if (filter.assignee && t.assignee?.id !== filter.assignee) return false;
      if (filter.status && t.status !== filter.status) return false;
      if (filter.open && (t.status === 'done' || t.status === 'cancelled')) return false;
      return true;
    });
  }

  /** The manager hands out a task; anyone else's becomes a request to the manager. */
  create(by: Actor, input: TaskInput, workers: WorkerInfo[]): Outcome {
    const title = text(input.title, TITLE_MAX);
    if (!title) return fail('Give the task a title');
    const boss = this.manager(workers);
    const notices: Notice[] = [];
    const task: TeamTask = {
      id: `T-${this.next}`,
      title,
      detail: text(input.detail, DETAIL_MAX),
      status: 'todo',
      priority: oneOf(TASK_PRIORITIES, input.priority) ?? 'normal',
      createdBy: by.name,
      request: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      notes: [],
    };
    if (typeof input.due === 'string' && DAY.test(input.due)) task.due = input.due;
    if (by.boss && typeof input.flow === 'string' && input.flow) task.flow = input.flow;
    if (by.boss) {
      const who = typeof input.assignee === 'string' && input.assignee.trim() ? findWorker(workers.filter((w) => w.kind === 'agent'), input.assignee) : undefined;
      if (typeof who === 'string') return fail(who);
      const why = who && this.blocked?.(who.id);
      if (why) return fail(why);
      if (who) {
        task.assignee = { id: who.id, name: who.name };
        if (who.id !== by.id) notices.push({ to: who.id, text: `کار تازه برای تو: ${task.id} «${task.title}»${task.detail ? `\n${task.detail}` : ''}\nوقتی شروع کردی وضعیتش را «doing» کن و وقتی تمام شد «review» (با update_task). کار را فقط از طریق مدیر هماهنگ کن.` });
      }
    } else {
      if (!boss) return fail('There is no manager to ask yet');
      task.request = true;
      task.assignee = { id: boss.id, name: boss.name };
      notices.push({ to: boss.id, text: `درخواست تازه از ${by.name}: ${task.id} «${task.title}»${task.detail ? `\n${task.detail}` : ''}\nبررسی کن و با update_task تصمیم بگیر: به کسی بده (assignee)، خودت انجامش بده، یا لغو کن.` });
    }
    this.next++;
    this.tasks.push(task);
    this.prune();
    this.save();
    return { ok: true, task, notices };
  }

  /**
   * Changes a task. The manager changes anything, and hands it to someone else; the worker it is
   * with moves it along and, saying it is done, sends it to review for the manager to close.
   */
  update(by: Actor, id: string, input: TaskInput, workers: WorkerInfo[]): Outcome {
    const task = this.get(id);
    if (!task) return fail(`No task ${id} (list_tasks says which there are)`);
    const mine = !!by.id && task.assignee?.id === by.id;
    if (!by.boss && !mine) return fail(`${task.id} isn't yours: ask the manager`);
    const notices: Notice[] = [];
    const boss = this.manager(workers);
    const before = task.status;

    if (input.title !== undefined || input.detail !== undefined || input.priority !== undefined || input.due !== undefined || input.assignee !== undefined) {
      if (!by.boss) return fail('Only the manager changes a title, detail, priority, due date or who it is with');
      const title = input.title === undefined ? task.title : text(input.title, TITLE_MAX);
      if (!title) return fail('A task needs a title');
      task.title = title;
      if (input.detail !== undefined) task.detail = text(input.detail, DETAIL_MAX);
      const priority = oneOf(TASK_PRIORITIES, input.priority);
      if (input.priority !== undefined && !priority) return fail(`priority is ${TASK_PRIORITIES.join(', ')}`);
      if (priority) task.priority = priority;
      if (typeof input.due === 'string') {
        if (input.due === '') delete task.due;
        else if (DAY.test(input.due)) task.due = input.due;
        else return fail('due is a day: YYYY-MM-DD');
      }
      if (typeof input.assignee === 'string') {
        if (!input.assignee.trim()) delete task.assignee;
        else {
          const who = findWorker(workers.filter((w) => w.kind === 'agent'), input.assignee);
          if (typeof who === 'string') return fail(who);
          const why = task.assignee?.id !== who.id ? this.blocked?.(who.id) : undefined;
          if (why) return fail(why);
          if (task.assignee?.id !== who.id) {
            task.assignee = { id: who.id, name: who.name };
            if (who.id !== by.id) notices.push({ to: who.id, text: `کار ${task.id} «${task.title}» به تو داده شد.${task.detail ? `\n${task.detail}` : ''}` });
          }
        }
      }
    }

    if (input.status !== undefined) {
      let status = oneOf(TASK_STATUSES, input.status);
      if (!status) return fail(`status is ${TASK_STATUSES.join(', ')}`);
      // Finishing is the manager's to confirm.
      if (status === 'done' && !by.boss) status = 'review';
      if (status === 'cancelled' && !by.boss) return fail('Only the manager cancels a task');
      task.status = status;
    }

    if (task.status !== before && boss && boss.id !== by.id && !task.flow) {
      if (task.status === 'review') notices.push({ to: boss.id, text: `${by.name} کار ${task.id} «${task.title}» را برای بازبینی گذاشت. بررسی کن و اگر خوب است «done» کن، وگرنه با یک یادداشت به او برگردان (doing).` });
      else if (task.status === 'blocked') notices.push({ to: boss.id, text: `${by.name} در کار ${task.id} «${task.title}» گیر کرده است. یادداشت‌هایش را ببین.` });
    }
    task.updatedAt = Date.now();
    this.save();
    return { ok: true, task, notices };
  }

  /** A note on a task; the manager and whoever it is with hear each other's. */
  note(by: Actor, id: string, body: unknown, workers: WorkerInfo[]): Outcome {
    const task = this.get(id);
    if (!task) return fail(`No task ${id}`);
    const mine = !!by.id && (task.assignee?.id === by.id || task.createdBy === by.name);
    if (!by.boss && !mine) return fail(`${task.id} isn't yours: ask the manager`);
    const said = text(body, NOTE_MAX);
    if (!said) return fail('Say what to note');
    task.notes.push({ at: Date.now(), by: by.name, text: said });
    if (task.notes.length > MAX_NOTES) task.notes.splice(0, task.notes.length - MAX_NOTES);
    task.updatedAt = Date.now();
    this.save();
    const notices: Notice[] = [];
    const boss = this.manager(workers);
    const other = by.boss ? task.assignee : boss ? { id: boss.id, name: boss.name } : undefined;
    if (other && other.id !== by.id && !task.flow) notices.push({ to: other.id, text: `یادداشت تازه روی ${task.id} «${task.title}» از ${by.name}: ${said}` });
    return { ok: true, task, notices };
  }

  /** The oldest finished ones go when there are too many. */
  private prune() {
    while (this.tasks.length > MAX_TASKS) {
      const i = this.tasks.findIndex((t) => t.status === 'done' || t.status === 'cancelled');
      this.tasks.splice(i < 0 ? 0 : i, 1);
    }
  }
}
