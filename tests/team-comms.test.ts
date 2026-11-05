import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TeamComms, type CommsDeps } from '../src/server/team-comms.js';

// Sara manages a team of Habib and Elmira; Arsalan works alone.
const NAMES: Record<string, string> = { sara: 'سارا', habib: 'حبیب', elmira: 'المیرا', arsalan: 'ارسلان' };
const TEAM = { id: 'T1', manager: 'sara', members: ['habib', 'elmira'] };

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'comms-'));
  const status: Record<string, string | undefined> = { sara: 'idle', habib: 'idle', elmira: 'idle', arsalan: 'idle' };
  const delivered: { id: string; text: string; by: string }[] = [];
  const alerts: string[] = [];
  const answers: Record<string, string | undefined> = {};
  let deliverError: string | undefined;
  const deps: CommsDeps = {
    name: (id) => NAMES[id],
    post: () => 'سمت',
    status: (id) => status[id],
    team: (id) => (id === 'arsalan' ? undefined : TEAM),
    deliver: (id, text, by) => {
      if (deliverError) return deliverError;
      delivered.push({ id, text, by });
      return undefined;
    },
    lastAnswer: (id) => answers[id],
    alert: (t) => alerts.push(t),
  };
  const comms = new TeamComms(dir, deps);
  return { comms, status, delivered, alerts, answers, fail: (e?: string) => (deliverError = e), done: () => { comms.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('by default a team talks with its own team and the rest with everyone', () => {
  const t = setup();
  assert.equal(t.comms.allowed('habib', 'elmira').ok, true);
  assert.equal(t.comms.allowed('habib', 'sara').ok, true);
  assert.equal(t.comms.allowed('arsalan', 'habib').ok, false, 'Habib accepts only his team by default');
  assert.equal(t.comms.allowed('habib', 'arsalan').ok, false, 'Habib calls only his team by default');
  assert.equal(t.comms.allowed('sara', 'arsalan').ok, true);
  t.done();
});

test('both sides must agree, and a reply is always allowed', () => {
  const t = setup();
  t.comms.setRule('habib', { receive: 'all' });
  assert.equal(t.comms.allowed('arsalan', 'habib').ok, true, 'Arsalan sends to all, Habib now takes from all');
  const r = t.comms.send('arsalan', 'habib', 'تست را انجام بده');
  assert.equal(r.ok, true);
  // Habib may not call outsiders, but may answer the one who called him.
  assert.equal(t.comms.allowed('habib', 'arsalan').ok && (t.comms.allowed('habib', 'arsalan') as { reply: boolean }).reply, true);
  t.comms.setRule('elmira', { receive: 'manager' });
  assert.equal(t.comms.allowed('habib', 'elmira').ok, false);
  t.comms.setRule('elmira', { receive: 'people', receiveFrom: ['habib'] });
  assert.equal(t.comms.allowed('habib', 'elmira').ok, true);
  assert.equal(t.comms.allowed('sara', 'elmira').ok, false);
  t.done();
});

test('a call is typed into the other terminal with who sent it; a busy one waits its turn', () => {
  const t = setup();
  t.status.habib = 'working';
  const r = t.comms.send('sara', 'habib', 'T-11 را شروع کن');
  assert.equal(r.ok && r.msg.status, 'queued');
  assert.equal(t.delivered.length, 0);
  t.status.habib = 'idle';
  (t.comms as unknown as { tick(now: number): void }).tick(Date.now());
  assert.equal(t.delivered.length, 1);
  assert.match(t.delivered[0].text, /سارا/);
  assert.match(t.delivered[0].text, /T-11/);
  assert.match(t.delivered[0].text, /call_member/);
  assert.equal(t.delivered[0].by, 'سارا');
  t.done();
});

test('it checks the call was taken up, sends it once more, and then tells the person', () => {
  const t = setup();
  const r = t.comms.send('sara', 'habib', 'سلام');
  assert.ok(r.ok);
  const tick = (now: number) => (t.comms as unknown as { tick(now: number): void }).tick(now);
  const start = Date.now();
  tick(start + 30_000);
  assert.equal(t.delivered.length, 2, 'sent once more');
  tick(start + 60_000);
  assert.equal(r.ok && r.msg.status, 'failed');
  assert.equal(t.alerts.length, 1);
  const r2 = t.comms.send('sara', 'elmira', 'سلام');
  assert.ok(r2.ok);
  t.status.elmira = 'working';
  tick(Date.now());
  assert.equal(r2.ok && r2.msg.status, 'delivered');
  t.done();
});

test('refusals are logged with the reason, and calls are capped', () => {
  const t = setup();
  const no = t.comms.send('habib', 'arsalan', 'سلام');
  assert.equal(no.ok, false);
  assert.match(no.ok ? '' : no.error, /اجازه نمی‌دهد/);
  assert.equal(t.comms.log.at(-1)?.status, 'refused');
  for (let i = 0; i < 6; i++) assert.equal(t.comms.send('sara', 'habib', `پیام ${i}`).ok, true);
  const capped = t.comms.send('sara', 'habib', 'هفتم');
  assert.equal(capped.ok, false);
  assert.equal(t.comms.send('sara', 'sara', 'x').ok, false);
  assert.equal(t.comms.send('sara', 'habib', '   ').ok, false);
  t.done();
});

test('a chain of calls stops after a few, and a failed delivery says why', () => {
  const t = setup();
  t.comms.setRule('arsalan', { send: 'all' });
  t.comms.setRule('habib', { receive: 'all', send: 'all' });
  t.comms.setRule('elmira', { receive: 'all', send: 'all' });
  t.comms.setRule('sara', { receive: 'all', send: 'all' });
  assert.ok(t.comms.send('arsalan', 'habib', 'یک').ok);
  assert.ok(t.comms.send('habib', 'elmira', 'دو').ok);
  assert.ok(t.comms.send('elmira', 'sara', 'سه').ok);
  assert.ok(t.comms.send('sara', 'habib', 'چهار').ok);
  const fifth = t.comms.send('habib', 'arsalan', 'پنج');
  assert.equal(fifth.ok, false, 'too deep');
  t.fail('Worker is not running');
  t.status.arsalan = 'idle';
  const failed = t.comms.send('sara', 'arsalan', 'سلام');
  assert.ok(failed.ok);
  assert.equal(failed.ok && failed.msg.status, 'failed');
  t.done();
});

test('rules for one are copied to the whole team and survive a restart', () => {
  const t = setup();
  t.comms.setRule('sara', { send: 'manager', receive: 'people', receiveFrom: ['arsalan'] });
  assert.equal(t.comms.copyToTeam('sara'), undefined);
  assert.equal(t.comms.ruleOf('elmira').receive, 'people');
  assert.deepEqual(t.comms.ruleOf('habib').receiveFrom, ['arsalan']);
  assert.equal(t.comms.copyToTeam('arsalan'), 'او در تیمی نیست');
  assert.equal(t.comms.setRule('ghost', { send: 'all' }), 'No such person');
  t.done();
});

test('what the person says to a member ends the chain of calls that led to them', () => {
  const t = setup();
  for (const id of ['arsalan', 'habib', 'elmira', 'sara']) t.comms.setRule(id, { send: 'all', receive: 'all' });
  const now = Date.now();
  assert.ok(t.comms.send('arsalan', 'habib', 'یک', now).ok);
  assert.ok(t.comms.send('habib', 'arsalan', 'دو', now + 1000).ok);
  assert.ok(t.comms.send('arsalan', 'habib', 'سه', now + 2000).ok);
  assert.ok(t.comms.send('habib', 'arsalan', 'چهار', now + 3000).ok);
  assert.equal(t.comms.send('arsalan', 'sara', 'پنج', now + 4000).ok, false, 'four deep with nobody in between');
  t.comms.humanSpoke('arsalan', now + 5000);
  assert.equal(t.comms.send('arsalan', 'sara', 'شش', now + 6000).ok, true, 'the person spoke: a new chain');
  t.done();
});

test('when the other finishes without calling back, the office brings their answer to the one who asked', () => {
  const t = setup();
  const tick = (now: number) => (t.comms as unknown as { tick(now: number): void }).tick(now);
  const start = Date.now();
  const r = t.comms.send('sara', 'habib', 'یک مقاله بنویس', start);
  assert.ok(r.ok);
  t.status.habib = 'working';
  tick(start + 1_000);
  assert.equal(r.ok && r.msg.status, 'delivered');
  t.answers.habib = 'مانع: پنل مقاله در دسترس نیست؛ پیش‌نویسی ذخیره نشد.';
  t.status.habib = 'done';
  tick(start + 3_000);
  assert.equal(t.delivered.length, 1, 'too soon: a turn that has only just ended is not yet the answer');
  tick(start + 12_000);
  assert.equal(t.delivered.length, 2, 'the answer went to Sara');
  assert.equal(t.delivered[1].id, 'sara');
  assert.match(t.delivered[1].text, /پنل مقاله در دسترس نیست/);
  assert.match(t.delivered[1].text, /ask_ceo/);
  assert.match(t.delivered[1].text, /از دفتر/);
  tick(start + 30_000);
  assert.equal(t.delivered.length, 2, 'once only');
  t.done();
});

test('no second copy when the other called back themselves, and a stuck one is reported once', () => {
  const t = setup();
  const tick = (now: number) => (t.comms as unknown as { tick(now: number): void }).tick(now);
  const start = Date.now();
  const r = t.comms.send('sara', 'habib', 'سلام', start);
  assert.ok(r.ok);
  t.status.habib = 'working';
  tick(start + 1_000);
  assert.ok(t.comms.send('habib', 'sara', 'نتیجه: انجام شد', start + 2_000).ok, 'a reply is allowed');
  t.status.sara = 'working';
  tick(start + 3_000);
  t.answers.habib = 'متن گفت‌وگوی من';
  t.status.habib = 'done';
  tick(start + 20_000);
  assert.equal(t.delivered.filter((d) => d.id === 'sara' && /از دفتر/.test(d.text)).length, 0, 'he answered: nothing to bring back');

  const stuck = t.comms.send('sara', 'elmira', 'بازبینی', start + 40_000);
  assert.ok(stuck.ok);
  t.status.elmira = 'working';
  tick(start + 41_000);
  t.status.elmira = 'needs_input';
  tick(start + 60_000);
  assert.equal(t.alerts.length, 0, 'not yet');
  tick(start + 140_000);
  tick(start + 150_000);
  assert.equal(t.alerts.length, 1, 'reported once');
  assert.match(t.alerts[0], /گیر کرده/);
  t.done();
});
