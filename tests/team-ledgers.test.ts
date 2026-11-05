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

test('a yes to changing a profile lets that agent change that file for an hour, and no one else', () => {
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
  assert.equal(r.permitFor('ars', 'freelance-team/people/habib/skill.md', now + 61 * 60_000), undefined, 'the leave runs out');
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
