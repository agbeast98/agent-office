import { closeSync, constants, fstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { ProviderConversation } from './providers/types.js';

const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_DIR_ENTRIES = 8_000;
const MAX_MESSAGES = 2_000;
const MAX_MESSAGE_CHARS = 100_000;
const SESSION_ID = /^[a-zA-Z0-9-]{1,160}$/;

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function safeSessionPath(file: string, sessionId: string, home: string): { target: string; root: string } | undefined {
  if (!path.isAbsolute(file) || !SESSION_ID.test(sessionId)) return;
  const root = realpathSync(home);
  const target = realpathSync(file);
  if (!inside(root, target)) return;
  const relative = path.relative(root, target).split(path.sep);
  if (!['sessions', 'archived_sessions'].includes(relative[0]) || relative.includes('..')) return;
  if (!path.basename(target).endsWith(`-${sessionId}.jsonl`)) return;
  return { target, root };
}

function header(fd: number, size: number, sessionId: string): Record<string, unknown> | undefined {
  const bytes = Buffer.alloc(Math.min(size, 1024 * 1024));
  const n = readSync(fd, bytes, 0, bytes.length, 0);
  const end = bytes.subarray(0, n).indexOf(10);
  if (end < 0) return;
  try {
    const row = JSON.parse(bytes.subarray(0, end).toString('utf8')) as Record<string, unknown>;
    if (row.type !== 'session_meta' || !row.payload || typeof row.payload !== 'object') return;
    const payload = row.payload as Record<string, unknown>;
    return payload.id === sessionId ? payload : undefined;
  } catch { return; }
}

function textFor(row: Record<string, unknown>, sessionId: string, offset: number): ProviderConversation['messages'][number] | undefined {
  if (row.type !== 'response_item' || !row.payload || typeof row.payload !== 'object') return;
  const payload = row.payload as Record<string, unknown>;
  if (payload.type !== 'message' || !Array.isArray(payload.content)) return;
  const role = payload.role;
  if (role !== 'user' && role !== 'assistant') return;
  // Codex records analysis separately. Only final-answer assistant messages belong in this chat.
  if (role === 'assistant' && payload.phase !== undefined && payload.phase !== 'final_answer') return;
  const allowed = role === 'user' ? 'input_text' : 'output_text';
  const parts = payload.content.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const content = item as Record<string, unknown>;
    return content.type === allowed && typeof content.text === 'string' ? [content.text] : [];
  });
  const text = parts.join('').slice(0, MAX_MESSAGE_CHARS).trim();
  if (!text) return;
  const at = typeof row.timestamp === 'string' && row.timestamp.length <= 64 ? row.timestamp : undefined;
  return { id: `${sessionId}:${offset}`, role, text, ...(at ? { at } : {}) };
}

/** Bounded reader for one worker's root Codex rollout; never reads tool details or reasoning. */
export class CodexChatReader {
  findForCwd(home: string, cwd: string): { file: string; sessionId: string } | undefined {
    try {
      const root = realpathSync(home);
      const wanted = path.resolve(cwd).toLowerCase();
      let visited = 0;
      let best: { file: string; sessionId: string; mtime: number } | undefined;
      const walk = (directory: string, depth: number) => {
        if (depth > 4 || visited >= MAX_DIR_ENTRIES) return;
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          if (++visited > MAX_DIR_ENTRIES) break;
          const candidate = path.join(directory, entry.name);
          if (entry.isDirectory() && !entry.isSymbolicLink()) { walk(candidate, depth + 1); continue; }
          if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
          const match = entry.name.match(/-([a-zA-Z0-9-]{1,160})\.jsonl$/);
          if (!match) continue;
          let fd: number | undefined;
          try {
            const safe = safeSessionPath(candidate, match[1], root);
            if (!safe) continue;
            fd = openSync(safe.target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            const stat = fstatSync(fd);
            if (!stat.isFile()) continue;
            const meta = header(fd, stat.size, match[1]);
            if (typeof meta?.cwd !== 'string' || path.resolve(meta.cwd).toLowerCase() !== wanted) continue;
            if (!best || stat.mtimeMs > best.mtime) best = { file: safe.target, sessionId: match[1], mtime: stat.mtimeMs };
          } catch { /* Ignore malformed, inaccessible, and replaced files. */ }
          finally { if (fd !== undefined) closeSync(fd); }
        }
      };
      for (const name of ['sessions', 'archived_sessions']) {
        const base = path.join(root, name);
        try { if (inside(root, realpathSync(base))) walk(base, 0); } catch { /* Not created yet. */ }
      }
      return best && { file: best.file, sessionId: best.sessionId };
    } catch { return; }
  }

  read(file: string, sessionId: string, home: string, after = 0): ProviderConversation {
    let fd: number | undefined;
    try {
      const safe = safeSessionPath(file, sessionId, home);
      if (!safe) return { status: 'waiting', cursor: 0, messages: [] };
      fd = openSync(safe.target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile()) return { status: 'waiting', cursor: 0, messages: [] };
      if (!header(fd, stat.size, sessionId)) return { status: 'waiting', cursor: 0, messages: [] };
      if (after === stat.size) return { status: 'ready', cursor: stat.size, messages: [], unchanged: true };
      const start = Math.max(0, stat.size - MAX_FILE_BYTES);
      const buffer = Buffer.alloc(stat.size - start);
      const n = readSync(fd, buffer, 0, buffer.length, start);
      const source = buffer.subarray(0, n);
      const text = source.toString('utf8');
      const lines = text.split('\n');
      if (start > 0) lines.shift(); // Discard a possible partial first record.
      if (lines.at(-1) === '') lines.pop();
      const messages: ProviderConversation['messages'] = [];
      let offset = start;
      for (const line of lines) {
        const lineBytes = Buffer.byteLength(line) + 1;
        try {
          const row = JSON.parse(line) as Record<string, unknown>;
          const message = textFor(row, sessionId, offset);
          if (message && messages.length < MAX_MESSAGES) messages.push(message);
        } catch { /* A malformed rollout row is not conversation text. */ }
        offset += lineBytes;
      }
      return { status: 'ready', cursor: stat.size, messages };
    } catch {
      return { status: 'waiting', cursor: 0, messages: [] };
    } finally { if (fd !== undefined) closeSync(fd); }
  }
}
