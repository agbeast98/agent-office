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
