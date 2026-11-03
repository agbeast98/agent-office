// The team's scenarios: a manager (a name and a brief, with no desk and no seat: the office plays them) who
// runs a scenario, a list of steps each given to one worker, one after the other. The office hands a step to
// its worker as a task, waits for it, passes what came of it to the next step, sends a QA step's complaints
// back to the step it names (up to a limit), asks the person before a step marked so, and says when it's done.
// The AI is only woken for the work itself; waiting and passing on cost nothing.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { WorkerInfo } from '../shared/protocol.js';
import { findWorker } from './office-workers.js';
import type { Notice, TeamTask, TeamTasks } from './team-tasks.js';

export interface Boss {
  id: string;
  name: string;
  /** The team it manages, like «سئو». */
  team: string;
  /** How it wants the work done: told to every worker at every step. */
  brief: string;
}

export interface Step {
  title: string;
  /** The worker's id (or name, when it was typed). */
  who: string;
  /** A QA step says yes (review) or sends the work back (blocked, with what is wrong). */
  kind: 'work' | 'qa';
  brief: string;
  /** Starts at the same time as the next step, and both must finish before the one after. */
  together: boolean;
  /** The person says go before it starts. */
  gate: boolean;
  /** A QA step: the step the work goes back to. */
  back?: number;
}

export interface Scenario {
  id: string;
  name: string;
  boss: string;
  steps: Step[];
  /** How many times QA may send it back before it asks the person. */
  maxReturns: number;
}

export interface Part {
  step: number;
  task: string;
  done: boolean;
  failed?: boolean;
}

export type RunStatus = 'running' | 'gate' | 'done' | 'stuck' | 'stopped';

export interface Run {
  id: string;
  scenario: string;
  name: string;
  boss: string;
  /** The scenario as it was when this started, so editing it doesn't change a run in progress. */
  steps: Step[];
  maxReturns: number;
  input: string;
  status: RunStatus;
  /** The first step of the group of steps now being done. */
  idx: number;
  returns: number;
  parts: Part[];
  outputs: Record<number, string>;
  log: { at: number; text: string }[];
  startedAt: number;
  updatedAt: number;
}

export interface FlowDeps {
  tasks: TeamTasks;
  workers: () => WorkerInfo[];
  tell: (notices: Notice[], by: string) => void;
  notify: (text: string) => void;
  /** Why a worker can't be given work yet, if it can't. */
  blocked?: (workerId: string) => string | undefined;
}

export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

export const MAX_STEPS = 20;
const MAX_BOSSES = 30;
const MAX_SCENARIOS = 40;
const MAX_RUNS = 60;
const MAX_LOG = 80;
const OUT_MAX = 3000;
const DETAIL_BUDGET = 3900;

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').trim().slice(0, max) : '');
const fail = (error: string) => ({ ok: false as const, error });
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The steps a scenario is typed with, checked and cleaned; or what's wrong with them. */
export function parseSteps(v: unknown): Step[] | string {
  if (!Array.isArray(v) || !v.length) return 'حداقل یک مرحله لازم است';
  if (v.length > MAX_STEPS) return `حداکثر ${MAX_STEPS} مرحله`;
  const steps: Step[] = [];
  for (const [i, raw] of v.entries()) {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const title = text(r.title, 80);
    const who = text(r.who, 80);
    if (!title) return `مرحله‌ی ${i + 1} عنوان ندارد`;
    if (!who) return `مرحله‌ی ${i + 1} مسئول ندارد`;
    const step: Step = { title, who, kind: r.kind === 'qa' ? 'qa' : 'work', brief: text(r.brief, 1500), together: r.together === true, gate: r.gate === true };
    if (step.kind === 'qa') {
      if (i === 0) return 'QA نمی‌تواند اولین مرحله باشد';
      step.together = false;
      const back = Number(r.back);
      step.back = Number.isInteger(back) && back >= 0 && back < i ? back : i - 1;
    }
    steps.push(step);
  }
  // The last step has nothing to go together with, and a QA step waits for what it tests.
  steps[steps.length - 1].together = false;
  for (let i = 0; i < steps.length - 1; i++) if (steps[i + 1].kind === 'qa') steps[i].together = false;
  return steps;
}

/** The steps done together with step `i`: first and last. */
export function groupAt(steps: Step[], i: number): [number, number] {
  let from = i;
  while (from > 0 && steps[from - 1].together) from--;
  let to = from;
  while (to < steps.length - 1 && steps[to].together) to++;
  return [from, to];
}

/** What a worker wrote on its task: its notes, which is the result the next step is built on. */
function outputOf(t: TeamTask): string {
  const said = t.notes.map((n) => `${n.by}: ${n.text}`).join('\n');
  return clip(said || '(چیزی ننوشت)', OUT_MAX);
}

export class Flows {
  bosses: Boss[] = [];
  scenarios: Scenario[] = [];
  runs: Run[] = [];
  private next = { boss: 1, scenario: 1, run: 1 };
  private file: string;
  private busy = false;
  private again = false;
  private launching = new Set<string>();
  /** Called after every change, so what shows it can look again. */
  onChange: () => void = () => {};

  constructor(dataDir: string, private deps: FlowDeps, private mirror?: string) {
    this.file = path.join(dataDir, 'team-flows.json');
    this.load();
  }

  private load() {
    if (!existsSync(this.file)) return;
    try {
      const s = JSON.parse(readFileSync(this.file, 'utf8')) as { bosses?: Boss[]; scenarios?: Scenario[]; runs?: Run[]; next?: Flows['next'] };
      const ok = <T extends { id: string }>(list: unknown): T[] => (Array.isArray(list) ? list.filter((x): x is T => !!x && typeof (x as T).id === 'string') : []);
      this.bosses = ok<Boss>(s.bosses);
      this.scenarios = ok<Scenario>(s.scenarios).filter((x) => Array.isArray(x.steps));
      this.runs = ok<Run>(s.runs).filter((x) => Array.isArray(x.steps) && Array.isArray(x.parts));
      const top = (list: { id: string }[]) => Math.max(0, ...list.map((x) => Number(x.id.replace(/\D/g, '')) || 0)) + 1;
      this.next = { boss: Math.max(s.next?.boss ?? 1, top(this.bosses)), scenario: Math.max(s.next?.scenario ?? 1, top(this.scenarios)), run: Math.max(s.next?.run ?? 1, top(this.runs)) };
    } catch {
      // A file that can't be read is started over rather than blocking the team.
    }
  }

  private save() {
    const tmp = `${this.file}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ next: this.next, bosses: this.bosses, scenarios: this.scenarios, runs: this.runs }, null, 1), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch {
      // Still held in memory until the next save works.
    }
    this.writeMirror();
    this.onChange();
  }

  /** The scenarios as a page of their own: the source anyone (or any agent) can read. */
  describe(): string {
    const who = (id: string) => this.bosses.find((b) => b.id === id)?.name ?? '—';
    const people = this.deps.workers();
    const person = (id: string) => people.find((w) => w.id === id)?.name ?? id;
    const out = ['# سناریوهای تیم', '', 'این فایل را دفتر می‌سازد؛ ویرایش در پنجره‌ی «🧭 روال‌ها» انجام می‌شود.', ''];
    for (const b of this.bosses) out.push(`## مدیر: ${b.name} (تیم ${b.team || '—'})`, '', b.brief || '(بدون دستور)', '');
    for (const s of this.scenarios) {
      out.push(`## سناریو: ${s.name} — مدیر ${who(s.boss)} — حداکثر برگشت ${s.maxReturns}`, '');
      s.steps.forEach((st, i) => {
        const flags = [st.kind === 'qa' ? `QA ← برگشت به ${(st.back ?? i - 1) + 1}` : '', st.together ? 'هم‌زمان با بعدی' : '', st.gate ? 'منتظر تأیید مدیرعامل' : ''].filter(Boolean).join(' · ');
        out.push(`${i + 1}. **${st.title}** (${person(st.who)})${flags ? ` — ${flags}` : ''}${st.brief ? `\n   ${st.brief.replace(/\n/g, '\n   ')}` : ''}`);
      });
      out.push('');
    }
    return `${out.join('\n')}\n`;
  }

  private writeMirror() {
    if (!this.mirror) return;
    try {
      mkdirSync(path.dirname(this.mirror), { recursive: true });
      writeFileSync(this.mirror, this.describe(), 'utf8');
    } catch {
      // The scenarios still hold; only the readable copy is behind.
    }
  }

  // ---- What the person defines ----

  saveBoss(input: Record<string, unknown>): Result<{ boss: Boss }> {
    const name = text(input.name, 60);
    if (!name) return fail('مدیر نام لازم دارد');
    const old = typeof input.id === 'string' ? this.bosses.find((b) => b.id === input.id) : undefined;
    if (typeof input.id === 'string' && input.id && !old) return fail('چنین مدیری نیست');
    if (this.bosses.some((b) => b !== old && b.name === name)) return fail('مدیری با این نام هست');
    if (!old && this.bosses.length >= MAX_BOSSES) return fail('تعداد مدیرها به سقف رسیده');
    const boss: Boss = old ?? { id: `B-${this.next.boss++}`, name, team: '', brief: '' };
    boss.name = name;
    boss.team = text(input.team, 60);
    boss.brief = text(input.brief, 1500);
    if (!old) this.bosses.push(boss);
    this.save();
    return { ok: true, boss };
  }

  removeBoss(id: string): Result {
    if (!this.bosses.some((b) => b.id === id)) return fail('چنین مدیری نیست');
    if (this.scenarios.some((s) => s.boss === id)) return fail('سناریویی با این مدیر هست: اول آن را پاک یا به مدیر دیگری بدهید');
    this.bosses = this.bosses.filter((b) => b.id !== id);
    this.save();
    return { ok: true };
  }

  saveScenario(input: Record<string, unknown>): Result<{ scenario: Scenario }> {
    const name = text(input.name, 80);
    if (!name) return fail('سناریو نام لازم دارد');
    if (!this.bosses.some((b) => b.id === input.boss)) return fail('مدیر سناریو را انتخاب کنید');
    const steps = parseSteps(input.steps);
    if (typeof steps === 'string') return fail(steps);
    const old = typeof input.id === 'string' ? this.scenarios.find((s) => s.id === input.id) : undefined;
    if (typeof input.id === 'string' && input.id && !old) return fail('چنین سناریویی نیست');
    if (!old && this.scenarios.length >= MAX_SCENARIOS) return fail('تعداد سناریوها به سقف رسیده');
    const returns = Number(input.maxReturns);
    const scenario: Scenario = old ?? { id: `S-${this.next.scenario++}`, name, boss: String(input.boss), steps, maxReturns: 3 };
    scenario.name = name;
    scenario.boss = String(input.boss);
    scenario.steps = steps;
    scenario.maxReturns = Number.isInteger(returns) && returns >= 0 && returns <= 10 ? returns : 3;
    if (!old) this.scenarios.push(scenario);
    this.save();
    return { ok: true, scenario };
  }

  removeScenario(id: string): Result {
    if (!this.scenarios.some((s) => s.id === id)) return fail('چنین سناریویی نیست');
    if (this.runs.some((r) => r.scenario === id && (r.status === 'running' || r.status === 'gate' || r.status === 'stuck'))) return fail('یک اجرای این سناریو هنوز باز است');
    this.scenarios = this.scenarios.filter((s) => s.id !== id);
    this.save();
    return { ok: true };
  }

  // ---- Running one ----

  start(scenarioId: string, input: unknown): Result<{ run: Run }> {
    const scenario = this.scenarios.find((s) => s.id === scenarioId);
    if (!scenario) return fail('چنین سناریویی نیست');
    const boss = this.bosses.find((b) => b.id === scenario.boss);
    if (!boss) return fail('مدیر این سناریو پاک شده است');
    const agents = this.deps.workers().filter((w) => w.kind === 'agent');
    const steps = scenario.steps.map((s) => ({ ...s }));
    for (const [i, s] of steps.entries()) {
      const w = findWorker(agents, s.who);
      if (typeof w === 'string') return fail(`مرحله‌ی ${i + 1} «${s.title}»: ${w}`);
      s.who = w.id;
      const why = this.deps.blocked?.(w.id);
      if (why) return fail(`مرحله‌ی ${i + 1} «${s.title}»: ${why}`);
    }
    const now = Date.now();
    const run: Run = { id: `R-${this.next.run++}`, scenario: scenario.id, name: scenario.name, boss: boss.id, steps, maxReturns: scenario.maxReturns, input: text(input, 3000), status: 'running', idx: 0, returns: 0, parts: [], outputs: {}, log: [], startedAt: now, updatedAt: now };
    this.runs.push(run);
    this.say(run, `شروع شد (مدیر ${boss.name})`);
    this.go(run, 0, '');
    this.prune();
    this.save();
    return { ok: true, run };
  }

  /** The person says go to a step that was waiting for them. */
  approve(id: string): Result {
    const run = this.runs.find((r) => r.id === id);
    if (!run || run.status !== 'gate') return fail('این اجرا منتظر تأیید نیست');
    run.status = 'running';
    this.say(run, 'مدیرعامل تأیید کرد');
    this.launch(run, '');
    this.save();
    return { ok: true };
  }

  /** Tries the step it is stuck at once more. */
  retry(id: string): Result {
    const run = this.runs.find((r) => r.id === id);
    if (!run || run.status !== 'stuck') return fail('این اجرا گیر نکرده است');
    this.cancelOpen(run);
    run.status = 'running';
    this.say(run, 'دوباره امتحان می‌شود');
    this.launch(run, '');
    this.save();
    return { ok: true };
  }

  stop(id: string): Result {
    const run = this.runs.find((r) => r.id === id);
    if (!run || run.status === 'done' || run.status === 'stopped') return fail('این اجرا باز نیست');
    run.status = 'stopped';
    this.cancelOpen(run);
    this.say(run, 'متوقف شد');
    this.save();
    return { ok: true };
  }

  removeRun(id: string): Result {
    const run = this.runs.find((r) => r.id === id);
    if (!run) return fail('چنین اجرایی نیست');
    if (run.status === 'running' || run.status === 'gate') return fail('اول متوقفش کنید');
    this.runs = this.runs.filter((r) => r !== run);
    this.save();
    return { ok: true };
  }

  private say(run: Run, line: string) {
    run.log.push({ at: Date.now(), text: line });
    if (run.log.length > MAX_LOG) run.log.splice(0, run.log.length - MAX_LOG);
    run.updatedAt = Date.now();
  }

  private bossOf(run: Run) {
    return this.bosses.find((b) => b.id === run.boss);
  }

  private cancelOpen(run: Run) {
    const by = { name: this.bossOf(run)?.name ?? 'مدیر', boss: true };
    for (const p of run.parts) {
      const t = this.deps.tasks.get(p.task);
      if (t && t.status !== 'done' && t.status !== 'cancelled') this.deps.tasks.update(by, t.id, { status: 'cancelled' }, this.deps.workers());
    }
  }

  /** Moves to the group that starts at `idx`; asks the person first if a step of it says so. */
  private go(run: Run, idx: number, feedback: string, asked = false) {
    run.idx = idx;
    run.parts = [];
    const [from, to] = groupAt(run.steps, idx);
    if (!asked && run.steps.slice(from, to + 1).some((s) => s.gate)) {
      run.status = 'gate';
      this.say(run, `منتظر تأیید مدیرعامل برای «${run.steps[from].title}»`);
      this.deps.notify(`🧭 ${run.name} (${run.id}): منتظر تأیید شما برای «${run.steps[from].title}»`);
      return;
    }
    this.launch(run, feedback);
  }

  /** Makes the tasks of the group now due, one per step, each for its worker. */
  private launch(run: Run, feedback: string) {
    const [from, to] = groupAt(run.steps, run.idx);
    const boss = this.bossOf(run);
    const by = { name: boss?.name ?? 'مدیر', boss: true };
    run.parts = [];
    this.launching.add(run.id);
    try {
      for (let i = from; i <= to; i++) {
        const step = run.steps[i];
        const res = this.deps.tasks.create(by, { title: `${run.name} · ${step.title}`, detail: this.detailOf(run, i, boss, feedback), assignee: step.who, flow: run.id }, this.deps.workers());
        if (!res.ok || !res.task) {
          run.status = 'stuck';
          this.say(run, `نشد به «${step.title}» کار بدهم: ${res.ok ? '؟' : res.error}`);
          this.deps.notify(`🧭 ${run.name} (${run.id}) گیر کرد: ${res.ok ? 'کار ساخته نشد' : res.error}`);
          return;
        }
        run.parts.push({ step: i, task: res.task.id, done: false });
        this.deps.tell(res.notices, by.name);
        this.say(run, `«${step.title}» ← ${res.task.id}`);
      }
      run.status = 'running';
    } finally {
      this.launching.delete(run.id);
    }
  }

  /** What a worker is told for its step: the job and how to hand it back come first, so they survive the length limit. */
  private detailOf(run: Run, i: number, boss: Boss | undefined, feedback: string): string {
    const step = run.steps[i];
    const head = [
      `سناریو «${run.name}» — مرحله‌ی ${i + 1} از ${run.steps.length}: ${step.title}`,
      boss?.brief ? `دستور مدیر ${boss.name}: ${boss.brief}` : '',
      step.brief ? `کار این مرحله: ${step.brief}` : '',
      step.kind === 'qa'
        ? 'کار را بررسی و تست کن. اگر همه چیز درست بود: یک یادداشت کوتاه با add_task_note بنویس و وضعیت را review کن. اگر ایراد دیدی: هر ایراد را روشن و جدا با add_task_note بنویس و وضعیت را blocked کن (نه review)؛ کار برمی‌گردد تا درست شود.'
        : 'نتیجه‌ی کامل را با add_task_note بنویس (مرحله‌ی بعد دقیقاً از یادداشت‌های همین کار ساخته می‌شود؛ حرف زدن در ترمینال کافی نیست) و بعد وضعیت را review کن. چیزی بیرون از این مرحله انجام نده.',
    ].filter(Boolean).join('\n');
    const before = Object.entries(run.outputs)
      .filter(([k]) => Number(k) < i)
      .map(([k, v]) => `— ${run.steps[Number(k)].title}:\n${clip(v, 1200)}`)
      .join('\n');
    const tail = [feedback ? `ایرادهای QA که باید رفع شود:\n${feedback}` : '', run.input ? `ورودی پروژه:\n${run.input}` : '', before ? `خروجی مرحله‌های قبل:\n${before}` : ''].filter(Boolean).join('\n\n');
    return clip(`${head}${tail ? `\n\n${tail}` : ''}`, DETAIL_BUDGET);
  }

  private prune() {
    while (this.runs.length > MAX_RUNS) {
      const i = this.runs.findIndex((r) => r.status === 'done' || r.status === 'stopped');
      if (i < 0) return;
      this.runs.splice(i, 1);
    }
  }

  /** Looks at every run in progress against its tasks, and moves on the ones whose step is finished. */
  sync() {
    if (this.busy) {
      this.again = true;
      return;
    }
    this.busy = true;
    try {
      do {
        this.again = false;
        let changed = false;
        for (const run of this.runs) if (run.status === 'running' && !this.launching.has(run.id)) changed = this.look(run) || changed;
        if (changed) this.save();
      } while (this.again);
    } finally {
      this.busy = false;
    }
  }

  private stick(run: Run, why: string) {
    run.status = 'stuck';
    this.say(run, why);
    this.deps.notify(`🧭 ${run.name} (${run.id}) گیر کرد: ${why}`);
    return true;
  }

  private look(run: Run): boolean {
    let changed = false;
    const by = { name: this.bossOf(run)?.name ?? 'مدیر', boss: true };
    for (const part of run.parts) {
      if (part.done) continue;
      const t = this.deps.tasks.get(part.task);
      const step = run.steps[part.step];
      if (!t) return this.stick(run, `کار ${part.task} پیدا نشد`);
      if (t.status === 'cancelled') return this.stick(run, `کار ${t.id} لغو شد`);
      if (t.status === 'review' || t.status === 'done' || (t.status === 'blocked' && step.kind === 'qa')) {
        part.done = true;
        part.failed = t.status === 'blocked';
        run.outputs[part.step] = outputOf(t);
        if (t.status !== 'done') this.deps.tasks.update(by, t.id, { status: 'done' }, this.deps.workers());
        this.say(run, `«${step.title}» ${part.failed ? 'ایراد پیدا کرد' : 'تمام شد'}`);
        changed = true;
      } else if (t.status === 'blocked') {
        return this.stick(run, `«${step.title}» گیر کرد (${t.id}) — یادداشت‌های کار را ببینید`);
      }
    }
    if (!run.parts.length || run.parts.some((p) => !p.done)) return changed;
    this.advance(run);
    return true;
  }

  private advance(run: Run) {
    const [, to] = groupAt(run.steps, run.idx);
    const bad = run.parts.find((p) => p.failed);
    if (bad) {
      const qa = run.steps[bad.step];
      run.returns++;
      if (run.returns > run.maxReturns) {
        this.stick(run, `بعد از ${run.maxReturns} بار برگشت هنوز ایراد دارد؛ شما تصمیم بگیرید`);
        return;
      }
      const back = qa.back ?? bad.step - 1;
      this.say(run, `QA کار را برگرداند به «${run.steps[back].title}» (برگشت ${run.returns} از ${run.maxReturns})`);
      this.go(run, groupAt(run.steps, back)[0], run.outputs[bad.step] ?? '', true);
      return;
    }
    if (to >= run.steps.length - 1) {
      run.status = 'done';
      this.say(run, 'همه‌ی مرحله‌ها تمام شد');
      this.deps.notify(`✅ ${run.name} (${run.id}) تمام شد`);
      return;
    }
    this.go(run, to + 1, '');
  }
}
