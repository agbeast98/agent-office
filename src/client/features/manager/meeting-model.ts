// What the meeting room's window reads from the server (see server/http/routes/team-meeting.ts) and does with it.

export interface Person { id: string; name: string; role?: string; color?: string; status: string; activity?: string; inMeeting: boolean; seated: boolean }
export type Mode = 'poll' | 'debate' | 'vote';
export interface Vote { id: string; name: string; choice: 'yes' | 'no' | 'abstain'; reason: string; at: number }
export interface Said { at: number; round: number; by: string; id?: string; text: string; note?: boolean; to?: { id: string; name: string } }
export interface TaskRow { id: string; title: string; status: string; priority: string; assignee?: string; assigneeId?: string }
export interface Full {
  id: string;
  topic: string;
  calledBy: string;
  startedAt: number;
  endedAt?: number;
  round: number;
  mode: Mode;
  rounds: number;
  votes: Vote[];
  result?: { verdict: 'accepted' | 'rejected' | 'tie'; yes: number; no: number; abstain: number };
  concluded?: boolean;
  members: { id: string; name: string }[];
  said: Said[];
  agenda: { text: string; done: boolean }[];
  decisions: { at: number; by: string; text: string }[];
  tasks: string[];
  asked: string[];
  summary?: string;
  minutes?: string;
  taskList: TaskRow[];
}
export interface PastRow { id: string; topic: string; startedAt: number; endedAt?: number; summary?: string; said: number; decisions: number; tasks: number; members: string[] }
export interface State { manager?: string; people: Person[]; current?: Full; past: PastRow[]; detail?: Full }

/** Sends an action to the meeting; resolves to whether it worked (the error is shown by whoever sent it). */
export type Act = (action: string, extra?: Record<string, unknown>) => Promise<boolean>;

export const CHAIRS = 5;
export const MODES: { id: Mode; icon: string; title: string; text: string }[] = [
  { id: 'poll', icon: '💬', title: 'نظرخواهی', text: 'هر نفر نظرش را می‌گوید؛ شما دور بعد را می‌دهید.' },
  { id: 'debate', icon: '🗣', title: 'بحث بین خودشان', text: 'به حرف هم جواب می‌دهند؛ دورها خودکار می‌گذرد.' },
  { id: 'vote', icon: '🗳', title: 'رأی‌گیری', text: 'یک سؤال بله/نه؛ هر نفر رأی و دلیلش را می‌گوید.' },
];
export const MODE_FA: Record<Mode, string> = { poll: 'نظرخواهی', debate: 'بحث بین خودشان', vote: 'رأی‌گیری' };
export const CHOICE_FA = { yes: 'موافق', no: 'مخالف', abstain: 'ممتنع' } as const;
export const STATUS_FA: Record<string, string> = { todo: 'انجام‌نشده', doing: 'در حال انجام', review: 'بازبینی', blocked: 'گیرکرده', done: 'تمام‌شده', cancelled: 'لغوشده' };

export const clock = (at: number) => new Date(at).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
export const day = (at: number) => new Date(at).toLocaleDateString('fa-IR', { month: 'long', day: 'numeric' });

/** What a person is doing right now, in a word. */
export function doing(p: Person | undefined, spoke: boolean): { text: string; cls: string } {
  if (!p) return { text: 'نیست', cls: 'off' };
  if (p.status === 'working') return { text: 'در حال نوشتن…', cls: 'work' };
  if (p.status === 'needs_input') return { text: 'منتظر شماست', cls: 'wait' };
  return spoke ? { text: 'گفت ✓', cls: 'done' } : { text: 'منتظر نوبت', cls: 'idle' };
}
