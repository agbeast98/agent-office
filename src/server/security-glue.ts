// What the floor does with the firewall's answers: telling the security agent (and the person) when something is
// held, telling a held agent what became of it, and turning what Claude Code is about to do into a check.
import type { WorkerInfo } from '../shared/protocol.js';
import type { Floor } from './floor.js';
import { tell } from './hooks/office-tasks.js';
import { KIND_FA, hostOf, programOf, type Check, type Hold, type Kind } from './security.js';

const wait = (h: Hold) => `«${h.target}» (${KIND_FA[h.kind]}) برای تو نگه داشته شد (${h.id}). امنیت بررسی می‌کند. برای صبر کردن هیچ دستوری (sleep و مانند آن) نزن، چون آن هم نگه داشته می‌شود: کار دیگرت را با ابزارهای گفتگو و کارها جلو ببر، یا همین‌جا بگو منتظری و متوقف شو. وقتی تصمیم رسید به تو پیام می‌دهیم و همان کار را دوباره امتحان کن.`;

/** The message an agent gets when what it tried is refused or held. */
export function refusal(c: Exclude<Check, { verdict: 'allow' }>): string {
  return c.verdict === 'deny' ? c.reason : wait(c.hold);
}

/** A hold that has just appeared: the security agent is woken to decide it, and the person hears of it on their phone. */
export function announce(floor: Floor, c: Check) {
  if (c.verdict !== 'hold' || !c.fresh) return;
  const h = c.hold;
  const guardian = floor.security.guardOf(h.agent.id);
  if (guardian) {
    tell(floor, [{ to: guardian, text: `نگه‌داشته شد ${h.id}: ${h.agent.name} می‌خواهد «${KIND_FA[h.kind]}» انجام دهد: ${h.target}${h.detail && h.detail !== h.target ? `\nجزئیات: ${h.detail}` : ''}\nبا security_holds قوانین او را ببین و با security_decide تصمیم بگیر: allow (مجوز موقت)، deny، یا ask اگر مطمئن نیستی و می‌خواهی از Mohammad بپرسی. از سقف قوانین بالاتر نرو.` }], 'امنیت');
  }
  void floor.notifier.send(`🛡 ${h.agent.name}: ${KIND_FA[h.kind]} «${h.target}» نگه داشته شد`);
}

/** The agent's rules say yes, no or wait for something it tried in the office's browser; anything but yes is thrown at it. */
export function browserGate(floor: Floor, workerId: string, kind: 'open' | 'write', address: string, detail: string) {
  const w = floor.workers.get(workerId);
  if (!w || w.kind !== 'agent') return;
  const c = floor.security.check({ id: w.id, name: w.name }, kind, hostOf(address), detail || address);
  if (c.verdict === 'allow') return;
  announce(floor, c);
  throw new Error(refusal(c));
}

const SAFE = new Set(['Glob', 'Grep', 'TodoWrite', 'Task', 'Agent', 'Skill', 'ToolSearch', 'ExitPlanMode', 'AskUserQuestion', 'BashOutput', 'KillShell', 'KillBash', 'SlashCommand', 'EnterPlanMode']);
const FILES = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'NotebookRead']);

/** What Claude Code is about to do, as a check (the PreToolUse hook asks; see providers/claude.ts). Undefined: nothing to hold. */
export function toolCheck(floor: Floor, me: WorkerInfo, payload: any): Check | undefined {
  const tool = String(payload?.tool_name ?? '');
  const input = payload?.tool_input ?? {};
  // Talking to the office (messages, tasks, the meeting, the browser, which has its own gate) is never held.
  if (!tool || tool.startsWith('mcp__agent-office__') || SAFE.has(tool)) return undefined;
  const agent = { id: me.id, name: me.name };
  const roots = [String(payload?.cwd ?? ''), floor.dir].filter(Boolean);
  const ask = (kind: Kind, target: string, detail: string) => floor.security.check(agent, kind, target, detail, roots);
  if (tool === 'Bash' || tool === 'PowerShell') {
    const command = String(input.command ?? '');
    return ask('shell', programOf(command) || tool, command);
  }
  if (tool === 'WebFetch') return ask('web', hostOf(String(input.url ?? '')), String(input.url ?? ''));
  if (tool === 'WebSearch') return ask('search', 'search', String(input.query ?? ''));
  if (FILES.has(tool)) {
    const file = String(input.file_path ?? input.notebook_path ?? input.path ?? '');
    return file ? ask('file', file, `${tool} ${file}`) : undefined;
  }
  return ask('tool', tool, tool);
}
