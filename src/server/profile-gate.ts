// A lock on the files that make a member who they are: their skill.md and memory.md, the team's policy.md and
// the roster. A member may write their own profile; changing anyone else's, or the policy, needs the person's yes
// for that file (an item in 📥 درخواست از شما: say yes and that agent may change it for an hour). Checked in the
// PreToolUse hook of every Claude Code worker (see hooks/office-security.ts); it stops Write and Edit tools, not a
// shell redirect, and Codex workers have no such hook.
import path from 'node:path';
import type { WorkerInfo } from '../shared/protocol.js';
import type { Floor } from './floor.js';

const WRITERS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const PROFILE = /^freelance-team\/people\/([^/]+)\/(skill|memory)\.md$/;
const PROTECTED = new Set(['freelance-team/policy.md', 'freelance-team/people/ROSTER.md']);

/** The file as the office names it (relative to the floor's folder, forward slashes), or undefined if it is outside. */
function relative(floor: Floor, cwd: string, file: string): string | undefined {
  const rel = path.relative(floor.dir, path.resolve(cwd || floor.dir, file)).split(path.sep).join('/');
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : undefined;
}

/** Why a worker may not do this write yet, as the words it is told; undefined when it may. */
export function profileGate(floor: Floor, me: WorkerInfo, payload: any): string | undefined {
  const tool = String(payload?.tool_name ?? '');
  if (!WRITERS.has(tool)) return undefined;
  const input = payload?.tool_input ?? {};
  const file = String(input.file_path ?? input.notebook_path ?? input.path ?? '');
  const rel = file ? relative(floor, String(payload?.cwd ?? ''), file) : undefined;
  if (!rel) return undefined;
  const profile = PROFILE.exec(rel);
  if (!profile && !PROTECTED.has(rel)) return undefined;
  if (profile && floor.interviews.latestFor(me.id)?.slug === profile[1]) return undefined;
  if (floor.requests.permitFor(me.id, rel)) return undefined;
  const owner = profile ? floor.interviews.all().find((i) => i.slug === profile[1])?.name ?? profile[1] : 'تیم';
  const asked = floor.requests.ask(me.id, me.name, {
    kind: 'approve',
    title: `اجازه‌ی تغییر ${profile ? `پروفایل ${owner} (${profile[2]}.md)` : rel}`,
    detail: `${me.name} می‌خواهد «${rel}» را عوض کند. تأیید کنید تا یک ساعت بتواند همین فایل را تغییر بدهد، یا رد کنید.`,
    file: rel,
  });
  if (asked.ok && asked.fresh) void floor.notifier.send(`📥 ${me.name}: اجازه‌ی تغییر «${rel}» را از شما می‌خواهد (${asked.req.id})`);
  return `«${rel}» پروفایل یا سیاست تیم است و تغییرش فقط با تأیید مدیرعامل ممکن است. درخواست${asked.ok ? ` ${asked.req.id}` : ''} در «📥 درخواست از شما» ثبت شد. منتظر نمان؛ کار دیگرت را ادامه بده. وقتی مدیرعامل تأیید کرد، خودت خبر می‌گیری و می‌توانی همین تغییر را دوباره انجام بدهی.`;
}
