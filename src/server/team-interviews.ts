// The first interview of a new hire (see client/features/manager/hiring.ts): the person hires at a desk with a
// name, a post and a description of the job; the new agent introduces itself in a chat with the person, asks its
// questions one by one, says what it wants and can do and what access it has and needs, and writes its own
// skill.md and memory.md (kept in the floor's repository, in git). Until the person hires it, it is given no work.
// The agent talks through the interview_say and interview_finish tools (bin/office-workers.js, hooks/office-tasks.ts).
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { noteOwnWrite } from './profile-watch.js';
import type { Notice } from './team-tasks.js';

/** `updated` and `kept` end a re-interview (see Interviews.review): the profile was changed to the agent's proposal, or left as it was. */
export type InterviewStatus = 'talking' | 'review' | 'hired' | 'rejected' | 'skipped' | 'updated' | 'kept';

/** The two files of a profile (freelance-team/people/<slug>/). */
export interface Profile {
  skill: string;
  memory: string;
}

export interface Talk {
  by: 'agent' | 'boss' | 'manager';
  /** For the manager: its name. */
  who?: string;
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
  /** The team it is hired into (see team-teams.ts), and whether as its manager. */
  team?: string;
  isManager?: boolean;
  messages: Talk[];
  summary?: string;
  access?: string;
  /** A re-interview of someone already hired: the agent is asked about its own work and proposes changes to its profile, which only the person's approval writes. */
  kind?: 'review';
  /** The profile as it was when the re-interview began, and what the agent proposes (with a list of the changes and why). */
  before?: Profile;
  proposal?: Profile & { changes: string };
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

const COMPANY_MAX = 12_000;
export const COMPANY_TEMPLATE = [
  '# کسب‌وکار مدیرعامل (همه‌ی نیروها قبل از مصاحبه و قبل از هر کار این را می‌خوانند)',
  '',
  'این فایل را مدیرعامل از پنل «استخدام» می‌نویسد و ایجنت‌ها آنچه از مصاحبه‌ها یاد می‌گیرند زیر «افزوده‌ها» اضافه می‌کنند.',
  '',
  '## کسب‌وکار',
  '(نام، سایت، نوع کار)',
  '',
  '## خدمت‌ها',
  '(فهرست خدمت‌ها و اولویت)',
  '',
  '## مشتری و بازار',
  '(چه کسانی، کجا)',
  '',
  '## رقبا و نمونه‌ها',
  '',
  '## قوانین و ممنوعات',
  '',
  '## افزوده‌ها',
  '',
].join('\n');

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

  /** The same person on another engine: its interviews follow the new worker id. */
  swap(from: string, to: string) {
    let changed = false;
    for (const i of this.list) if (i.worker === from) { i.worker = to; changed = true; }
    if (changed) this.save();
  }

  /** Why a worker can't be given work yet: it hasn't been hired. */
  blocking(worker: string): string | undefined {
    const i = this.open(worker);
    if (!i) return undefined;
    return i.kind === 'review' ? `${i.name} در مصاحبه‌ی بازبینی است: اول آن را در «🧑‍💼 استخدام» تمام کنید` : `${i.name} هنوز در مصاحبه است و استخدام نشده: اول مصاحبه را در «🧑‍💼 استخدام» تمام کنید`;
  }

  /** When the worker was last interviewed (the first interview or a re-interview that ended), or undefined if never. */
  lastInterviewed(worker: string): number | undefined {
    const done = this.list.filter((i) => i.worker === worker && i.status !== 'talking' && i.status !== 'review' && i.status !== 'rejected');
    return done.length ? Math.max(...done.map((i) => i.updatedAt)) : undefined;
  }

  /**
   * A hired agent is interviewed again: a new interview on its existing profile, which is left untouched until
   * the person approves what the agent proposes at the end. Or why not.
   */
  review(worker: string): Result<{ interview: Interview }> {
    if (this.open(worker)) return fail('او الان در مصاحبه است');
    const last = this.latestFor(worker);
    if (!last || !this.peopleDir) return fail('این ایجنت پروفایلی ندارد که بازبینی شود');
    const skill = this.fileFor(last, 'skill.md');
    const memory = this.fileFor(last, 'memory.md');
    if (skill === undefined || memory === undefined) return fail('فایل‌های پروفایل او پیدا نشد');
    const now = Date.now();
    const i: Interview = { id: `I-${this.next++}`, worker, name: last.name, role: last.role, desk: last.desk, slug: last.slug, status: 'talking', skill: last.skill, kind: 'review', before: { skill, memory }, messages: [], startedAt: now, updatedAt: now, ...(last.team ? { team: last.team } : {}), ...(last.isManager ? { isManager: true } : {}), ...(last.access ? { access: last.access } : {}) };
    this.list.push(i);
    this.save();
    return { ok: true, interview: i };
  }

  /** freelance-team/company.md: what the business is, shared by everyone, so no new hire asks it all again. */
  get companyFile(): string | undefined {
    return this.peopleDir ? path.join(path.dirname(this.peopleDir), 'company.md') : undefined;
  }

  company(): string {
    const f = this.companyFile;
    if (!f) return '';
    try {
      return readFileSync(f, 'utf8').slice(0, COMPANY_MAX);
    } catch {
      return '';
    }
  }

  saveCompany(text: string): boolean {
    const f = this.companyFile;
    if (!f) return false;
    try {
      mkdirSync(path.dirname(f), { recursive: true });
      writeFileSync(f, `${text.slice(0, COMPANY_MAX).trim()}\n`, 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  /** A floor that has no company.md yet gets one with its headings, so the first hire has something to read. */
  ensureCompany() {
    const f = this.companyFile;
    if (f && !existsSync(f)) this.saveCompany(COMPANY_TEMPLATE);
  }

  fileFor(i: Interview, name: 'skill.md' | 'memory.md'): string | undefined {
    if (!this.peopleDir) return undefined;
    try {
      return readFileSync(path.join(this.peopleDir, i.slug, name), 'utf8').slice(0, FILE_MAX);
    } catch {
      return undefined;
    }
  }

  /** The newest interview of a worker (its profile folder is that one's slug), hired or not. */
  latestFor(worker: string): Interview | undefined {
    return this.list.filter((i) => i.worker === worker).pop();
  }

  /** A worker's skill.md or memory.md replaced by the person (the manager's computer, 👥 اعضای تیم). False without a profile. */
  saveFile(worker: string, name: 'skill.md' | 'memory.md', body: string): boolean {
    const i = this.latestFor(worker);
    if (!i || !this.peopleDir) return false;
    this.write(i.slug, name, body.slice(0, FILE_MAX));
    return this.fileFor(i, name) !== undefined;
  }

  private write(slug: string, name: 'skill.md' | 'memory.md', body: string) {
    if (!this.peopleDir) return;
    noteOwnWrite(slug, name);
    try {
      const dir = path.join(this.peopleDir, slug);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, name), `${body.trim()}\n`, 'utf8');
    } catch {
      // The interview still goes on; only the file is behind.
    }
  }

  /** A hired worker's interview begins: its profile gets what the person wrote. */
  start(input: { worker: string; name: string; role: string; desk: string; skill: string; team?: string; isManager?: boolean }): Interview {
    const name = text(input.name, 60);
    const role = text(input.role, 120);
    const skill = text(input.skill, 3000);
    const slug = slugOf(name, (s) => this.list.some((i) => i.slug === s));
    const now = Date.now();
    const i: Interview = { id: `I-${this.next++}`, worker: input.worker, name, role, desk: input.desk, slug, status: 'talking', skill, messages: [], startedAt: now, updatedAt: now, ...(input.team ? { team: input.team } : {}), ...(input.isManager ? { isManager: true } : {}) };
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

  /** What the team's manager says about the interview or the candidate: seen in the chat, not sent to the candidate. */
  managerSay(id: string, who: string, body: unknown): Result<{ interview: Interview }> {
    const i = this.get(id);
    if (!i || (i.status !== 'talking' && i.status !== 'review')) return fail('این مصاحبه باز نیست');
    const said = text(body, TEXT_MAX);
    if (!said) return fail('چیزی بنویس');
    this.push(i, 'manager', said, who);
    return { ok: true, interview: i };
  }

  /** What the person says. */
  bossSay(id: string, body: unknown): Result<{ interview: Interview; notices: Notice[] }> {
    const i = this.get(id);
    if (!i || (i.status !== 'talking' && i.status !== 'review')) return fail('این مصاحبه باز نیست');
    const said = text(body, TEXT_MAX);
    if (!said) return fail('چیزی بنویسید');
    this.push(i, 'boss', said);
    i.status = 'talking';
    const next = i.kind === 'review'
      ? `سؤال یا نظر مدیرعامل در مصاحبه‌ی بازبینی:\n${said}\n\nبا interview_say جواب بده؛ جوابت را با شاهد (فایل، کار، خروجی) بگو و حدس را «حدس» بنام. وقتی همه‌ی محورها جواب داده شد، interview_finish را با پیشنهاد تغییراتت صدا بزن.`
      : `پاسخ مدیرعامل در مصاحبه:\n${said}\n\nبا interview_say جواب بده و سؤال بعدی‌ات را بپرس (یکی‌یکی). وقتی همه‌چیز را فهمیدی، نظر و دسترسی‌هایت را بگو و interview_finish را صدا بزن.`;
    return { ok: true, interview: i, notices: [{ to: i.worker, text: next }] };
  }

  /** The agent is done: its refined skill, what it learned, and the access it has and needs. */
  finish(worker: string, input: { summary?: unknown; skill?: unknown; memory?: unknown; access?: unknown; changes?: unknown }): Result<{ interview: Interview }> {
    const i = this.open(worker);
    if (!i) return fail('مصاحبه‌ای برای تو باز نیست');
    const skill = text(input.skill, FILE_MAX);
    const memory = text(input.memory, FILE_MAX);
    if (!skill || !memory) return fail('skill و memory را کامل بنویس (markdown)');
    i.summary = text(input.summary, 2000) || undefined;
    i.access = text(input.access, 3000) || undefined;
    if (i.kind === 'review') {
      // Nothing is written yet: the person sees what would change and decides.
      const changes = text(input.changes, 4000);
      if (!changes) return fail('changes را بنویس: هر تغییر (اضافه، تغییر یا حذف)، دلیلش و شاهدش؛ اگر تغییری لازم نیست بنویس «بدون تغییر» و دلیلش');
      i.proposal = { skill, memory, changes };
      i.status = 'review';
      this.push(i, 'agent', `مصاحبه‌ی بازبینی را تمام کردم.${i.summary ? `\n\n${i.summary}` : ''}`);
      return { ok: true, interview: i };
    }
    this.write(i.slug, 'skill.md', skill);
    this.write(i.slug, 'memory.md', memory);
    i.status = 'review';
    this.push(i, 'agent', `مصاحبه را تمام کردم.${i.summary ? `\n\n${i.summary}` : ''}`);
    return { ok: true, interview: i };
  }

  /** The person's decision on a re-interview: the profile becomes what the agent proposed, or stays as it was. */
  settle(id: string, verdict: 'apply' | 'keep'): Result<{ interview: Interview }> {
    const i = this.get(id);
    if (!i || i.kind !== 'review' || (i.status !== 'talking' && i.status !== 'review')) return fail('این بازبینی باز نیست');
    if (verdict === 'apply') {
      if (!i.proposal || i.status !== 'review') return fail('ایجنت هنوز پیشنهادش را ننوشته');
      this.write(i.slug, 'skill.md', i.proposal.skill);
      this.write(i.slug, 'memory.md', i.proposal.memory);
    }
    i.status = verdict === 'apply' ? 'updated' : 'kept';
    i.updatedAt = Date.now();
    this.save();
    return { ok: true, interview: i };
  }

  /** The person's decision: hire, send home, or hire without finishing the interview. */
  decide(id: string, verdict: 'hire' | 'reject' | 'skip'): Result<{ interview: Interview }> {
    const i = this.get(id);
    if (!i || i.kind === 'review' || (i.status !== 'talking' && i.status !== 'review')) return fail('این مصاحبه باز نیست');
    if (verdict === 'hire' && i.status !== 'review') return fail('ایجنت هنوز مصاحبه را تمام نکرده؛ یا منتظرش بمانید یا «رد شدن از مصاحبه» را بزنید');
    i.status = verdict === 'hire' ? 'hired' : verdict === 'reject' ? 'rejected' : 'skipped';
    i.updatedAt = Date.now();
    this.save();
    if (verdict === 'reject') this.discard(i);
    return { ok: true, interview: i };
  }

  private push(i: Interview, by: Talk['by'], body: string, who?: string) {
    i.messages.push({ by, text: body, at: Date.now(), ...(who ? { who } : {}) });
    if (i.messages.length > MAX_MESSAGES) i.messages.splice(0, i.messages.length - MAX_MESSAGES);
    i.updatedAt = Date.now();
    this.save();
  }
}

/** The first message of the new agent: who it is, and how its interview goes. */
export function interviewPrompt(name: string, role: string, skill: string, folder: string, team?: { name: string; manager?: string; isManager: boolean }): string {
  const about = !team ? 'تو مستقل کار می‌کنی و عضو هیچ تیمی نیستی.'
    : team.isManager ? `تو مدیر و هماهنگ‌کننده‌ی تیم «${team.name}» هستی؛ اولین نفر این تیمی و بعد از تو نیروها را مدیرعامل استخدام می‌کند.`
    : `تو عضو تیم «${team.name}» هستی و مدیرت ${team.manager ?? 'مدیر تیم'} است. او هم نظرش را درباره‌ی مصاحبه‌ات می‌دهد.`;
  const manager = team?.isManager
    ? [
      'چون مدیر تیمی، در سؤال‌هایت این‌ها را هم بپرس: هدف تیم، مشتری‌ها و خروجی‌هایی که انتظار دارد، ترتیب کارها و مرحله‌ها، چه چیزی را باید خودش تأیید کند و چه چیزی را خودت. در نظرت هم بگو: برای این تیم به چه نیروهایی نیاز داریم و هر نفر دقیقاً چه کاری می‌کند.',
      'قاعده‌ی مدیر: نیرو استخدام نمی‌کنی؛ فقط با propose_hire پیشنهاد می‌دهی و مدیرعامل تصمیم می‌گیرد. درباره‌ی تیم همیشه واقع‌گرایانه بگو: اگر نیروهای فعلی کافی‌اند صریح بگو کافی است، اگر نه بگو چه چیزی کم است و چرا (با team_advise).',
    ].join('\n')
    : '';
  const company = folder.replace(/\/people\/[^/]+$/, '/company.md');
  return [
    about,
    manager,
    `تو «${name}» هستی، با سمت «${role}» در تیم فریلنسری مدیرعامل (Mohammad / Khat Web). این مصاحبه‌ی اولیه‌ی توست؛ هنوز کار واقعی نداری و تا استخدام نشده‌ای هیچ کاری نکن و به هیچ سایتی نرو (فقط خواندن و افزودن به ${company} و پروفایل خودت مجاز است).`,
    skill ? `شرحی که مدیرعامل برای کار تو نوشته:\n${skill}` : '',
    'قواعد مصاحبه: فقط با ابزار interview_say با مدیرعامل حرف بزن (حرف زدن در ترمینال به او نمی‌رسد). جواب‌های او با پیامی که با «پاسخ مدیرعامل در مصاحبه» شروع می‌شود می‌رسد.',
    `۰) اول فایل ${company} را بخوان: کسب‌وکار مدیرعامل، خدمت‌ها، بازار، رقبا و قوانین همه‌ی تیم آنجاست. آنچه آنجا هست دوباره نپرس؛ اگر خالی یا ناقص بود فقط همان بخش را بپرس.`,
    '۱) بعد در یک پیام کوتاه خودت را معرفی کن: نام، سمت و آنچه فکر می‌کنی کارت است، و در یک خط بگو از کسب‌وکار چه فهمیده‌ای.',
    '۲) بعد سؤال‌هایت را یکی‌یکی بپرس (حدود ۳ تا ۸ سؤال)، فقط درباره‌ی چیزهایی که در فایل کسب‌وکار نیست و به کار خودت مربوط است: نیاز مخصوص کارت، لحن، معیار کیفیت، نمونه‌ی کار خوب، ممنوعات. بعد از هر سؤال صبر کن تا جواب برسد.',
    '۳) بعد از سؤال‌ها نظر خودت را بگو: چه کارهایی را می‌خواهی و می‌توانی انجام بدهی، چه کارهایی را نمی‌توانی یا نباید انجام بدهی، و پیشنهادت برای بهتر شدن کار.',
    '۴) دسترسی‌هایت را روشن بگو: آیا مرورگر داری (ابزارهای browser_* دفتر: بله، یک مرورگر اختصاصی که مدیرعامل زنده می‌بیند؛ ارسال و ورود فقط با تأیید او) و برای کارت به چه سایت‌ها، حساب‌ها، فایل‌ها یا ابزارهایی نیاز داری و کدام‌ها را الان نداری.',
    `۵) اگر در مصاحبه چیز تازه‌ای درباره‌ی کسب‌وکار شنیدی که در ${company} نبود، زیر عنوان «افزوده‌ها» همان فایل با نام خودت و یک خط اضافه کن (فقط اضافه کن، چیزی را پاک یا عوض نکن) تا نفر بعدی دوباره نپرسد. بعد interview_finish را صدا بزن با: summary (خلاصه‌ی ۵ خط)، skill (متن کامل و بهترشده‌ی فایل مهارتت به markdown: سمت، کارهایی که می‌کنی، خروجی هر کار، قواعد و ممنوعات؛ نوشته‌ی مدیرعامل را حفظ کن)، memory (آنچه درباره‌ی مدیرعامل و کار یاد گرفتی، markdown)، access (دسترسی‌هایی که داری و آنهایی که لازم داری).`,
    `پروفایل تو در پوشه‌ی ${folder} است (skill.md و memory.md). در آینده در شروع هر کار آن‌ها را بخوان و بعد از هر کار نکته‌های تازه را به memory.md اضافه کن.`,
    'حالا شروع کن: خودت را معرفی کن.',
  ].filter(Boolean).join('\n\n');
}

/** The rules of a good re-interview, in the words the agent is given (and the person reads in docs/features.md). */
export const REVIEW_RULES = [
  'مصاحبه با خودِ ایجنت است و درباره‌ی کار واقعی خودش؛ نه گفتگو با مدیرعامل درباره‌ی کسب‌وکار. آنچه در company.md هست از مدیرعامل نپرس.',
  'هر ادعا شاهد دارد: فایل، شماره‌ی کار، خروجی یا اشتباه ثبت‌شده. ادعای بی‌شاهد را «حدس» بنام.',
  'اول پروفایل فعلی‌ات را بخوان و با کار واقعی مقایسه کن (list_tasks، خروجی‌ها، mistakes.md، ارزیابی‌ها). چیزی که نمی‌دانی یا یادت نیست را نساز.',
  '«بدون تغییر» جواب معتبری است. فقط آنچه شاهد دارد عوض شود؛ متن مدیرعامل و بخش‌های درست حفظ می‌شود و هیچ‌چیز بی‌صدا پاک نمی‌شود.',
  'اختیار بیشتر (دسترسی تازه، کار بدون تأیید) را فقط با برچسب «افزایش اختیار» و دلیل پیشنهاد بده. policy.md و قوانین ثابت را سست نکن و پروفایل دیگران را دست نزن.',
  'در این مصاحبه skill.md و memory.md را خودت ننویس: پیشنهادت را با interview_finish بده و فقط با تأیید مدیرعامل نوشته می‌شود. تا پایان مصاحبه کار تازه‌ای نگیر.',
];

/** What a re-interview covers: the agent answers each in turn, from evidence. */
export const REVIEW_TOPICS = [
  'فلو کار: ورودی هر کارت چیست، مرحله‌هایش چیست و خروجی‌اش را کجا و به چه کسی تحویل می‌دهی؟ کدام مرحله با کدام ابزار است؟',
  'بایدها: چه کارهایی را همیشه انجام می‌دهی (قاعده‌های خودت)؟',
  'نبایدها: چه کارهایی را هرگز نمی‌کنی و چرا؟ هر مورد از policy.md یا قوانین ثابت می‌آید یا قاعده‌ی خودت است؟',
  'تأیید: کدام کارهایت فقط با تأیید مدیرعامل (یا مدیر تیم) انجام می‌شود؟',
  'دسترسی‌ها: چه داری، چه لازم داری و چه نداری، و کدام ورود یا دسترسی قطع یا ناپایدار بوده؟',
  'پروفایل فعلی: کدام بخش skill.md و memory.md قدیمی، ناقص یا مخالف کار واقعی است؟ برای هر مورد شاهد بیاور.',
  'اشتباه‌ها: از مصاحبه‌ی قبلی چه اشتباهی کرده‌ای و چه قاعده‌ای از آن درآمده؟ قاعده‌ای لازم است که هنوز ننوشته‌ای؟',
  'پیشنهاد: چه چیزی (آموزش، ابزار، تقسیم کار) کارت را بهتر می‌کند؟ به ترتیب اولویت.',
];

/** The message that starts a re-interview in an agent already at work. */
export function reviewPrompt(name: string, role: string, folder: string, team?: { name: string; manager?: string; isManager: boolean }): string {
  const about = !team ? 'تو مستقل کار می‌کنی.' : team.isManager ? `تو مدیر تیم «${team.name}» هستی.` : `تو عضو تیم «${team.name}» هستی${team.manager ? ` و مدیرت ${team.manager} است` : ''}.`;
  const company = folder.replace(/\/people\/[^/]+$/, '/company.md');
  return [
    `مصاحبه‌ی بازبینی. تو «${name}» هستی، با سمت «${role.split(':')[0]}». ${about} مدیرعامل (Mohammad) می‌خواهد دانش و قواعد کارت را به‌روز کند. این مصاحبه با توست، نه با او: تو درباره‌ی کار خودت جواب می‌دهی.`,
    `قواعد مصاحبه:\n${REVIEW_RULES.map((r, n) => `${n + 1}. ${r}`).join('\n')}`,
    `پیش از هر چیز بخوان: ${folder}/skill.md و memory.md (پروفایل خودت)، ${company}، freelance-team/policy.md، freelance-team/mistakes.md و کارهایی که انجام داده‌ای (list_tasks).`,
    `محورها؛ به ترتیب، هر محور در یک پیام کوتاه با interview_say (حرف زدن در ترمینال به مدیرعامل نمی‌رسد):\n${REVIEW_TOPICS.map((t, n) => `${n + 1}) ${t}`).join('\n')}`,
    'مدیرعامل ممکن است وسط کار سؤال یا اصلاح بفرستد (پیامی که با «سؤال یا نظر مدیرعامل» شروع می‌شود)؛ جواب بده و ادامه بده.',
    'در پایان interview_finish را صدا بزن: summary (خلاصه‌ی ۵ خطی)، changes (فهرست هر تغییر: اضافه، تغییر یا حذف، دلیل و شاهد؛ تغییرِ «افزایش اختیار» را برچسب بزن؛ اگر تغییری لازم نیست بنویس «بدون تغییر» و دلیل)، skill و memory (متن کامل و پیشنهادی هر دو فایل؛ بدون تغییر هم کامل بفرست)، access (دسترسی‌های فعلی و لازم).',
    'حالا شروع کن: محور اول را جواب بده.',
  ].join('\n\n');
}
