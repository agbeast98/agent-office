// What the استخدام window reads from /api/hiring (see server/http/routes/hiring.ts).
export interface Person { id: string; name: string; role?: string; status: string; provider?: string; interview?: string; interviewedAt?: number }
export interface Desk { id: string; label: string; x: number; z: number; rotY: number; worker?: Person; interview?: string }
export interface Talk { by: 'agent' | 'boss' | 'manager'; who?: string; text: string; at: number }
export interface Interview {
  id: string; worker: string; name: string; role: string; desk: string; slug: string; status: 'talking' | 'review'; skill: string;
  team?: string; isManager?: boolean; messages: Talk[]; summary?: string; access?: string; skillFile?: string; memoryFile?: string;
  /** A re-interview of someone hired: the profile as it was, and what the agent proposes. */
  kind?: 'review'; before?: { skill: string; memory: string }; proposal?: { skill: string; memory: string; changes: string };
}
export interface Proposal { id: string; team: string; kind: 'hire' | 'adopt'; by: string; role: string; skill: string; why: string; worker?: string; workerName?: string; at: number }
export interface Advice { team: string; by: 'boss' | 'manager'; text: string; at: number }
export interface TeamView { id: string; name: string; manager: Person | null; members: Person[]; advice: Advice[]; proposals: Proposal[] }
export interface State { paused: string | null; company: string; desks: Desk[]; interviews: Interview[]; teams: TeamView[]; alone: Person[] }

/** What is typed in the hire form stays while the window redraws. */
export interface Draft { mode: 'solo' | 'team' | 'newteam'; team: string; teamName: string; name: string; role: string; skill: string; provider: string; proposal?: string }

export type Call = (action: string, extra?: Record<string, unknown>) => Promise<boolean>;

/** The engines a hire can run on: the office default, Claude or ChatGPT's Codex. */
export const ENGINES: [string, string][] = [['', 'پیش‌فرض دفتر'], ['claude', 'Claude'], ['codex', 'Codex (ChatGPT)']];
