// Codex: its native lifecycle hooks (see ../codex.ts), set on its command line, report on
// /hooks/codex; its usage is read from the root session's rollout (see codex-usage.ts).
import { homedir } from 'node:os';
import path from 'node:path';
import { officeHome } from '../config.js';
import { codexHookArgs, codexModelArgs, codexPermissionArgs, codexPromptArg, normalizeCodexHook, readCodexAccess, writeCodexHook, type CodexAccess } from '../codex.js';
import { CodexChatReader } from '../codex-chat.js';
import { CodexUsageReader } from '../codex-usage.js';
import { codexMcpArgs } from '../office-workers.js';
import { reduceLifecycle, type ToolTracker } from '../workers/lifecycle.js';
import type { WorkerHandle } from '../workers/types.js';
import type { ProviderAdapter } from './types.js';

interface CodexState {
  usage: CodexUsageReader;
  /** Where its sessions are logged (see codexHome). */
  home?: string;
  /** This worker's unique Codex workspace; used to find its root rollout if hooks fail. */
  workspace?: string;
  /** Its root session's rollout, as its hooks name it. */
  transcript?: string;
  /** Its tool calls in flight, and which of them wait on the person (see tracker). */
  tools: Map<string, string>;
  pending: Set<string>;
  permissionUnknown?: boolean;
}

interface CodexSetup {
  hook: string;
  /** What this floor lets its Codex workers do (see codexPermissionArgs). */
  access: CodexAccess;
  mcpScript?: string;
}

/** Where a Codex worker's sessions are logged, for reading its usage. */
function codexHome(cwd: string, env: NodeJS.ProcessEnv): string {
  return path.resolve(cwd, env.CODEX_HOME || path.join(env.HOME || homedir(), '.codex'));
}

/**
 * Codex's hooks never say a question was answered, so its tool calls are followed one by one: one
 * that asks the person something, or wants permission, keeps it needing input until it's over.
 */
function tracker(s: CodexState): ToolTracker {
  return {
    clear() {
      s.tools.clear();
      s.pending.clear();
      s.permissionUnknown = false;
    },
    started(tool, toolUseId) {
      if (toolUseId && s.tools.size < 256) s.tools.set(toolUseId, tool ?? '');
      if (/(?:^|[.])(?:AskUserQuestion|request_user_input)$/.test(tool ?? '')) {
        if (toolUseId) s.pending.add(toolUseId);
        else s.permissionUnknown = true;
      }
    },
    permission(tool) {
      // PermissionRequest has no tool_use_id in the native schema. Keep every matching
      // active call pending so an unrelated parallel tool cannot dismiss the prompt.
      const candidates = [...s.tools].filter(([, t]) => t === tool);
      if (!candidates.length) s.permissionUnknown = true;
      for (const [id] of candidates) s.pending.add(id);
    },
    finished(toolUseId) {
      if (toolUseId) {
        s.tools.delete(toolUseId);
        s.pending.delete(toolUseId);
      }
      if (!s.tools.size) s.permissionUnknown = false;
    },
    waiting: () => !!(s.pending.size || s.permissionUnknown),
  };
}

/** Native Codex lifecycle hooks register the root rollout for bounded metric reads. */
function codexHook(h: WorkerHandle<CodexState>, event: string, payload: unknown): boolean {
  const report = normalizeCodexHook(event, payload);
  if (!report) return false;
  const s = h.state;
  return reduceLifecycle(h, report, {
    onSessionSwitch() {
      h.info.usage = undefined;
      s.transcript = undefined;
      s.usage = new CodexUsageReader();
    },
    onReport() {
      if (report.transcriptPath) s.transcript = report.transcriptPath;
      h.scheduleScan();
    },
    tools: tracker(s),
  });
}

const chatReader = new CodexChatReader();
const BOOT_HINT = 'Open the terminal: complete login and review Office hooks in /hooks';

export const codex: ProviderAdapter<CodexState, CodexSetup> = {
  id: 'codex',
  scrubEnv: ['CODEX_THREAD_ID', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE'],
  createState: () => ({ usage: new CodexUsageReader(), tools: new Map(), pending: new Set() }),
  // One hook file for every floor: Codex keeps a single trust stamp per hook event, made from the command (its path
  // included), so a file of its own on each floor made the floors un-trust each other and every start asked again.
  prepare: ({ dataDir, mcpScript }) => ({ hook: writeCodexHook(path.join(officeHome(), 'codex-hook')), access: readCodexAccess(dataDir), mcpScript }),
  launch({ h, args, prompt, resumeSessionId, setup, dirs }) {
    // The hint of a boot that was silent (see bootHint) is stale once it is launched again.
    if (h.info.activity === BOOT_HINT) h.info.activity = undefined;
    // Resumed too: Codex resumes on whatever its config says now, not on the model the session ran on.
    args = codexModelArgs(args, h.info.model, h.info.effort);
    args.push(...codexPermissionArgs(args, process.env, setup.access));
    // Codex reads the whole disk already; --add-dir makes a folder writable, so only the writable grants are added.
    for (const d of dirs?.write ?? []) args.push('--add-dir', d);
    args.push(...codexHookArgs(setup.hook), ...(setup.mcpScript ? codexMcpArgs(setup.mcpScript) : []), '--no-alt-screen');
    if (resumeSessionId) args.push('resume', resumeSessionId);
    if (prompt) args.push('--', codexPromptArg(path.dirname(setup.hook), h.info.id, prompt));
    tracker(h.state).clear();
    return { args, rotateToken: true };
  },
  // The chat tab: its prompts and answers off the root rollout its hooks named. Without a hook report yet
  // there is no telling which rollout is this worker's (workers can share a folder), so it waits.
  conversation(h, after = 0) {
    const { home } = h.state;
    // Windows hooks name the rollout as \\?\C:\…; the reader wants the plain path.
    const named = h.state.transcript?.replace(/^\\\\\?\\/, '');
    const sessionId = h.info.sessionId ?? named?.match(/-([a-zA-Z0-9-]{1,160})\.jsonl$/)?.[1];
    if (!home || !sessionId) return { status: 'waiting', cursor: 0, messages: [] };
    // Without a usable name from a hook (before one reported, or after a restart of the office) it is found by the session id.
    const read = (file?: string) => (file ? chatReader.read(file, sessionId, home, after) : undefined);
    const chat = read(named);
    if (chat && chat.status !== 'waiting') return chat;
    const found = chatReader.findBySession(home, sessionId);
    return read(found) ?? { status: 'waiting', cursor: 0, messages: [] };
  },
  quietResume: true,
  bootHint: BOOT_HINT,
  hook: { strictJson: true, handle: codexHook },
  usage: {
    persisted: true,
    scanOnExit: true,
    scan(h) {
      const { info, state: s } = h;
      if (!s.transcript || !s.home || !info.sessionId) return;
      const usage = s.usage.read(s.transcript, info.sessionId, s.home);
      if (usage && JSON.stringify(usage) !== JSON.stringify(info.usage)) {
        info.usage = usage;
        h.emit();
        h.persist();
      }
    },
    locate(h, cwd, env) {
      h.state.home = codexHome(cwd, env);
      h.state.workspace = path.resolve(cwd);
    },
    save: (s) => ({ codexTranscript: s.transcript }),
    restore(s, saved) {
      if (typeof saved.codexTranscript === 'string') s.transcript = saved.codexTranscript;
    },
  },
};
