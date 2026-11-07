import assert from 'node:assert/strict';
import test from 'node:test';
import { lineDiff } from '../src/client/features/manager/hiring-diff.js';

test('lineDiff keeps what is the same and marks added and removed lines', () => {
  const d = lineDiff('a\nb\nc', 'a\nc\nd');
  assert.deepEqual(d.map((l) => `${l.t}:${l.text}`), ['same:a', 'del:b', 'same:c', 'add:d']);
  assert.ok(lineDiff('x\ny', 'x\ny').every((l) => l.t === 'same'));
  assert.deepEqual(lineDiff('', 'new').map((l) => l.t), ['del', 'add']);
});
