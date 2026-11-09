import test from 'node:test';
import assert from 'node:assert/strict';
import { openWorkNote } from '../src/server/resume-work.js';

const now = Date.UTC(2026, 10, 8, 12, 0, 0);
const hour = 3_600_000;

test('an agent back after a restart is told which tasks were in progress and which it was just given, and only those', () => {
  const tasks = [
    { id: 'T-1', title: 'تحقیق کلمه', status: 'doing', assignee: { id: 'a' }, updatedAt: now - hour },
    { id: 'T-2', title: 'نوشتن', status: 'todo', assignee: { id: 'a' }, updatedAt: now - hour },
    { id: 'T-3', title: 'تصویر', status: 'doing', assignee: { id: 'b' }, updatedAt: now - hour },
    { id: 'T-4', title: 'بازبینی', status: 'done', assignee: { id: 'a' }, updatedAt: now - hour },
    { id: 'T-5', title: 'قدیمی', status: 'todo', assignee: { id: 'a' }, updatedAt: now - 30 * hour },
  ];
  const note = openWorkNote(tasks, 'a', now) ?? '';
  assert.match(note, /در حال انجام تو: T-1 «تحقیق کلمه»/);
  assert.match(note, /هنوز شروع نکرده‌ای: T-2 «نوشتن»/);
  assert.ok(!note.includes('T-3') && !note.includes('T-4') && !note.includes('T-5'), 'not another one\'s, not a finished one, not a todo from yesterday');
  assert.equal(openWorkNote(tasks, 'nobody', now), undefined);
  // only a todo: it is told to start it
  const only = openWorkNote([{ id: 'T-9', title: 'بازبینی نهایی', status: 'todo', assignee: { id: 'e' }, updatedAt: now - hour }], 'e', now) ?? '';
  assert.match(only, /همین حالا شروع کن/);
  assert.ok(!only.includes('در حال انجام'));
});

test('work that stands still: the idle agent is told once, then its manager once; a long block goes to the manager; moving work starts over', async () => {
  const { stalledWork } = await import('../src/server/resume-work.js');
  const min = 60_000;
  const state = { told: new Map() };
  const tasks = [
    { id: 'T-1', title: 'نوشتن', status: 'todo', assignee: { id: 'a' }, updatedAt: now - 50 * min },
    { id: 'T-2', title: 'تصویر', status: 'doing', assignee: { id: 'b' }, updatedAt: now - 50 * min },
    { id: 'T-3', title: 'API', status: 'blocked', assignee: { id: 'a' }, updatedAt: now - 3 * hour },
    { id: 'T-4', title: 'تازه', status: 'doing', assignee: { id: 'a' }, updatedAt: now - 5 * min },
  ];
  const idle = (w: string) => w !== 'b'; // b is working
  const managerOf = () => 'm';
  const first = stalledWork(tasks, idle, managerOf, state, now);
  assert.deepEqual(first.map((n) => `${n.to}:${n.text.includes('T-1') ? 'T-1' : n.text.includes('T-3') ? 'T-3' : '?'}`), ['a:T-1', 'm:T-3']);
  // ten minutes on: nothing new is said
  assert.equal(stalledWork(tasks, idle, managerOf, state, now + 10 * min).length, 0);
  // forty minutes after the reminder, still nothing moved: the manager hears about T-1, once
  const later = stalledWork(tasks, idle, managerOf, state, now + 45 * min).filter((n) => n.text.includes('T-1'));
  assert.deepEqual(later.map((n) => n.to), ['m']);
  assert.match(later[0].text, /T-1/);
  assert.equal(stalledWork(tasks, idle, managerOf, state, now + 60 * min).filter((n) => n.text.includes('T-1')).length, 0);
  // the task moves: it is forgotten, and stalls again only after a while
  tasks[0].updatedAt = now + 61 * min;
  assert.equal(stalledWork(tasks, idle, managerOf, state, now + 70 * min).filter((n) => n.text.includes('T-1')).length, 0);
});
