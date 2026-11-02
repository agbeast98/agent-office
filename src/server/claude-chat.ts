// A Claude Code worker's conversation, read off its session transcript (~/.claude/projects/<dir>/<session>.jsonl,
// named by the hook payloads) for the chat tab on its terminal. Read-only and bounded: only the tail of the file is
// read, only files under Claude's own projects folder, and only the prompts and answers (never reasoning, tool
// calls or their results).
import { closeSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ProviderConversation } from './providers/types.js';

type Message = ProviderConversation['messages'][number];

/** Only the end of a long session is read. */
const TAIL_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGES = 200;
const MAX_TEXT = 30_000;
const MAX_CACHED = 32;

/** Lines Claude Code writes for itself rather than for the person: slash commands, local command output, reminders. */
const NOISE = /^\s*<(command-name|command-message|command-args|local-command|system-reminder|user-prompt-submit-hook|task-notification)/;

/** Where Claude keeps its sessions. */
const projectsRoot = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'), 'projects');

/** What a message says: a plain string, or the `text` blocks of a list. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text as string)
    .join('\n\n');
}

/** The prompts and answers in `raw`, which starts at byte `base` of the file. Anything unexpected is skipped. */
export function claudeMessages(raw: string, sessionId: string, base = 0): Message[] {
  const out: Message[] = [];
  let offset = base;
  for (const line of raw.split('\n')) {
    const at = offset;
    offset += Buffer.byteLength(line) + 1;
    if (!line.startsWith('{')) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj?.isSidechain || obj?.isMeta) continue;
    const role = obj?.type;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = textOf(obj.message?.content).trim();
    if (!text || (role === 'user' && NOISE.test(text))) continue;
    const message: Message = { id: `${sessionId}:${at}`, role, text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text };
    if (typeof obj.timestamp === 'string' && Number.isFinite(Date.parse(obj.timestamp))) message.at = obj.timestamp;
    out.push(message);
  }
  return out.slice(-MAX_MESSAGES);
}

interface Cached {
  size: number;
  mtimeMs: number;
  messages: Message[];
}

export class ClaudeChatReader {
  private cache = new Map<string, Cached>();

  /** `file` is the transcript a hook named; `after` is the cursor the last answer gave, so an unchanged file is answered cheaply. */
  read(file: string | undefined, sessionId: string | undefined, after = 0): ProviderConversation {
    const waiting: ProviderConversation = { status: 'waiting', cursor: 0, messages: [] };
    if (!file || !sessionId || !file.endsWith('.jsonl')) return waiting;
    let fd: number | undefined;
    try {
      // The real path, so a link can't point the reader outside Claude's own folder.
      const real = realpathSync(file);
      const root = realpathSync(projectsRoot());
      if (!real.startsWith(root + path.sep)) return waiting;
      fd = openSync(real, 'r');
      const { size, mtimeMs } = fstatSync(fd);
      const hit = this.cache.get(real);
      if (hit && hit.size === size && hit.mtimeMs === mtimeMs) {
        return after === size ? { status: 'ready', cursor: size, messages: [], unchanged: true } : { status: 'ready', cursor: size, messages: hit.messages };
      }
      const start = Math.max(0, size - TAIL_BYTES);
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      let text = buf.toString('utf8');
      let base = start;
      // Starting partway through the file, its first line is cut off.
      if (start > 0) {
        const nl = buf.indexOf(0x0a);
        base = start + (nl < 0 ? buf.length : nl + 1);
        text = nl < 0 ? '' : buf.subarray(nl + 1).toString('utf8');
      }
      const messages = claudeMessages(text, sessionId, base);
      this.cache.delete(real);
      this.cache.set(real, { size, mtimeMs, messages });
      if (this.cache.size > MAX_CACHED) this.cache.delete(this.cache.keys().next().value!);
      return { status: 'ready', cursor: size, messages };
    } catch {
      return waiting;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
}
