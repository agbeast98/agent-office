// The floor's teams: a team is a manager and its members, hired into it (or taken in from those who work alone).
// Those who belong to no team work for themselves. A team's manager tells the person, as an honest view, whether
// the team it has is enough or what it still needs: it proposes (never hires: only the person hires), advises in a
// thread with the person, and comments on the interviews of those who would join. See team-interviews.ts for the
// interview, hooks/office-tasks.ts for the manager's tools and routes/hiring.ts for the window.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface Team {
  id: string;
  name: string;
  /** The manager's worker id. */
  manager: string;
  /** The members' worker ids, the manager not among them. */
  members: string[];
  createdAt: number;
}

export interface Proposal {
  id: string;
  team: string;
  /** hire: a new person with this post; adopt: someone who works alone, taken into the team. */
  kind: 'hire' | 'adopt';
  by: string;
  role: string;
  skill: string;
  why: string;
  /** For adopt: the worker. */
  worker?: string;
  status: 'pending' | 'accepted' | 'dismissed';
  at: number;
}

export interface Advice {
  team: string;
  by: 'boss' | 'manager';
  text: string;
  at: number;
}

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

const MAX_TEAMS = 20;
const MAX_PROPOSALS = 100;
const MAX_ADVICE = 200;
const fail = (error: string) => ({ ok: false as const, error });
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').trim().slice(0, max) : '');

export class Teams {
  teams: Team[] = [];
  proposals: Proposal[] = [];
  advice: Advice[] = [];
  private next = { team: 1, proposal: 1 };
  private file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'team-teams.json');
    this.load();
  }

  private load() {
    if (!existsSync(this.file)) return;
    try {
      const s = JSON.parse(readFileSync(this.file, 'utf8')) as { next?: Teams['next']; teams?: Team[]; proposals?: Proposal[]; advice?: Advice[] };
      this.teams = (Array.isArray(s.teams) ? s.teams : []).filter((t) => !!t && typeof t.id === 'string' && Array.isArray(t.members));
      this.proposals = (Array.isArray(s.proposals) ? s.proposals : []).filter((p) => !!p && typeof p.id === 'string');
      this.advice = Array.isArray(s.advice) ? s.advice.filter((a) => !!a && typeof a.text === 'string') : [];
      const top = (list: { id: string }[]) => Math.max(0, ...list.map((x) => Number(x.id.replace(/\D/g, '')) || 0)) + 1;
      this.next = { team: Math.max(s.next?.team ?? 1, top(this.teams)), proposal: Math.max(s.next?.proposal ?? 1, top(this.proposals)) };
    } catch {
      // A file that can't be read is started over rather than blocking the team.
    }
  }

  private save() {
    const tmp = `${this.file}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ next: this.next, teams: this.teams, proposals: this.proposals, advice: this.advice }, null, 1), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch {
      // Still held in memory until the next save works.
    }
  }

  get(id: string): Team | undefined {
    return this.teams.find((t) => t.id === id);
  }

  /** The team a worker belongs to, as its manager or a member. */
  teamOf(worker: string): Team | undefined {
    return this.teams.find((t) => t.manager === worker || t.members.includes(worker));
  }

  isManager(worker: string): boolean {
    return this.teams.some((t) => t.manager === worker);
  }

  create(name: string, manager: string): Result<{ team: Team }> {
    const n = text(name, 60);
    if (!n) return fail('تیم نام لازم دارد');
    if (this.teams.some((t) => t.name === n)) return fail('تیمی با این نام هست');
    if (this.teams.length >= MAX_TEAMS) return fail('تعداد تیم‌ها به سقف رسیده');
    if (this.teamOf(manager)) return fail('این نفر در تیم دیگری است');
    const team: Team = { id: `T${this.next.team++}`, name: n, manager, members: [], createdAt: Date.now() };
    this.teams.push(team);
    this.save();
    return { ok: true, team };
  }

  /** Takes a worker into a team (out of any other it was in). */
  add(teamId: string, worker: string): Result<{ team: Team }> {
    const team = this.get(teamId);
    if (!team) return fail('چنین تیمی نیست');
    if (team.manager === worker) return fail('او مدیر همین تیم است');
    if (this.isManager(worker)) return fail('او مدیر تیم دیگری است');
    this.leave(worker);
    team.members.push(worker);
    this.save();
    return { ok: true, team };
  }

  /** A team whose manager never joined (its interview was rejected) and that has no members: gone. */
  dropEmpty(manager: string) {
    const before = this.teams.length;
    this.teams = this.teams.filter((t) => !(t.manager === manager && !t.members.length));
    if (this.teams.length !== before) this.save();
  }

  /** Takes a worker out of its team: it works for itself again. */
  leave(worker: string): boolean {
    let changed = false;
    for (const t of this.teams) {
      if (t.members.includes(worker)) {
        t.members = t.members.filter((m) => m !== worker);
        changed = true;
      }
    }
    if (changed) this.save();
    return changed;
  }

  /** A team's manager proposes someone to hire, or someone working alone to take in. */
  propose(manager: string, by: string, input: { kind: 'hire' | 'adopt'; role?: unknown; skill?: unknown; why?: unknown; worker?: string }): Result<{ proposal: Proposal }> {
    const team = this.teams.find((t) => t.manager === manager);
    if (!team) return fail('فقط مدیر یک تیم پیشنهاد می‌دهد');
    const role = text(input.role, 120);
    const why = text(input.why, 1500);
    if (input.kind === 'hire' && !role) return fail('سمت را بنویس');
    if (!why) return fail('دلیل را بنویس');
    if (input.kind === 'adopt' && (!input.worker || this.teamOf(input.worker))) return fail('این نفر در تیمی هست یا پیدا نشد');
    if (this.proposals.filter((p) => p.status === 'pending').length >= MAX_PROPOSALS) return fail('پیشنهادهای بی‌جواب زیادند؛ اول به آن‌ها جواب بدهید');
    const proposal: Proposal = { id: `P-${this.next.proposal++}`, team: team.id, kind: input.kind, by, role, skill: text(input.skill, 3000), why, worker: input.worker, status: 'pending', at: Date.now() };
    this.proposals.push(proposal);
    if (this.proposals.length > MAX_PROPOSALS * 2) this.proposals.splice(0, this.proposals.length - MAX_PROPOSALS * 2);
    this.save();
    return { ok: true, proposal };
  }

  resolve(id: string, verdict: 'accepted' | 'dismissed'): Result<{ proposal: Proposal }> {
    const p = this.proposals.find((x) => x.id === id);
    if (!p || p.status !== 'pending') return fail('این پیشنهاد باز نیست');
    if (verdict === 'accepted' && p.kind === 'adopt') {
      const r = this.add(p.team, p.worker ?? '');
      if (!r.ok) return fail(r.error);
    }
    p.status = verdict;
    this.save();
    return { ok: true, proposal: p };
  }

  say(team: string, by: Advice['by'], body: unknown): Result<{ advice: Advice }> {
    if (!this.get(team)) return fail('چنین تیمی نیست');
    const said = text(body, 4000);
    if (!said) return fail('چیزی بنویس');
    const advice: Advice = { team, by, text: said, at: Date.now() };
    this.advice.push(advice);
    if (this.advice.length > MAX_ADVICE) this.advice.splice(0, this.advice.length - MAX_ADVICE);
    this.save();
    return { ok: true, advice };
  }
}

/** What each person of the floor is, for the team page and for the managers (freelance-team/people/ROSTER.md). */
export function rosterText(teams: Team[], people: { id: string; name: string; role?: string; line?: string; state?: string }[]): string {
  const by = new Map(people.map((p) => [p.id, p]));
  const row = (id: string) => {
    const p = by.get(id);
    if (!p) return undefined;
    const post = (p.role ?? '').split(':')[0].trim() || 'بدون سمت';
    return `- **${p.name}** — ${post}${p.state ? ` (${p.state})` : ''}${p.line ? `\n  ${p.line}` : ''}`;
  };
  const out = ['# فهرست تیم‌ها و افراد', '', 'این فایل را دفتر می‌سازد. هر نفر پروفایلی در freelance-team/people/<نام>/ دارد (skill.md و memory.md).', ''];
  const inTeam = new Set<string>();
  for (const t of teams) {
    const boss = row(t.manager);
    out.push(`## تیم ${t.name}`, '', `مدیر:\n${boss ?? '- (مدیر رفته است)'}`, '', 'اعضا:');
    t.members.forEach((m) => { inTeam.add(m); });
    inTeam.add(t.manager);
    const rows = t.members.map(row).filter(Boolean);
    out.push(...(rows.length ? (rows as string[]) : ['- (هنوز عضوی نیست)']), '');
  }
  const solo = people.filter((p) => !inTeam.has(p.id));
  out.push('## مستقل (در هیچ تیمی نیستند)', '', ...(solo.length ? (solo.map((p) => row(p.id)).filter(Boolean) as string[]) : ['- (کسی نیست)']), '');
  return `${out.join('\n')}\n`;
}
