// A meeting of the people the team already has: the person at the manager's computer (or the manager) names a
// subject and who is to come, each of them says what they think with `meeting_say`, and everything said is
// kept in one place for all of them and for the meeting room's window to show. No one is hired for it (see
// meetings.ts for the office's own meetings, which hire a table of workers). A round is everyone saying their
// piece once; the next round hands each of them what the others said first. Besides what is said, the meeting
// keeps an agenda, the decisions, the notes, the tasks made in it, and when it ends its minutes are written
// down as a file of its own (`meetings/<id>.md`).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Notice } from './team-tasks.js';

export interface MeetingSaid {
  at: number;
  round: number;
  by: string;
  /** The worker's id, or none for the person at the manager's computer. */
  id?: string;
  text: string;
  /** A note the person kept for themselves: no one is told it, and it isn't in what the next round hears. */
  note?: boolean;
  /** Asked of one person: who. */
  to?: { id: string; name: string };
}

/** poll: each says their piece, and the person hands out the next round; debate: they answer each other round after round by themselves; vote: a yes or no question. */
export type MeetingMode = 'poll' | 'debate' | 'vote';
export type Choice = 'yes' | 'no' | 'abstain';

export interface Member { id: string; name: string; joinedAt?: number; arrivedAt?: number }

export interface Vote { id: string; name: string; choice: Choice; reason: string; at: number }

export interface TeamMeeting {
  id: string;
  mode: MeetingMode;
  /** How many rounds a debate runs by itself before the manager is asked to sum it up. */
  rounds: number;
  /** Who writes it up: told when a debate or a vote is over. */
  manager?: { id: string; name: string };
  votes: Vote[];
  /** Set when a vote has been counted. */
  result?: { verdict: 'accepted' | 'rejected' | 'tie'; yes: number; no: number; abstain: number };
  /** A debate that has run its rounds. */
  concluded?: boolean;
  topic: string;
  calledBy: string;
  startedAt: number;
  endedAt?: number;
  round: number;
  /** Who is to come: worker ids and the names they had, when they were called and when they sat down at the table. */
  members: Member[];
  said: MeetingSaid[];
  agenda: { text: string; done: boolean }[];
  decisions: { at: number; by: string; text: string }[];
  /** Ids of the tasks made in this meeting (see team-tasks.ts). */
  tasks: string[];
  /** Members who have been asked something directly and may answer once more this round. */
  asked: string[];
  summary?: string;
  /** Where the minutes were written, once it ended. */
  minutes?: string;
}

const TOPIC_MAX = 400;
const SAID_MAX = 3000;
const ITEM_MAX = 300;
const AGENDA_MAX = 12;
const KEEP_PAST = 15;
const MAX_SAID = 400;
const MAX_ROUNDS = 6;
const MODE_FA: Record<MeetingMode, string> = { poll: 'نظرخواهی', debate: 'بحث بین خودشان', vote: 'رأی‌گیری' };
const CHOICE_FA: Record<Choice, string> = { yes: 'موافق', no: 'مخالف', abstain: 'ممتنع' };
/** The meeting room has this many chairs. */
export const CHAIRS = 5;

const clip = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').trim().slice(0, max) : '');
const fail = (error: string) => ({ ok: false as const, error });

export type MeetingOutcome = { ok: true; meeting: TeamMeeting; notices: Notice[] } | { ok: false; error: string };

const stamp = (at: number) => new Date(at).toLocaleString('fa-IR', { hour12: false });

/** The meeting written out for reading later. */
export function minutesOf(m: TeamMeeting, tasks: { id: string; title: string; status: string; assignee?: string }[] = []): string {
  const lines = [`# ${m.topic}`, '', `- شروع: ${stamp(m.startedAt)}${m.endedAt ? ` · پایان: ${stamp(m.endedAt)}` : ''}`, `- برگزارکننده: ${m.calledBy}`, `- حاضران: ${m.members.map((x) => x.name).join('، ')}`];
  lines.splice(5, 0, `- شیوه: ${MODE_FA[m.mode]}${m.mode === 'debate' ? ` (${m.rounds} دور)` : ''}`);
  if (m.votes.length) lines.push('', '## رأی‌ها', ...m.votes.map((v) => `- ${v.name}: ${CHOICE_FA[v.choice]}${v.reason ? ` — ${v.reason.replace(/\n/g, ' ')}` : ''}`));
  if (m.agenda.length) lines.push('', '## دستور جلسه', ...m.agenda.map((a) => `- [${a.done ? 'x' : ' '}] ${a.text}`));
  if (m.summary) lines.push('', '## جمع‌بندی مدیر', m.summary);
  if (m.decisions.length) lines.push('', '## تصمیم‌ها', ...m.decisions.map((d, i) => `${i + 1}. ${d.text} (${d.by})`));
  if (tasks.length) lines.push('', '## کارهای ساخته‌شده', ...tasks.map((t) => `- ${t.id} · ${t.title} · ${t.status}${t.assignee ? ` · ${t.assignee}` : ''}`));
  lines.push('', '## گفتگو');
  for (const r of [...new Set(m.said.filter((s) => !s.note).map((s) => s.round))].sort((a, b) => a - b)) {
    lines.push('', `### دور ${r}`, ...m.said.filter((s) => s.round === r && !s.note).map((s) => `- **${s.by}${s.to ? ` ← ${s.to.name}` : ''}:** ${s.text.replace(/\n/g, ' ')}`));
  }
  const notes = m.said.filter((s) => s.note);
  if (notes.length) lines.push('', '## یادداشت‌ها', ...notes.map((n) => `- ${n.text.replace(/\n/g, ' ')}`));
  return `${lines.join('\n')}\n`;
}

export class TeamMeetings {
  current?: TeamMeeting;
  past: TeamMeeting[] = [];
  /** What a member is to be told once they have sat down at the table (not kept across a restart: see fill). */
  private waiting = new Map<string, Notice>();
  private file: string;
  private dir: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'team-meetings.json');
    this.dir = path.join(dataDir, 'meetings');
    if (!existsSync(this.file)) return;
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as { current?: TeamMeeting; past?: TeamMeeting[] };
      if (saved.current && typeof saved.current.id === 'string' && !saved.current.endedAt) this.current = fill(saved.current);
      if (Array.isArray(saved.past)) this.past = saved.past.slice(0, KEEP_PAST).map(fill);
    } catch {
      // Started over rather than blocking the team.
    }
  }

  private save() {
    const tmp = `${this.file}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ current: this.current, past: this.past }, null, 1), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch {
      // Held in memory until the next save works.
    }
  }

  find(id: string): TeamMeeting | undefined {
    return this.current?.id === id ? this.current : this.past.find((m) => m.id === id);
  }

  /** The minutes file of a meeting that ended, or what would be written for one still on. */
  minutesFile(id: string): string | undefined {
    const m = this.past.find((x) => x.id === id);
    if (!m?.minutes) return undefined;
    try {
      return readFileSync(m.minutes, 'utf8');
    } catch {
      return undefined;
    }
  }

  /** Calls everyone in `members` to talk about `topic`. One meeting at a time. */
  start(by: string, topic: unknown, members: { id: string; name: string }[], agenda: unknown = '', opts: { mode?: unknown; rounds?: unknown; manager?: { id: string; name: string } } = {}): MeetingOutcome {
    if (this.current) return fail('A meeting is already on: end it first');
    const subject = clip(topic, TOPIC_MAX);
    if (!subject) return fail('Say what the meeting is about');
    if (members.length < 1) return fail('Say who is to come');
    if (members.length > CHAIRS) return fail(`The meeting room has ${CHAIRS} chairs`);
    const items = clip(agenda, AGENDA_MAX * ITEM_MAX).split('\n').map((l) => l.replace(/^[-*•\d.)\s]+/, '').trim()).filter(Boolean).slice(0, AGENDA_MAX);
    const mode: MeetingMode = opts.mode === 'debate' || opts.mode === 'vote' ? opts.mode : 'poll';
    const rounds = mode === 'debate' ? Math.min(MAX_ROUNDS, Math.max(2, Math.floor(Number(opts.rounds)) || 3)) : 1;
    const joinedAt = Date.now();
    const meeting: TeamMeeting = {
      id: `M-${joinedAt.toString(36)}`, mode, rounds, manager: opts.manager, votes: [], topic: subject, calledBy: by, startedAt: joinedAt, round: 1, members: members.map((m) => ({ ...m, joinedAt })), said: [],
      agenda: items.map((text) => ({ text: text.slice(0, ITEM_MAX), done: false })), decisions: [], tasks: [], asked: [],
    };
    this.current = meeting;
    this.save();
    const names = members.map((m) => m.name).join('، ');
    const points = items.length ? ` دستور جلسه: ${items.map((t, i) => `${i + 1}) ${t}`).join(' ')}.` : '';
    const how = mode === 'vote'
      ? 'این یک رأی‌گیری است. با ابزار meeting_vote رأی بده (yes موافق، no مخالف، abstain ممتنع) و در reason دلیلت را در یک تا دو خط بنویس. یک بار؛ بقیه‌ی رأی‌ها را نمی‌بینی.'
      : mode === 'debate'
        ? `این بحث آزاد بین خودتان است و ${rounds} دور دارد. نظر اولیه‌ات را کوتاه و روشن (حداکثر ۱۰ خط) با meeting_say بگو. بعد از هر دور حرف بقیه به تو داده می‌شود و باید مستقیم جواب یکی‌شان را بدهی (در to نام او را بنویس)، موافقت یا مخالفتت را با دلیل بگو و تکرار نکن.`
        : 'نظر و پیشنهادت را کوتاه و روشن (حداکثر ۱۰ خط) با ابزار meeting_say ثبت کن، یک بار.';
    const notices = members.map((m) => ({
      to: m.id,
      text: `جلسه‌ی تیمی (${MODE_FA[mode]}، دور ۱). موضوع: «${subject}».${points} شرکت‌کنندگان: ${names}. ${how} بقیه‌ی گفته‌ها را با meeting_read می‌بینی. در جلسه کاری انجام نده.`,
    }));
    return { ok: true, meeting, notices };
  }

  /** What a member says; the person at the manager's computer says things too (no id). */
  say(by: { id?: string; name: string }, text: unknown, to?: unknown): MeetingOutcome {
    const m = this.current;
    if (!m) return fail('No meeting is on');
    if (by.id && !m.members.some((x) => x.id === by.id)) return fail('You are not in this meeting');
    const said = clip(text, SAID_MAX);
    if (!said) return fail('Say something');
    const answering = !!by.id && m.asked.includes(by.id);
    if (m.mode === 'vote' && by.id && !answering) return fail('This meeting is a vote: use meeting_vote');
    if (by.id && !answering && m.said.some((s) => s.id === by.id && s.round === m.round && !s.note)) return fail('You have already spoken this round: wait for the next one');
    if (answering) m.asked = m.asked.filter((x) => x !== by.id);
    // What the person says to the room may be answered by each of them, once, even in a round they have spoken in.
    if (!by.id) m.asked = m.members.map((x) => x.id);
    const key = typeof to === 'string' ? to.trim() : '';
    const target = key ? m.members.find((x) => x.id !== by.id && (x.name === key || x.id === key)) : undefined;
    this.push(m, { at: Date.now(), round: m.round, by: by.name, id: by.id, text: said, ...(target ? { to: { id: target.id, name: target.name } } : {}) });
    const notices: Notice[] = target ? [{ to: target.id, text: `در جلسه‌ی «${m.topic}» ${by.name} خطاب به تو گفت: ${said}` }] : [];
    return { ok: true, meeting: m, notices: by.id && m.mode === 'debate' ? [...notices, ...this.advance(m)] : notices };
  }

  /** In a debate, once everyone has spoken the next round begins by itself, until the rounds are used up and the manager is asked to sum it up. */
  private advance(m: TeamMeeting): Notice[] {
    if (m.concluded || !m.members.every((x) => m.said.some((s) => s.id === x.id && s.round === m.round && !s.note))) return [];
    if (m.round < m.rounds) {
      const next = this.nextRound();
      return next.ok ? next.notices : [];
    }
    m.concluded = true;
    this.save();
    const wrap = this.summarise(m.manager);
    return wrap.ok ? wrap.notices : [];
  }

  /** A member's vote (changing it is allowed until the vote is counted); it is counted by itself once all have voted. */
  vote(by: { id: string; name: string }, choice: unknown, reason: unknown): MeetingOutcome {
    const m = this.current;
    if (!m) return fail('No meeting is on');
    if (m.mode !== 'vote') return fail('This meeting is not a vote');
    if (!m.members.some((x) => x.id === by.id)) return fail('You are not in this meeting');
    if (m.result) return fail('The vote is closed');
    if (choice !== 'yes' && choice !== 'no' && choice !== 'abstain') return fail('choice is yes, no or abstain');
    m.votes = m.votes.filter((v) => v.id !== by.id);
    m.votes.push({ id: by.id, name: by.name, choice, reason: clip(reason, ITEM_MAX), at: Date.now() });
    this.save();
    return m.votes.length >= m.members.length ? this.closeVote() : { ok: true, meeting: m, notices: [] };
  }

  /** Counts the votes so far (the person can do it before all are in); the outcome is kept as a decision. */
  closeVote(): MeetingOutcome {
    const m = this.current;
    if (!m) return fail('No meeting is on');
    if (m.mode !== 'vote') return fail('This meeting is not a vote');
    if (m.result) return fail('The vote is closed');
    if (!m.votes.length) return fail('No one has voted yet');
    const count = (c: Choice) => m.votes.filter((v) => v.choice === c).length;
    const [yes, no, abstain] = [count('yes'), count('no'), count('abstain')];
    m.result = { verdict: yes > no ? 'accepted' : no > yes ? 'rejected' : 'tie', yes, no, abstain };
    const word = { accepted: 'تصویب شد', rejected: 'رد شد', tie: 'مساوی شد' }[m.result.verdict];
    m.decisions.push({ at: Date.now(), by: 'رأی‌گیری', text: `«${m.topic}» ${word} (${yes} موافق، ${no} مخالف، ${abstain} ممتنع)` });
    this.save();
    const wrap = this.summarise(m.manager);
    return { ok: true, meeting: m, notices: wrap.ok ? wrap.notices : [] };
  }

  private push(m: TeamMeeting, s: MeetingSaid) {
    m.said.push(s);
    if (m.said.length > MAX_SAID) m.said.splice(0, m.said.length - MAX_SAID);
    this.save();
  }

  /** Keeps what each is to be told until they have sat down (see arrived), or the fallback says to tell them anyway. */
  hold(notices: Notice[]) {
    for (const n of notices) this.waiting.set(n.to, n);
  }

  /** What was kept for `id` (or for everyone), now to be told. */
  release(id?: string): Notice[] {
    const out = [...this.waiting].filter(([to]) => !id || to === id).map(([, n]) => n);
    for (const n of out) this.waiting.delete(n.to);
    return out;
  }

  /** `id` has sat down at the table: they are told what the meeting is about. */
  arrived(id: string): Notice[] {
    const x = this.current?.members.find((m) => m.id === id);
    if (!x || x.arrivedAt) return [];
    x.arrivedAt = Date.now();
    this.save();
    return this.release(id);
  }

  /** Whoever hasn't been reported sitting by now (nobody is watching the 3D view, or they can't be seated) is counted as there. */
  arriveAll(): Notice[] {
    const m = this.current;
    if (!m) return [];
    const at = Date.now();
    for (const x of m.members) x.arrivedAt ??= at;
    this.save();
    return this.release();
  }

  /** The person asks one member something directly; that member may answer even if they spoke this round. */
  ask(by: string, to: string, text: unknown): MeetingOutcome {
    const m = this.current;
    if (!m) return fail('No meeting is on');
    const who = m.members.find((x) => x.id === to);
    if (!who) return fail('They are not in this meeting');
    const asked = clip(text, SAID_MAX);
    if (!asked) return fail('Say what to ask');
    if (!m.asked.includes(who.id)) m.asked.push(who.id);
    this.push(m, { at: Date.now(), round: m.round, by, text: asked, to: { id: who.id, name: who.name } });
    return { ok: true, meeting: m, notices: [{ to: who.id, text: `در جلسه‌ی «${m.topic}» ${by} مستقیم از تو پرسید: ${asked}\nکوتاه (حداکثر ۱۰ خط) با meeting_say جواب بده.` }] };
  }

  /** A note for the person's own record: nobody is told it. */
  note(by: string, text: unknown): MeetingOutcome {
    const m = this.current;
    if (!m) return fail('No meeting is on');
    const t = clip(text, SAID_MAX);
    if (!t) return fail('Write the note');
    this.push(m, { at: Date.now(), round: m.round, by, text: t, note: true });
    return { ok: true, meeting: m, notices: [] };
  }

  /** The next round: each member is given what the others said and asked to answer it. */
  nextRound(): MeetingOutcome {
    const m = this.current;
    if (!m) return fail('No meeting is on');
    const heard = m.said.filter((s) => s.round === m.round && !s.note);
    const digest = heard.map((s) => `• ${s.by}${s.to ? ` ← ${s.to.name}` : ''}: ${s.text}`).join('\n');
    m.round++;
    m.asked = [];
    this.save();
    const rounds = m.mode === 'debate' ? ` از ${m.rounds}` : '';
    const notices = m.members.map((x) => ({
      to: x.id,
      text: `جلسه‌ی تیمی، دور ${m.round}${rounds}. موضوع: «${m.topic}». نظرهای دور قبل:\n${digest || '(کسی چیزی نگفت)'}\nبا توجه به آن‌ها، موافقت یا اعتراض یا پیشنهاد اصلاحی‌ات را کوتاه با meeting_say بگو${m.mode === 'debate' ? ' و در to نام کسی را که جوابش را می‌دهی بنویس' : ''}. تکرار نکن.`,
    }));
    return { ok: true, meeting: m, notices };
  }

  /** Someone joins the meeting (a chair is free), and is told what it is about and what has been said. */
  invite(member: { id: string; name: string }): MeetingOutcome {
    const m = this.current;
    if (!m) return fail('No meeting is on');
    if (m.members.some((x) => x.id === member.id)) return fail('They are already in the meeting');
    if (m.members.length >= CHAIRS) return fail(`The meeting room has ${CHAIRS} chairs`);
    m.members.push({ ...member, joinedAt: Date.now() });
    this.save();
    const heard = m.said.filter((s) => !s.note).slice(-8).map((s) => `• ${s.by}: ${s.text}`).join('\n');
    return { ok: true, meeting: m, notices: [{ to: member.id, text: `به جلسه‌ی تیمی دعوت شدی (دور ${m.round}). موضوع: «${m.topic}».${heard ? `\nتا الان گفته‌اند:\n${heard}` : ''}\nنظرت را کوتاه با meeting_say بگو.` }] };
  }

  /** Someone is let go from the meeting early. */
  dismiss(id: string): MeetingOutcome {
    const m = this.current;
    if (!m) return fail('No meeting is on');
    if (!m.members.some((x) => x.id === id)) return fail('They are not in this meeting');
    if (m.members.length < 2) return fail('End the meeting instead: no one else is in it');
    m.members = m.members.filter((x) => x.id !== id);
    m.asked = m.asked.filter((x) => x !== id);
    this.save();
    return { ok: true, meeting: m, notices: [] };
  }

  agendaItem(change: { add?: unknown; toggle?: unknown }): MeetingOutcome {
    const m = this.current;
    if (!m) return fail('No meeting is on');
    if (change.add !== undefined) {
      const text = clip(change.add, ITEM_MAX);
      if (!text) return fail('Write the point');
      if (m.agenda.length >= AGENDA_MAX) return fail('The agenda is full');
      m.agenda.push({ text, done: false });
    } else if (typeof change.toggle === 'number' && m.agenda[change.toggle]) {
      m.agenda[change.toggle].done = !m.agenda[change.toggle].done;
    } else {
      return fail('Nothing to change');
    }
    this.save();
    return { ok: true, meeting: m, notices: [] };
  }

  decide(by: string, text: unknown): MeetingOutcome {
    const m = this.current;
    if (!m) return fail('No meeting is on');
    const t = clip(text, ITEM_MAX * 2);
    if (!t) return fail('Say what was decided');
    m.decisions.push({ at: Date.now(), by, text: t });
    this.save();
    return { ok: true, meeting: m, notices: [] };
  }

  /** A task made in this meeting is kept with it. */
  linkTask(id: string) {
    const m = this.current;
    if (!m || m.tasks.includes(id)) return;
    m.tasks.push(id);
    this.save();
  }

  /** Asks the manager to write the outcome down; `summary` is then kept with the meeting. */
  summarise(manager?: { id: string; name: string }): MeetingOutcome {
    const m = this.current;
    if (!m) return fail('No meeting is on');
    if (!manager) return fail('There is no manager to write it up');
    const all = [...m.said.filter((s) => !s.note).map((s) => `• (دور ${s.round}) ${s.by}${s.to ? ` ← ${s.to.name}` : ''}: ${s.text}`), ...m.votes.map((v) => `• رأی ${v.name}: ${CHOICE_FA[v.choice]}${v.reason ? ` — ${v.reason}` : ''}`)].join('\n');
    return { ok: true, meeting: m, notices: [{ to: manager.id, text: `جلسه‌ی «${m.topic}» تمام شد. گفته‌ها:\n${all || '(چیزی گفته نشد)'}\nهر تصمیم را جداگانه با meeting_decision ثبت کن، نتیجه را در چند خط با meeting_summary بنویس، و برای هر کار لازم با create_task کار بساز.` }] };
  }

  setSummary(text: unknown): MeetingOutcome {
    const m = this.current;
    if (!m) return fail('No meeting is on');
    const s = clip(text, SAID_MAX * 2);
    if (!s) return fail('Say what came of it');
    m.summary = s;
    this.save();
    return { ok: true, meeting: m, notices: [] };
  }

  /** Ends the meeting and writes its minutes; `tasks` are those it made, for the minutes. */
  end(tasks: { id: string; title: string; status: string; assignee?: string }[] = []): MeetingOutcome {
    const m = this.current;
    if (!m) return fail('No meeting is on');
    m.endedAt = Date.now();
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      m.minutes = path.join(this.dir, `${m.id}.md`);
      writeFileSync(m.minutes, minutesOf(m, tasks), { mode: 0o600 });
    } catch {
      m.minutes = undefined;
    }
    this.past.unshift(m);
    this.past.splice(KEEP_PAST);
    this.current = undefined;
    this.save();
    return { ok: true, meeting: m, notices: [] };
  }
}

/** A meeting saved before agendas, decisions and tasks existed gets them empty. */
function fill(m: TeamMeeting): TeamMeeting {
  const now = Date.now();
  return { ...m, members: m.members.map((x) => ({ ...x, joinedAt: x.joinedAt ?? m.startedAt, arrivedAt: x.arrivedAt ?? now })), mode: m.mode ?? 'poll', rounds: m.rounds ?? 1, votes: m.votes ?? [], agenda: m.agenda ?? [], decisions: m.decisions ?? [], tasks: m.tasks ?? [], asked: m.asked ?? [] };
}
