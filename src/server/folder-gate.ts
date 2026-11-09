// The check that keeps an agent inside the project folders it was granted (see projects.ts). It is the PreToolUse
// hook of every Claude Code worker (hooks/office-security.ts): a tool that reads or writes a file in a project's
// folder the agent was not granted, or writes in one it may only read, is refused with the reason, and the same
// time a card goes to 📥 درخواست از شما so the person can allow that folder for eight hours. Files outside every
// project's folders are not its business. A shell command is judged by the paths written in it and by the folder it
// runs in, so it is a guard that tells the agent where it went wrong and not a wall: a roundabout command can still
// get through. Codex workers are checked the same way (its PreToolUse reaches hooks/server.ts); its --add-dir grants and sandbox limit it besides.
import path from 'node:path';
import type { WorkerInfo } from '../shared/protocol.js';
import type { Floor } from './floor.js';
import { SHELLS, WRITERS, WRITING } from './profile-gate.js';

const READERS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']);
const PATCH = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;
/** Paths written out in a shell command: a drive letter path, or an absolute one. */
const SHELL_PATH = /(?:[A-Za-z]:[\\/][^\s"'`|;&<>()]*)|(?:(?<![\w.:-])\/(?:[\w.@+-]+\/)*[\w.@+-]+)/g;
/** A file of secrets: read or written only with the person's yes, even in a folder the agent was given. */
const SECRET = /(^|[\\/])(\.env(\.[\w-]+)?|id_rsa|id_ed25519|[^\\/]*\.(pem|key|pfx|p12))$/i;
const SAFE_ENV = /\.(example|sample|template|dist)$/i;

type Need = 'read' | 'write';
interface Touch {
  file: string;
  need: Need;
}

/** The files a tool is about to touch. */
function touches(payload: any): Touch[] {
  const tool = String(payload?.tool_name ?? '');
  const input = payload?.tool_input ?? {};
  const cwd = String(payload?.cwd ?? '');
  const abs = (f: string) => (f ? path.resolve(cwd || '.', f) : '');
  if (SHELLS.has(tool)) {
    const raw = input.command ?? input.cmd ?? input.script ?? '';
    const command = Array.isArray(raw) ? raw.join(' ') : String(raw);
    const need: Need = WRITING.test(command.replace(/\\/g, '/')) ? 'write' : 'read';
    const found = [...command.matchAll(SHELL_PATH)].map((m) => m[0]);
    // A command run from inside a project's folder is about that folder, whatever paths it names.
    return [...(cwd ? [cwd] : []), ...found].map((file) => ({ file: abs(file), need }));
  }
  if (tool === 'apply_patch') {
    const patch = String(input.command ?? input.input ?? input.patch ?? (typeof payload?.tool_input === 'string' ? payload.tool_input : ''));
    return [...patch.matchAll(PATCH)].map((m) => ({ file: abs(m[1].trim()), need: 'write' as Need }));
  }
  if (WRITERS.has(tool)) return [{ file: abs(String(input.file_path ?? input.notebook_path ?? input.path ?? '')), need: 'write' }];
  if (READERS.has(tool)) return [{ file: abs(String(input.file_path ?? input.path ?? input.notebook_path ?? '')), need: 'read' }];
  return [];
}

/** What the team keeps in its own repository: its files, the office's data, the agents' settings. Nothing else is written there. */
const TEAM_OWN = /^(freelance-team|\.agent-office|\.claude|\.codex|\.agents)([\\/]|$)|^(CLAUDE|AGENTS|README)\.md$/i;
/** A branch made or switched to: in the team's repository that leaves the office writing its files on someone's branch. */
const BRANCHING = /\bgit\b(?![^;&|]*\s-C\s)[^;&|]*\b(?:switch\s+-[cC]|checkout\s+-[bB]|checkout\s+(?!-)[\w./-]+|switch\s+(?!-)[\w./-]+|branch\s+(?!-)[\w./-]+)/;

/**
 * On a floor with projects, an agent's own folder is the team's repository and the project's code lives in the
 * project's folders: a project file written here, or a branch made here, went to the wrong place (it happened: a
 * design and a git branch ended up in the team's repository). Undefined when it is fine.
 */
export function teamRepoGate(floor: Floor, me: WorkerInfo, payload: any): string | undefined {
  const root = floor.dir;
  if (!root) return undefined;
  const tool = String(payload?.tool_name ?? '');
  const input = payload?.tool_input ?? {};
  const cwd = String(payload?.cwd ?? '');
  const inRoot = (f: string) => !path.relative(root, f).startsWith('..') && !path.isAbsolute(path.relative(root, f));
  const where = () => floor.projects.list().flatMap((p) => p.folders.map((f) => `${p.name}/${f.name}: ${f.path}`)).slice(0, 6).join('؛ ');
  const refuse = (what: string) =>
    `${what} مخزن خود تیم (${root}) است، نه پوشه‌ی پروژه. کد، طرح و فایل‌های پروژه را فقط با مسیر مطلق در پوشه‌ی پروژه بنویس و git را با «git -C <مسیر پروژه>» بزن. پوشه‌های پروژه: ${where()}`;
  if (SHELLS.has(tool)) {
    const raw = input.command ?? input.cmd ?? input.script ?? '';
    const command = Array.isArray(raw) ? raw.join(' ') : String(raw);
    if (cwd && inRoot(path.resolve(cwd)) && BRANCHING.test(command)) return refuse('ساختن یا عوض کردن شاخه‌ی git در');
    return undefined;
  }
  const files = tool === 'apply_patch'
    ? [...String(input.command ?? input.input ?? input.patch ?? (typeof payload?.tool_input === 'string' ? payload.tool_input : '')).matchAll(PATCH)].map((m) => m[1].trim())
    : WRITERS.has(tool) ? [String(input.file_path ?? input.notebook_path ?? input.path ?? '')] : [];
  for (const f of files) {
    if (!f) continue;
    const abs = path.resolve(cwd || root, f);
    if (inRoot(abs) && !TEAM_OWN.test(path.relative(root, abs))) return refuse(`نوشتن «${path.relative(root, abs)}» در`);
  }
  return undefined;
}

/** Why a worker may not do this yet, as the words it is told; undefined when it may. */
export function folderGate(floor: Floor, me: WorkerInfo, payload: any): string | undefined {
  if (!floor.projects.list().some((p) => p.folders.length)) return undefined;
  const misplaced = teamRepoGate(floor, me, payload);
  if (misplaced) return misplaced;
  const manager = floor.teams.isManager(me.id);
  for (const t of touches(payload)) {
    if (!t.file) continue;
    const hit = floor.projects.access(me.id, t.file, manager);
    if (!hit) continue;
    const secret = SECRET.test(t.file) && !SAFE_ENV.test(t.file);
    const ok = !secret && (hit.mode === 'write' || (hit.mode === 'read' && t.need === 'read'));
    if (ok) continue;
    const key = `folder:${hit.folder.path}:${secret ? 'secret' : t.need}`;
    if (floor.requests.permitFor(me.id, key)) continue;
    const what = secret ? 'فایل رمزها (.env و کلیدها) در' : t.need === 'write' ? 'نوشتن در' : 'خواندن';
    const where = `پوشه‌ی «${hit.folder.name}» پروژه‌ی «${hit.project.name}»`;
    const asked = floor.requests.ask(me.id, me.name, {
      kind: 'approve',
      title: `اجازه‌ی ${what} ${where}`,
      detail: `${me.name} می‌خواهد ${t.need === 'write' ? 'در' : 'از'} «${t.file}» ${t.need === 'write' ? 'بنویسد' : 'بخواند'}${secret ? ' (فایل رمز)' : ''}، ولی ${hit.mode ? 'فقط خواندن' : 'هیچ'} دسترسی به این پوشه ندارد. تأیید کنید تا هشت ساعت بتواند، یا رد کنید. دسترسی ثابت را در 📁 پروژه‌ها بدهید.`,
      file: key,
    });
    if (asked.ok && asked.fresh) void floor.notifier.send(`📥 ${me.name}: اجازه‌ی ${what} ${where} را می‌خواهد (${asked.req.id})`);
    return `${where} ${secret ? 'رمز دارد و فقط با تأیید مدیرعامل' : hit.mode ? 'برای تو فقط خواندنی است' : 'جزو دسترسی‌های تو نیست'}؛ ${what} آن ممکن نیست. اگر کار پروژه‌ی دیگری را اشتباهی کرده‌ای برگرد؛ اگر لازم است درخواست${asked.ok ? ` ${asked.req.id}` : ''} در «📥 درخواست از شما» ثبت شد: منتظر نمان و کار دیگرت را ادامه بده.`;
  }
  return undefined;
}
