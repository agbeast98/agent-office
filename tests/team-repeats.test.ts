import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TeamRepeats } from '../src/server/team-repeats.js';

const fresh = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'team-repeats-'));
  return { dir, r: new TeamRepeats(dir), done: () => rmSync(dir, { recursive: true, force: true }) };
};
const HOUR = 3_600_000;
const anyone = () => true;

test('a round is told at once, then again only after its hours, and waits for a busy person', () => {
  const { dir, r, done } = fresh();
  try {
    assert.equal(r.set({ to: 'w1', everyHours: 10, text: 'look for something new' }), undefined);
    const t0 = 1_000 * HOUR;
    assert.deepEqual(r.due(t0, () => false), [], 'the person is busy');
    assert.equal(r.due(t0, anyone).length, 1);
    assert.deepEqual(r.due(t0 + 9 * HOUR, anyone), []);
    assert.deepEqual(r.due(t0 + 10 * HOUR, () => false), [], 'due, but busy: kept for later');
    assert.equal(r.due(t0 + 10 * HOUR + 60_000, anyone).length, 1);
    // It is kept on disk, with when it last ran.
    const again = new TeamRepeats(dir);
    assert.equal(again.items[0].id, 'E-1');
    assert.deepEqual(again.due(t0 + 11 * HOUR, anyone), []);
  } finally { done(); }
});

test('one can be changed, turned off and removed; nonsense is refused', () => {
  const { r, done } = fresh();
  try {
    assert.match(r.set({ to: 'w1', everyHours: 0, text: 'x' }) ?? '', /hours/);
    assert.match(r.set({ to: 'w1', everyHours: 5, text: ' ' }) ?? '', /tell/);
    assert.match(r.set({ id: 'E-9', enabled: false }) ?? '', /No such/);
    r.set({ to: 'w1', everyHours: 5, text: 'x' });
    assert.equal(r.set({ id: 'E-1', enabled: false }), undefined);
    assert.deepEqual(r.due(Date.now(), anyone), []);
    r.set({ id: 'E-1', enabled: true, everyHours: 2 }, 50 * HOUR);
    assert.deepEqual(r.due(51 * HOUR, anyone), [], 'a changed pace counts from the change');
    assert.equal(r.due(52 * HOUR, anyone).length, 1);
    assert.equal(r.set({ id: 'E-1', remove: true }), undefined);
    assert.equal(r.items.length, 0);
  } finally { done(); }
});
