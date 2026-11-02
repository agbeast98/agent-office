import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { WorkerInfo } from '../src/shared/protocol.js';
import { TeamSchedule, noticesFor } from '../src/server/team-schedule.js';

const worker = (id: string, name: string, role?: string): WorkerInfo => ({ id, name, kind: 'agent', role }) as WorkerInfo;
const fresh = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'team-schedule-'));
  return { dir, s: new TeamSchedule(dir), done: () => rmSync(dir, { recursive: true, force: true }) };
};
// 2026-11-07 is a Saturday (6); 2026-11-08 a Sunday (0).
const at = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m, 0, 0);

test('everything is off until the person turns it on', () => {
  const { s, done } = fresh();
  try {
    assert.deepEqual(s.due(at(7, 12)), []);
  } finally { done(); }
});

test('an item runs once on its day after its time, and catches up if the office opens late', () => {
  const { s, done } = fresh();
  try {
    s.set('interview', { enabled: true, time: '09:00', days: [6] });
    s.items[0].lastRun = 0;
    assert.deepEqual(s.due(at(7, 8, 59)), [], 'not yet');
    assert.deepEqual(s.due(at(8, 12)), [], 'not on a Sunday');
    assert.deepEqual(s.due(at(7, 14)).map((i) => i.id), ['interview'], 'the office opened at 14:00: still runs');
    assert.deepEqual(s.due(at(7, 14, 1)), [], 'only once a day');
    assert.deepEqual(s.due(new Date(2026, 10, 14, 9, 0)).map((i) => i.id), ['interview'], 'and again next week');
  } finally { done(); }
});

test('turning an item on after its time has passed does not fire it for today', () => {
  const { s, done } = fresh();
  try {
    s.set('review', { enabled: true, time: '00:01', days: [0, 1, 2, 3, 4, 5, 6] });
    assert.deepEqual(s.due(new Date()), []);
  } finally { done(); }
});

test('bad changes are refused, good ones are kept across a restart', () => {
  const { dir, s, done } = fresh();
  try {
    assert.match(s.set('nope', {}) ?? '', /No such/);
    assert.match(s.set('review', { time: '25:00' }) ?? '', /HH:MM/);
    assert.match(s.set('review', { days: [9] }) ?? '', /0 to 6/);
    assert.equal(s.set('workday', { enabled: true, time: '10:15', days: [1, 3, 1] }), undefined);
    const again = new TeamSchedule(dir).items.find((i) => i.id === 'workday');
    assert.deepEqual([again?.enabled, again?.time, again?.days], [true, '10:15', [1, 3]]);
  } finally { done(); }
});

test('the interview goes to the interviewer and the rest to the manager', () => {
  const { s, done } = fresh();
  try {
    const team = [worker('m', 'مدیر', 'مدیر تیم'), worker('i', 'سارا', 'مصاحبه‌گر'), worker('h', 'آوا', 'شکارچی')];
    const [interview, review, workday] = s.items;
    assert.deepEqual(noticesFor(interview, team, team[0]).map((n) => n.to), ['i']);
    assert.deepEqual(noticesFor(review, team, team[0]).map((n) => n.to), ['m']);
    assert.deepEqual(noticesFor(workday, team, team[0]).map((n) => n.to), ['m']);
    assert.deepEqual(noticesFor(workday, team, undefined), [], 'no manager, no one to tell');
    assert.deepEqual(noticesFor(interview, [team[0]], team[0]), [], 'no interviewer');
  } finally { done(); }
});
