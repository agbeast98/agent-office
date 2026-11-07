import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  CODEX_HOOK_EVENTS,
  codexHookArgs,
  hookCommand,
  codexModelArgs,
  codexPromptArg,
  CODEX_TOOLS_NOTE,
  normalizeCodexHook,
  validateCodexHook,
  writeCodexHook,
} from '../src/server/codex.js';
import { codex } from '../src/server/providers/codex.js';

test('normalizes bounded root Codex hook payloads and passes only the metric reader path', () => {
  assert.deepEqual(normalizeCodexHook('SessionStart', {
    session_id: 'thread-1', source: 'startup', transcript_path: '/private/transcript.jsonl', turn_id: 'turn-1',
  }), { sessionId: 'thread-1', event: 'SessionStart', source: 'startup', turnId: 'turn-1', transcriptPath: '/private/transcript.jsonl' });
  assert.deepEqual(normalizeCodexHook('UserPromptSubmit', {
    session_id: 'thread-1', prompt: '  fix the login  ', turn_id: 'turn-2', model: 'secret-model',
  }), { sessionId: 'thread-1', event: 'UserPromptSubmit', prompt: 'fix the login', turnId: 'turn-2' });
  assert.deepEqual(normalizeCodexHook('PermissionRequest', {
    session_id: 'thread-1', tool_name: 'Bash', tool_use_id: 'tool-1', tool_input: { command: 'secret' },
  }), { sessionId: 'thread-1', event: 'PermissionRequest', tool: 'Bash', toolUseId: 'tool-1' });
});

test('rejects unknown, malformed, empty, oversized, and child-scoped events', () => {
  assert.equal(validateCodexHook('Unknown', { session_id: 'x' }), false);
  assert.equal(validateCodexHook('Stop', null), false);
  assert.equal(validateCodexHook('Stop', { session_id: '' }), false);
  assert.equal(validateCodexHook('Stop', { session_id: 'x'.repeat(161) }), false);
  assert.equal(validateCodexHook('Stop', { session_id: 'x', agent_id: 'child-1' }), false);
  assert.equal(validateCodexHook('Stop', { session_id: 'x', agent_type: 'explorer' }), false);
  assert.equal(validateCodexHook('Stop', { session_id: 'x', agent_id: 'c'.repeat(161) }), false);
});

test('generates one stable CLI hook override per supported event', () => {
  const args = codexHookArgs('/tmp/office data/agent-office-codex-hook.cjs');
  assert.equal(args.length, CODEX_HOOK_EVENTS.length * 2);
  for (let i = 0; i < CODEX_HOOK_EVENTS.length; i++) {
    assert.equal(args[i * 2], '-c');
    assert.match(args[i * 2 + 1], new RegExp(`^hooks\\.${CODEX_HOOK_EVENTS[i]}=\\[\\{hooks=`));
    assert.match(args[i * 2 + 1], /type="command"/);
    assert.match(args[i * 2 + 1], /timeout=3/);
    assert.match(args[i * 2 + 1], /agent-office-codex-hook\.cjs/);
  }
});

test('on Windows the hook line starts with a bare node, which PowerShell and cmd both run', () => {
  const line = hookCommand('C:\\Users\\a b\\hook.cjs', 'Stop', 'win32');
  assert.ok(/^(node|".*") "C:\\Users\\a b\\hook\.cjs" Stop$/.test(line), line);
  assert.ok(!line.includes("'"));
  assert.match(hookCommand('/tmp/x y/hook.cjs', 'Stop', 'linux'), /^'.*' '\/tmp\/x y\/hook\.cjs' 'Stop'$/);
});

test('a worker\'s own model and effort go on Codex\'s command line, in place of an office-wide model', () => {
  assert.deepEqual(codexModelArgs([]), []);
  assert.deepEqual(codexModelArgs(['--yolo'], 'gpt-5.5', 'high'), ['--yolo', '--model', 'gpt-5.5', '-c', 'model_reasoning_effort="high"']);
  // Codex refuses --model twice: the office's --agent-args one gives way, however it was written.
  assert.deepEqual(codexModelArgs(['-m', 'gpt-6-astra', '--yolo'], 'gpt-5.5'), ['--yolo', '--model', 'gpt-5.5']);
  assert.deepEqual(codexModelArgs(['--model', 'gpt-6-astra'], 'gpt-5.5'), ['--model', 'gpt-5.5']);
  assert.deepEqual(codexModelArgs(['--model=gpt-6-astra', '-mgpt-6-astra', '--yolo'], 'gpt-5.5'), ['--yolo', '--model', 'gpt-5.5']);
  // With only an effort picked, the office-wide model stays.
  assert.deepEqual(codexModelArgs(['-m', 'gpt-6-astra'], undefined, 'xhigh'), ['-m', 'gpt-6-astra', '-c', 'model_reasoning_effort="xhigh"']);
});

test('a Codex worker starts, and resumes, on the model and effort picked for it', () => {
  const data = mkdtempSync(path.join(tmpdir(), 'codex-launch-'));
  const launch = (info: { model?: string; effort?: string }, more: { prompt?: string; resumeSessionId?: string } = {}) =>
    codex.launch({ h: { info: { id: 'w1', ...info }, state: codex.createState!() } as never, args: ['--yolo'], setup: { hook: path.join(data, 'hook.cjs') }, ...more }).args;
  const fresh = launch({ model: 'gpt-5.5', effort: 'high' }, { prompt: 'fix it' });
  assert.deepEqual(fresh.slice(0, 5), ['--yolo', '--model', 'gpt-5.5', '-c', 'model_reasoning_effort="high"']);
  assert.equal(fresh.at(-2), '--');
  // The prompt follows, with the note about the deferred tools (on Windows, as a file to read).
  assert.match(String(fresh.at(-1)), /tool_search/);
  assert.equal(String(fresh.at(-1)).includes('fix it') || process.platform === 'win32', true);
  // Its options come before the `resume` subcommand, which then takes the session.
  const resumed = launch({ model: 'gpt-5.5', effort: 'high' }, { resumeSessionId: 'thread-1' });
  assert.deepEqual(resumed.slice(0, 5), ['--yolo', '--model', 'gpt-5.5', '-c', 'model_reasoning_effort="high"']);
  assert.deepEqual(resumed.slice(-2), ['resume', 'thread-1']);
  // Left on its defaults, nothing is added.
  const plain = launch({});
  assert.equal(plain.includes('--model'), false);
  assert.equal(plain.some((a) => a.startsWith('model_reasoning_effort')), false);
  rmSync(data, { recursive: true, force: true });
});

test('writes a mode-restricted helper that forwards paths without reading transcripts', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-office-codex-'));
  try {
    const file = writeCodexHook(dir);
    assert.equal(file, path.join(dir, 'agent-office-codex-hook.cjs'));
    const source = readFileSync(file, 'utf8');
    assert.match(source, /MAX = 64 \* 1024/);
    assert.match(source, /AGENT_OFFICE_HOOK_TOKEN/);
    assert.doesNotMatch(source, /readFile|readSync|createReadStream/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('helper forwards only the bounded root event fields to the authenticated bridge', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-office-codex-'));
  const received: { url?: string; authorization?: string; body?: unknown } = {};
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.url = req.url;
      received.authorization = req.headers.authorization;
      received.body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200).end();
    });
  });
  try {
    const file = writeCodexHook(dir);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const child = spawn(process.execPath, [file, 'UserPromptSubmit'], {
      env: {
        PATH: process.env.PATH,
        AGENT_OFFICE_HOOK_URL: `http://127.0.0.1:${address.port}`,
        AGENT_OFFICE_HOOK_TOKEN: 'hook-token',
        AGENT_OFFICE_WORKER_ID: 'worker-1',
      },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const stdout = await new Promise<string>((resolve, reject) => {
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.on('error', reject);
      child.on('close', () => resolve(output));
      child.stdin.end(JSON.stringify({
        session_id: 'thread-1', prompt: 'fix it', turn_id: 'turn-1',
        transcript_path: '/private/transcript.jsonl', model: 'private-model',
        tool_input: { command: 'private' }, hook_event_name: 'forged',
      }));
    });
    assert.equal(stdout, '{}');
    assert.equal(received.authorization, 'Bearer hook-token');
    assert.equal(received.url, '/hooks/codex?worker=worker-1&event=UserPromptSubmit');
    assert.deepEqual(received.body, {
      session_id: 'thread-1', hook_event_name: 'UserPromptSubmit', prompt: 'fix it', turn_id: 'turn-1',
      transcript_path: '/private/transcript.jsonl',
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a Codex prompt carries the note about deferred tools, and on Windows goes as a file to read', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codex-prompt-'));
  try {
    const long = 'first\n\nsecond "quoted" & more';
    const arg = codexPromptArg(dir, 'w1', long, true);
    assert.doesNotMatch(arg, /[\r\n"&|<>^%]/);
    assert.ok(arg.includes('tool_search'));
    const file = path.join(dir, 'prompts', 'w1.md');
    assert.ok(arg.includes(file));
    const written = readFileSync(file, 'utf8');
    assert.ok(written.startsWith('\uFEFF'));
    assert.ok(written.includes(long));
    assert.ok(written.includes('tool_search'));
    assert.equal(codexPromptArg(dir, 'w1', long, false), `${CODEX_TOOLS_NOTE}\n\n${long}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every floor gets the same Codex hook file, so one trust stamp covers them all', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'office-home-'));
  const before = process.env.AGENT_OFFICE_HOME;
  process.env.AGENT_OFFICE_HOME = home;
  try {
    const a = codex.prepare({ dataDir: path.join(home, 'floor-a'), mcpScript: undefined } as never);
    const b = codex.prepare({ dataDir: path.join(home, 'floor-b'), mcpScript: undefined } as never);
    assert.equal(a.hook, b.hook);
    assert.equal(a.hook, path.join(home, 'codex-hook', 'agent-office-codex-hook.cjs'));
    assert.equal(hookCommand(a.hook, 'Stop'), hookCommand(b.hook, 'Stop'));
  } finally {
    if (before === undefined) delete process.env.AGENT_OFFICE_HOME;
    else process.env.AGENT_OFFICE_HOME = before;
    rmSync(home, { recursive: true, force: true });
  }
});
