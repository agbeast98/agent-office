// The 🛡 امنیت window of the manager's computer (see client/features/manager/security.ts): who is guarded
// and by whom, each one's rules, what is held and what the firewall has learned from the person's answers;
// and what the person does there: tick an agent under a security agent's guard, change its rules, decide a hold.
import { tell } from '../../hooks/office-tasks.js';
import { str } from '../../office/input.js';
import { GUARD_MAX } from '../../security.js';
import { readBody, sameOrigin, send } from '../util.js';
import type { Route } from '../router.js';
import { floorParam } from './files.js';

export const securityRoutes = {
  /** GET /api/security?floor=<id> */
  state: {
    method: 'GET',
    path: '/api/security',
    auth: 'session',
    handle(ctx, { res, url }) {
      const floor = floorParam(ctx, url);
      if (!floor) return send(res, 404, { error: 'No such floor' });
      const sec = floor.security;
      const agents = floor.workers.list().filter((w) => w.kind === 'agent');
      const guardians = Object.keys(sec.guards);
      return send(res, 200, {
        max: GUARD_MAX,
        guardians: guardians.map((id) => ({ id, name: floor.workers.get(id)?.name ?? id, guarding: sec.guards[id] })),
        agents: agents.map((w) => ({ id: w.id, name: w.name, role: w.role, guardian: sec.guardOf(w.id), isGuardian: guardians.includes(w.id), rules: sec.rules(w.id) })),
        holds: sec.holds.slice(0, 80),
        learned: sec.learned,
      });
    },
  },
  /** POST /api/security/action?floor=<id>: { action: guardian | guard | rules | decide | forget, ... } */
  action: {
    method: 'POST',
    path: '/api/security/action',
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
      const sec = floor.security;
      const known = (id: unknown) => floor.workers.list().find((w) => w.kind === 'agent' && w.id === id);
      const mirror = () => sec.writeMirror((id) => floor.workers.get(id)?.name ?? id);
      switch (body.action) {
        case 'guardian': {
          const w = known(body.worker);
          if (!w) return send(res, 400, { error: 'No such person' });
          if (body.on !== true && (sec.guards[w.id]?.length ?? 0) > 0) return send(res, 400, { error: 'It still guards someone: take them off first' });
          sec.setGuardian(w.id, body.on === true);
          mirror();
          return send(res, 200, { ok: true });
        }
        case 'guard': {
          const agent = known(body.agent);
          const guardian = typeof body.guardian === 'string' ? body.guardian : '';
          if (!agent) return send(res, 400, { error: 'No such person' });
          if (body.on !== true) {
            sec.guard(guardian, agent.id, false);
          } else {
            if (!(guardian in sec.guards)) return send(res, 400, { error: 'Pick a security agent first' });
            const error = sec.guard(guardian, agent.id, true);
            if (error) return send(res, 400, { error });
            tell(floor, [{ to: agent.id, text: 'از این لحظه زیر نظر امنیت هستی: هر کاری غیر از گفتگو (سایت، فرم، ترمینال، فایل بیرون از پوشه‌هایت) اول با قوانینت سنجیده می‌شود. اگر چیزی نگه داشته شد، صبر کن و بعد دوباره امتحان کن؛ از سقف قوانین بالاتر نرو.' }], 'امنیت');
          }
          mirror();
          return send(res, 200, { ok: true });
        }
        case 'rules': {
          const agent = known(body.agent);
          if (!agent) return send(res, 400, { error: 'No such person' });
          const rules = sec.setRules(agent.id, body as Record<string, unknown>);
          mirror();
          return send(res, 200, { ok: true, rules });
        }
        case 'decide': {
          const verdict = body.verdict === 'allow' || body.verdict === 'deny' ? body.verdict : undefined;
          if (!verdict) return send(res, 400, { error: 'verdict is allow or deny' });
          const out = sec.decide(typeof body.id === 'string' ? body.id : '', verdict, 'you', str(body.note, 600), Number(body.minutes) || undefined);
          if (!out.ok) return send(res, 400, { error: out.error });
          tell(floor, out.notices, session.account?.name ?? 'مدیرعامل');
          mirror();
          return send(res, 200, { ok: true, learned: out.learned });
        }
        case 'forget':
          sec.forget(typeof body.key === 'string' ? body.key : '');
          mirror();
          return send(res, 200, { ok: true });
        default:
          return send(res, 400, { error: 'action is guardian, guard, rules, decide or forget' });
      }
    },
  },
} satisfies Record<string, Route>;
