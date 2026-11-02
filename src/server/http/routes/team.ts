// The manager's computer (see client/features/manager): the team's tasks and people to read, and what the
// person at it does: hand tasks out, move them along, note them, say who the manager is, and tell the team.
import { tell, view } from '../../hooks/office-tasks.js';
import { str } from '../../office/input.js';
import type { Actor, Outcome } from '../../team-tasks.js';
import type { MeetingOutcome } from '../../team-meeting.js';
import { readBody, sameOrigin, send } from '../util.js';
import type { Route } from '../router.js';
import { floorParam } from './files.js';

export const teamRoutes = {
  /** GET /api/team?floor=<id> */
  team: {
    method: 'GET',
    path: '/api/team',
    auth: 'session',
    handle(ctx, { res, url }) {
      const floor = floorParam(ctx, url);
      if (!floor) return send(res, 404, { error: 'No such floor' });
      const workers = floor.workers.list().filter((w) => w.kind === 'agent');
      const boss = floor.teamTasks.manager(workers);
      return send(res, 200, {
        manager: boss ? { id: boss.id, name: boss.name } : undefined,
        hiringLocked: ctx.ledger.hiringLocked,
        people: workers.map((w) => ({ id: w.id, name: w.name, role: w.role, status: w.status, activity: w.activity })),
        tasks: floor.teamTasks.all().map((t) => ({ ...view(t), assigneeId: t.assignee?.id, notes: t.notes.slice(-20), updatedAt: t.updatedAt, createdAt: t.createdAt })),
      });
    },
  },
  /** POST /api/team/action?floor=<id>: { action: create | update | note | manager | command, ... } */
  action: {
    method: 'POST',
    path: '/api/team/action',
    auth: 'session',
    async handle(ctx, { req, res, url, session }) {
      if (!sameOrigin(req, ctx.cfg)) return send(res, 403, { error: 'Forbidden' });
      const floor = floorParam(ctx, url);
      if (!floor) return send(res, 404, { error: 'No such floor' });
      let body: Record<string, unknown>;
      try {
        const value = JSON.parse(await readBody(req, 30_000));
        if (!value || typeof value !== 'object' || Array.isArray(value)) return send(res, 400, { error: 'Bad request' });
        body = value as Record<string, unknown>;
      } catch {
        return send(res, 400, { error: 'Bad request' });
      }
      const workers = floor.workers.list().filter((w) => w.kind === 'agent');
      const by: Actor = { name: session.account?.name ?? 'مدیرعامل', boss: true };
      const tasks = floor.teamTasks;
      const id = typeof body.id === 'string' ? body.id : '';
      let result: Outcome;
      switch (body.action) {
        case 'create':
          result = tasks.create(by, body, workers);
          break;
        case 'update':
          result = tasks.update(by, id, body, workers);
          break;
        case 'note':
          result = tasks.note(by, id, body.text, workers);
          break;
        case 'manager': {
          const w = workers.find((x) => x.id === body.worker);
          if (!w) return send(res, 400, { error: 'Pick one of the team as manager' });
          tasks.setManager(w.id);
          return send(res, 200, { ok: true });
        }
        case 'lock':
          ctx.ledger.setHiringLocked(body.on === true);
          return send(res, 200, { ok: true, hiringLocked: ctx.ledger.hiringLocked });
        case 'command': {
          const text = str(body.text, 8000).replace(/\r\n?/g, '\n').trim();
          if (!text) return send(res, 400, { error: 'Say what to tell them' });
          const to = body.to === 'all' ? workers : workers.filter((w) => w.id === body.to);
          if (!to.length) return send(res, 400, { error: 'Say who to tell' });
          tell(floor, to.map((w) => ({ to: w.id, text: `دستور مدیرعامل (${by.name}): ${text}` })), by.name);
          return send(res, 200, { ok: true, told: to.map((w) => w.name) });
        }
        default:
          return send(res, 400, { error: 'action is create, update, note, manager, lock or command' });
      }
      if (!result.ok) return send(res, 400, { error: result.error });
      tell(floor, result.notices, by.name);
      return send(res, 200, { ok: true, task: result.task && view(result.task) });
    },
  },
  /** GET /api/team/meeting?floor=<id>: the meeting that is on, and the last few. */
  meeting: {
    method: 'GET',
    path: '/api/team/meeting',
    auth: 'session',
    handle(ctx, { res, url }) {
      const floor = floorParam(ctx, url);
      if (!floor) return send(res, 404, { error: 'No such floor' });
      const { current, past } = floor.teamMeetings;
      return send(res, 200, { current, past: past.slice(0, 5).map((m) => ({ id: m.id, topic: m.topic, startedAt: m.startedAt, summary: m.summary, said: m.said.length })) });
    },
  },
  /** POST /api/team/meeting?floor=<id>: { action: start | say | next | summarise | end, ... } */
  meetingAction: {
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
      const workers = floor.workers.list().filter((w) => w.kind === 'agent');
      const name = session.account?.name ?? 'مدیرعامل';
      let result: MeetingOutcome;
      switch (body.action) {
        case 'start': {
          const ids = Array.isArray(body.members) ? body.members.filter((x): x is string => typeof x === 'string') : [];
          const members = (body.members === 'all' ? workers : workers.filter((w) => ids.includes(w.id))).map((w) => ({ id: w.id, name: w.name }));
          result = meetings.start(name, body.topic, members);
          // They sit down at the meeting room's table, as many as it has chairs for.
          if (result.ok) for (const m of members) floor.workers.visitMeeting(m.id);
          break;
        }
        case 'say':
          result = meetings.say({ name }, body.text);
          if (result.ok) tell(floor, result.meeting.members.map((m) => ({ to: m.id, text: `در جلسه‌ی «${result.ok ? result.meeting.topic : ''}» ${name} گفت: ${str(body.text, 3000)}` })), name);
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
          result = meetings.end();
          if (result.ok) for (const m of members) if (floor.workers.get(m.id)?.meetingOriginDesk) floor.workers.returnFromMeeting(m.id);
          break;
        }
        default:
          return send(res, 400, { error: 'action is start, say, next, summarise or end' });
      }
      if (!result.ok) return send(res, 400, { error: result.error });
      tell(floor, result.notices, name);
      return send(res, 200, { ok: true });
    },
  },
} satisfies Record<string, Route>;
