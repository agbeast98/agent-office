// What the team's members may say to each other (see team-comms.ts and the 📡 ارتباط tab of the member window,
// client/features/manager/member-comms.ts): each member's rule, whom they can reach, and the messages so far.
import { str } from '../../office/input.js';
import { readBody, sameOrigin, send } from '../util.js';
import type { Route } from '../router.js';
import { floorParam } from './files.js';

export const commsRoutes = {
  /** GET /api/comms?floor=<id> */
  state: {
    method: 'GET',
    path: '/api/comms',
    auth: 'session',
    handle(ctx, { res, url }) {
      const floor = floorParam(ctx, url);
      if (!floor) return send(res, 404, { error: 'No such floor' });
      const agents = floor.workers.list().filter((w) => w.kind === 'agent');
      const all = agents.map((w) => w.id);
      const members = agents.map((w) => {
        const team = floor.teams.teamOf(w.id);
        const { canCall, canHear } = floor.comms.reach(w.id, all);
        return { id: w.id, name: w.name, post: (w.role ?? '').split(':')[0].trim(), team: team?.name, manager: floor.teams.isManager(w.id), rule: floor.comms.ruleOf(w.id), canCall, canHear };
      });
      const log = floor.comms.log.slice(-200).map((m) => ({ ...m, text: m.text.slice(0, 800) }));
      return send(res, 200, { members, log });
    },
  },
  /** POST /api/comms/action?floor=<id>: { action: rule | rule_team, worker, send?, sendTo?, receive?, receiveFrom? } */
  action: {
    method: 'POST',
    path: '/api/comms/action',
    auth: 'session',
    async handle(ctx, { req, res, url }) {
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
      const worker = str(body.worker, 32);
      if (body.action === 'rule' || body.action === 'rule_team') {
        const err = floor.comms.setRule(worker, body) ?? (body.action === 'rule_team' ? floor.comms.copyToTeam(worker) : undefined);
        return err ? send(res, 400, { error: err }) : send(res, 200, { ok: true });
      }
      return send(res, 400, { error: 'action is rule or rule_team' });
    },
  },
} satisfies Record<string, Route>;
