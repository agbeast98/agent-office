import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { WorkerInfo } from '../src/shared/protocol.js';
import { TeamTasks } from '../src/server/team-tasks.js';

const worker = (id: string, name: string, role?: string): WorkerInfo => ({ id, name, kind: 'agent', role }) as WorkerInfo;
const WORKERS = [worker('m1', 'علیرضا احمدی', 'مدیر تیم'), worker('h1', 'آوا رضایی', 'شکارچی پروژه'), worker('w1', 'مهسا کاظمی', 'نویسنده')];

function fresh() {
  const dir = mkdtempSync(path.join(tmpdir(), 'team-tasks-'));
  const tasks = new TeamTasks(dir);
  return { dir, tasks, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('the manager is the one chosen, or else the worker whose role says it manages', () => {
  const { tasks, done } = fresh();
  try {
    assert.equal(tasks.manager(WORKERS)?.name, 'علیرضا احمدی');
    tasks.setManager('w1');
    assert.equal(tasks.manager(WORKERS)?.name, 'مهسا کاظمی');
    tasks.setManager('gone');
    assert.equal(tasks.manager(WORKERS)?.name, 'علیرضا احمدی');
    assert.equal(tasks.manager([worker('a', 'آ'), worker('b', 'ب')]), undefined);
  } finally {
    done();
  }
});

test('the manager hands a task out and the worker is told; anyone else only asks the manager', () => {
  const { tasks, done } = fresh();
  try {
    const boss = tasks.actorOf(WORKERS[0], WORKERS);
    const ava = tasks.actorOf(WORKERS[1], WORKERS);
    assert.equal(boss.boss, true);
    assert.equal(ava.boss, false);

    const given = tasks.create(boss, { title: 'پیدا کردن پروژه‌های تازه', detail: 'فقط ۲۴ ساعت اخیر', assignee: 'آوا رضایی', priority: 'high', due: '2026-11-05' }, WORKERS);
    assert.ok(given.ok);
    assert.equal(given.task?.id, 'T-1');
    assert.equal(given.task?.assignee?.id, 'h1');
    assert.equal(given.task?.priority, 'high');
    assert.deepEqual(given.notices.map((n) => n.to), ['h1']);

    // A worker's own "create" is a request to the manager, whoever it names.
    const asked = tasks.create(ava, { title: 'قیمت را بررسی کنید', assignee: 'مهسا کاظمی' }, WORKERS);
    assert.ok(asked.ok);
    assert.equal(asked.task?.request, true);
    assert.equal(asked.task?.assignee?.id, 'm1');
    assert.deepEqual(asked.notices.map((n) => n.to), ['m1']);

    assert.equal(tasks.create(boss, { title: '' }, WORKERS).ok, false);
    assert.equal(tasks.create(boss, { title: 'x', assignee: 'ناشناس' }, WORKERS).ok, false);
    assert.equal(tasks.create(ava, { title: 'x' }, [WORKERS[1]]).ok, false, 'no manager to ask');
  } finally {
    done();
  }
});

test('a worker moves its own task along, finishing goes to review, and only the manager closes or reassigns', () => {
  const { tasks, done } = fresh();
  try {
    const boss = tasks.actorOf(WORKERS[0], WORKERS);
    const ava = tasks.actorOf(WORKERS[1], WORKERS);
    const mahsa = tasks.actorOf(WORKERS[2], WORKERS);
    tasks.create(boss, { title: 'کار', assignee: 'h1' }, WORKERS);

    const started = tasks.update(ava, 'T-1', { status: 'doing' }, WORKERS);
    assert.ok(started.ok);
    assert.equal(started.task?.status, 'doing');

    const finished = tasks.update(ava, 't-1', { status: 'done' }, WORKERS);
    assert.ok(finished.ok);
    assert.equal(finished.task?.status, 'review', 'a worker saying done sends it to review');
    assert.deepEqual(finished.notices.map((n) => n.to), ['m1']);

    // Not hers to rename, hand on or cancel; not another worker's to touch.
    assert.equal(tasks.update(ava, 'T-1', { title: 'new' }, WORKERS).ok, false);
    assert.equal(tasks.update(ava, 'T-1', { assignee: 'w1' }, WORKERS).ok, false);
    assert.equal(tasks.update(ava, 'T-1', { status: 'cancelled' }, WORKERS).ok, false);
    assert.equal(tasks.update(mahsa, 'T-1', { status: 'doing' }, WORKERS).ok, false);
    assert.equal(tasks.update(ava, 'T-9', { status: 'doing' }, WORKERS).ok, false);
    assert.equal(tasks.update(ava, 'T-1', { status: 'flying' }, WORKERS).ok, false);

    const closed = tasks.update(boss, 'T-1', { status: 'done' }, WORKERS);
    assert.equal(closed.ok && closed.task?.status, 'done');

    const moved = tasks.update(boss, 'T-1', { assignee: 'w1', status: 'todo' }, WORKERS);
    assert.ok(moved.ok);
    assert.equal(moved.task?.assignee?.id, 'w1');
    assert.deepEqual(moved.notices.map((n) => n.to), ['w1']);

    const stuck = tasks.update(tasks.actorOf(WORKERS[2], WORKERS), 'T-1', { status: 'blocked' }, WORKERS);
    assert.deepEqual(stuck.ok && stuck.notices.map((n) => n.to), ['m1']);
  } finally {
    done();
  }
});

test('notes reach the other side, and only those on a task can add them', () => {
  const { tasks, done } = fresh();
  try {
    const boss = tasks.actorOf(WORKERS[0], WORKERS);
    const ava = tasks.actorOf(WORKERS[1], WORKERS);
    const mahsa = tasks.actorOf(WORKERS[2], WORKERS);
    tasks.create(boss, { title: 'کار', assignee: 'h1' }, WORKERS);

    const fromBoss = tasks.note(boss, 'T-1', 'لطفاً فهرست را کوتاه کن', WORKERS);
    assert.deepEqual(fromBoss.ok && fromBoss.notices.map((n) => n.to), ['h1']);
    const fromAva = tasks.note(ava, 'T-1', 'انجام شد', WORKERS);
    assert.deepEqual(fromAva.ok && fromAva.notices.map((n) => n.to), ['m1']);
    assert.equal(tasks.get('T-1')?.notes.length, 2);
    assert.equal(tasks.note(mahsa, 'T-1', 'سلام', WORKERS).ok, false);
    assert.equal(tasks.note(ava, 'T-1', '   ', WORKERS).ok, false);
  } finally {
    done();
  }
});

test('tasks are kept across a restart, and listed by who they are with', () => {
  const { dir, tasks, done } = fresh();
  try {
    const boss = tasks.actorOf(WORKERS[0], WORKERS);
    tasks.create(boss, { title: 'یک', assignee: 'h1' }, WORKERS);
    tasks.create(boss, { title: 'دو', assignee: 'w1' }, WORKERS);
    tasks.update(boss, 'T-2', { status: 'done' }, WORKERS);
    tasks.setManager('w1');

    const again = new TeamTasks(dir);
    assert.deepEqual(again.all().map((t) => t.id), ['T-1', 'T-2']);
    assert.equal(again.manager(WORKERS)?.id, 'w1');
    assert.deepEqual(again.list({ mine: 'h1' }).map((t) => t.id), ['T-1']);
    assert.deepEqual(again.list({ open: true }).map((t) => t.id), ['T-1']);
    // The next one carries on from where it was, not from 1.
    const next = again.create(again.actorOf(WORKERS[2], WORKERS), { title: 'سه', assignee: 'h1' }, WORKERS);
    assert.equal(next.ok && next.task?.id, 'T-3');
  } finally {
    done();
  }
});
