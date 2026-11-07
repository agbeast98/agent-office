// The 📁 پروژه‌ها window of the manager's computer (see client/features/manager/projects.ts): the floor's projects,
// the folders of each on this computer, and which agent may use which folder (see projects.ts, folder-gate.ts).
import { readBody, sameOrigin, send } from '../util.js';
import type { Route } from '../router.js';
import { str } from '../../office/input.js';
import { floorParam } from './files.js';

export const projectRoutes = {
  /** GET /api/projects?floor=<id> */
  state: {
    method: 'GET',
    path: '/api/projects',
    auth: 'session',
    handle(ctx, { res, url }) {
      const floor = floorParam(ctx, url);
      if (!floor) return send(res, 404, { error: 'No such floor' });
      const agents = floor.workers.list().filter((w) => w.kind === 'agent');
      const tasks = floor.teamTasks.all();
      return send(res, 200, {
        projects: floor.projects.list().map((p) => ({ ...p, open: tasks.filter((t) => t.project === p.id && t.status !== 'done' && t.status !== 'cancelled').length })),
        agents: agents.map((w) => ({ id: w.id, name: w.name, role: (w.role ?? '').split(':')[0], manager: floor.teams.isManager(w.id), team: floor.teams.teamOf(w.id)?.name, status: w.status, provider: w.provider })),
        grants: floor.projects.allGrants(),
      });
    },
  },
  /** POST /api/projects/action?floor=<id>: { action: create | update | grant, ... } */
  action: {
    method: 'POST',
    path: '/api/projects/action',
    auth: 'session',
    async handle(ctx, { req, res, url }) {
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
      const bad = (error: string) => send(res, 400, { error });
      switch (body.action) {
        case 'create': {
          const r = floor.projects.create(body);
          return r.ok ? send(res, 200, { ok: true, project: r.project.id }) : bad(r.error);
        }
        case 'update': {
          const r = floor.projects.update(str(body.id, 20), body);
          return r.ok ? send(res, 200, { ok: true }) : bad(r.error);
        }
        case 'grant': {
          const worker = floor.workers.get(str(body.worker, 32));
          if (!worker || worker.kind !== 'agent') return bad('چنین ایجنتی نیست');
          const mode = body.mode === 'read' || body.mode === 'write' ? body.mode : 'none';
          const r = floor.projects.setGrant(worker.id, str(body.project, 20), str(body.folder, 40), mode);
          if (!r.ok) return bad(r.error);
          // The folders go on its command line when it starts: a running agent gets them the next time it does.
          return send(res, 200, { ok: true, note: 'اعمال دسترسی روی خط فرمان از راه‌اندازی بعدی ایجنت است؛ قفل پوشه همین الان کار می‌کند.' });
        }
        default:
          return bad('action is create, update or grant');
      }
    },
  },
} satisfies Record<string, Route>;
