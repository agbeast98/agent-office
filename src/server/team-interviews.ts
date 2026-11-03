// The first interview of a new hire (see client/features/manager/hiring.ts): the person hires at a desk with a
// name, a post and a description of the job; the new agent introduces itself in a chat with the person, asks its
// questions one by one, says what it wants and can do and what access it has and needs, and writes its own
// skill.md and memory.md (kept in the floor's repository, in git). Until the person hires it, it is given no work.
// The agent talks through the interview_say and interview_finish tools (bin/office-workers.js, hooks/office-tasks.ts).
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Notice } from './team-tasks.js';

export type InterviewStatus = 'talking' | 'review' | 'hired' | 'rejected' | 'skipped';

export interface Talk {
  by: 'agent' | 'boss';
  text: string;
  at: number;
}

export interface Interview {
  id: string;
  worker: string;
  name: string;
  /** The post, like «ایده‌یاب سئو». */
  role: string;
  desk: string;
  /** The folder of its profile: freelance-team/people/<slug>/ */
  slug: string;
  status: InterviewStatus;
  /** What the person wrote the job is. */
  skill: string;
  messages: Talk[];
  summary?: string;
  access?: string;
  startedAt: number;
  updatedAt: number;
}

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const MAX_MESSAGES = 200;
const TEXT_MAX = 4000;
const FILE_MAX = 20_000;
const fail = (error: string) => ({ ok: false as const, error });
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').trim().slice(0, max) : '');

/** A folder name from a person's name: its letters, with dashes between words. */
export function slugOf(name: string, taken: (slug: string) => boolean): string {
  const base = name.trim().replace(/[\\/:*?"<>|.\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'agent';
  let slug = base;
  for (let n = 2; taken(slug); n++) slug = `${base}-${n}`;
  return slug;
}

export class Interviews {
  private list: Interview[] = [];
  private next = 1;
  private file: string;

  /** `peopleDir` is where the profiles are kept (freelance-team/people in the floor's repository). */
  constructor(dataDir: string, readonly peopleDir?: string) {
    this.file = path.join(dataDir, 'team-interviews.json');
    this.load();
  }

  private load() {
    if (!existsSync(this.file)) return;
    try {
      const s = JSON.parse(readFileSync(this.file, 'utf8')) as { next?: number; list?: Interview[] };
      if (Array.isArray(s.list)) this.list = s.list.filter((i) => !!i && typeof i.id === 'string' && Array.isArray(i.messages));
      this.next = Math.max(Number(s.next) || 1, ...this.list.map((i) => Number(i.id.replace(/\D/g, '')) + 1));
    } catch {
      // A file that can't be read is started over rather than blocking the team.
    }
  }

  private save() {
    const tmp = `${this.file}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ next: this.next, list: this.list }, null, 1), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch {
      // Still held in memory until the next save works.
    }
  }

  all(): Interview[] {
    return this.list;
  }

  get(id: string): Interview | undefined {
    return this.list.find((i) => i.id === id);
  }

  /** The interview a worker is in, if it is the one still on. */
  open(worker: string): Interview | undefined {
    return this.list.find((i) => i.worker === worker && (i.status === 'talking' || i.status === 'review'));
  }

  /** Why a worker can't be given work yet: it hasn't been hired. */
  blocking(worker: string): string | undefined {
    const i = this.open(worker);
    return i ? `${i.name} هنوز در مصاحبه است و استخدام نشده: اول مصاحبه را در «🧑‍💼 استخدام» تمام کنید` : undefined;
  }

  fileFor(i: Interview, name: 'skill.md' | 'memory.md'): string | undefined {
    if (!this.peopleDir) return undefined;
    try {
      return readFileSync(path.join(this.peopleDir, i.slug, name), 'utf8').slice(0, FILE_MAX);
    } catch {
      return undefined;
    }
  }

  private write(slug: string, name: 'skill.md' | 'memory.md', body: string) {
    if (!this.peopleDir) return;
    try {
      const dir = path.join(this.peopleDir, slug);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, name), `${body.trim()}\n`, 'utf8');
    } catch {
      // The interview still goes on; only the file is behind.
    }
  }

  /** A hired worker's interview begins: its profile gets what the person wrote. */
  start(input: { worker: string; name: string; role: string; desk: string; skill: string }): Interview {
    const name = text(input.name, 60);
    const role = text(input.role, 120);
    const skill = text(input.skill, 3000);
    const slug = slugOf(name, (s) => this.list.some((i) => i.slug === s));
    const now = Date.now();
    const i: Interview = { id: `I-${this.next++}`, worker: input.worker, name, role, desk: input.desk, slug, status: 'talking', skill, messages: [], startedAt: now, updatedAt: now };
    this.list.push(i);
    this.write(slug, 'skill.md', `# ${name} — ${role}\n\n## شرح کار و مهارت (به قلم مدیرعامل)\n\n${skill || '(هنوز نوشته نشده)'}`);
    this.write(slug, 'memory.md', `# حافظه‌ی ${name}\n\n(هنوز چیزی ثبت نشده؛ بعد از مصاحبه و هر کار تکمیل می‌شود.)`);
    this.save();
    return i;
  }

  /** An interview that never happened (the hire didn't go through) or a rejected one: gone, with its profile folder. */
  discard(i: Interview) {
    this.list = this.list.filter((x) => x !== i);
    if (this.peopleDir) {
      try {
        rmSync(path.join(this.peopleDir, i.slug), { recursive: true, force: true });
      } catch {
        // A folder that can't be removed is only left behind.
      }
    }
    this.save();
  }

  /** What the agent says in the interview. */
  say(worker: string, body: unknown): Result<{ interview: Interview; notices: Notice[] }> {
    const i = this.open(worker);
    if (!i) return fail('مصاحبه‌ای برای تو باز نیست');
    const said = text(body, TEXT_MAX);
    if (!said) return fail('چیزی بنویس');
    this.push(i, 'agent', said);
    return { ok: true, interview: i, notices: [] };
  }

  /** What the person says. */
  bossSay(id: string, body: unknown): Result<{ interview: Interview; notices: Notice[] }> {
    const i = this.get(id);
    if (!i || (i.status !== 'talking' && i.status !== 'review')) return fail('این مصاحبه باز نیست');
    const said = text(body, TEXT_MAX);
    if (!said) return fail('چیزی بنویسید');
    this.push(i, 'boss', said);
    i.status = 'talking';
    return { ok: true, interview: i, notices: [{ to: i.worker, text: `پاسخ مدیرعامل در مصاحبه:\n${said}\n\nبا interview_say جواب بده و سؤال بعدی‌ات را بپرس (یکی‌یکی). وقتی همه‌چیز را فهمیدی، نظر و دسترسی‌هایت را بگو و interview_finish را صدا بزن.` }] };
  }

  /** The agent is done: its refined skill, what it learned, and the access it has and needs. */
  finish(worker: string, input: { summary?: unknown; skill?: unknown; memory?: unknown; access?: unknown }): Result<{ interview: Interview }> {
    const i = this.open(worker);
    if (!i) return fail('مصاحبه‌ای برای تو باز نیست');
    const skill = text(input.skill, FILE_MAX);
    const memory = text(input.memory, FILE_MAX);
    if (!skill || !memory) return fail('skill و memory را کامل بنویس (markdown)');
    i.summary = text(input.summary, 2000) || undefined;
    i.access = text(input.access, 3000) || undefined;
    this.write(i.slug, 'skill.md', skill);
    this.write(i.slug, 'memory.md', memory);
    i.status = 'review';
    this.push(i, 'agent', `مصاحبه را تمام کردم.${i.summary ? `\n\n${i.summary}` : ''}`);
    return { ok: true, interview: i };
  }

  /** The person's decision: hire, send home, or hire without finishing the interview. */
  decide(id: string, verdict: 'hire' | 'reject' | 'skip'): Result<{ interview: Interview }> {
    const i = this.get(id);
    if (!i || (i.status !== 'talking' && i.status !== 'review')) return fail('این مصاحبه باز نیست');
    if (verdict === 'hire' && i.status !== 'review') return fail('ایجنت هنوز مصاحبه را تمام نکرده؛ یا منتظرش بمانید یا «رد شدن از مصاحبه» را بزنید');
    i.status = verdict === 'hire' ? 'hired' : verdict === 'reject' ? 'rejected' : 'skipped';
    i.updatedAt = Date.now();
    this.save();
    if (verdict === 'reject') this.discard(i);
    return { ok: true, interview: i };
  }

  private push(i: Interview, by: Talk['by'], body: string) {
    i.messages.push({ by, text: body, at: Date.now() });
    if (i.messages.length > MAX_MESSAGES) i.messages.splice(0, i.messages.length - MAX_MESSAGES);
    i.updatedAt = Date.now();
    this.save();
  }
}

/** The first message of the new agent: who it is, and how its interview goes. */
export function interviewPrompt(name: string, role: string, skill: string, folder: string): string {
  return [
    `تو «${name}» هستی، با سمت «${role}» در تیم فریلنسری مدیرعامل (Mohammad / Khat Web). این مصاحبه‌ی اولیه‌ی توست؛ هنوز کار واقعی نداری و تا استخدام نشده‌ای هیچ کاری نکن و به هیچ سایتی نرو.`,
    skill ? `شرحی که مدیرعامل برای کار تو نوشته:\n${skill}` : '',
    'قواعد مصاحبه: فقط با ابزار interview_say با مدیرعامل حرف بزن (حرف زدن در ترمینال به او نمی‌رسد). جواب‌های او با پیامی که با «پاسخ مدیرعامل در مصاحبه» شروع می‌شود می‌رسد.',
    '۱) اول در یک پیام کوتاه خودت را معرفی کن: نام، سمت و آنچه فکر می‌کنی کارت است.',
    '۲) بعد سؤال‌هایت را یکی‌یکی بپرس (حدود ۵ تا ۸ سؤال): درباره‌ی خود مدیرعامل و کسب‌وکارش، مشتری‌ها و بازار، لحن، معیار کیفیت، نمونه‌ی کار خوب، و ممنوعات. بعد از هر سؤال صبر کن تا جواب برسد.',
    '۳) بعد از سؤال‌ها نظر خودت را بگو: چه کارهایی را می‌خواهی و می‌توانی انجام بدهی، چه کارهایی را نمی‌توانی یا نباید انجام بدهی، و پیشنهادت برای بهتر شدن کار.',
    '۴) دسترسی‌هایت را روشن بگو: آیا مرورگر داری (ابزارهای browser_* دفتر: بله، یک مرورگر اختصاصی که مدیرعامل زنده می‌بیند؛ ارسال و ورود فقط با تأیید او) و برای کارت به چه سایت‌ها، حساب‌ها، فایل‌ها یا ابزارهایی نیاز داری و کدام‌ها را الان نداری.',
    `۵) آخر interview_finish را صدا بزن با: summary (خلاصه‌ی ۵ خط)، skill (متن کامل و بهترشده‌ی فایل مهارتت به markdown: سمت، کارهایی که می‌کنی، خروجی هر کار، قواعد و ممنوعات؛ نوشته‌ی مدیرعامل را حفظ کن)، memory (آنچه درباره‌ی مدیرعامل و کار یاد گرفتی، markdown)، access (دسترسی‌هایی که داری و آنهایی که لازم داری).`,
    `پروفایل تو در پوشه‌ی ${folder} است (skill.md و memory.md). در آینده در شروع هر کار آن‌ها را بخوان و بعد از هر کار نکته‌های تازه را به memory.md اضافه کن.`,
    'حالا شروع کن: خودت را معرفی کن.',
  ].filter(Boolean).join('\n\n');
}
