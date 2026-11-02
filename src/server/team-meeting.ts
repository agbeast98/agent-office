// A meeting of the people the team already has: the person at the manager's computer (or the manager) names a
// subject and who is to come, each of them says what they think with `meeting_say`, and everything said is
// kept in one place for all of them and for the window to show. No one is hired for it (see meetings.ts for
// the office's own meetings, which hire a table of workers). A round is everyone saying their piece once;
// the next round hands each of them what the others said first.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Notice } from './team-tasks.js';

export interface MeetingSaid {
  at: number;
  round: number;
  by: string;
  /** The worker's id, or none for the person at the manager's computer. */
  id?: string;
  text: string;
}

export interface TeamMeeting {
  id: string;
  topic: string;
  calledBy: string;
  startedAt: number;
  endedAt?: number;
  round: number;
  /** Who is to come: worker ids and the names they had. */
  members: { id: string; name: string }[];
  said: MeetingSaid[];
  summary?: string;
}

const TOPIC_MAX = 400;
const SAID_MAX = 3000;
const KEEP_PAST = 15;
const MAX_SAID = 400;

const clip = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\r\n?/g, '\n').trim().slice(0, max) : '');
const fail = (error: string) => ({ ok: false as const, error });

export type MeetingOutcome = { ok: true; meeting: TeamMeeting; notices: Notice[] } | { ok: false; error: string };

export class TeamMeetings {
  current?: TeamMeeting;
  past: TeamMeeting[] = [];
  private file: string;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'team-meetings.json');
    if (!existsSync(this.file)) return;
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8')) as { current?: TeamMeeting; past?: TeamMeeting[] };
      if (saved.current && typeof saved.current.id === 'string' && !saved.current.endedAt) this.current = saved.current;
      if (Array.isArray(saved.past)) this.past = saved.past.slice(0, KEEP_PAST);
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

  /** Calls everyone in `members` to talk about `topic`. One meeting at a time. */
  start(by: string, topic: unknown, members: { id: string; name: string }[]): MeetingOutcome {
    if (this.current) return fail('A meeting is already on: end it first');
    const subject = clip(topic, TOPIC_MAX);
    if (!subject) return fail('Say what the meeting is about');
    if (members.length < 1) return fail('Say who is to come');
    const meeting: TeamMeeting = { id: `M-${Date.now().toString(36)}`, topic: subject, calledBy: by, startedAt: Date.now(), round: 1, members, said: [] };
    this.current = meeting;
    this.save();
    const names = members.map((m) => m.name).join('، ');
    const notices = members.map((m) => ({
      to: m.id,
      text: `جلسه‌ی تیمی (دور ۱). موضوع: «${subject}». شرکت‌کنندگان: ${names}. نظر و پیشنهادت را کوتاه و روشن (حداکثر ۱۰ خط) با ابزار meeting_say ثبت کن، یک بار. بقیه‌ی گفته‌ها را با meeting_read می‌بینی. در جلسه کاری انجام نده، فقط نظر بده.`,
    }));
    return { ok: true, meeting, notices };
  }

  /** What a member says; the person at the manager's computer says things too (no id). */
  say(by: { id?: string; name: string }, text: unknown): MeetingOutcome {
    const m = this.current;
    if (!m) return fail('No meeting is on');
    if (by.id && !m.members.some((x) => x.id === by.id)) return fail('You are not in this meeting');
    const said = clip(text, SAID_MAX);
    if (!said) return fail('Say something');
    if (by.id && m.said.some((s) => s.id === by.id && s.round === m.round)) return fail('You have already spoken this round: wait for the next one');
    m.said.push({ at: Date.now(), round: m.round, by: by.name, id: by.id, text: said });
    if (m.said.length > MAX_SAID) m.said.splice(0, m.said.length - MAX_SAID);
    this.save();
    return { ok: true, meeting: m, notices: [] };
  }

  /** The next round: each member is given what the others said and asked to answer it. */
  nextRound(): MeetingOutcome {
    const m = this.current;
    if (!m) return fail('No meeting is on');
    const heard = m.said.filter((s) => s.round === m.round);
    const digest = heard.map((s) => `• ${s.by}: ${s.text}`).join('\n');
    m.round++;
    this.save();
    const notices = m.members.map((x) => ({
      to: x.id,
      text: `جلسه‌ی تیمی، دور ${m.round}. موضوع: «${m.topic}». نظرهای دور قبل:\n${digest || '(کسی چیزی نگفت)'}\nبا توجه به آن‌ها، موافقت یا اعتراض یا پیشنهاد اصلاحی‌ات را کوتاه با meeting_say بگو. تکرار نکن.`,
    }));
    return { ok: true, meeting: m, notices };
  }

  /** Asks the manager to write the outcome down; `summary` is then kept with the meeting. */
  summarise(manager?: { id: string; name: string }): MeetingOutcome {
    const m = this.current;
    if (!m) return fail('No meeting is on');
    if (!manager) return fail('There is no manager to write it up');
    const all = m.said.map((s) => `• (دور ${s.round}) ${s.by}: ${s.text}`).join('\n');
    return { ok: true, meeting: m, notices: [{ to: manager.id, text: `جلسه‌ی «${m.topic}» تمام شد. گفته‌ها:\n${all || '(چیزی گفته نشد)'}\nنتیجه را در چند خط تصمیم‌ها و کارهای بعدی بنویس و با meeting_summary ثبت کن؛ برای هر کار لازم با create_task کار بساز.` }] };
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

  end(): MeetingOutcome {
    const m = this.current;
    if (!m) return fail('No meeting is on');
    m.endedAt = Date.now();
    this.past.unshift(m);
    this.past.splice(KEEP_PAST);
    this.current = undefined;
    this.save();
    return { ok: true, meeting: m, notices: [] };
  }
}
