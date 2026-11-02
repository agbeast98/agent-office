// The meeting room's window (see client/features/manager/meeting.ts): the team meeting that is on, with who is
// in it and how they are, what was said, the agenda, the decisions and the tasks it made, and the earlier ones
// with their minutes. And what the person does there: call it, say something, ask one person, note, decide,
// make a task, let someone in or out, hand out the next round, have the manager sum it up, end it.
import { tell, view } from '../../hooks/office-tasks.js';
import { str } from '../../office/input.js';
import type { MeetingOutcome } from '../../team-meeting.js';
import type { Floor } from '../../floor.js';
import { readBody, sameOrigin, send } from '../util.js';
import type { Route } from '../router.js';
import { floorParam } from './files.js';

/** How long a member who isn't reported sitting down is waited for before they're told anyway. */
const ARRIVE_FALLBACK_MS = 20_000;

/** Tells them once they sit (the 3D view says so), or after a while if no one is watching. */
function holdUntilSeated(floor: Floor, notices: Parameters<typeof tell>[1], by: string) {
  floor.teamMeetings.hold(notices);
  const timer = setTimeout(() => tell(floor, floor.teamMeetings.arriveAll(), by), ARRIVE_FALLBACK_MS);
  timer.unref();
}

const agents = (floor: Floor) => floor.workers.list().filter((w) => w.kind === 'agent');

/** The tasks a meeting made, as they are now. */
function madeIn(floor: Floor, ids: string[]) {
  return ids.map((id) => floor.teamTasks.get(id)).filter((t): t is NonNullable<typeof t> => !!t);
}

export const teamMeetingRoutes = {
  /** GET /api/team/meeting?floor=<id>[&id=<past meeting>]: the meeting that is on and the last few; with `id`, one of them in full. */
  meeting: {
    method: 'GET',
    path: '/api/team/meeting',
    auth: 'session',
    handle(ctx, { res, url }) {
      const floor = floorParam(ctx, url);
      if (!floor) return send(res, 404, { error: 'No such floor' });
      const { current, past } = floor.teamMeetings;
      const people = agents(floor);
      const boss = floor.teamTasks.manager(people);
      const full = (m: NonNullable<typeof current>) => ({ ...m, taskList: madeIn(floor, m.tasks).map((t) => ({ ...view(t), assigneeId: t.assignee?.id })) });
      const wanted = url.searchParams.get('id');
      const one = wanted ? floor.teamMeetings.find(wanted) : undefined;
      return send(res, 200, {
        manager: boss?.id,
        now: Date.now(),
        people: people.map((w) => ({ id: w.id, name: w.name, role: w.role, color: w.color, status: w.status, activity: w.activity, inMeeting: !!current?.members.some((m) => m.id === w.id), seated: !!w.meetingOriginDesk })),
        current: current && full(current),
        past: past.slice(0, 15).map((m) => ({ id: m.id, topic: m.topic, startedAt: m.startedAt, endedAt: m.endedAt, summary: m.summary, said: m.said.filter((s) => !s.note).length, decisions: m.decisions.length, tasks: m.tasks.length, members: m.members.map((x) => x.name) })),
        ...(one && one !== current ? { detail: full(one) } : {}),
      });
    },
  },
  /** GET /api/team/meeting/minutes?floor=<id>&id=<meeting>: the minutes of a meeting that ended, as a file. */
  minutes: {
    method: 'GET',
    path: '/api/team/meeting/minutes',
    auth: 'session',
    handle(ctx, { res, url }) {
      const floor = floorParam(ctx, url);
      if (!floor) return send(res, 404, { error: 'No such floor' });
      const id = url.searchParams.get('id') ?? '';
      const text = floor.teamMeetings.minutesFile(id);
      if (!text || !/^M-[a-z0-9]+$/.test(id)) return send(res, 404, { error: 'No minutes for that meeting' });
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': `attachment; filename="${id}.md"`, 'cache-control': 'no-store' });
      res.end(text);
    },
  },
  /** POST /api/team/meeting?floor=<id>: { action: start | say | ask | note | decide | agenda | task | invite | dismiss | next | summarise | end, ... } */
  action: {
    method: 'POST',
    path: '/api/team/meeting',
    auth: 'session',
    async handle(ctx, { req, res, url, session }) {
      if (!sameOrigin(req, ctx.cfg)) return send(res, 403, { error: 'Forbidden' });
      const floor = floorParam(ctx, url);
      if (!floor) return send(res, 404, { error: 'No such floor' });
      let body: Record<string, unknown>;
      try {
        const value = JSON.parse(await readBody(req, 20_000));
        if (!value || typeof value !== 'object' || Array.isArray(value)) return send(res, 400, { error: 'Bad request' });
        body = value as Record<string, unknown>;
      } catch {
        return send(res, 400, { error: 'Bad request' });
      }
      const meetings = floor.teamMeetings;
      const workers = agents(floor);
      const name = session.account?.name ?? 'مدیرعامل';
      const pick = (id: unknown) => workers.find((w) => w.id === id);
      let result: MeetingOutcome;
      switch (body.action) {
        case 'start': {
          const ids = Array.isArray(body.members) ? body.members.filter((x): x is string => typeof x === 'string') : [];
          const members = (body.members === 'all' ? workers : workers.filter((w) => ids.includes(w.id))).map((w) => ({ id: w.id, name: w.name }));
          const boss = floor.teamTasks.manager(workers);
          result = meetings.start(name, body.topic, members, body.agenda, { mode: body.mode, rounds: body.rounds, manager: boss && { id: boss.id, name: boss.name } });
          if (!result.ok) break;
          // They sit down at the meeting room's table, as many as it has chairs for; whoever can't is said so.
          const notSeated = members.flatMap((m) => {
            const why = floor.workers.visitMeeting(m.id);
            return why ? [{ name: m.name, why }] : [];
          });
          holdUntilSeated(floor, result.notices, name);
          // Someone who can't sit at the table is told at once, wherever they are.
          for (const n of notSeated) {
            const w = workers.find((x) => x.name === n.name);
            if (w) tell(floor, meetings.arrived(w.id), name);
          }
          return send(res, 200, { ok: true, notSeated });
        }
        case 'arrived': {
          tell(floor, meetings.arrived(typeof body.worker === 'string' ? body.worker : ''), name);
          return send(res, 200, { ok: true });
        }
        case 'seat': {
          const why = floor.workers.visitMeeting(typeof body.worker === 'string' ? body.worker : '');
          return why ? send(res, 400, { error: why }) : send(res, 200, { ok: true });
        }
        case 'closevote':
          result = meetings.closeVote();
          break;
        case 'say':
          result = meetings.say({ name }, body.text);
          if (result.ok) tell(floor, result.meeting.members.map((m) => ({ to: m.id, text: `در جلسه‌ی «${result.ok ? result.meeting.topic : ''}» ${name} به همه گفت: ${str(body.text, 3000)}\nهمه جواب بدهند: کوتاه (حداکثر ۱۰ خط) با ابزار meeting_say، حتی اگر فقط بگویی به تو مربوط نیست یا نمی‌توانی. این بار نوبت اضافه است. در ترمینال جواب نده.` })), name);
          break;
        case 'ask':
          result = meetings.ask(name, typeof body.to === 'string' ? body.to : '', body.text);
          break;
        case 'note':
          result = meetings.note(name, body.text);
          break;
        case 'decide':
          result = meetings.decide(name, body.text);
          break;
        case 'agenda':
          result = meetings.agendaItem({ add: body.add, toggle: body.toggle });
          break;
        case 'task': {
          const m = meetings.current;
          if (!m) return send(res, 400, { error: 'No meeting is on' });
          const made = floor.teamTasks.create({ name, boss: true }, { title: body.title, detail: str(body.detail, 4000) || `ساخته‌شده در جلسه‌ی «${m.topic}»`, assignee: body.assignee, priority: body.priority, due: body.due }, workers);
          if (!made.ok) return send(res, 400, { error: made.error });
          if (made.task) meetings.linkTask(made.task.id);
          tell(floor, made.notices, name);
          return send(res, 200, { ok: true, task: made.task && view(made.task) });
        }
        case 'invite': {
          const w = pick(body.worker);
          if (!w) return send(res, 400, { error: 'No such person' });
          result = meetings.invite({ id: w.id, name: w.name });
          if (result.ok) {
            const seated = floor.workers.visitMeeting(w.id);
            if (seated) {
              meetings.dismiss(w.id);
              return send(res, 400, { error: seated });
            }
            holdUntilSeated(floor, result.notices, name);
            return send(res, 200, { ok: true });
          }
          break;
        }
        case 'dismiss':
          result = meetings.dismiss(typeof body.worker === 'string' ? body.worker : '');
          if (result.ok && floor.workers.get(String(body.worker))?.meetingOriginDesk) floor.workers.returnFromMeeting(String(body.worker));
          break;
        case 'next':
          result = meetings.nextRound();
          break;
        case 'summarise': {
          const boss = floor.teamTasks.manager(workers);
          result = meetings.summarise(boss && { id: boss.id, name: boss.name });
          break;
        }
        case 'end': {
          const members = meetings.current?.members ?? [];
          const made = madeIn(floor, meetings.current?.tasks ?? []).map((t) => ({ id: t.id, title: t.title, status: t.status, assignee: t.assignee?.name }));
          result = meetings.end(made);
          if (result.ok) for (const m of members) if (floor.workers.get(m.id)?.meetingOriginDesk) floor.workers.returnFromMeeting(m.id);
          if (result.ok) void floor.notifier.send(`🤝 جلسه‌ی «${result.meeting.topic}» تمام شد${result.meeting.decisions.length ? ` (${result.meeting.decisions.length} تصمیم)` : ''}`);
          break;
        }
        default:
          return send(res, 400, { error: 'action is start, say, ask, note, decide, agenda, task, invite, dismiss, next, summarise or end' });
      }
      if (!result.ok) return send(res, 400, { error: result.error });
      tell(floor, result.notices, name);
      return send(res, 200, { ok: true });
    },
  },
} satisfies Record<string, Route>;
