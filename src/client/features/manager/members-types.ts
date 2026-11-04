import type { AgentProvider } from '../../../shared/protocol';
import { store } from '../../state';
import { engineLabel } from '../../ui/provider';
import { h } from '../../ui/dom';
import type { Call } from './extras';

// What the 👥 اعضای تیم page reads from /api/members (see server/http/routes/members.ts), and the small
// pieces its cards and its member window share.

export interface Member {
  id: string;
  name: string;
  role?: string;
  status: string;
  activity?: string;
  provider?: AgentProvider;
  model?: string;
  /** The model its session says it runs on. */
  runsOn?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  desk: string;
  since: number;
  team?: { id: string; name: string; manager: boolean };
  boss: boolean;
  slug?: string;
  interview?: string;
  usage?: { cost: number; costKnown?: boolean; input: number; output: number; calls: number };
  counts: { todo: number; doing: number; review: number; blocked: number; done: number };
  tasks: { id: string; title: string; status: string; updatedAt: number }[];
}

/** What the page gives the member window: the team window's own `call` and a way to redraw the list. */
export interface MemberCtx { floor: string; call: Call; changed: () => void }

export const STATUS_FA: Record<string, string> = { working: 'در حال کار', idle: 'آماده', done: 'کارش تمام شد', needs_input: 'منتظر شماست', starting: 'در حال شروع', error: 'خطا' };
export const TASK_FA: Record<string, string> = { todo: 'انجام‌نشده', doing: 'در حال انجام', review: 'بازبینی', blocked: 'گیرکرده', done: 'تمام‌شده', cancelled: 'لغوشده' };

/** The job title without the reminder that follows it ("تصویرساز مقاله: پروفایل تو در…"). */
export const roleShort = (m: Pick<Member, 'role'>) => (m.role ?? '').split(':')[0].trim();

export const engineText = (m: Member) => engineLabel({ provider: m.provider, model: m.model, effort: m.effort, usage: m.runsOn ? ({ model: m.runsOn } as never) : undefined }, store.project);

/** "claude" or "codex" for the chip's colour; the office default shows as its own provider. */
export const engineKind = (m: Member): string => m.provider ?? store.project?.defaultProvider ?? 'claude';

export const faNum = (n: number) => n.toLocaleString('fa-IR');
export const faDate = (ms: number) => new Date(ms).toLocaleDateString('fa-IR', { year: 'numeric', month: 'long', day: 'numeric' });

export function avatar(m: Pick<Member, 'name' | 'status'>): HTMLElement {
  return h('span.mb-avatar', {}, [...m.name.trim()][0] ?? '؟', h('i', { class: m.status }));
}

/** A small reader for the profile files: # headings, - lists and paragraphs, the way agents write them. */
export function mdLite(text: string): HTMLElement {
  const out = h('div.mb-md', { dir: 'auto' });
  let list: HTMLElement | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const head = /^(#{1,4})\s+(.*)$/.exec(line);
    const item = /^\s*[-*]\s+(.*)$/.exec(line);
    if (item) {
      if (!list) out.append((list = h('ul')));
      list.append(h('li', { dir: 'auto' }, item[1]));
      continue;
    }
    list = null;
    if (head) out.append(h(head[1].length === 1 ? 'h3' : 'h4', { dir: 'auto' }, head[2]));
    else if (line.trim()) out.append(h('p', { dir: 'auto' }, line));
  }
  return out;
}
