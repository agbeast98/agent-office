import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TeamEvals, TeamMistakes, TeamRequests } from '../src/server/team-ledgers.js';
import { seedFromSnapshot, snapshotPath } from '../src/server/team-snapshot.js';

const dir = () => mkdtempSync(path.join(tmpdir(), 'ledgers-'));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('a request is not made twice while it is open, and the answer is remembered', () => {
  const d = dir();
  const r = new TeamRequests(d);
  const a = r.ask('h1', 'حبیب', { title: 'ورود به Search Console', kind: 'login', url: 'https://search.google.com', detail: 'وارد شوید' });
  assert.ok(a.ok && a.fresh);
  const again = r.ask('h1', 'حبیب', { title: 'ورود به Search Console' });
  assert.ok(again.ok && !again.fresh && again.req.id === (a.ok && a.req.id));
  assert.equal(r.ask('h1', 'حبیب', { title: '  ' }).ok, false);
  assert.equal(r.open().length, 1);
  const done = r.resolve(a.ok ? a.req.id : '', 'done', 'انجام شد');
  assert.equal(done?.status, 'done');
  assert.equal(r.open().length, 0);
  assert.equal(done?.until, undefined, 'no leave to change a file was asked');
  rmSync(d, { recursive: true, force: true });
});

test('a yes to changing a profile lets that agent change that file for eight hours, and no one else', () => {
  const d = dir();
  const r = new TeamRequests(d);
  const a = r.ask('ars', 'ارسلان', { title: 'اجازه', kind: 'approve', file: 'freelance-team/people/habib/skill.md' });
  assert.ok(a.ok);
  const id = a.ok ? a.req.id : '';
  const now = Date.now();
  assert.equal(r.permitFor('ars', 'freelance-team/people/habib/skill.md', now), undefined, 'not before the person says yes');
  r.resolve(id, 'done', '', now);
  assert.ok(r.permitFor('ars', 'freelance-team/people/habib/skill.md', now + 1000));
  assert.equal(r.permitFor('other', 'freelance-team/people/habib/skill.md', now + 1000), undefined);
  assert.equal(r.permitFor('ars', 'freelance-team/people/elmira/skill.md', now + 1000), undefined);
  assert.equal(r.permitFor('ars', 'freelance-team/people/habib/skill.md', now + 8 * 60 * 60_000 + 60_000), undefined, 'the leave runs out');
  r.resolve(id, 'declined', 'نه', now);
  assert.equal(r.permitFor('ars', 'freelance-team/people/habib/skill.md', now + 1000), undefined);
  r.swap('ars', 'ars2');
  assert.equal(r.get(id)?.from, 'ars2');
  rmSync(d, { recursive: true, force: true });
});

test('mistakes are listed for the person and written for every agent to read', async () => {
  const d = dir();
  const mirror = path.join(d, 'freelance-team', 'mistakes.md');
  const m = new TeamMistakes(d, mirror);
  assert.equal(m.report({ what: '' }, 'agent', 'سارا').ok, false);
  const r = m.report({ what: 'یادداشت بلند قطع شد', did: 'دوباره فرستاد', cause: 'طول متن', lesson: 'مسیر فایل را در متن بگذار' }, 'agent', 'سارا', { id: 's', name: 'سارا' });
  assert.ok(r.ok);
  m.report({ what: 'سرور وسط کار بالا آمد', lesson: 'برای اصلاح کوچک سرور را دوباره بالا نیاور' }, 'assistant', 'دستیار');
  const bad = m.report({ what: 'بی‌ربط', lesson: 'x' }, 'ceo', 'مدیرعامل');
  assert.ok(bad.ok);
  m.setStatus(bad.ok ? bad.mistake.id : '', 'wontfix');
  await wait(450);
  const text = readFileSync(mirror, 'utf8');
  assert.match(text, /مسیر فایل را در متن بگذار/);
  assert.match(text, /دستیار/);
  assert.doesNotMatch(text, /بی‌ربط/, 'what the person set aside is not told to agents');
  assert.ok(existsSync(path.join(d, 'team-mistakes.json')));
  assert.equal(new TeamMistakes(d, mirror).items.length, 3, 'read back after a restart');
  rmSync(d, { recursive: true, force: true });
});

test('an evaluation keeps its evidence and moves through its states', () => {
  const d = dir();
  const e = new TeamEvals(d);
  assert.equal(e.record('ars', 'ارسلان', { id: 'h', name: 'حبیب' }, { summary: '' }).ok, false);
  const r = e.record('ars', 'ارسلان', { id: 'h', name: 'حبیب' }, { summary: 'تست را درست انجام داد', strengths: ['شاهد دارد', ''], weaknesses: ['جایگزین نداد'], proposal: 'دو قاعده', status: 'proposed' });
  assert.ok(r.ok);
  const ev = r.ok ? r.evaluation : undefined;
  assert.deepEqual(ev?.strengths, ['شاهد دارد']);
  assert.equal(e.setStatus(ev?.id ?? '', 'applied')?.status, 'applied');
  e.swap('h', 'h2');
  assert.equal(e.get(ev?.id ?? '')?.member, 'h2');
  rmSync(d, { recursive: true, force: true });
});

test('a fresh clone takes the team from the snapshot, and a floor that has a team keeps its own', () => {
  const floor = dir();
  const data = path.join(floor, '.agent-office');
  assert.equal(seedFromSnapshot(floor, data), false, 'no snapshot');
  mkdirSync(path.dirname(snapshotPath(floor)), { recursive: true });
  writeFileSync(snapshotPath(floor), JSON.stringify({ version: 1, savedAt: 1, members: [{ id: 'a', name: 'سارا', desk: 'desk-1' }], files: { 'team-teams.json': '{"teams":[]}', 'evil.json': 'x' } }));
  assert.equal(seedFromSnapshot(floor, data), true);
  assert.equal(readFileSync(path.join(data, 'team-teams.json'), 'utf8'), '{"teams":[]}');
  assert.equal(existsSync(path.join(data, 'evil.json')), false, 'only the team files are taken');
  assert.equal(seedFromSnapshot(floor, data), false, 'it already has a team now');
  rmSync(floor, { recursive: true, force: true });
});

test('another member\'s profile and the policy are locked until the person says yes; a member\'s own are not', async () => {
  const { profileGate } = await import('../src/server/profile-gate.js');
  const d = dir();
  const requests = new TeamRequests(d);
  const told: string[] = [];
  const floor = {
    dir: path.join(d, 'floor'),
    interviews: {
      latestFor: (id: string) => (id === 'h' ? { slug: 'habib' } : id === 'a' ? { slug: 'arsalan' } : undefined),
      all: () => [{ slug: 'habib', name: 'حبیب' }, { slug: 'arsalan', name: 'ارسلان' }],
    },
    requests,
    notifier: { send: async (t: string) => void told.push(t) },
  } as never;
  const arsalan = { id: 'a', name: 'ارسلان' } as never;
  const habib = { id: 'h', name: 'حبیب' } as never;
  const write = (file: string, tool = 'Write') => ({ tool_name: tool, cwd: path.join(d, 'floor'), tool_input: { file_path: file } });
  const shell = (command: string) => ({ tool_name: 'Bash', cwd: path.join(d, 'floor'), tool_input: { command } });
  const habibMemory = path.join(d, 'floor', 'freelance-team', 'people', 'habib', 'memory.md');

  assert.equal(profileGate(floor, habib, write(habibMemory)), undefined, 'his own');
  assert.equal(profileGate(floor, arsalan, write(path.join(d, 'floor', 'src', 'x.ts'))), undefined, 'an ordinary file');
  assert.equal(profileGate(floor, arsalan, { tool_name: 'Read', tool_input: { file_path: habibMemory } }), undefined, 'reading is free');
  const denied = profileGate(floor, arsalan, write(habibMemory, 'Edit'));
  assert.match(denied ?? '', /R-1/);
  assert.equal(requests.open().length, 1);
  assert.equal(profileGate(floor, arsalan, write(habibMemory)), denied, 'asked again: the same request, not a second');
  assert.equal(requests.open().length, 1);
  assert.match(profileGate(floor, arsalan, shell('echo "x" >> freelance-team/people/habib/memory.md')) ?? '', /R-1/, 'a shell redirect is caught too');
  assert.match(profileGate(floor, arsalan, shell('sed -i s/a/b/ C:\\u\\freelance-team\\people\\habib\\skill.md')) ?? '', /R-/, 'a Windows path too');
  assert.equal(profileGate(floor, arsalan, shell('cat freelance-team/people/habib/memory.md 2>&1')), undefined, 'reading by shell is free');
  assert.equal(profileGate(floor, arsalan, shell('echo hi > notes.txt')), undefined);
  assert.match(profileGate(floor, arsalan, write(path.join(d, 'floor', 'freelance-team', 'policy.md'))) ?? '', /policy\.md/);
  requests.resolve('R-1', 'done', '');
  assert.equal(profileGate(floor, arsalan, write(habibMemory)), undefined, 'the person said yes: for that file');
  assert.equal(profileGate(floor, arsalan, write(path.join(d, 'floor', 'freelance-team', 'people', 'habib', 'skill.md'))) === undefined, false, 'not for his skill.md');
  assert.ok(told.length >= 1);
  rmSync(d, { recursive: true, force: true });
});

test('Codex edits are locked too: apply_patch names its files, and its shell takes a command list', async () => {
  const { profileGate } = await import('../src/server/profile-gate.js');
  const d = dir();
  const requests = new TeamRequests(d);
  const floor = {
    dir: path.join(d, 'floor'),
    interviews: { latestFor: (id: string) => (id === 'a' ? { slug: 'arsalan' } : undefined), all: () => [{ slug: 'habib', name: 'حبیب' }] },
    requests,
    notifier: { send: async () => undefined },
  } as never;
  const me = { id: 'a', name: 'ارسلان' } as never;
  const cwd = path.join(d, 'floor');
  const patch = (file: string) => ({ tool_name: 'apply_patch', cwd, tool_input: { command: `*** Begin Patch\n*** Update File: ${file}\n@@\n-a\n+b\n*** End Patch` } });
  assert.match(profileGate(floor, me, patch('freelance-team/people/habib/memory.md')) ?? '', /R-1/);
  assert.equal(profileGate(floor, me, patch('freelance-team/people/arsalan/memory.md')), undefined, 'his own');
  assert.equal(profileGate(floor, me, patch('src/index.ts')), undefined);
  assert.match(profileGate(floor, me, { tool_name: 'shell', cwd, tool_input: { command: ['powershell', '-Command', "Add-Content 'freelance-team/people/habib/skill.md' 'x'"] } }) ?? '', /R-\d/);
  rmSync(d, { recursive: true, force: true });
});

test('a team that is missing is brought back member by member, and every store learns the new ids', async () => {
  const { missingMembers, restoreMembers, snapshotPath } = await import('../src/server/team-snapshot.js');
  const floorDir = dir();
  mkdirSync(path.dirname(snapshotPath(floorDir)), { recursive: true });
  writeFileSync(snapshotPath(floorDir), JSON.stringify({
    version: 1, savedAt: 1, files: {},
    members: [
      { id: 'old1', name: 'سارا', role: 'مدیر تیم سئو: بخوان', desk: 'desk-1', provider: 'claude', model: 'sonnet', effort: 'medium' },
      { id: 'old2', name: 'آرمین', role: 'تصویرساز', desk: 'desk-1', provider: 'codex' },
      { id: 'old3', name: 'حبیب', role: 'سئو فنی', desk: 'desk-2' },
    ],
  }));
  const here = [{ id: 'new3', name: 'حبیب', kind: 'agent' }];
  const spawned: { desk: string; provider?: string; model?: string; prompt: string }[] = [];
  const swaps: string[] = [];
  const swap = (store: string) => (from: string, to: string) => void swaps.push(`${store}:${from}>${to}`);
  const taken = new Set<string>(['desk-2']);
  let snapshotWritten = false;
  const floor = {
    dir: floorDir,
    workers: {
      list: () => here,
      wing: () => 99,
      deskOccupied: (id: string) => taken.has(id),
      spawn: (desk: string, _by: string, prompt: string, _wt: boolean, _kind: string, provider?: string, model?: string) => {
        if (taken.has(desk)) return 'taken';
        taken.add(desk);
        spawned.push({ desk, provider, model, prompt });
        return { id: `new${spawned.length}` };
      },
      describe: () => true,
    },
    teams: { teamOf: (id: string) => (id === 'old1' ? { name: 'سئو' } : undefined), isManager: (id: string) => id === 'old1', swap: swap('teams') },
    interviews: { all: () => [{ worker: 'old1', slug: 'sara' }], swap: swap('interviews'), peopleDir: undefined },
    teamTasks: { swap: swap('tasks') },
    comms: { swap: swap('comms') },
    requests: { swap: swap('requests') },
    mistakes: { swap: swap('mistakes') },
    evals: { swap: swap('evals') },
    snapshot: { write: () => void (snapshotWritten = true) },
  } as never;
  assert.deepEqual(missingMembers(floor).map((m) => m.name), ['سارا', 'آرمین'], 'Habib is already here, by name');
  const out = restoreMembers(floor, 'مدیرعامل');
  assert.deepEqual(out.restored, ['سارا', 'آرمین']);
  assert.deepEqual(out.failed, []);
  assert.equal(spawned[0].provider, 'claude');
  assert.equal(spawned[0].model, 'sonnet');
  assert.equal(spawned[1].provider, 'codex');
  assert.notEqual(spawned[1].desk, spawned[0].desk, 'a taken desk is not used twice');
  assert.match(spawned[0].prompt, /مدیر تیم «سئو»/);
  assert.match(spawned[0].prompt, /freelance-team\/people\/sara\/skill\.md/);
  assert.match(spawned[0].prompt, /mistakes\.md/);
  for (const store of ['teams', 'interviews', 'tasks', 'comms', 'requests', 'mistakes', 'evals']) assert.ok(swaps.includes(`${store}:old1>new1`), `${store} follows Sara`);
  assert.ok(snapshotWritten);
  rmSync(floorDir, { recursive: true, force: true });
});

test('📥 takes what only the person can do: reports are turned away, the same ask is not made twice, and an agent has at most three open', () => {
  const r = new TeamRequests(dir());
  const report = r.ask('a', 'علی', { title: 'خلاصه‌ی وضعیت T-21', kind: 'decision' });
  assert.equal(report.ok, false);
  assert.equal(r.ask('a', 'علی', { title: 'کار تمام شد', kind: 'info' }).ok, false);
  const first = r.ask('a', 'علی', { title: 'ورود به پنل لازم است', kind: 'login' });
  assert.ok(first.ok && first.fresh);
  const again = r.ask('a', 'علی', { title: 'ورود به پنل، لازم است!', kind: 'login' });
  assert.ok(again.ok && !again.fresh, 'the same ask comes back as the open one');
  assert.ok(r.ask('a', 'علی', { title: 'تأیید انتشار', kind: 'approve' }).ok);
  assert.ok(r.ask('a', 'علی', { title: 'کدام عکس', kind: 'decision' }).ok);
  assert.equal(r.ask('a', 'علی', { title: 'یک چیز دیگر', kind: 'decision' }).ok, false, 'three open is the most');
  // a lock asking for a folder or a file is never held back
  assert.ok(r.ask('a', 'علی', { title: 'اجازه‌ی نوشتن', kind: 'approve', file: 'folder:x:write' }).ok);
});
