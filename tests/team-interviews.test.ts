import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Interviews, continuedInterview, interviewPrompt, slugOf } from '../src/server/team-interviews.js';
import { TeamTasks } from '../src/server/team-tasks.js';
import type { WorkerInfo } from '../src/shared/protocol.js';

function fresh() {
  const dir = mkdtempSync(path.join(tmpdir(), 'interviews-'));
  const people = path.join(dir, 'people');
  return { dir, people, i: new Interviews(dir, people), done: () => rmSync(dir, { recursive: true, force: true }) };
}
const begin = (i: Interviews) => i.start({ worker: 'w1', name: 'سارا نادری', role: 'ایده‌یاب سئو', desk: 'desk-1', skill: 'سه ایده‌ی مقاله بده' });

test('a hire starts an interview and a profile folder with what the person wrote', () => {
  const t = fresh();
  try {
    const x = begin(t.i);
    assert.equal(x.status, 'talking');
    assert.match(readFileSync(path.join(t.people, x.slug, 'skill.md'), 'utf8'), /سه ایده‌ی مقاله بده/);
    assert.ok(existsSync(path.join(t.people, x.slug, 'memory.md')));
    assert.equal(slugOf('سارا نادری', () => false), 'سارا-نادری');
    assert.equal(slugOf('a', (s) => s === 'a'), 'a-2');
    assert.match(interviewPrompt('سارا', 'ایده‌یاب', 'x', 'freelance-team/people/سارا'), /interview_finish/);
  } finally {
    t.done();
  }
});

test('the agent and the person talk, and the agent finishes with its own files', () => {
  const t = fresh();
  try {
    const x = begin(t.i);
    assert.equal(t.i.say('w1', 'سلام، من سارا هستم').ok, true);
    assert.equal(t.i.say('other', 'سلام').ok, false);
    const r = t.i.bossSay(x.id, 'مشتری‌ها کافه‌دارها هستند');
    assert.ok(r.ok && r.notices[0].to === 'w1' && /کافه‌دارها/.test(r.notices[0].text));
    assert.equal(t.i.finish('w1', { summary: 'خلاصه', skill: '# مهارت', memory: '' , access: 'مرورگر' }).ok, false);
    assert.equal(t.i.finish('w1', { summary: 'خلاصه', skill: '# مهارت بهتر', memory: '# یاد گرفتم', access: 'مرورگر دارم؛ حساب سرچ کنسول لازم است' }).ok, true);
    assert.equal(x.status, 'review');
    assert.equal(readFileSync(path.join(t.people, x.slug, 'skill.md'), 'utf8').trim(), '# مهارت بهتر');
    assert.match(x.access ?? '', /سرچ کنسول/);
    assert.deepEqual(x.messages.map((m) => m.by), ['agent', 'boss', 'agent']);
  } finally {
    t.done();
  }
});

test('it can not be hired before it finishes, unless the person skips; it is given no work meanwhile', () => {
  const t = fresh();
  try {
    const x = begin(t.i);
    assert.match(t.i.blocking('w1') ?? '', /مصاحبه/);
    assert.equal(t.i.decide(x.id, 'hire').ok, false);
    t.i.finish('w1', { summary: 's', skill: 'a', memory: 'b', access: 'c' });
    assert.match(t.i.blocking('w1') ?? '', /مصاحبه/);
    assert.equal(t.i.decide(x.id, 'hire').ok, true);
    assert.equal(t.i.blocking('w1'), undefined);
    assert.equal(t.i.decide(x.id, 'hire').ok, false);
    const y = t.i.start({ worker: 'w2', name: 'نیما', role: 'نویسنده', desk: 'desk-2', skill: '' });
    assert.equal(t.i.decide(y.id, 'skip').ok, true);
    assert.equal(t.i.blocking('w2'), undefined);
  } finally {
    t.done();
  }
});

test('a rejected candidate leaves no folder, and a restart keeps the interview going', () => {
  const t = fresh();
  try {
    const x = begin(t.i);
    const again = new Interviews(t.dir, t.people);
    assert.equal(again.open('w1')?.id, x.id);
    t.i.decide(x.id, 'reject');
    assert.equal(existsSync(path.join(t.people, x.slug)), false);
    assert.equal(t.i.all().length, 0);
  } finally {
    t.done();
  }
});

test('tasks and the team manager can not hand work to someone still in an interview', () => {
  const t = fresh();
  try {
    begin(t.i);
    const tasks = new TeamTasks(t.dir);
    tasks.blocked = (id) => t.i.blocking(id);
    const workers = [{ id: 'w1', name: 'سارا نادری', kind: 'agent' }] as unknown as WorkerInfo[];
    const boss = { name: 'مدیر', boss: true };
    const r = tasks.create(boss, { title: 'کار', assignee: 'w1' }, workers);
    assert.equal(r.ok, false);
    t.i.decide('I-1', 'skip');
    assert.equal(tasks.create(boss, { title: 'کار', assignee: 'w1' }, workers).ok, true);
  } finally {
    t.done();
  }
});

test('the business is written once in company.md and every interview is told to read it first', () => {
  const t = fresh();
  try {
    assert.equal(t.i.company(), '');
    t.i.ensureCompany();
    assert.match(t.i.company(), /## خدمت‌ها/);
    assert.equal(t.i.saveCompany('# Khat Web\nسایت فروشگاهی'), true);
    t.i.ensureCompany();
    assert.match(t.i.company(), /سایت فروشگاهی/);
    assert.equal(path.dirname(t.i.companyFile ?? ''), t.dir);
    const prompt = interviewPrompt('سارا', 'ایده‌یاب', 'x', 'freelance-team/people/سارا');
    assert.match(prompt, /freelance-team\/company\.md/);
    assert.match(prompt, /دوباره نپرس/);
  } finally {
    t.done();
  }
});

test('a re-interview proposes changes, writes nothing until approved, and keeps the old profile when refused', () => {
  const t = fresh();
  try {
    const x = begin(t.i);
    t.i.finish('w1', { summary: 's', skill: '# مهارت قدیمی', memory: '# حافظه قدیمی', access: 'مرورگر' });
    t.i.decide(x.id, 'hire');
    assert.equal(t.i.review('nobody').ok, false);
    const r = t.i.review('w1');
    assert.ok(r.ok);
    const re = r.interview;
    assert.equal(re.kind, 'review');
    assert.equal(re.slug, x.slug);
    assert.equal(re.before?.skill.trim(), '# مهارت قدیمی');
    assert.equal(t.i.review('w1').ok, false);
    assert.match(t.i.blocking('w1') ?? '', /بازبینی/);
    assert.equal(t.i.decide(re.id, 'hire').ok, false);
    assert.equal(t.i.settle(re.id, 'apply').ok, false);
    assert.equal(t.i.finish('w1', { summary: 's', skill: '# مهارت تازه', memory: '# حافظه قدیمی', access: 'a' }).ok, false);
    assert.equal(t.i.finish('w1', { summary: 's', skill: '# مهارت تازه', memory: '# حافظه قدیمی', access: 'a', changes: 'افزودن قاعده‌ی تازه، شاهد: T-3' }).ok, true);
    assert.equal(readFileSync(path.join(t.people, x.slug, 'skill.md'), 'utf8').trim(), '# مهارت قدیمی');
    assert.equal(t.i.settle(re.id, 'keep').ok, true);
    assert.equal(readFileSync(path.join(t.people, x.slug, 'skill.md'), 'utf8').trim(), '# مهارت قدیمی');
    assert.equal(t.i.blocking('w1'), undefined);

    const again = t.i.review('w1');
    assert.ok(again.ok);
    t.i.finish('w1', { summary: 's', skill: '# مهارت تازه', memory: '# حافظه تازه', access: 'a', changes: 'تغییر' });
    assert.equal(t.i.settle(again.interview.id, 'apply').ok, true);
    assert.equal(readFileSync(path.join(t.people, x.slug, 'skill.md'), 'utf8').trim(), '# مهارت تازه');
    assert.equal(readFileSync(path.join(t.people, x.slug, 'memory.md'), 'utf8').trim(), '# حافظه تازه');
    assert.ok(t.i.lastInterviewed('w1'));
    assert.equal(t.i.lastInterviewed('nobody'), undefined);
  } finally {
    t.done();
  }
});

test('an interview moved to another engine starts again with its instructions and what has been said', () => {
  const t = fresh();
  try {
    const x = begin(t.i);
    assert.doesNotMatch(continuedInterview(x), /گفتگوی تا اینجا/);
    t.i.say('w1', 'سلام، من سارا هستم');
    t.i.bossSay(x.id, 'مشتری‌ها کافه‌دارها هستند');
    const text = continuedInterview(x);
    assert.match(text, /interview_finish/);
    assert.match(text, /سلام، من سارا هستم/);
    assert.match(text, /مدیرعامل: مشتری‌ها کافه‌دارها هستند/);
  } finally {
    t.done();
  }
});
