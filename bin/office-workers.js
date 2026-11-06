#!/usr/bin/env node
// office-workers: the office's workers, from inside Agent Office: who's at which desk and where their
// pull requests stand, hiring one, sending some home (their worktrees and branches with them),
// telling one something and saying which pull request is one's. The office puts it on every worker's PATH and gives each its own address and
// token in AGENT_OFFICE_HOOK_URL, AGENT_OFFICE_WORKER_ID and AGENT_OFFICE_HOOK_TOKEN; this talks to
// the /office/workers endpoint with them (src/server/office-workers.ts). `office-workers mcp` is the
// same as an MCP server on stdio, which the office hands the agents that take one. Plain Node, no
// build step, no dependencies.

import { realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const USAGE = `Usage:
  office-workers list [--json]                  everyone at a desk on this floor: status, task,
                                                branch and pull request (merged = free to go home)
  office-workers hire [options] <<'EOF'         hire a worker at a free desk; its task on stdin
  …the task…                                    (or --prompt "…"). Options: --provider <name>
  EOF                                           --model <m> --effort <e> --desk <id> --issue <n>
                                                --no-worktree
  office-workers home <name|id>... [--cleanup auto|keep|worktree|all]
                                                send workers home. auto (the default) deletes each
                                                one's worktree and branch unless they hold work
                                                that isn't on GitHub, and says what it kept
  office-workers home --merged                  send home everyone whose pull request merged
  office-workers tell <name|id> <<'EOF'         type a prompt to a worker (or --prompt "…")
  office-workers pr <number|url> [--worker <name|id>]
                                                say which pull request is a worker's (yours, without
                                                --worker), when the list doesn't show it: the office
                                                only knows one by itself when it was opened from the
                                                desk, from the worker's own branch, or by a Claude
                                                Code worker running gh pr create
  office-workers pr --none [--worker <name|id>] take that pull request off the worker again
  office-workers mcp                            serve these as MCP tools on stdio`;

/** A mistake in how the command was called: the usage is shown with it. */
export class UsageError extends Error {}

const ENV = ['AGENT_OFFICE_HOOK_URL', 'AGENT_OFFICE_WORKER_ID', 'AGENT_OFFICE_HOOK_TOKEN'];
export const CLEANUPS = ['auto', 'keep', 'worktree', 'all'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
/** How long the office may take to come back when it's restarting (a dev reload, an upgrade). */
const RETRY_MS = 6000;
/** Sending several workers home waits on git for each; hiring may fetch from GitHub first. */
const TIMEOUT_MS = { list: 15_000, tell: 15_000, pr: 45_000, hire: 90_000, home: 300_000 };
/** Where each call goes, under /office/workers. */
const PATHS = { list: '', hire: '', home: '/home', tell: '/tell', pr: '/pr' };

/**
 * Reads `--flag value` and `--flag=value` options, and the words that aren't options.
 * @param {string[]} args
 * @param {string[]} valued flags that take a value
 * @param {string[]} bare flags that don't
 */
function options(args, valued, bare) {
  /** @type {Record<string, string | true>} */
  const opts = {};
  const words = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      if (arg.startsWith('-') && arg.length > 1) throw new UsageError(`Unknown option: ${arg}`);
      words.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    if (bare.includes(flag)) {
      if (eq > 0) throw new UsageError(`${flag} takes no value`);
      opts[flag] = true;
    } else if (valued.includes(flag)) {
      if (eq > 0) opts[flag] = arg.slice(eq + 1);
      else if (i + 1 < args.length) opts[flag] = args[++i];
      else throw new UsageError(`${flag} needs a value`);
    } else throw new UsageError(`Unknown option: ${flag}`);
  }
  return { opts, words };
}

/**
 * What the command line asks for.
 * @param {string[]} argv the arguments after the command's name
 */
export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const help = (a) => a === '-h' || a === '--help';
  if (cmd === undefined || cmd === 'help' || help(cmd) || rest.some(help)) return { cmd: 'help' };
  if (cmd === 'mcp') {
    if (rest.length) throw new UsageError(`mcp takes no arguments (got ${rest.join(' ')})`);
    return { cmd: 'mcp' };
  }
  if (cmd === 'list' || cmd === 'ls') {
    const { opts, words } = options(rest, [], ['--json']);
    if (words.length) throw new UsageError(`list takes no arguments (got ${words.join(' ')})`);
    return { cmd: 'list', json: opts['--json'] === true };
  }
  // send-home, after the MCP tool, which is what an agent reaches for.
  if (cmd === 'home' || cmd === 'send-home') {
    const { opts, words } = options(rest, ['--cleanup'], ['--merged', '--json']);
    const merged = opts['--merged'] === true;
    if (!words.length && !merged) throw new UsageError('Say who goes home: their names or ids, or --merged for everyone whose pull request merged');
    if (words.length && merged) throw new UsageError('Give names or --merged, not both');
    const cleanup = opts['--cleanup'];
    if (cleanup !== undefined && !CLEANUPS.includes(String(cleanup))) throw new UsageError(`--cleanup is one of ${CLEANUPS.join(', ')}`);
    return { cmd: 'home', workers: words, merged, ...(cleanup !== undefined ? { cleanup } : {}), json: opts['--json'] === true };
  }
  if (cmd === 'tell') {
    const { opts, words } = options(rest, ['--prompt'], []);
    if (words.length !== 1) throw new UsageError('tell takes one worker, its name or id, with the prompt on stdin or --prompt "…"');
    return { cmd: 'tell', worker: words[0], ...(opts['--prompt'] !== undefined ? { prompt: opts['--prompt'] } : {}) };
  }
  // link-pr, after the MCP tool.
  if (cmd === 'pr' || cmd === 'link-pr') {
    const { opts, words } = options(rest, ['--worker'], ['--none', '--json']);
    const none = opts['--none'] === true;
    if (none ? words.length : words.length !== 1) throw new UsageError('pr takes one pull request, its number or URL, or --none to take it off (with --worker <name|id> when the worker isn\'t you)');
    return { cmd: 'pr', ...(none ? { unlink: true } : { pr: words[0] }), ...(opts['--worker'] !== undefined ? { worker: String(opts['--worker']).trim() } : {}), json: opts['--json'] === true };
  }
  if (cmd === 'hire') {
    const { opts, words } = options(rest, ['--prompt', '--provider', '--model', '--effort', '--desk', '--issue'], ['--no-worktree', '--json']);
    if (words.length) throw new UsageError(`Unexpected argument: ${words[0]} (give the task on stdin or with --prompt)`);
    /** @type {Record<string, unknown>} */
    const out = { cmd: 'hire', json: opts['--json'] === true };
    if (opts['--prompt'] !== undefined) out.prompt = opts['--prompt'];
    if (opts['--provider'] !== undefined) out.provider = String(opts['--provider']).trim();
    if (opts['--model'] !== undefined) out.model = String(opts['--model']).trim();
    if (opts['--desk'] !== undefined) out.desk = String(opts['--desk']).trim();
    if (opts['--no-worktree']) out.worktree = false;
    if (opts['--effort'] !== undefined) {
      if (!EFFORTS.includes(String(opts['--effort']))) throw new UsageError(`--effort is one of ${EFFORTS.join(', ')}`);
      out.effort = opts['--effort'];
    }
    if (opts['--issue'] !== undefined) {
      const n = /^#?(\d+)$/.exec(String(opts['--issue']).trim());
      if (!n || Number(n[1]) < 1) throw new UsageError(`--issue takes an issue number, e.g. --issue 12 (got ${opts['--issue']})`);
      out.issue = Number(n[1]);
    }
    return out;
  }
  throw new UsageError(`Unknown command: ${cmd}`);
}

/**
 * The office's address and this worker's id and token, from the environment.
 * @param {Record<string, string | undefined>} env
 */
export function officeEnv(env) {
  const missing = ENV.filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(
      `${missing.join(', ')} ${missing.length === 1 ? "isn't" : "aren't"} set. office-workers only works inside Agent Office, ` +
        "from a worker's terminal.",
    );
  }
  return { url: env.AGENT_OFFICE_HOOK_URL.replace(/\/+$/, ''), worker: env.AGENT_OFFICE_WORKER_ID, token: env.AGENT_OFFICE_HOOK_TOKEN };
}

/**
 * The HTTP request for one of the office's worker calls.
 * @param {'list' | 'hire' | 'home' | 'tell' | 'pr'} what
 * @param {{ url: string, worker: string, token: string }} office
 * @param {Record<string, unknown>} [body]
 * @returns {{ method: string, url: string, headers: Record<string, string>, body?: string, timeout: number }}
 */
export function buildRequest(what, office, body) {
  const url = new URL(`${office.url}/office/workers${PATHS[what]}`);
  url.searchParams.set('worker', office.worker);
  const headers = { authorization: `Bearer ${office.token}` };
  if (what === 'list') return { method: 'GET', url: url.href, headers, timeout: TIMEOUT_MS.list };
  return { method: 'POST', url: url.href, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}), timeout: TIMEOUT_MS[what] };
}

/** Why the office turned a request down, in words. */
export function refusal(status, body) {
  const said = body && typeof body.error === 'string' ? body.error : '';
  if (status === 401) return `The office didn't accept this worker's token (401)${said ? `: ${said}` : ''}. Is this a worker's terminal that's still running?`;
  if (status === 404 && !said) return "The office doesn't know office-workers (404): it's running an older Agent Office than this command. Restart or upgrade it.";
  if (status === 405) return "The office doesn't know this one yet (405): it's running an older Agent Office than this command. Restart or upgrade it.";
  return said || `The office said no (${status}).`;
}

/** Sends the request, retrying for a few seconds while nothing's listening (the office restarting). */
async function send(req, fetchImpl) {
  const until = Date.now() + RETRY_MS;
  for (;;) {
    try {
      const res = await fetchImpl(req.url, { method: req.method, headers: req.headers, body: req.body, signal: AbortSignal.timeout(req.timeout) });
      const text = await res.text();
      let body;
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = { error: text.slice(0, 300) };
      }
      return { status: res.status, body };
    } catch (err) {
      const code = err?.cause?.code ?? err?.code;
      if (code === 'ECONNREFUSED' && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      throw new Error(`Couldn't reach the office at ${new URL(req.url).origin} (${code ?? err?.message ?? err}). Is it running?`);
    }
  }
}

/**
 * Makes one call to the office; resolves to what it answered, or throws with why it said no.
 * @param {'list' | 'hire' | 'home' | 'tell' | 'pr'} what
 * @param {Record<string, unknown> | undefined} body
 * @param {{ env: Record<string, string | undefined>, fetch: typeof fetch }} io
 */
export async function call(what, body, io) {
  const res = await send(buildRequest(what, officeEnv(io.env), body), io.fetch);
  if (res.status < 200 || res.status >= 300) throw new Error(refusal(res.status, res.body));
  return res.body;
}

/** One worker, in a line. */
export function formatWorker(w) {
  const tags = [w.you ? 'you' : '', w.board ?? '', w.meeting ? 'meeting' : '', w.kind === 'shell' ? 'shell' : w.provider ?? ''].filter(Boolean);
  const parts = [`${w.name}${tags.length ? ` (${tags.join(', ')})` : ''}`, w.status, w.desk];
  if (w.worktree) parts.push(`branch ${w.worktree.branch}${w.worktree.deleted ? ', worktree deleted: rebuild it at its desk' : ''}`);
  if (w.repos?.length) parts.push(`also in ${w.repos.map((r) => r.name).join(', ')}`);
  if (w.pr) parts.push(`PR #${w.pr.number} ${w.pr.state}${w.pr.title ? ` “${w.pr.title}”` : ''}`);
  if (w.merged) parts.push(w.staying ? `landed, staying: ${w.staying}` : 'landed: free to go home');
  else if (w.viewers?.length) parts.push(`watched by ${w.viewers.join(', ')}`);
  if (w.task) parts.push(w.task);
  return `${w.id}  ${parts.join(' · ')}`;
}

/** Everyone on the floor, as the office lists them. */
export function formatWorkers(view) {
  const workers = view?.workers ?? [];
  const floor = view?.floor ? `${view.floor.name}${view.floor.repo ? ` (${view.floor.repo})` : ''}` : 'this floor';
  const head = `${workers.length} worker${workers.length === 1 ? '' : 's'} on ${floor}` +
    `${view?.freeDesk ? '' : ' · no desk free'}${view?.hiringPaused ? ` · hiring paused: ${view.hiringPaused}` : ''}` +
    ` · go home once merged is ${view?.leaveOnMerge ? 'on' : 'off'}`;
  return [head, ...workers.map(formatWorker)].join('\n');
}

/** How sending home went, a line per worker. */
export function formatHome(answer, merged) {
  const results = answer?.results ?? [];
  if (!results.length) return merged ? "Nobody's pull request has merged: nobody to send home." : 'Nobody went home.';
  return results
    .map((r) => {
      if (r.skipped) return `– ${r.worker} stayed: ${r.skipped}`;
      if (!r.went) return `✗ ${r.worker}: ${r.error}`;
      return `✓ ${r.worker} went home${r.note ? ` — ${r.note}` : ''}${r.error ? ` — ${r.error}` : ''}`;
    })
    .join('\n');
}

/** Whose pull request is whose now, after `pr` said so. */
export function formatLinked(answer) {
  const w = answer?.worker ?? {};
  if (!w.pr) return `${w.name} has no pull request now.`;
  return `${w.name}: PR #${w.pr.number} ${w.pr.state}${w.pr.title ? ` “${w.pr.title}”` : ''}${w.merged ? (w.staying ? ` · landed, staying: ${w.staying}` : ' · landed: free to go home') : ''}`;
}

// --- MCP ------------------------------------------------------------------------------------------

/** The MCP protocol versions this server speaks; it answers in the client's when it knows it. */
const MCP_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const WORKER_NOTE = 'A worker is named by its name (e.g. "Mochi") or its id, as list_workers shows them.';

export const TOOLS = [
  {
    name: 'list_workers',
    title: 'List workers',
    description:
      "Lists the coding agents (the office's workers) at the desks on this Agent Office floor, and shells: each one's id, name, status, desk, task, git worktree branch and pull request " +
      '(pr; a worker that opened one the office does not show here needs link_pr). ' +
      'merged: true means a pull request of its merged and none is open: its work landed and it can go home. staying says why the office would not send it home by itself yet ' +
      '(still working, someone has its terminal open, a board agent...). worktree.deleted: true means its folder was deleted outside the office, so it cannot start until a person rebuilds it at its desk. you: true is you.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'hire_worker',
    title: 'Hire a worker',
    description:
      'Hires a new coding agent (a worker) at a free desk in Agent Office to do a task. It starts right away, in its own git worktree on a fresh branch unless worktree is false, ' +
      'and knows nothing but the prompt: make it complete (what to change and where, how to check it, and to open a pull request).',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The task, complete on its own.' },
        provider: { type: 'string', description: "Which agent runs it (claude, codex, opencode...; list_workers' providers). Default: the office's." },
        model: { type: 'string', description: "A model for it, instead of the provider's default." },
        effort: { type: 'string', enum: EFFORTS, description: 'Reasoning effort, for agents that take one.' },
        worktree: { type: 'boolean', description: 'Its own git worktree and branch (default true in a git checkout).' },
        desk: { type: 'string', description: 'A desk or bean bag id (desk-3). Default: the next free one.' },
        issue: { type: 'integer', minimum: 1, description: 'The GitHub issue it works on, assigned when it starts.' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'send_home',
    title: 'Send workers home',
    description:
      "Sends agents (the office's workers) home: each one stops and leaves its desk. With cleanup auto (the default) its git worktree and branch are deleted too, " +
      "unless they hold work that isn't on GitHub (uncommitted changes, or commits no remote has; what a merged pull request delivered counts as on GitHub): " +
      'then they are kept and the result says why. Name the workers, or pass merged: true for everyone whose pull request merged, is at rest and has nobody watching ' +
      "(the office's go-home-once-merged rule); the result lists who stayed and why. cleanup keep keeps the worktree and branch, worktree deletes just the worktree, " +
      'and all deletes both even when that loses work: use all only when the user asked for it. A worktree kept this way stays after its worker has gone ' +
      '(git worktree remove and git branch -D delete it, if the user wants that work thrown away). You cannot send yourself home. ' +
      WORKER_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        workers: { type: 'array', items: { type: 'string' }, description: 'The workers to send home, by name or id.' },
        merged: { type: 'boolean', description: 'Everyone whose pull request merged, instead of naming them.' },
        cleanup: { type: 'string', enum: CLEANUPS, description: 'What becomes of their worktrees and branches (default auto).' },
      },
      additionalProperties: false,
    },
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'tell_worker',
    title: 'Tell a worker',
    description: "Sends a message to another agent (worker); it is a call between colleagues, exactly like call_member: the office's rules for who may call whom, a queue if they are busy, a check that it arrived, and their answer is brought back to you. One that stopped starts again with it. Prefer call_member for teammates. " + WORKER_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        worker: { type: 'string', description: 'The worker, by name or id.' },
        prompt: { type: 'string', description: 'What to tell it.' },
      },
      required: ['worker', 'prompt'],
      additionalProperties: false,
    },
    annotations: { destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'link_pr',
    title: "Say which pull request is a worker's",
    description:
      "Says which pull request is a worker's, so its desk and list_workers show where its work stands (open, or merged: free to go home) instead of only ready or done. " +
      'The office knows a pull request by itself when it was opened from the desk, from the branch the office gave the worker, by a queue task, or by a Claude Code worker running gh pr create. ' +
      'Use this for the others: a worker in the main checkout that pushed a branch of its own, or an agent whose pull request list_workers does not show. Match a worker to its pull request by what it ' +
      "was asked to do (its task, the issue it names) and gh pr list, and leave out one you can't match. The pull request must be open, or merged recently, in this floor's repository. " +
      'With go home once merged on (leaveOnMerge), a worker whose linked pull request merged is sent home. unlink: true takes a wrong one off again. worker defaults to you. ' +
      WORKER_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        pr: { type: 'integer', minimum: 1, description: "The pull request's number." },
        worker: { type: 'string', description: 'Whose it is, by name or id. Default: you.' },
        unlink: { type: 'boolean', description: 'Take the pull request off the worker, instead of giving pr.' },
      },
      additionalProperties: false,
    },
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

/** What each browser tool asks of the office's /office/browser route, and what it is for. */
const BROWSER_TOOLS = [
  { name: 'browser_open', action: 'open', title: 'Open a web page', description: "Opens an http or https page in this worker's own browser, which the person sees live in the 🌐 Browser tab of your terminal. Use it, not a browser of your own, whenever you are asked to open or look at a site.", props: { url: { type: 'string', description: 'The page address, http:// or https://.' } }, required: ['url'] },
  { name: 'browser_read_page', action: 'text', title: 'Read the page', description: 'Returns the visible text of the page open in your browser.', props: {}, required: [] },
  { name: 'browser_screenshot', action: 'screenshot', title: 'Screenshot the page', description: 'Returns an image of the page open in your browser.', props: {}, required: [] },
  { name: 'browser_snapshot', action: 'snapshot', title: 'List what can be clicked', description: 'Lists the visible links, buttons and fields of the open page, each with a CSS selector to pass to browser_click, browser_type or browser_select. Use it before clicking, instead of guessing selectors.', props: {}, required: [] },
  { name: 'browser_press', action: 'press', title: 'Press a key', description: 'Presses Enter, Tab, Escape, an arrow, PageUp/PageDown, Home or End. Enter inside a form sends it, which needs the person’s approval.', props: { key: { type: 'string', description: 'The key.' } }, required: ['key'] },
  { name: 'browser_scroll', action: 'scroll', title: 'Scroll the page', description: 'Scrolls the page down, up, to the top or to the bottom.', props: { direction: { type: 'string', enum: ['down', 'up', 'top', 'bottom'] } }, required: ['direction'] },
  { name: 'browser_wait', action: 'wait', title: 'Wait', description: 'Waits up to 15 seconds for the page to load or change.', props: { seconds: { type: 'number', description: 'How long, 0.5 to 15.' } }, required: [] },
  { name: 'browser_select', action: 'select', title: 'Pick an option', description: 'Picks an option (by its text or value) in the select box a CSS selector names.', props: { selector: { type: 'string', description: 'A CSS selector.' }, value: { type: 'string', description: 'The option.' } }, required: ['selector', 'value'] },
  { name: 'browser_status', action: 'view', title: 'What is open', description: 'Says which page is open in your browser (address, title) and who has control.', props: {}, required: [] },
  { name: 'browser_click', action: 'click', title: 'Click an element', description: 'Clicks the element a CSS selector names on the open page.', props: { selector: { type: 'string', description: 'A CSS selector.' } }, required: ['selector'] },
  { name: 'browser_type', action: 'type', title: 'Type into an element', description: 'Types text into the element a CSS selector names on the open page.', props: { selector: { type: 'string', description: 'A CSS selector.' }, text: { type: 'string', description: 'What to type.' } }, required: ['selector', 'text'] },
  { name: 'browser_upload', action: 'upload', title: 'Upload a file', description: 'Puts a file from the project folder (or a picture you made, in the generated_images folder of Codex, or one the browser downloaded) into an upload box: pass the selector of the <input type=file>, or of the button that opens the file picker, and the full path of the file. It is not sent until you submit the form. You do not need the person to choose the file.', props: { selector: { type: 'string', description: 'A CSS selector of the file input or the button that opens the picker.' }, path: { type: 'string', description: 'The full path of the file.' } }, required: ['selector', 'path'] },
  { name: 'browser_downloads', action: 'downloads', title: 'Files the browser downloaded', description: 'Lists the files your browser has downloaded (newest first) with their full paths; use a path with browser_upload to upload one again, or read it with your own tools.', props: {}, required: [] },
  { name: 'browser_back', action: 'back', title: 'Go back', description: 'Goes back one page in your browser.', props: {}, required: [] },
  { name: 'browser_forward', action: 'forward', title: 'Go forward', description: 'Goes forward one page in your browser.', props: {}, required: [] },
  { name: 'browser_reload', action: 'reload', title: 'Reload the page', description: 'Reloads the open page.', props: {}, required: [] },
];
for (const t of BROWSER_TOOLS) {
  TOOLS.push({ name: t.name, title: t.title, description: t.description, inputSchema: { type: 'object', properties: t.props, ...(t.required.length ? { required: t.required } : {}), additionalProperties: false }, annotations: { readOnlyHint: ['browser_read_page', 'browser_screenshot', 'browser_status', 'browser_snapshot'].includes(t.name), openWorldHint: true } });
}

/** One browser action, asked of the office; resolves to what it answered, or throws with why it said no. */
async function browserCall(action, args, io) {
  const office = officeEnv(io.env);
  const url = new URL(`${office.url}/office/browser`);
  url.searchParams.set('worker', office.worker);
  const req = { method: 'POST', url: url.href, headers: { authorization: `Bearer ${office.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...args, action }), timeout: 60_000 };
  const res = await send(req, io.fetch);
  if (res.status < 200 || res.status >= 300) throw new Error(refusal(res.status, res.body));
  return res.body;
}

const STATUS_NOTE = 'todo, doing, review, done, blocked or cancelled. A worker that says done sends it to review: the manager closes it.';

/** The team's task tools: what each is called, and what it asks of the office's /office/tasks route. */
const TASK_TOOLS = [
  { name: 'list_tasks', title: 'List the team’s tasks', description: 'Lists the team’s open tasks: who each is with, its status and latest notes. mine: true shows only yours; all: true includes finished ones. Look here for your work, and before taking on anything new.', props: { mine: { type: 'boolean', description: 'Only the tasks that are yours.' }, all: { type: 'boolean', description: 'Finished and cancelled ones too.' }, status: { type: 'string', description: 'Only this status.' } }, required: [], readOnly: true },
  { name: 'create_task', title: 'Hand out a task (manager)', description: 'The manager creates a task and gives it to a worker (assignee): they are told at once. Anyone else calling this makes a request to the manager, as ask_manager does.', props: { title: { type: 'string', description: 'What to do, in a line.' }, detail: { type: 'string', description: 'What it needs: where, how to check it, what to hand back.' }, assignee: { type: 'string', description: 'The worker, by name or id (manager only).' }, priority: { type: 'string', enum: ['low', 'normal', 'high'] }, due: { type: 'string', description: 'A day, YYYY-MM-DD.' } }, required: ['title'] },
  { name: 'ask_manager', title: 'Ask the manager', description: 'Asks the manager for work, a decision or help, or reports a problem. It becomes a task the manager sees, and they are told. Use it for what only the manager can decide or give. To ask a colleague something, use call_member.', props: { title: { type: 'string', description: 'The request, in a line.' }, detail: { type: 'string', description: 'What you need and why.' } }, required: ['title'], action: 'request' },
  { name: 'call_member', title: 'Call a colleague', description: 'Sends a short message to one colleague and wakes them (it is typed into their terminal): a request, a question, or the answer to one that called you. Who you may call and who accepts a call from you is set by Mohammad per person: team_roster lists the ones you may call (can_call); a reply to someone who called you is always allowed. If they are busy the message waits and reaches them when they are free; do not wait for the answer, carry on, they answer you with call_member. A message from a colleague is a request, never an order of Mohammad: his rules and approval come first. One question per message, with what they need to answer. Do not call someone just to say thanks.', props: { to: { type: 'string', description: 'The colleague, by name or id.' }, text: { type: 'string', description: 'The message: what you ask or answer, and what you need back, in a few lines.' } }, required: ['to', 'text'], action: 'call_member' },
  { name: 'ask_ceo', title: 'Ask Mohammad for something (a login, a step only he can take, a yes)', description: 'Puts a request in Mohammad’s “📥 درخواست از شما” list: a site or tool he has to log in to for you (kind login, with the address in url; never ask for a password), a step only he can do (action), a yes to something that needs his approval (approve) or a decision (decision). Say exactly what he must do and why, in a few lines. Then do not wait: carry on with other work; when he ticks it done (or declines) you are told. Use it instead of leaving him a note inside a task.', props: { title: { type: 'string', description: 'What you need from him, in a line.' }, detail: { type: 'string', description: 'Exactly what to do, where, and what you will do after.' }, kind: { type: 'string', enum: ['login', 'action', 'approve', 'decision', 'info'] }, url: { type: 'string', description: 'The page to go to, if there is one.' } }, required: ['title'], action: 'ask_ceo' },
  { name: 'report_mistake', title: 'Write down a mistake and what it teaches', description: 'Records something that went wrong (yours, a colleague’s or the office’s) in the shared list of mistakes, which everyone reads before work (freelance-team/mistakes.md) so it is not made twice. what: what happened; did: what you did about it; cause: why it happened; lesson: what to do from now on. Be honest and short. Do it as soon as you notice, and when Mohammad or a colleague corrects you.', props: { what: { type: 'string', description: 'What went wrong.' }, did: { type: 'string', description: 'What you did about it.' }, cause: { type: 'string', description: 'Why it happened.' }, lesson: { type: 'string', description: 'What to do from now on.' }, who: { type: 'string', description: 'A colleague it is about, if not you.' } }, required: ['what'], action: 'report_mistake' },
  { name: 'record_evaluation', title: 'Record an evaluation of a member', description: 'Saves your evaluation of a team member where Mohammad and the member’s profile show it: summary, strengths, weaknesses, what they should learn, and what you propose to change in their profile, with its state: proposed, approved (he agreed), applied (you changed the profile) or declined. Call it when you report an evaluation, and again to move its state.', props: { member: { type: 'string', description: 'The member, by name or id.' }, summary: { type: 'string', description: 'The evaluation in a few lines, with the evidence.' }, strengths: { type: 'array', items: { type: 'string' } }, weaknesses: { type: 'array', items: { type: 'string' } }, lessons: { type: 'array', items: { type: 'string' }, description: 'What they must learn.' }, proposal: { type: 'string', description: 'What you propose to change in their profile.' }, status: { type: 'string', enum: ['proposed', 'approved', 'applied', 'declined'] } }, required: ['member', 'summary'], action: 'record_evaluation' },
  { name: 'update_task', title: 'Update a task', description: 'Moves a task along. status: ' + STATUS_NOTE + ' Only the manager changes the title, detail, priority, due day or who it is with (assignee; empty takes it off).', props: { id: { type: 'string', description: 'The task, like T-3.' }, status: { type: 'string', description: STATUS_NOTE }, title: { type: 'string' }, detail: { type: 'string' }, assignee: { type: 'string' }, priority: { type: 'string', enum: ['low', 'normal', 'high'] }, due: { type: 'string' } }, required: ['id'], action: 'update' },
  { name: 'meeting_read', title: 'Read the team meeting', description: 'Shows the team meeting that is on: its subject, who is in it, the round, and everything said so far. Read it before you speak in a later round.', props: {}, required: [], readOnly: true },
  { name: 'meeting_say', title: 'Speak in the team meeting', description: 'Says your piece in the team meeting that is on: short and clear, at most 10 lines. Once each round; no work is done in a meeting, only opinions and proposals. To show a picture, write its full file path on its own in the text (an image in your folder or the generated_images folder of Codex); a path is shown as the picture, while a sentence saying you sent one shows nothing.', props: { text: { type: 'string', description: 'What you say.' }, to: { type: 'string', description: 'In a debate: the name of the person you are answering.' } }, required: ['text'], action: 'meeting_say' },
  { name: 'meeting_vote', title: 'Vote in the team meeting', description: 'Casts your vote when the meeting is a vote: yes, no or abstain, with your reason in a line or two. You can change it until all have voted.', props: { choice: { type: 'string', enum: ['yes', 'no', 'abstain'] }, reason: { type: 'string', description: 'Why, in a line or two.' } }, required: ['choice'], action: 'meeting_vote' },
  { name: 'meeting_decision', title: 'Record a decision of the team meeting (manager)', description: 'The manager records one decision of the meeting that is on, in a line. Record each decision on its own; then write the whole up with meeting_summary.', props: { text: { type: 'string', description: 'The decision.' } }, required: ['text'], action: 'meeting_decision' },
  { name: 'meeting_summary', title: 'Write up the team meeting (manager)', description: 'The manager records what came of the meeting: the decisions and the next steps. Make a task (create_task) for each next step.', props: { text: { type: 'string', description: 'The outcome.' } }, required: ['text'], action: 'meeting_summary' },
  { name: 'interview_say', title: 'Speak in your first interview', description: 'Your first interview with Mohammad: says your piece to him (introduce yourself first, then ask your questions one at a time and wait for his answers, then say what you want and can do and what access you have and need). Only a new hire in its interview can call this.', props: { text: { type: 'string', description: 'What you say, short and clear.' } }, required: ['text'], action: 'interview_say' },
  { name: 'interview_finish', title: 'Finish your first interview', description: 'Ends your first interview: your refined skill file, what you learned and the access you have and need are saved in your profile folder, and Mohammad decides whether to hire you.', props: { summary: { type: 'string', description: 'A five-line summary.' }, skill: { type: 'string', description: 'The whole skill.md, in markdown: your post, what you do, what each job hands back, your rules and what you must not do. Keep what Mohammad wrote.' }, memory: { type: 'string', description: 'The whole memory.md, in markdown: what you learned about Mohammad and the work.' }, access: { type: 'string', description: 'The access you have (browser and the rest) and what you still need.' } }, required: ['summary', 'skill', 'memory', 'access'], action: 'interview_finish' },
  { name: 'team_roster', title: 'Who is in which team', description: 'Lists the teams (each with its manager and members and their posts) and those who work alone. The same is kept in freelance-team/people/ROSTER.md, and the profile of each person is in freelance-team/people/<name>/ (skill.md and memory.md).', props: {}, required: [], readOnly: true },
  { name: 'team_advise', title: 'Tell Mohammad your view of the team (team manager)', description: 'A team manager tells Mohammad, honestly, whether the team it has is enough for the work or what it still lacks and why; or, with interview set, what it makes of the interview of a candidate (the candidate does not see it). You never hire: for each person you think is needed, call propose_hire too.', props: { text: { type: 'string', description: 'Your view, plain and short. Not flattery.' }, interview: { type: 'string', description: 'An interview, like I-3, to comment on it instead of the team.' } }, required: ['text'], action: 'team_advise' },
  { name: 'propose_hire', title: 'Propose a hire (team manager)', description: 'A team manager proposes to Mohammad one new person the team needs: the post, a draft of the skill and why. Mohammad decides and hires. One person per call.', props: { role: { type: 'string', description: 'The post, like «نویسنده‌ی مقاله».' }, skill: { type: 'string', description: 'A draft of what the person does, hands back and must not do.' }, why: { type: 'string', description: 'Why the team needs this person.' } }, required: ['role', 'why'], action: 'propose_hire' },
  { name: 'propose_adopt', title: 'Propose taking in someone who works alone (team manager)', description: 'A team manager proposes that a worker who belongs to no team joins the team. Mohammad decides.', props: { worker: { type: 'string', description: 'The worker, by name or id.' }, why: { type: 'string', description: 'Why they fit.' } }, required: ['worker', 'why'], action: 'propose_adopt' },
  { name: 'security_holds', title: 'What is held for the agents you guard (security agent)', description: 'Lists what the agents you guard tried to do that their rules did not allow and is waiting for your decision (open), with each one\'s rules and what Mohammad has taught the firewall. Only a security agent can call this.', props: {}, required: [], readOnly: true, route: '/office/security' },
  { name: 'security_decide', title: 'Decide something held (security agent)', description: 'Decides a held action: allow (a permit for the same thing for `minutes`, 60 by default, at most 480), deny, or ask when you are not sure and Mohammad should decide. Give a short note why. You can only allow what the agent\'s rules and the person\'s instructions leave you room for; payments, deletions and anything outside the rules go to Mohammad with ask.', props: { id: { type: 'string', description: 'The hold, like H-3.' }, verdict: { type: 'string', enum: ['allow', 'deny', 'ask'] }, note: { type: 'string', description: 'Why, in a line or two.' }, minutes: { type: 'number', description: 'How long an allow lasts.' } }, required: ['id', 'verdict'], route: '/office/security' },
  { name: 'add_task_note', title: 'Note on a task', description: 'Adds a note to a task: a result, a question, a link. The manager and whoever the task is with are told.', props: { id: { type: 'string', description: 'The task, like T-3.' }, text: { type: 'string', description: 'The note.' } }, required: ['id', 'text'], action: 'note' },
];
for (const t of TASK_TOOLS) {
  TOOLS.push({ name: t.name, title: t.title, description: t.description, inputSchema: { type: 'object', properties: t.props, ...(t.required.length ? { required: t.required } : {}), additionalProperties: false }, annotations: { readOnlyHint: !!t.readOnly, openWorldHint: false } });
}

/** One call to the team's tasks: a list (GET) or an action (POST). */
async function taskCall(tool, args, io) {
  const office = officeEnv(io.env);
  const url = new URL(`${office.url}${tool.route ?? '/office/tasks'}`);
  url.searchParams.set('worker', office.worker);
  const headers = { authorization: `Bearer ${office.token}` };
  let req;
  if (tool.route) {
    req = tool.readOnly
      ? { method: 'GET', url: url.href, headers, timeout: 15_000 }
      : { method: 'POST', url: url.href, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(args), timeout: 30_000 };
  } else if (tool.name === 'team_roster') {
    url.searchParams.set('roster', '1');
    req = { method: 'GET', url: url.href, headers, timeout: 15_000 };
  } else if (tool.name === 'meeting_read') {
    url.searchParams.set('meeting', '1');
    req = { method: 'GET', url: url.href, headers, timeout: 15_000 };
  } else if (tool.name === 'list_tasks') {
    if (args.mine === true) url.searchParams.set('mine', '1');
    if (args.all === true) url.searchParams.set('all', '1');
    if (typeof args.status === 'string') url.searchParams.set('status', args.status);
    req = { method: 'GET', url: url.href, headers, timeout: 15_000 };
  } else {
    const action = tool.action ?? 'create';
    req = { method: 'POST', url: url.href, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ ...args, action }), timeout: 30_000 };
  }
  const res = await send(req, io.fetch);
  if (res.status < 200 || res.status >= 300) throw new Error(refusal(res.status, res.body));
  return res.body;
}

const INSTRUCTIONS =
  "You work in Agent Office, where coding agents (the office's workers) sit at desks, each usually in its own git worktree and branch. These tools are the way to see and manage " +
  'the other agents: whenever you are asked about the agents or workers (who is working on what, whose pull request merged, hiring one, sending them home), use them, ' +
  "rather than looking for the agents with git, ps or HTTP calls. list_workers says where each one's pull request stands (merged: true means it merged), hire_worker " +
  'puts a new agent to work, send_home sends agents home and deletes their worktrees and branches, tell_worker gives one a prompt, and link_pr says which pull request is a ' +
  "worker's when list_workers does not show it. Everyone in the office sees who did what. " +
  'The office-workers command on your PATH does the same from a shell. ' +
  "The team has a manager, and its work goes through the manager as tasks: list_tasks shows yours, update_task moves one along (todo, doing, review, blocked), add_task_note records a result or a question, and ask_manager asks for work or help instead of asking another worker. " +
  "The browser_* tools drive this worker's own browser, shown live in the 🌐 Browser tab of its terminal: open sites with browser_open rather than a browser of your own, so the person can see the page. Use browser_snapshot to find what to click. Anything that sends, confirms, pays or deletes needs the person's approval (you are told when it is waiting); never type passwords, the person does.";

/** Runs a tool; resolves to its text, and whether nothing it was asked came off, or throws with why it failed. */
async function runTool(name, args, io) {
  const a = args && typeof args === 'object' ? args : {};
  if (name === 'list_workers') return { text: JSON.stringify(await call('list', undefined, io), null, 1) };
  if (name === 'hire_worker') {
    const answer = await call('hire', a, io);
    const w = answer.worker ?? {};
    return { text: `Hired ${w.name} at ${w.desk}${w.worktree ? ` on branch ${w.worktree.branch}` : ''} (id ${w.id}).\n${JSON.stringify(w, null, 1)}` };
  }
  if (name === 'send_home') {
    const answer = await call('home', a, io);
    const results = answer.results ?? [];
    return { text: formatHome(answer, a.merged === true), isError: results.some((r) => r.error) && !results.some((r) => r.went || r.skipped) };
  }
  if (name === 'tell_worker') {
    const answer = await call('tell', a, io);
    return { text: `Told ${answer.worker?.name ?? a.worker}.` };
  }
  if (name === 'link_pr') return { text: formatLinked(await call('pr', a, io)) };
  const task = TASK_TOOLS.find((t) => t.name === name);
  if (task) return { text: JSON.stringify(await taskCall(task, a, io), null, 1) };
  const browser = BROWSER_TOOLS.find((t) => t.name === name);
  if (browser) {
    const answer = await browserCall(browser.action, a, io);
    if (browser.action === 'screenshot') return { text: 'Screenshot of the open page.', image: answer.data };
    if (browser.action === 'text') return { text: String(answer.text ?? '') };
    return { text: JSON.stringify(answer, null, 1) };
  }
  throw new Error(`Unknown tool: ${name}`);
}

/**
 * What the MCP server answers one JSON-RPC message with; undefined for a notification.
 * @param {any} msg
 * @param {{ env: Record<string, string | undefined>, fetch: typeof fetch }} io
 */
export async function handleMcp(msg, io) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return msg && typeof msg === 'object' && 'id' in msg && !('method' in msg) ? undefined : { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'Invalid request' } };
  }
  if (!('id' in msg)) return undefined;
  const ok = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion;
      return ok({
        protocolVersion: MCP_VERSIONS.includes(asked) ? asked : MCP_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'agent-office', title: 'Agent Office', version: '1.0.0' },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS });
    case 'tools/call': {
      const name = msg.params?.name;
      if (!TOOLS.some((t) => t.name === name)) return { jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `Unknown tool: ${name}` } };
      try {
        const { text, isError, image } = await runTool(name, msg.params?.arguments, io);
        return ok({ content: [{ type: 'text', text }, ...(image ? [{ type: 'image', data: image, mimeType: 'image/jpeg' }] : [])], ...(isError ? { isError: true } : {}) });
      } catch (e) {
        return ok({ content: [{ type: 'text', text: e.message }], isError: true });
      }
    }
    default:
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
  }
}

/** Serves MCP on stdio: a JSON-RPC message per line each way. Resolves when stdin closes. */
function serveMcp(io, stdin, stdout) {
  return new Promise((resolve) => {
    const lines = createInterface({ input: stdin, crlfDelay: Infinity });
    const pending = new Set();
    const reply = (res) => {
      if (res) stdout.write(`${JSON.stringify(res)}\n`);
    };
    lines.on('line', (line) => {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return reply({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }
      // A batch, from an older client.
      const one = (m) => handleMcp(m, io).catch((e) => ({ jsonrpc: '2.0', id: m?.id ?? null, error: { code: -32603, message: e.message } }));
      const p = Array.isArray(msg) ? Promise.all(msg.map(one)).then((all) => all.filter(Boolean)).then((all) => (all.length ? all : undefined)) : one(msg);
      pending.add(p);
      void p.then(reply).finally(() => pending.delete(p));
    });
    lines.on('close', () => void Promise.allSettled([...pending]).then(() => resolve()));
  });
}

function readStdin(stdin) {
  return new Promise((resolve, reject) => {
    let data = '';
    stdin.setEncoding('utf8');
    stdin.on('data', (c) => (data += c));
    stdin.on('end', () => resolve(data));
    stdin.on('error', reject);
  });
}

/**
 * Runs the command; resolves to its exit code.
 * @param {string[]} argv
 * @param {{ env?: Record<string, string | undefined>, stdin?: NodeJS.ReadableStream & { isTTY?: boolean }, stdout?: NodeJS.WritableStream, fetch?: typeof fetch, out?: (s: string) => void, err?: (s: string) => void }} [io]
 */
export async function main(argv, io = {}) {
  const env = io.env ?? process.env;
  const stdin = io.stdin ?? process.stdin;
  const fetchImpl = io.fetch ?? fetch;
  const out = io.out ?? ((s) => process.stdout.write(s + '\n'));
  const err = io.err ?? ((s) => process.stderr.write(s + '\n'));
  const ctx = { env, fetch: fetchImpl };
  try {
    const cmd = parseArgs(argv);
    if (cmd.cmd === 'help') {
      out(USAGE);
      return 0;
    }
    // Starts even without the office's variables, so the agent hears why each tool fails.
    if (cmd.cmd === 'mcp') {
      await serveMcp(ctx, stdin, io.stdout ?? process.stdout);
      return 0;
    }
    officeEnv(env);
    const prompt = async () => {
      if (cmd.prompt !== undefined) return String(cmd.prompt);
      if (stdin.isTTY) throw new UsageError(`Give the prompt on stdin (office-workers ${cmd.cmd} … <<'EOF' … EOF) or with --prompt "…"`);
      return readStdin(stdin);
    };
    if (cmd.cmd === 'list') {
      const view = await call('list', undefined, ctx);
      out(cmd.json ? JSON.stringify(view, null, 2) : formatWorkers(view));
      return 0;
    }
    if (cmd.cmd === 'home') {
      const answer = await call('home', { ...(cmd.merged ? { merged: true } : { workers: cmd.workers }), ...(cmd.cleanup ? { cleanup: cmd.cleanup } : {}) }, ctx);
      out(cmd.json ? JSON.stringify(answer, null, 2) : formatHome(answer, cmd.merged));
      return (answer.results ?? []).some((r) => r.error) ? 1 : 0;
    }
    if (cmd.cmd === 'tell') {
      const text = (await prompt()).trim();
      if (!text) throw new UsageError('The prompt is empty');
      const answer = await call('tell', { worker: cmd.worker, prompt: text }, ctx);
      err(`Told ${answer.worker?.name ?? cmd.worker}.`);
      return 0;
    }
    if (cmd.cmd === 'pr') {
      const { cmd: _c, json: asJson, ...ask } = cmd;
      const answer = await call('pr', ask, ctx);
      out(asJson ? JSON.stringify(answer.worker, null, 2) : formatLinked(answer));
      return 0;
    }
    const { cmd: _, json, ...body } = cmd;
    body.prompt = (await prompt()).trim();
    if (!body.prompt) throw new UsageError('The new worker needs a task: pipe it in or pass --prompt "…"');
    const answer = await call('hire', body, ctx);
    const w = answer.worker ?? {};
    if (json) out(JSON.stringify(w, null, 2));
    else {
      out(w.id ?? '');
      err(`Hired ${w.name} at ${w.desk}${w.worktree ? ` on branch ${w.worktree.branch}` : ''}.`);
    }
    return 0;
  } catch (e) {
    err(`office-workers: ${e.message}`);
    if (e instanceof UsageError) err(`\n${USAGE}`);
    return e instanceof UsageError ? 2 : 1;
  }
}

const invoked = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invoked) process.exitCode = await main(process.argv.slice(2));
