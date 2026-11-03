// The team's firewall. Agents the person ticks are "guarded": everything they do outside talking (opening a
// site, sending a form, a shell command, fetching a page, touching a file outside their folders) is checked
// against their rules first. What the rules allow goes through; what they forbid is refused; anything else is
// held and the security agent guarding them decides: it may allow it for a while, refuse it, or ask the person.
// The person's own answers are counted, and two the same for one site or command make a rule of their own, so
// it isn't asked again. One security agent guards at most GUARD_MAX agents.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Notice } from './team-tasks.js';

/** open: reading a site in the office's browser; write: sending, logging in or uploading there; web: fetching a page another way; search: a web search; shell: a command; file: a file outside its folders; tool: anything else. */
export type Kind = 'open' | 'write' | 'web' | 'search' | 'shell' | 'file' | 'tool';
export type Verdict = 'allow' | 'deny';

export interface Rules {
  /** May read any site in the office's browser. */
  browse: boolean;
  /** May search the web. */
  search: boolean;
  /** Sites it may send, log in or upload to (and fetch). */
  write: string[];
  /** Sites it may fetch pages from outside the browser. */
  web: string[];
  /** Sites it may never touch. */
  blocked: string[];
  /** Shell commands it may run, by how they start ("git status", "ls"). */
  commands: string[];
  /** Folders it may read and write besides its own. */
  paths: string[];
}

export interface Hold {
  id: string;
  agent: { id: string; name: string };
  kind: Kind;
  /** What it was about: the site, the command's program, the file or the tool. */
  target: string;
  /** The whole of it, for whoever decides (the address, the command line). */
  detail: string;
  at: number;
  /** pending: the security agent is deciding; asked: it handed it to the person. */
  status: 'pending' | 'asked' | 'allowed' | 'denied';
  by?: 'security' | 'you' | 'rule';
  note?: string;
  decidedAt?: number;
}

export interface Learned { key: string; verdict: Verdict; at: number }

interface Saved {
  guards: Record<string, string[]>;
  rules: Record<string, Rules>;
  holds: Hold[];
  permits: { agent: string; key: string; until: number }[];
  votes: Record<string, { allow: number; deny: number }>;
  learned: Learned[];
  seq: number;
}

export type Check = { verdict: 'allow' } | { verdict: 'deny'; reason: string } | { verdict: 'hold'; hold: Hold; fresh: boolean };

export const GUARD_MAX = 5;
const KEEP_HOLDS = 200;
const PERMIT_MINUTES = 60;
const PERMIT_MAX_MINUTES = 8 * 60;
/** How many times the person has to answer the same way before it becomes a rule. */
const LEARN_AFTER = 2;

export const KIND_FA: Record<Kind, string> = { open: 'باز کردن سایت', write: 'ارسال یا ورود در سایت', web: 'دریافت صفحه', search: 'جستجوی وب', shell: 'دستور ترمینال', file: 'فایل بیرون از پوشه‌ها', tool: 'ابزار' };

const empty = (): Rules => ({ browse: true, search: true, write: [], web: [], blocked: [], commands: [], paths: [] });

/** A site as rules name it: its host, lower-case, without www. */
export function hostOf(address: string): string {
  try {
    return new URL(/^[a-z]+:\/\//i.test(address) ? address : `https://${address}`).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return address.trim().toLowerCase().replace(/^www\./, '');
  }
}

/** A site matches a rule's site, or any of its subdomains. */
const onSite = (host: string, site: string) => host === site || host.endsWith(`.${site}`);

/** The program a command line runs (what a learned rule about it is about). */
export function programOf(command: string): string {
  const m = /^\s*(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(command);
  const first = m?.[1] ?? m?.[2] ?? m?.[3] ?? '';
  return (first.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
}

const norm = (p: string) => {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};
const inside = (file: string, root: string) => {
  const rel = path.relative(norm(root), norm(file));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

export class Security {
  private s: Saved = { guards: {}, rules: {}, holds: [], permits: [], votes: {}, learned: [], seq: 0 };
  private file: string;
  /** Where the rules are also written out for people (and git) to read, if anywhere. */
  readonly mirror?: string;

  constructor(dataDir: string, mirror?: string) {
    this.file = path.join(dataDir, 'security.json');
    this.mirror = mirror;
    if (!existsSync(this.file)) return;
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Saved>;
      this.s = { ...this.s, ...saved };
      for (const id of Object.keys(this.s.rules)) this.s.rules[id] = { ...empty(), ...this.s.rules[id] };
    } catch {
      // Started over: nobody is guarded, so nothing is held by mistake.
    }
  }

  private save() {
    const tmp = `${this.file}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(this.s, null, 1), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch {
      // Kept in memory until the next save works.
    }
  }

  get guards(): Record<string, string[]> {
    return this.s.guards;
  }
  get holds(): Hold[] {
    return this.s.holds;
  }
  get learned(): Learned[] {
    return this.s.learned;
  }

  /** The security agent guarding `agentId`, if any. */
  guardOf(agentId: string): string | undefined {
    return Object.keys(this.s.guards).find((g) => this.s.guards[g].includes(agentId));
  }

  rules(agentId: string): Rules {
    return this.s.rules[agentId] ?? empty();
  }

  /** Puts `agentId` under `securityId`'s guard (on), or takes it out (off). */
  guard(securityId: string, agentId: string, on: boolean): string | undefined {
    if (securityId === agentId) return 'A security agent does not guard itself';
    if (on && this.s.guards[agentId]) return 'A security agent is not guarded by another';
    for (const g of Object.keys(this.s.guards)) this.s.guards[g] = this.s.guards[g].filter((x) => x !== agentId);
    if (on) {
      const list = (this.s.guards[securityId] ??= []);
      if (list.length >= GUARD_MAX) return `Each security agent guards at most ${GUARD_MAX}: hire another for more`;
      list.push(agentId);
      this.s.rules[agentId] ??= empty();
    }
    this.save();
    return undefined;
  }

  /** Makes `securityId` a security agent with no one to guard yet, or stops it being one. */
  setGuardian(securityId: string, on: boolean) {
    if (on) this.s.guards[securityId] ??= [];
    else delete this.s.guards[securityId];
    this.save();
  }

  setRules(agentId: string, change: Partial<Record<keyof Rules, unknown>>): Rules {
    const r = { ...this.rules(agentId) };
    const list = (v: unknown, host: boolean) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[\n,]+/) : [])
      .map((x) => String(x).trim()).filter(Boolean).map((x) => (host ? hostOf(x) : x)).slice(0, 100);
    if (change.browse !== undefined) r.browse = change.browse === true;
    if (change.search !== undefined) r.search = change.search === true;
    for (const k of ['write', 'web', 'blocked'] as const) if (change[k] !== undefined) r[k] = [...new Set(list(change[k], true))];
    if (change.commands !== undefined) r.commands = [...new Set(list(change.commands, false))];
    if (change.paths !== undefined) r.paths = [...new Set(list(change.paths, false))];
    this.s.rules[agentId] = r;
    this.save();
    return r;
  }

  /** The key a decision is remembered by. */
  static key(kind: Kind, target: string) {
    return `${kind}:${target}`;
  }

  /**
   * What `agent` wants to do is checked against its rules: allowed, refused, or held for the security agent.
   * `roots` are the folders it works in (its project), which it may always read and write.
   */
  check(agent: { id: string; name: string }, kind: Kind, target: string, detail: string, roots: string[] = []): Check {
    if (!this.guardOf(agent.id)) return { verdict: 'allow' };
    const key = Security.key(kind, target);
    const r = this.rules(agent.id);
    const learned = this.s.learned.find((l) => l.key === key);
    const site = ['open', 'write', 'web'].includes(kind);
    if (learned?.verdict === 'deny') return { verdict: 'deny', reason: `قانون امنیت (از تصمیم‌های قبلی Mohammad): «${target}» برای ${KIND_FA[kind]} ممنوع است. دوباره امتحان نکن.` };
    if (site && r.blocked.some((b) => onSite(target, b))) return { verdict: 'deny', reason: `قانون امنیت: «${target}» در فهرست سایت‌های ممنوع توست. دوباره امتحان نکن.` };
    if (learned?.verdict === 'allow') return { verdict: 'allow' };
    const now = Date.now();
    this.s.permits = this.s.permits.filter((p) => p.until > now);
    if (this.s.permits.some((p) => p.agent === agent.id && p.key === key)) return { verdict: 'allow' };
    if (this.allowedByRules(r, kind, target, detail, roots)) return { verdict: 'allow' };
    const open = this.s.holds.find((h) => h.agent.id === agent.id && Security.key(h.kind, h.target) === key && (h.status === 'pending' || h.status === 'asked'));
    if (open) return { verdict: 'hold', hold: open, fresh: false };
    const hold: Hold = { id: `H-${++this.s.seq}`, agent, kind, target, detail: detail.slice(0, 600), at: now, status: 'pending' };
    this.s.holds.unshift(hold);
    this.s.holds.splice(KEEP_HOLDS);
    this.save();
    return { verdict: 'hold', hold, fresh: true };
  }

  private allowedByRules(r: Rules, kind: Kind, target: string, detail: string, roots: string[]): boolean {
    switch (kind) {
      case 'open':
        return r.browse || r.write.some((w) => onSite(target, w));
      case 'write':
        return r.write.some((w) => onSite(target, w));
      case 'web':
        return [...r.web, ...r.write].some((w) => onSite(target, w));
      case 'search':
        return r.search;
      case 'shell': {
        const line = detail.trim().toLowerCase();
        return r.commands.some((c) => line === c.toLowerCase() || line.startsWith(`${c.toLowerCase()} `));
      }
      case 'file':
        return [...roots, ...r.paths].some((root) => root && inside(target, root));
      default:
        return false;
    }
  }

  /**
   * A decision on a hold. The security agent may allow it (for `minutes`), refuse it, or ask the person;
   * the person allows or refuses, and their answers are counted towards a rule.
   */
  decide(id: string, verdict: Verdict | 'ask', by: 'security' | 'you', note = '', minutes = PERMIT_MINUTES): { ok: true; hold: Hold; notices: Notice[]; learned?: Learned } | { ok: false; error: string } {
    const h = this.s.holds.find((x) => x.id === id);
    if (!h) return { ok: false, error: 'No such hold' };
    if (h.status === 'allowed' || h.status === 'denied') return { ok: false, error: 'Already decided' };
    if (by === 'security' && h.status === 'asked') return { ok: false, error: 'Mohammad is deciding this one' };
    h.note = note.slice(0, 600) || h.note;
    if (verdict === 'ask') {
      if (by === 'you') return { ok: false, error: 'Allow or deny it' };
      h.status = 'asked';
      this.save();
      return { ok: true, hold: h, notices: [] };
    }
    h.status = verdict === 'allow' ? 'allowed' : 'denied';
    h.by = by;
    h.decidedAt = Date.now();
    const key = Security.key(h.kind, h.target);
    if (verdict === 'allow') this.s.permits.push({ agent: h.agent.id, key, until: Date.now() + Math.min(PERMIT_MAX_MINUTES, Math.max(5, minutes)) * 60_000 });
    let learned: Learned | undefined;
    if (by === 'you') {
      const v = (this.s.votes[key] ??= { allow: 0, deny: 0 });
      v[verdict]++;
      v[verdict === 'allow' ? 'deny' : 'allow'] = 0;
      if (v[verdict] >= LEARN_AFTER) {
        learned = { key, verdict, at: Date.now() };
        this.s.learned = [learned, ...this.s.learned.filter((l) => l.key !== key)];
      }
    }
    this.save();
    const told = verdict === 'allow'
      ? `امنیت: ${KIND_FA[h.kind]} «${h.target}» (${h.id}) تأیید شد${h.note ? `: ${h.note}` : ''}. همان کار را دوباره انجام بده.`
      : `امنیت: ${KIND_FA[h.kind]} «${h.target}» (${h.id}) رد شد${h.note ? `: ${h.note}` : ''}. دوباره امتحان نکن؛ اگر کارت بدون آن پیش نمی‌رود، با ask_manager بگو.`;
    return { ok: true, hold: h, notices: [{ to: h.agent.id, text: told }], learned };
  }

  /** Takes back a rule learned from the person's answers. */
  forget(key: string) {
    this.s.learned = this.s.learned.filter((l) => l.key !== key);
    delete this.s.votes[key];
    this.s.permits = this.s.permits.filter((p) => p.key !== key);
    this.save();
  }

  /** The rules written out for people, and for the agents to read. */
  describe(names: (id: string) => string): string {
    const lines = ['# قوانین امنیت', '', 'این فایل را دفتر می‌نویسد؛ قوانین را در «🛡 امنیت» کامپیوتر مدیر عوض کنید.', ''];
    for (const [g, agents] of Object.entries(this.s.guards)) {
      lines.push(`## نگهبان: ${names(g)} (${agents.length} از ${GUARD_MAX})`);
      for (const a of agents) {
        const r = this.rules(a);
        lines.push('', `### ${names(a)}`, `- مرور سایت‌ها (فقط خواندن): ${r.browse ? 'آزاد' : 'با بررسی'}`, `- جستجوی وب: ${r.search ? 'آزاد' : 'با بررسی'}`,
          `- ارسال و ورود فقط در: ${r.write.join('، ') || '—'}`, `- دریافت صفحه از: ${r.web.join('، ') || '—'}`, `- ممنوع: ${r.blocked.join('، ') || '—'}`,
          `- دستورهای ترمینال مجاز: ${r.commands.join('، ') || '—'}`, `- پوشه‌های اضافه: ${r.paths.join('، ') || '—'}`);
      }
      lines.push('');
    }
    if (this.s.learned.length) lines.push('## یادگرفته از تصمیم‌های Mohammad', ...this.s.learned.map((l) => `- ${l.verdict === 'allow' ? 'مجاز' : 'ممنوع'}: ${l.key}`), '');
    return `${lines.join('\n')}\n`;
  }

  /** Writes the rules out beside the project, if there's somewhere to. */
  writeMirror(names: (id: string) => string) {
    if (!this.mirror) return;
    try {
      writeFileSync(this.mirror, this.describe(names), 'utf8');
    } catch {
      // The rules still hold; only the readable copy is behind.
    }
  }
}
