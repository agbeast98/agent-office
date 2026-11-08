import test from 'node:test';
import assert from 'node:assert/strict';
import { openWorkNote } from '../src/server/resume-work.js';

test('an agent back after a restart is told which of its tasks were in progress, and only those', () => {
  const tasks = [
    { id: 'T-1', title: 'تحقیق کلمه', status: 'doing', assignee: { id: 'a' } },
    { id: 'T-2', title: 'نوشتن', status: 'todo', assignee: { id: 'a' } },
    { id: 'T-3', title: 'تصویر', status: 'doing', assignee: { id: 'b' } },
    { id: 'T-4', title: 'بازبینی', status: 'done', assignee: { id: 'a' } },
  ];
  const note = openWorkNote(tasks, 'a');
  assert.match(note ?? '', /T-1 «تحقیق کلمه»/);
  assert.ok(!note?.includes('T-2') && !note?.includes('T-3') && !note?.includes('T-4'));
  assert.equal(openWorkNote(tasks, 'nobody'), undefined);
});
