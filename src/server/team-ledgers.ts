// The lists the team keeps for the person: what agents need from them (requests), what went wrong and what was
// learned (mistakes) and how each member was judged (evaluations). Each is a small file in .agent-office, read
// and written the same way (see Ledger). The mistakes are also written as freelance-team/mistakes.md, which
// every agent reads before work, so the same mistake isn't made twice.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export class Ledger<T extends { id: string; at: number }> {
  items: T[] = [];
  private seq = 1;
  private saving = false;

  constructor(private file: string, private prefix: string, private max: number, private onSave?: () => void) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      if (Array.isArray(raw.items)) this.items = raw.items.slice(-max);
      this.seq = Number(raw.seq) > 0 ? Number(raw.seq) : this.items.length + 1;
    } catch {
      // No file yet.
    }
  }

  add(data: Omit<T, 'id' | 'at'> & Partial<Pick<T, 'at'>>): T {
    const item = { ...data, id: `${this.prefix}-${this.seq++}`, at: data.at ?? Date.now() } as T;
    this.items.push(item);
    if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max);
    this.save();
    return item;
  }

  get(id: string): T | undefined {
    return this.items.find((i) => i.id === id);
  }

  save() {
    this.onSave?.();
    if (this.saving) return;
    this.saving = true;
    setTimeout(() => {
      this.saving = false;
      try {
        mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.tmp`;
        writeFileSync(tmp, JSON.stringify({ seq: this.seq, items: this.items }), 'utf8');
        renameSync(tmp, this.file);
      } catch {
        // The next change saves again.
      }
    }, 300).unref();
  }
}

const text = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').trim().slice(0, max) : '');
const list = (v: unknown, max: number, n = 12): string[] => (Array.isArray(v) ? v.map((x) => text(x, max)).filter(Boolean).slice(0, n) : []);

// ---- What agents need from the person ----

export type ReqKind = 'login' | 'action' | 'approve' | 'decision' | 'info';
export const REQ_KINDS: readonly ReqKind[] = ['login', 'action', 'approve', 'decision', 'info'];
export interface Req {
  id: string;
  at: number;
  from: string;
  fromName: string;
  kind: ReqKind;
  title: string;
  detail: string;
  /** A page to go to (a site to log in to, a file), when there is one. */
  url?: string;
  status: 'open' | 'done' | 'declined';
  note?: string;
  doneAt?: number;
  /** A request for leave to change a profile file: what, and until when the leave lasts once the person says yes. */
  scope?: { file: string };
  until?: number;
}

const PERMIT_MS = 60 * 60_000;

export class TeamRequests extends Ledger<Req> {
  constructor(dataDir: string) {
    super(path.join(dataDir, 'team-requests.json'), 'R', 300);
  }

  open(): Req[] {
    return this.items.filter((r) => r.status === 'open');
  }

  /** Someone asks the person for something. The same ask from the same agent, still open, is not made twice. */
  ask(from: string, fromName: string, input: Record<string, unknown>): { ok: true; req: Req; fresh: boolean } | { ok: false; error: string } {
    const title = text(input.title, 160);
    if (!title) return { ok: false, error: 'عنوان درخواست خالی است' };
    const kind = REQ_KINDS.find((k) => k === input.kind) ?? 'action';
    const dup = this.items.find((r) => r.status === 'open' && r.from === from && r.title === title);
    if (dup) return { ok: true, req: dup, fresh: false };
    const url = text(input.url, 500);
    const file = text(input.file, 300);
    const req = this.add({ from, fromName, kind, title, detail: text(input.detail, 4000), status: 'open', ...(url ? { url } : {}), ...(file ? { scope: { file } } : {}) });
    return { ok: true, req, fresh: true };
  }

  resolve(id: string, verdict: 'done' | 'declined' | 'open', note: string, now = Date.now()): Req | undefined {
    const r = this.get(id);
    if (!r) return undefined;
    r.status = verdict;
    r.note = note ? text(note, 1000) : undefined;
    r.doneAt = verdict === 'open' ? undefined : now;
    r.until = verdict === 'done' && r.scope ? now + PERMIT_MS : undefined;
    this.save();
    return r;
  }

  /** The person said yes to this agent changing this file, lately. */
  permitFor(from: string, file: string, now = Date.now()): Req | undefined {
    return this.items.find((r) => r.status === 'done' && r.from === from && r.scope?.file === file && (r.until ?? 0) > now);
  }

  swap(from: string, to: string) {
    for (const r of this.items) if (r.from === from) r.from = to;
    this.save();
  }
}

// ---- What went wrong, and what was learned ----

export type MistakeBy = 'agent' | 'ceo' | 'assistant' | 'system';
export interface Mistake {
  id: string;
  at: number;
  by: MistakeBy;
  byName: string;
  /** The agent it happened with (or to), when there is one. */
  who?: string;
  whoId?: string;
  what: string;
  /** What the agent did about it. */
  did: string;
  cause: string;
  /** What to do from now on. */
  lesson: string;
  status: 'open' | 'learned' | 'wontfix';
  note?: string;
}

const BY_FA: Record<MistakeBy, string> = { agent: 'ایجنت', ceo: 'مدیرعامل', assistant: 'دستیار', system: 'سیستم' };

export class TeamMistakes extends Ledger<Mistake> {
  constructor(dataDir: string, private mirror?: string) {
    super(path.join(dataDir, 'team-mistakes.json'), 'E', 500, () => this.writeMirror());
  }

  report(input: Record<string, unknown>, by: MistakeBy, byName: string, who?: { id: string; name: string }): { ok: true; mistake: Mistake } | { ok: false; error: string } {
    const what = text(input.what, 1500);
    if (!what) return { ok: false, error: 'بنویس چه اشتباهی شد' };
    const named = text(input.who, 60);
    const mistake = this.add({
      by, byName, ...(who ? { who: who.name, whoId: who.id } : named ? { who: named } : {}),
      what, did: text(input.did, 1500), cause: text(input.cause, 1500), lesson: text(input.lesson, 1500), status: 'open',
    });
    return { ok: true, mistake };
  }

  setStatus(id: string, status: Mistake['status'], note = ''): Mistake | undefined {
    const m = this.get(id);
    if (!m) return undefined;
    m.status = status;
    m.note = note ? text(note, 500) : undefined;
    this.save();
    return m;
  }

  swap(from: string, to: string) {
    for (const m of this.items) if (m.whoId === from) m.whoId = to;
    this.save();
  }

  /** freelance-team/mistakes.md: what every agent reads before work. */
  private writeMirror() {
    if (!this.mirror) return;
    const day = (at: number) => new Date(at).toISOString().slice(0, 10);
    const live = this.items.filter((m) => m.status !== 'wontfix' && (m.lesson || m.what)).slice(-60).reverse();
    const lines = [
      '# اشتباهات ثبت‌شده و درس‌هایشان (همه‌ی نیروها قبل از کار می‌خوانند)',
      '',
      'دفتر این فایل را خودش می‌نویسد؛ دستی عوضش نکن. اشتباهی که دیدی یا کردی را با ابزار `report_mistake` ثبت کن تا بقیه تکرارش نکنند.',
      '',
      ...live.map((m) => `- ${day(m.at)} · ${m.who ? `${m.who} (${BY_FA[m.by]})` : BY_FA[m.by]}: ${m.what.replace(/\n+/g, ' ')}${m.cause ? ` — علت: ${m.cause.replace(/\n+/g, ' ')}` : ''}${m.lesson ? ` — **درس:** ${m.lesson.replace(/\n+/g, ' ')}` : ''}${m.status === 'learned' ? ' ✓' : ''}`),
    ];
    try {
      mkdirSync(path.dirname(this.mirror), { recursive: true });
      writeFileSync(this.mirror, `${lines.join('\n')}\n`, 'utf8');
    } catch {
      // The list itself is kept.
    }
  }
}

// ---- How each member was judged ----

export interface Evaluation {
  id: string;
  at: number;
  by: string;
  byName: string;
  member: string;
  memberName: string;
  summary: string;
  strengths: string[];
  weaknesses: string[];
  lessons: string[];
  /** What the evaluator proposes to change in the profile. */
  proposal: string;
  status: 'proposed' | 'approved' | 'applied' | 'declined';
}

const EVAL_STATUS = ['proposed', 'approved', 'applied', 'declined'] as const;

export class TeamEvals extends Ledger<Evaluation> {
  constructor(dataDir: string) {
    super(path.join(dataDir, 'team-evals.json'), 'V', 400);
  }

  record(by: string, byName: string, member: { id: string; name: string }, input: Record<string, unknown>): { ok: true; evaluation: Evaluation } | { ok: false; error: string } {
    const summary = text(input.summary, 2000);
    if (!summary) return { ok: false, error: 'خلاصه‌ی ارزیابی خالی است' };
    const status = EVAL_STATUS.find((s) => s === input.status) ?? 'proposed';
    const evaluation = this.add({ by, byName, member: member.id, memberName: member.name, summary, strengths: list(input.strengths, 400), weaknesses: list(input.weaknesses, 400), lessons: list(input.lessons, 400), proposal: text(input.proposal, 2000), status });
    return { ok: true, evaluation };
  }

  setStatus(id: string, status: Evaluation['status']): Evaluation | undefined {
    const e = this.get(id);
    if (!e) return undefined;
    e.status = status;
    this.save();
    return e;
  }

  swap(from: string, to: string) {
    for (const e of this.items) {
      if (e.member === from) e.member = to;
      if (e.by === from) e.by = to;
    }
    this.save();
  }
}
