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

test('an agenda is told to everyone, and points can be added and ticked off', () => {
  const { meetings, done } = fresh();
  try {
    const started = meetings.start('مدیرعامل', 'برنامه‌ی هفته', MEMBERS, '1) قیمت‌ها\n- ساعت کاری\n\n');
    assert.ok(started.ok);
    assert.deepEqual(started.meeting.agenda.map((a) => a.text), ['قیمت‌ها', 'ساعت کاری']);
    assert.match(started.notices[0].text, /دستور جلسه: 1\) قیمت‌ها 2\) ساعت کاری/);
    assert.ok(meetings.agendaItem({ add: 'گزارش روزانه' }).ok);
    assert.ok(meetings.agendaItem({ toggle: 0 }).ok);
    assert.deepEqual(meetings.current?.agenda.map((a) => a.done), [true, false, false]);
    assert.equal(meetings.agendaItem({ add: '  ' }).ok, false);
    assert.equal(meetings.agendaItem({ toggle: 9 }).ok, false);
    assert.equal(meetings.start('x', 'y', MEMBERS.concat(MEMBERS, MEMBERS)).ok, false, 'more people than chairs');
  } finally { done(); }
});

test('asking one person lets them answer again, tells only them, and a note is told to no one', () => {
  const { meetings, done } = fresh();
  try {
    meetings.start('مدیرعامل', 'موضوع', MEMBERS);
    meetings.say({ id: 'a', name: 'آوا' }, 'نظر اول');
    assert.equal(meetings.say({ id: 'a', name: 'آوا' }, 'نظر دوم').ok, false);

    const asked = meetings.ask('مدیرعامل', 'a', 'منظورت از قیمت چیست؟');
    assert.ok(asked.ok);
    assert.deepEqual(asked.notices.map((n) => n.to), ['a']);
    assert.match(asked.notices[0].text, /منظورت از قیمت چیست/);
    assert.ok(meetings.say({ id: 'a', name: 'آوا' }, 'منظورم قیمت پایه است').ok, 'answering a question is allowed');
    assert.equal(meetings.say({ id: 'a', name: 'آوا' }, 'باز هم').ok, false, 'but only once per question');
    assert.equal(meetings.ask('مدیرعامل', 'zzz', 'سلام').ok, false);
    assert.equal(meetings.ask('مدیرعامل', 'a', ' ').ok, false);

    const noted = meetings.note('مدیرعامل', 'یادم باشد قیمت را چک کنم');
    assert.ok(noted.ok);
    assert.deepEqual(noted.notices, []);
    const next = meetings.nextRound();
    assert.ok(next.ok);
    assert.ok(!next.notices[0].text.includes('یادم باشد'), 'a note is not handed to the next round');
    assert.match(next.notices[0].text, /مدیرعامل ← آوا/);
    const summary = meetings.summarise({ id: 'm', name: 'علیرضا' });
    assert.ok(summary.ok && !summary.notices[0].text.includes('یادم باشد'));
    assert.match(summary.ok ? summary.notices[0].text : '', /meeting_decision/);
  } finally { done(); }
});

test('people come and go mid-meeting, within the chairs, and a decision or a task is kept with the meeting', () => {
  const { meetings, done } = fresh();
  try {
    meetings.start('مدیرعامل', 'موضوع', MEMBERS.slice(0, 2));
    meetings.say({ id: 'a', name: 'آوا' }, 'سلام');
    const joined = meetings.invite(MEMBERS[2]);
    assert.ok(joined.ok);
    assert.match(joined.notices[0].text, /سلام/, 'the newcomer is told what has been said');
    assert.equal(meetings.invite(MEMBERS[2]).ok, false, 'already in');
    for (const x of ['c', 'd']) assert.ok(meetings.invite({ id: x, name: x }).ok);
    assert.equal(meetings.invite({ id: 'e', name: 'e' }).ok, false, 'five chairs');
    assert.ok(meetings.dismiss('d').ok);
    assert.equal(meetings.dismiss('d').ok, false);
    assert.ok(meetings.say({ id: 'm', name: 'علیرضا' }, 'من هم').ok);

    assert.ok(meetings.decide('علیرضا', 'قیمت پایه ۵ میلیون').ok);
    assert.equal(meetings.decide('علیرضا', '').ok, false);
    meetings.linkTask('T-4');
    meetings.linkTask('T-4');
    assert.deepEqual(meetings.current?.tasks, ['T-4']);
    assert.equal(meetings.current?.decisions.length, 1);
  } finally { done(); }
});

test('ending writes the minutes as a file that can be read back, with everything in it but the notes’ privacy kept', () => {
  const { dir, meetings, done } = fresh();
  try {
    meetings.start('مدیرعامل', 'ارزیابی قیمت', MEMBERS, 'قیمت\nزمان');
    meetings.say({ id: 'a', name: 'آوا' }, 'پنج میلیون');
    meetings.ask('مدیرعامل', 'b', 'نظر تو؟');
    meetings.say({ id: 'b', name: 'نیما' }, 'کمی بیشتر');
    meetings.note('مدیرعامل', 'یادداشت شخصی');
    meetings.decide('علیرضا', 'قیمت ۶ میلیون');
    meetings.setSummary('نتیجه: ۶ میلیون');
    const ended = meetings.end([{ id: 'T-7', title: 'ارسال پیشنهاد', status: 'todo', assignee: 'مهسا' }]);
    assert.ok(ended.ok);
    const file = ended.ok ? ended.meeting.minutes : undefined;
    assert.ok(file && file.endsWith(`${ended.ok ? ended.meeting.id : ''}.md`));
    const text = meetings.minutesFile(ended.ok ? ended.meeting.id : '') ?? '';
    for (const want of ['# ارزیابی قیمت', 'آوا، نیما، علیرضا', 'پنج میلیون', 'مدیرعامل ← نیما', 'قیمت ۶ میلیون', 'نتیجه: ۶ میلیون', 'T-7 · ارسال پیشنهاد', '## دستور جلسه', 'یادداشت شخصی']) assert.ok(text.includes(want), want);
    assert.equal(new TeamMeetings(dir).minutesFile('M-zzz'), undefined);
    assert.equal(new TeamMeetings(dir).past[0].decisions.length, 1, 'kept across a restart');
  } finally { done(); }
});

test('a debate runs its rounds by itself, each answering the others, then asks the manager to sum it up', () => {
  const { meetings, done } = fresh();
  try {
    const started = meetings.start('مدیرعامل', 'ارزان یا گران؟', MEMBERS, '', { mode: 'debate', rounds: 2, manager: MEMBERS[2] });
    assert.ok(started.ok);
    assert.equal(started.meeting.mode, 'debate');
    assert.match(started.notices[0].text, /بحث آزاد بین خودتان است و 2 دور/);

    const a = meetings.say({ id: 'a', name: 'آوا' }, 'من گران‌تر می‌گویم');
    assert.ok(a.ok);
    assert.deepEqual(a.notices, [], 'the round goes on until all have spoken');
    meetings.say({ id: 'b', name: 'نیما' }, 'من مخالفم', 'آوا');
    const last = meetings.say({ id: 'm', name: 'علیرضا' }, 'میانه بهتر است', 'نیما');
    assert.ok(last.ok);
    assert.equal(last.meeting.round, 2, 'round two began without anyone pressing next');
    assert.equal(last.notices.length, 4, 'one for the one addressed, three for the new round');
    assert.ok(last.notices.some((n) => n.to === 'b' && /خطاب به تو/.test(n.text)));
    assert.ok(last.notices.some((n) => n.to === 'a' && /دور 2 از 2/.test(n.text) && /من مخالفم/.test(n.text)));
    assert.deepEqual(last.meeting.said[1].to, { id: 'a', name: 'آوا' });

    meetings.say({ id: 'a', name: 'آوا' }, 'قبول');
    meetings.say({ id: 'b', name: 'نیما' }, 'قبول');
    const end = meetings.say({ id: 'm', name: 'علیرضا' }, 'پس میانه');
    assert.ok(end.ok);
    assert.equal(end.meeting.concluded, true);
    assert.equal(end.meeting.round, 2, 'no round past the last');
    assert.deepEqual(end.notices.map((n) => n.to), ['m'], 'the manager is asked to sum up');
    assert.equal(meetings.start('x', 'y', MEMBERS).ok, false);
  } finally { done(); }
});

test('a vote counts itself once all have voted, keeps the result as a decision, and is closed by the person early', () => {
  const { meetings, done } = fresh();
  try {
    const poll = meetings.start('مدیرعامل', 'آیا ساعت ارسال ثابت باشد؟', MEMBERS, '', { mode: 'vote', manager: MEMBERS[2] });
    assert.ok(poll.ok);
    assert.match(poll.notices[0].text, /meeting_vote/);
    assert.equal(meetings.say({ id: 'a', name: 'آوا' }, 'نظرم این است').ok, false, 'members vote, they do not talk');
    assert.ok(meetings.say({ name: 'مدیرعامل' }, 'لطفاً دلیل بگویید').ok, 'the person still can');
    assert.equal(meetings.vote({ id: 'zzz', name: 'غریبه' }, 'yes', '').ok, false);
    assert.equal(meetings.vote({ id: 'a', name: 'آوا' }, 'maybe', '').ok, false);

    assert.ok(meetings.vote({ id: 'a', name: 'آوا' }, 'no', 'داده نداریم').ok);
    assert.ok(meetings.vote({ id: 'a', name: 'آوا' }, 'yes', 'نظرم عوض شد').ok, 'a vote can be changed');
    assert.equal(meetings.current?.votes.length, 1);
    assert.ok(meetings.vote({ id: 'b', name: 'نیما' }, 'yes', 'ساده‌تر است').ok);
    const counted = meetings.vote({ id: 'm', name: 'علیرضا' }, 'no', 'انعطاف لازم است');
    assert.ok(counted.ok);
    assert.deepEqual(counted.meeting.result, { verdict: 'accepted', yes: 2, no: 1, abstain: 0 });
    assert.match(counted.meeting.decisions[0].text, /تصویب شد \(2 موافق، 1 مخالف، 0 ممتنع\)/);
    assert.deepEqual(counted.notices.map((n) => n.to), ['m']);
    assert.equal(meetings.vote({ id: 'a', name: 'آوا' }, 'no', '').ok, false, 'closed');

    meetings.end();
    meetings.start('مدیرعامل', 'دوباره؟', MEMBERS, '', { mode: 'vote' });
    assert.equal(meetings.closeVote().ok, false, 'no one has voted');
    meetings.vote({ id: 'a', name: 'آوا' }, 'no', 'نه');
    meetings.vote({ id: 'b', name: 'نیما' }, 'abstain', '');
    const early = meetings.closeVote();
    assert.ok(early.ok);
    assert.equal(early.meeting.result?.verdict, 'rejected');
    const ended = meetings.end();
    assert.ok(ended.ok);
    assert.match(meetings.minutesFile(ended.ok ? ended.meeting.id : '') ?? '', /## رأی‌ها[\s\S]*آوا: مخالف — نه/);
  } finally { done(); }
});

test('a poll stays as it was, and a meeting saved before modes existed reads as one', () => {
  const { dir, meetings, done } = fresh();
  try {
    const started = meetings.start('مدیرعامل', 'موضوع', MEMBERS);
    assert.ok(started.ok && started.meeting.mode === 'poll' && started.meeting.rounds === 1);
    assert.equal(meetings.vote({ id: 'a', name: 'آوا' }, 'yes', '').ok, false, 'not a vote');
    assert.deepEqual(meetings.say({ id: 'a', name: 'آوا' }, 'سلام').ok && meetings.current?.round, 1, 'no round of its own accord');
    assert.equal(new TeamMeetings(dir).current?.mode, 'poll');
  } finally { done(); }
});

test('what a member is told waits until they have sat down, and the fallback tells whoever was never reported', () => {
  const { meetings, done } = fresh();
  try {
    const started = meetings.start('مدیرعامل', 'موضوع', MEMBERS);
    assert.ok(started.ok);
    assert.ok(started.meeting.members.every((m) => m.joinedAt && !m.arrivedAt), 'called, not yet at the table');
    meetings.hold(started.notices);
    const first = meetings.arrived('a');
    assert.deepEqual(first.map((n) => n.to), ['a'], 'told when they sit');
    assert.match(first[0].text, /meeting_say/);
    assert.deepEqual(meetings.arrived('a'), [], 'only once');
    assert.deepEqual(meetings.arrived('zzz'), [], 'not a member');
    assert.ok(meetings.current?.members[0].arrivedAt);
    assert.deepEqual(meetings.arriveAll().map((n) => n.to), ['b', 'm'], 'the others are told anyway after the wait');
    assert.ok(meetings.current?.members.every((m) => m.arrivedAt));
    assert.deepEqual(meetings.arriveAll(), []);
  } finally { done(); }
});

test('what the person says to the room can be answered by each of them, even after they spoke, and even in a vote', () => {
  const { dir, meetings, done } = fresh();
  try {
    meetings.start('مدیرعامل', 'موضوع', MEMBERS);
    meetings.say({ id: 'a', name: 'آوا' }, 'نظر اول');
    assert.equal(meetings.say({ id: 'a', name: 'آوا' }, 'دوم').ok, false);
    meetings.say({ name: 'مدیرعامل' }, 'کسی آب می‌تواند بخرد؟');
    assert.ok(meetings.say({ id: 'a', name: 'آوا' }, 'نه، پرداخت نمی‌کنم').ok, 'answers the question');
    assert.ok(meetings.say({ id: 'b', name: 'نیما' }, 'من هم نه').ok);
    assert.equal(meetings.say({ id: 'a', name: 'آوا' }, 'باز').ok, false, 'once per question');
    assert.equal(meetings.current?.said.filter((s) => s.id).length, 3);
    meetings.end();

    meetings.start('مدیرعامل', 'آیا؟', MEMBERS, '', { mode: 'vote' });
    assert.equal(meetings.say({ id: 'a', name: 'آوا' }, 'نظر').ok, false, 'in a vote they vote');
    meetings.say({ name: 'مدیرعامل' }, 'دلیلتان؟');
    assert.ok(meetings.say({ id: 'a', name: 'آوا' }, 'دلیلم این است').ok, 'but may answer the person');
    // A restart counts everyone as seated: nobody is left waiting for a walk that won't happen.
    assert.ok(new TeamMeetings(dir).current?.members.every((m) => m.arrivedAt));
  } finally { done(); }
});
