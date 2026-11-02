// The manager's computer (see client/features/manager): the team's tasks and people to read, and what the
// person at it does: hand tasks out, move them along, note them, say who the manager is, and tell the team.
import { tell, view } from '../../hooks/office-tasks.js';
import { str } from '../../office/input.js';
import type { Actor, Outcome } from '../../team-tasks.js';
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
        case 'command': {
          const text = str(body.text, 8000).replace(/\r\n?/g, '\n').trim();
          if (!text) return send(res, 400, { error: 'Say what to tell them' });
          const to = body.to === 'all' ? workers : workers.filter((w) => w.id === body.to);
          if (!to.length) return send(res, 400, { error: 'Say who to tell' });
          tell(floor, to.map((w) => ({ to: w.id, text: `دستور مدیرعامل (${by.name}): ${text}` })), by.name);
          return send(res, 200, { ok: true, told: to.map((w) => w.name) });
        }
        default:
          return send(res, 400, { error: 'action is create, update, note, manager or command' });
      }
      if (!result.ok) return send(res, 400, { error: result.error });
      tell(floor, result.notices, by.name);
      return send(res, 200, { ok: true, task: result.task && view(result.task) });
    },
  },
} satisfies Record<string, Route>;
