// The 🧭 روال‌ها window of the manager's computer (see client/features/manager/flows.ts): the managers and
// scenarios the person defines, and the runs of them (see team-flows.ts) with how far each is.
import { str } from '../../office/input.js';
import { readBody, sameOrigin, send } from '../util.js';
import type { Route } from '../router.js';
import { floorParam } from './files.js';

export const flowRoutes = {
  /** GET /api/flows?floor=<id> */
  state: {
    method: 'GET',
    path: '/api/flows',
    auth: 'session',
    handle(ctx, { res, url }) {
      const floor = floorParam(ctx, url);
      if (!floor) return send(res, 404, { error: 'No such floor' });
      const name = (id: string) => floor.workers.get(id)?.name ?? id;
      const f = floor.flows;
      return send(res, 200, {
        people: floor.workers.list().filter((w) => w.kind === 'agent').map((w) => ({ id: w.id, name: w.name, role: w.role })),
        bosses: f.bosses,
        scenarios: f.scenarios,
        runs: f.runs.slice().reverse().map((r) => ({
          ...r,
          outputs: undefined,
          steps: r.steps.map((s, i) => {
            const part = r.parts.find((p) => p.step === i);
            const task = part && floor.teamTasks.get(part.task);
            return { ...s, whoName: name(s.who), task: part?.task, taskStatus: task?.status, done: i in r.outputs };
          }),
        })),
      });
    },
  },
  /** POST /api/flows/action?floor=<id>: { action: boss | bossRemove | scenario | scenarioRemove | start | approve | retry | stop | remove, ... } */
  action: {
    method: 'POST',
    path: '/api/flows/action',
    auth: 'session',
    async handle(ctx, { req, res, url }) {
      if (!sameOrigin(req, ctx.cfg)) return send(res, 403, { error: 'Forbidden' });
      const floor = floorParam(ctx, url);
      if (!floor) return send(res, 404, { error: 'No such floor' });
      let body: Record<string, unknown>;
      try {
        const value = JSON.parse(await readBody(req, 60_000));
        if (!value || typeof value !== 'object' || Array.isArray(value)) return send(res, 400, { error: 'Bad request' });
        body = value as Record<string, unknown>;
      } catch {
        return send(res, 400, { error: 'Bad request' });
      }
      const f = floor.flows;
      const id = str(body.id, 40);
      const out =
        body.action === 'boss' ? f.saveBoss(body)
        : body.action === 'bossRemove' ? f.removeBoss(id)
        : body.action === 'scenario' ? f.saveScenario(body)
        : body.action === 'scenarioRemove' ? f.removeScenario(id)
        : body.action === 'start' ? f.start(id, body.input)
        : body.action === 'approve' ? f.approve(id)
        : body.action === 'retry' ? f.retry(id)
        : body.action === 'stop' ? f.stop(id)
        : body.action === 'remove' ? f.removeRun(id)
        : undefined;
      if (!out) return send(res, 400, { error: 'action is boss, bossRemove, scenario, scenarioRemove, start, approve, retry, stop or remove' });
      if (!out.ok) return send(res, 400, { error: out.error });
      return send(res, 200, { ok: true, id: (out as { run?: { id: string } }).run?.id });
    },
  },
} satisfies Record<string, Route>;
