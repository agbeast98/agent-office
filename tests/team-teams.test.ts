import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Interviews } from '../src/server/team-interviews.js';
import { Teams, rosterText } from '../src/server/team-teams.js';

function fresh() {
  const dir = mkdtempSync(path.join(tmpdir(), 'teams-'));
  return { dir, t: new Teams(dir), done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a team is its manager and members; a worker is in one team at most', () => {
  const x = fresh();
  try {
    const seo = x.t.create('سئو', 'm1');
    assert.ok(seo.ok);
    assert.equal(x.t.create('سئو', 'm2').ok, false);
    assert.equal(x.t.create('کد', 'm1').ok, false);
    assert.ok(x.t.isManager('m1'));
    assert.equal(x.t.add('T1', 'w1').ok, true);
    assert.equal(x.t.teamOf('w1')?.name, 'سئو');
    const code = x.t.create('کد', 'm2');
    assert.ok(code.ok);
    assert.equal(x.t.add('T2', 'w1').ok, true);
    assert.deepEqual(x.t.get('T1')?.members, []);
    assert.equal(x.t.add('T1', 'm2').ok, false);
    assert.equal(x.t.leave('w1'), true);
    assert.equal(x.t.teamOf('w1'), undefined);
    assert.equal(new Teams(x.dir).teams.length, 2);
  } finally {
    x.done();
  }
});

test('only a team manager proposes; accepting taking someone in puts them in the team', () => {
  const x = fresh();
  try {
    x.t.create('سئو', 'm1');
    assert.equal(x.t.propose('someone', 'X', { kind: 'hire', role: 'نویسنده', why: 'لازم است' }).ok, false);
    assert.equal(x.t.propose('m1', 'M', { kind: 'hire', role: '', why: 'لازم است' }).ok, false);
    const hire = x.t.propose('m1', 'M', { kind: 'hire', role: 'نویسنده', skill: 'مقاله بنویس', why: 'کسی برای نوشتن نیست' });
    assert.ok(hire.ok);
    const adopt = x.t.propose('m1', 'M', { kind: 'adopt', role: 'QA', why: 'تست می‌گیرد', worker: 'solo1' });
    assert.ok(adopt.ok);
    if (!adopt.ok) return;
    assert.equal(x.t.resolve(adopt.proposal.id, 'accepted').ok, true);
    assert.equal(x.t.teamOf('solo1')?.id, 'T1');
    assert.equal(x.t.resolve(adopt.proposal.id, 'accepted').ok, false);
    assert.equal(x.t.propose('m1', 'M', { kind: 'adopt', why: 'x', worker: 'solo1' }).ok, false);
    if (hire.ok) assert.equal(x.t.resolve(hire.proposal.id, 'dismissed').ok, true);
  } finally {
    x.done();
  }
});

test('the manager and the person talk in a thread, and an empty team goes when its manager is rejected', () => {
  const x = fresh();
  try {
    x.t.create('سئو', 'm1');
    assert.equal(x.t.say('T1', 'boss', 'نیرو کافی است؟').ok, true);
    assert.equal(x.t.say('T1', 'manager', 'نه، نویسنده کم است').ok, true);
    assert.equal(x.t.say('T9', 'boss', 'x').ok, false);
    assert.deepEqual(x.t.advice.map((a) => a.by), ['boss', 'manager']);
    x.t.dropEmpty('m1');
    assert.equal(x.t.teams.length, 0);
  } finally {
    x.done();
  }
});

test('the roster says who is in which team and who works alone', () => {
  const md = rosterText([{ id: 'T1', name: 'سئو', manager: 'm1', members: ['w1'], createdAt: 0 }], [
    { id: 'm1', name: 'علی', role: 'مدیر تیم سئو: هماهنگ' },
    { id: 'w1', name: 'سارا', role: 'نویسنده: مقاله', state: 'در مصاحبه', line: 'دسترسی: مرورگر' },
    { id: 'z', name: 'نیما', role: 'QA: تست' },
  ]);
  assert.match(md, /## تیم سئو/);
  assert.match(md, /\*\*علی\*\* — مدیر تیم سئو/);
  assert.match(md, /\*\*سارا\*\* — نویسنده \(در مصاحبه\)\n {2}دسترسی: مرورگر/);
  assert.match(md, /مستقل[\s\S]*\*\*نیما\*\*/);
});

test('the manager comments on an interview, seen in its chat, and the candidate is not told', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'teams-iv-'));
  try {
    const iv = new Interviews(dir, path.join(dir, 'people'));
    const i = iv.start({ worker: 'w1', name: 'سارا', role: 'نویسنده', desk: 'desk-1', skill: '', team: 'T1' });
    const r = iv.managerSay(i.id, 'علی', 'مهارتش کامل است');
    assert.ok(r.ok);
    assert.deepEqual(i.messages.map((m) => [m.by, m.who]), [['manager', 'علی']]);
    assert.equal(i.team, 'T1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the same person on another engine keeps their place: team, manager seat, interviews', () => {
  const x = fresh();
  try {
    x.t.create('سئو', 'm1');
    x.t.add('T1', 'w1');
    x.t.swap('w1', 'w9');
    x.t.swap('m1', 'm9');
    assert.equal(x.t.teamOf('w9')?.name, 'سئو');
    assert.equal(x.t.teamOf('w1'), undefined);
    assert.ok(x.t.isManager('m9'));
    assert.equal(x.t.isManager('m1'), false);
    const i = new Interviews(x.dir, path.join(x.dir, 'people'));
    const iv = i.start({ worker: 'w9', name: 'آرمین', role: 'تصویرساز', desk: 'desk-1', skill: '' });
    i.decide(iv.id, 'skip');
    i.swap('w9', 'w10');
    assert.equal(i.all().filter((a) => a.worker === 'w10').length, 1);
  } finally {
    x.done();
  }
});
