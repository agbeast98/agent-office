// The Claude plan limits of the account the workers run on (the 5-hour session and the week) for
// the meter under the workers in the sidebar. Claude Code answers a `get_usage` control request on
// its stream-json protocol with the numbers its /usage screen shows. Asking starts no conversation
// and costs nothing, and Claude Code deals with the sign-in (keychain, token refresh) itself.

import { spawn } from 'node:child_process';
import os from 'node:os';
import type { PlanLimits, PlanWindow } from '../shared/protocol.js';

const POLL_MS = 2 * 60_000;
/** Someone walking in, or clicking the meter, reads again, at most this often. */
const MIN_GAP_MS = 20_000;
const TIMEOUT_MS = 30_000;
/** No plan limits to show (an API key, Bedrock, Vertex, signed out): look again much later. */
const NO_PLAN_MS = 30 * 60_000;
/** After this many failed reads in a row (no network, a `claude` too old to answer), wait longer. */
const FAILS_BEFORE_BACKOFF = 3;
const BACKOFF_MS = 10 * 60_000;
const LABEL_MAX = 24;

export class PlanLimitsReader {
  private limits: PlanLimits = { windows: [], at: 0 };
  /** Per-model weeks from the last answer that listed them; an answer from Claude Code's cache may not. */
  private modelWeeks: PlanWindow[] = [];
  private codex: PlanLimits['codex'];
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private lastRead = 0;
  private fails = 0;
  private closed = false;

  /**
   * @param claude the `claude` binary, or null when it isn't installed (nothing is ever shown)
   * @param env environment for it (the office's own, minus anything that marks a child session)
   * @param wanted whether anyone is in the office to see the numbers; polls are skipped when not
   */
  constructor(
    private claude: string | null,
    private env: Record<string, string>,
    private wanted: () => boolean,
    private onChange: (limits: PlanLimits) => void,
    /** the `codex` binary, or null: its plan limits ride along in the same state */
    private codexBin: string | null = null,
  ) {
    this.schedule(0);
  }

  get state(): PlanLimits {
    return this.codex ? { ...this.limits, codex: this.codex } : this.limits;
  }

  /** Reads now, unless a read is running or one just finished. */
  refresh() {
    if (this.running || Date.now() - this.lastRead < MIN_GAP_MS) return;
    this.schedule(0);
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
  }

  private schedule(ms: number) {
    if (this.closed || !(this.claude || this.codexBin)) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.read(), ms);
    this.timer.unref();
  }

  private async read() {
    if (!this.wanted()) return this.schedule(POLL_MS);
    this.running = true;
    const [answer, codex] = await Promise.all([this.claude ? ask(this.claude, this.env) : null, this.codexBin ? askCodex(this.codexBin, this.env) : null]);
    this.running = false;
    if (codex) this.codex = codex;
    this.lastRead = Date.now();
    if (this.closed) return;
    let next = POLL_MS;
    if (answer === null) {
      if (codex) this.onChange(this.state);
      if (this.claude && ++this.fails >= FAILS_BEFORE_BACKOFF) {
        this.fails = 0;
        next = BACKOFF_MS;
      }
    } else {
      this.fails = 0;
      const parsed = this.parse(answer);
      // Claude Code sometimes answers with the plan but no numbers (its own read of them failed or is warming up): the last numbers
      // it gave stay on the meter, marked with when they were read, rather than the meter vanishing.
      this.limits = !parsed.windows.length && this.limits.windows.length ? { ...this.limits, plan: parsed.plan ?? this.limits.plan } : parsed;
      if (!this.limits.windows.length && !this.limits.plan && !this.codex?.windows.length) next = NO_PLAN_MS;
      this.onChange(this.state);
    }
    this.schedule(next);
  }

  private parse(answer: any): PlanLimits {
    const rl = answer?.rate_limits;
    const plan = typeof answer?.subscription_type === 'string' ? answer.subscription_type.slice(0, LABEL_MAX) : undefined;
    if (answer?.rate_limits_available === false || !rl || typeof rl !== 'object') {
      this.modelWeeks = [];
      return { plan, windows: [], at: Date.now() };
    }
    const windows = [toWindow('5h session', rl.five_hour), toWindow('Week', rl.seven_day)];
    if (Array.isArray(rl.model_scoped)) {
      this.modelWeeks = rl.model_scoped
        .filter((m: any) => typeof m?.display_name === 'string' && m.display_name.trim())
        .map((m: any) => toWindow(`${m.display_name.trim().slice(0, LABEL_MAX)} week`, m))
        .filter((w: PlanWindow | null): w is PlanWindow => w !== null);
    } else if (rl.seven_day_opus || rl.seven_day_sonnet) {
      // Claude Code before per-model buckets
      this.modelWeeks = [toWindow('Opus week', rl.seven_day_opus), toWindow('Sonnet week', rl.seven_day_sonnet)].filter((w): w is PlanWindow => w !== null);
    }
    return { plan, windows: [...windows.filter((w): w is PlanWindow => w !== null), ...this.modelWeeks], at: Date.now() };
  }
}

function toWindow(label: string, w: any): PlanWindow | null {
  if (typeof w?.utilization !== 'number' || !Number.isFinite(w.utilization)) return null;
  const resetsAt = typeof w.resets_at === 'string' ? Date.parse(w.resets_at) : NaN;
  return { label, pct: Math.max(0, Math.min(100, w.utilization)), resetsAt: Number.isFinite(resetsAt) ? resetsAt : undefined };
}

/** Claude Code's structured /usage answer, or null when it couldn't give one. */
function ask(claude: string, env: Record<string, string>): Promise<any> {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--tools', '',
    // Not the user's or the project's settings: no hooks, no MCP servers, no plugins, no transcript.
    '--setting-sources', '',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--no-session-persistence',
  ];
  return new Promise((resolve) => {
    let settled = false;
    let buf = '';
    const child = spawn(claude, args, { cwd: os.tmpdir(), env, stdio: ['pipe', 'pipe', 'ignore'] });
    const finish = (v: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
      // No prompt was sent, so a closed stdin ends the session; a stuck one is killed.
      child.stdin.end();
      setTimeout(() => child.exitCode === null && child.signalCode === null && child.kill('SIGKILL'), 10_000).unref();
    };
    const timer = setTimeout(() => finish(null), TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const res = msg?.type === 'control_response' ? msg.response : undefined;
        if (res?.request_id === 'usage') finish(res.subtype === 'success' ? (res.response ?? null) : null);
      }
    });
    child.on('error', () => finish(null));
    child.on('close', () => finish(null));
    child.stdin.on('error', () => {});
    child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'usage', request: { subtype: 'get_usage', skip_behaviors: true } }) + '\n');
  });
}

/** One window of Codex's `account/rateLimits/read`: usedPercent, windowDurationMins, resetsAt (seconds). */
function codexWindow(label: string, w: any): PlanWindow | null {
  if (typeof w?.usedPercent !== 'number' || !Number.isFinite(w.usedPercent)) return null;
  const mins = w.windowDurationMins;
  const name = typeof mins === 'number' && mins > 0 ? (mins >= 7 * 24 * 60 ? 'Week' : mins % 60 === 0 ? `${mins / 60}h session` : `${mins}m`) : label;
  return { label: name, pct: Math.max(0, Math.min(100, w.usedPercent)), resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt * 1000 : undefined };
}

/**
 * Codex's own numbers: `codex app-server` answers `account/rateLimits/read` over JSON-RPC on stdio,
 * as the Codex app shows them. Asking starts no conversation. Null when Codex isn't signed in
 * with ChatGPT or couldn't answer.
 */
function askCodex(bin: string, env: Record<string, string>): Promise<PlanLimits['codex'] | null> {
  return new Promise((resolve) => {
    let settled = false;
    let buf = '';
    let plan: string | undefined;
    // npm's codex.cmd shim on Windows needs a shell to run.
    const shim = process.platform === 'win32' && /.(cmd|bat)$/i.test(bin);
    const child = spawn(shim ? `"${bin}"` : bin, ['app-server'], { cwd: os.tmpdir(), env, stdio: ['pipe', 'pipe', 'ignore'], shell: shim, windowsHide: true });
    const finish = (v: PlanLimits['codex'] | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
      child.stdin.end();
      child.kill();
      setTimeout(() => child.exitCode === null && child.signalCode === null && child.kill('SIGKILL'), 2_000).unref();
    };
    const timer = setTimeout(() => finish(null), TIMEOUT_MS);
    const send = (m: object) => child.stdin.write(JSON.stringify(m) + '\n');
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg?.id === 1) {
          send({ jsonrpc: '2.0', method: 'initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read' });
        } else if (msg?.method === 'account/updated' && typeof msg.params?.planType === 'string') {
          plan = msg.params.planType.slice(0, LABEL_MAX);
        } else if (msg?.id === 2) {
          const rl = msg.result?.rateLimits;
          const windows = [codexWindow('5h session', rl?.primary), codexWindow('Week', rl?.secondary)].filter((w): w is PlanWindow => w !== null);
          const p = typeof rl?.planType === 'string' ? rl.planType.slice(0, LABEL_MAX) : plan;
          finish(windows.length ? { plan: p, windows, at: Date.now() } : null);
        }
      }
    });
    child.on('error', () => finish(null));
    child.on('close', () => finish(null));
    child.stdin.on('error', () => {});
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'agent-office', version: '0.1' } } });
  });
}
