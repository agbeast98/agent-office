import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { WorkerInfo } from '../src/shared/protocol.js';
import { Flows, groupAt, parseSteps } from '../src/server/team-flows.js';
import { TeamTasks, type Notice } from '../src/server/team-tasks.js';

const people = ['idea', 'writer', 'qa', 'back', 'front'].map((id) => ({ id, name: id.toUpperCase(), kind: 'agent', role: id })) as unknown as WorkerInfo[];
const worker = (id: string) => ({ id, name: id.toUpperCase(), boss: false });

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'flows-'));
  const tasks = new TeamTasks(dir);
  const told: Notice[] = [];
  const sent: string[] = [];
  const flows = new Flows(dir, { tasks, workers: () => people, tell: (n) => told.push(...n), notify: (t) => sent.push(t) }, path.join(dir, 'out', 'scenarios.md'));
  tasks.onChange = () => flows.sync();
  const mk = (steps: unknown[], extra: Record<string, unknown> = {}) => {
    const b = flows.bosses[0] ?? (() => {
      const made = flows.saveBoss({ name: 'مدیر سئو', team: 'سئو', brief: 'کوتاه و دقیق' });
      if (!made.ok) throw new Error(made.error);
      return made.boss;
    })();
    const s = flows.saveScenario({ name: `مقاله ${flows.scenarios.length}`, boss: b.id, steps, ...extra });
    if (!s.ok) throw new Error(s.error);
    return s.scenario;
  };
  const begin = (id: string, input = '') => {
    const r = flows.start(id, input);
    if (!r.ok) throw new Error(r.error);
    return r.run;
  };
  /** What a worker does with its task: writes the result and sets its status. */
  const finish = (who: string, taskId: string, note: string, status = 'review') => {
    assert.equal(tasks.note(worker(who), taskId, note, people).ok, true);
    assert.equal(tasks.update(worker(who), taskId, { status }, people).ok, true);
  };
  const open = (who: string) => tasks.list({ mine: who, open: true });
  return { dir, tasks, flows, told, sent, mk, begin, finish, open, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('steps are checked, and together/QA settled', () => {
  assert.match(String(parseSteps([])), /مرحله/);
  assert.match(String(parseSteps([{ title: 'a' }])), /مسئول/);
  assert.match(String(parseSteps([{ title: 'a', who: 'x', kind: 'qa' }])), /QA/);
  const steps = parseSteps([{ title: 'a', who: 'x', together: true }, { title: 'b', who: 'y', together: true }, { title: 'q', who: 'z', kind: 'qa', back: 9 }]);
  if (typeof steps === 'string') throw new Error(steps);
  assert.deepEqual(steps.map((s) => s.together), [true, false, false]);
  assert.equal(steps[2].back, 1);
  assert.deepEqual(groupAt(steps, 1), [0, 1]);
  assert.deepEqual(groupAt(steps, 2), [2, 2]);
});

test('each step goes to its worker in turn, the result is passed on, and it finishes', () => {
  const t = setup();
  try {
    const s = t.mk([{ title: 'ایده', who: 'idea' }, { title: 'مقاله', who: 'writer', brief: 'بنویس' }]);
    const run = t.begin(s.id, 'موضوع: قهوه');
    assert.equal(t.open('idea').length, 1);
    assert.equal(t.open('writer').length, 0);
    assert.ok(t.told.some((n) => n.to === 'idea' && /ایده/.test(n.text)));
    assert.match(t.open('idea')[0].detail, /موضوع: قهوه/);

    t.finish('idea', t.open('idea')[0].id, 'ایده: قهوه‌ی سرد');
    assert.deepEqual(run.parts.map((p) => p.step), [1]);
    const mine = t.open('writer')[0];
    assert.match(mine.detail, /قهوه‌ی سرد/);
    assert.match(mine.detail, /بنویس/);
    assert.equal(t.tasks.list({ assignee: 'idea', open: true }).length, 0);

    t.finish('writer', mine.id, 'متن آماده');
    assert.equal(run.status, 'done');
    assert.ok(t.sent.some((x) => /تمام شد/.test(x)));
  } finally {
    t.done();
  }
});

test('steps marked together run at once and the next waits for both', () => {
  const t = setup();
  try {
    const s = t.mk([{ title: 'بک‌اند', who: 'back', together: true }, { title: 'فرانت', who: 'front' }, { title: 'مونتاژ', who: 'writer' }]);
    t.begin(s.id);
    assert.equal(t.open('back').length, 1);
    assert.equal(t.open('front').length, 1);
    t.finish('back', t.open('back')[0].id, 'api');
    assert.equal(t.open('writer').length, 0);
    t.finish('front', t.open('front')[0].id, 'ui');
    assert.match(t.open('writer')[0].detail, /api[\s\S]*ui/);
  } finally {
    t.done();
  }
});

test('QA sends the work back to the step it names, with its complaints, up to the limit', () => {
  const t = setup();
  try {
    const s = t.mk([{ title: 'مقاله', who: 'writer' }, { title: 'بازبینی', who: 'qa', kind: 'qa', back: 0 }], { maxReturns: 1 });
    const run = t.begin(s.id);
    t.finish('writer', t.open('writer')[0].id, 'v1');
    t.finish('qa', t.open('qa')[0].id, 'تیتر غلط است', 'blocked');
    assert.equal(run.returns, 1);
    const again = t.open('writer')[0];
    assert.match(again.detail, /تیتر غلط است/);
    t.finish('writer', again.id, 'v2');
    t.finish('qa', t.open('qa')[0].id, 'هنوز غلط', 'blocked');
    assert.equal(run.status, 'stuck');
    assert.ok(t.sent.some((x) => /گیر کرد/.test(x)));
  } finally {
    t.done();
  }
});

test('QA saying yes ends it with no return', () => {
  const t = setup();
  try {
    const s = t.mk([{ title: 'مقاله', who: 'writer' }, { title: 'بازبینی', who: 'qa', kind: 'qa' }]);
    const run = t.begin(s.id);
    t.finish('writer', t.open('writer')[0].id, 'v1');
    t.finish('qa', t.open('qa')[0].id, 'درست است');
    assert.equal(run.status, 'done');
    assert.equal(run.returns, 0);
  } finally {
    t.done();
  }
});

test('a gated step waits for the person; stopping cancels what is open', () => {
  const t = setup();
  try {
    const s = t.mk([{ title: 'مقاله', who: 'writer' }, { title: 'بارگذاری', who: 'back', gate: true }]);
    const run = t.begin(s.id);
    t.finish('writer', t.open('writer')[0].id, 'v1');
    assert.equal(run.status, 'gate');
    assert.equal(t.open('back').length, 0);
    assert.equal(t.flows.approve(run.id).ok, true);
    assert.equal(t.open('back').length, 1);
    assert.equal(t.flows.stop(run.id).ok, true);
    assert.equal(t.open('back').length, 0);
    assert.equal(run.status, 'stopped');
  } finally {
    t.done();
  }
});

test('a worker who is stuck leaves the run stuck, and retry tries the step again', () => {
  const t = setup();
  try {
    const s = t.mk([{ title: 'مقاله', who: 'writer' }]);
    const run = t.begin(s.id);
    t.finish('writer', t.open('writer')[0].id, 'سایت باز نشد', 'blocked');
    assert.equal(run.status, 'stuck');
    assert.equal(t.flows.retry(run.id).ok, true);
    assert.equal(run.status, 'running');
    assert.equal(t.open('writer').length, 1);
  } finally {
    t.done();
  }
});

test('an absent worker refuses the start, and the real manager is not woken for steps', () => {
  const t = setup();
  try {
    const bad = t.mk([{ title: 'مقاله', who: 'nobody' }]);
    assert.equal(t.flows.start(bad.id, '').ok, false);
    assert.equal(t.flows.runs.length, 0);
    const good = t.mk([{ title: 'مقاله', who: 'writer' }]);
    t.begin(good.id);
    assert.equal(t.told.filter((n) => n.to !== 'writer').length, 0);
  } finally {
    t.done();
  }
});

test('it survives a restart and is written out as a page', () => {
  const t = setup();
  try {
    const s = t.mk([{ title: 'مقاله', who: 'writer' }]);
    const run = t.begin(s.id, 'x');
    const again = new Flows(t.dir, { tasks: t.tasks, workers: () => people, tell: () => {}, notify: () => {} });
    assert.equal(again.scenarios.length, 1);
    assert.equal(again.runs[0].id, run.id);
    assert.match(readFileSync(path.join(t.dir, 'out', 'scenarios.md'), 'utf8'), /مقاله/);
  } finally {
    t.done();
  }
});

test('a manager a scenario uses, or a scenario that is running, cannot be removed', () => {
  const t = setup();
  try {
    const s = t.mk([{ title: 'مقاله', who: 'writer' }]);
    assert.equal(t.flows.removeBoss(s.boss).ok, false);
    t.begin(s.id);
    assert.equal(t.flows.removeScenario(s.id).ok, false);
  } finally {
    t.done();
  }
});
