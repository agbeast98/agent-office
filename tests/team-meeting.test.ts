import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TeamMeetings } from '../src/server/team-meeting.js';

const MEMBERS = [{ id: 'a', name: 'آوا' }, { id: 'b', name: 'نیما' }, { id: 'm', name: 'علیرضا' }];

function fresh() {
  const dir = mkdtempSync(path.join(tmpdir(), 'team-meeting-'));
  return { dir, meetings: new TeamMeetings(dir), done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a meeting calls the people it names, each speaks once a round, and the next round hands them what was said', () => {
  const { meetings, done } = fresh();
  try {
    assert.equal(meetings.start('مدیرعامل', '', MEMBERS).ok, false);
    assert.equal(meetings.start('مدیرعامل', 'قیمت‌گذاری', []).ok, false);
    const started = meetings.start('مدیرعامل', 'قیمت‌گذاری پروژه‌ها', MEMBERS);
    assert.ok(started.ok);
    assert.deepEqual(started.notices.map((n) => n.to), ['a', 'b', 'm']);
    assert.match(started.notices[0].text, /meeting_say/);
    assert.equal(meetings.start('x', 'دیگر', MEMBERS).ok, false, 'one meeting at a time');

    assert.ok(meetings.say({ id: 'a', name: 'آوا' }, 'پیشنهاد من ۵ میلیون').ok);
    assert.equal(meetings.say({ id: 'a', name: 'آوا' }, 'دوباره').ok, false, 'once a round');
    assert.equal(meetings.say({ id: 'zzz', name: 'غریبه' }, 'سلام').ok, false, 'not in the meeting');
    assert.ok(meetings.say({ name: 'مدیرعامل' }, 'لطفاً کوتاه').ok, 'the person speaks as often as they like');
    assert.ok(meetings.say({ name: 'مدیرعامل' }, 'و دقیق').ok);
    assert.equal(meetings.say({ id: 'b', name: 'نیما' }, '   ').ok, false);

    const next = meetings.nextRound();
    assert.ok(next.ok);
    assert.equal(next.meeting.round, 2);
    assert.match(next.notices[1].text, /پیشنهاد من ۵ میلیون/);
    assert.ok(meetings.say({ id: 'a', name: 'آوا' }, 'موافقم با نیما').ok, 'a new round, a new turn');
  } finally {
    done();
  }
});

test('the manager is asked to write it up, the outcome is kept, and ending moves it to the past', () => {
  const { dir, meetings, done } = fresh();
  try {
    assert.equal(meetings.end().ok, false);
    meetings.start('مدیرعامل', 'موضوع', MEMBERS);
    meetings.say({ id: 'b', name: 'نیما' }, 'نظر نیما');
    assert.equal(meetings.summarise(undefined).ok, false);
    const asked = meetings.summarise({ id: 'm', name: 'علیرضا' });
    assert.ok(asked.ok);
    assert.deepEqual(asked.notices.map((n) => n.to), ['m']);
    assert.match(asked.notices[0].text, /نظر نیما/);
    assert.ok(meetings.setSummary('تصمیم: قیمت ۵ میلیون').ok);

    // A restart in the middle keeps the meeting.
    assert.equal(new TeamMeetings(dir).current?.summary, 'تصمیم: قیمت ۵ میلیون');
    assert.ok(meetings.end().ok);
    assert.equal(meetings.current, undefined);
    assert.equal(meetings.past[0].summary, 'تصمیم: قیمت ۵ میلیون');
    const after = new TeamMeetings(dir);
    assert.equal(after.current, undefined);
    assert.equal(after.past.length, 1);
  } finally {
    done();
  }
});
