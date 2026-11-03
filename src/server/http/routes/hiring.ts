// The 🧑‍💼 استخدام window of the manager's computer (see client/features/manager/hiring.ts): the map of the
// floor's desks (who sits where, which are free), hiring at a free desk with a name, a post and a description of
// the job, and the new agent's first interview (see team-interviews.ts) until the person hires or rejects it.
import { DESK_BY_ID, SEATS, deskBuilt } from '../../../shared/layout.js';
import { tell } from '../../hooks/office-tasks.js';
import { str } from '../../office/input.js';
import { interviewPrompt } from '../../team-interviews.js';
import { readBody, sameOrigin, send } from '../util.js';
import type { Route } from '../router.js';
import { floorParam } from './files.js';

export const hiringRoutes = {
  /** GET /api/hiring?floor=<id> */
  state: {
    method: 'GET',
    path: '/api/hiring',
    auth: 'session',
    handle(ctx, { res, url }) {
      const floor = floorParam(ctx, url);
      if (!floor) return send(res, 404, { error: 'No such floor' });
      const wing = floor.workers.wing();
      const workers = floor.workers.list().filter((w) => w.kind === 'agent');
      const at = (desk: string) => workers.find((w) => w.deskId === desk);
      const interviews = floor.interviews;
      return send(res, 200, {
        paused: ctx.ledger.hiringPaused ?? null,
        desks: SEATS.filter((d) => !d.station && !d.room && !d.beanbag && deskBuilt(d, wing)).map((d) => {
          const w = at(d.id);
          return { id: d.id, label: d.label, x: d.x, z: d.z, rotY: d.rotY, worker: w && { id: w.id, name: w.name, role: w.role, status: w.status }, interview: w ? interviews.open(w.id)?.id : undefined };
        }),
        interviews: interviews.all().filter((i) => i.status === 'talking' || i.status === 'review').map((i) => ({ ...i, skillFile: interviews.fileFor(i, 'skill.md'), memoryFile: interviews.fileFor(i, 'memory.md') })),
      });
    },
  },
  /** POST /api/hiring/action?floor=<id>: { action: hire | say | hired | reject | skip, ... } */
  action: {
    method: 'POST',
    path: '/api/hiring/action',
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
      const by = session.account?.name ?? 'مدیرعامل';
      const interviews = floor.interviews;
      switch (body.action) {
        case 'hire': {
          const desk = str(body.desk, 32);
          const name = str(body.name, 60).trim();
          const role = str(body.role, 120).trim();
          const skill = str(body.skill, 3000).trim();
          const seat = DESK_BY_ID.get(desk);
          if (!seat || seat.station || seat.room || seat.beanbag) return send(res, 400, { error: 'یک میز را انتخاب کنید' });
          if (!name) return send(res, 400, { error: 'نام لازم است' });
          if (!role) return send(res, 400, { error: 'سمت لازم است' });
          if (floor.workers.list().some((w) => w.kind === 'agent' && w.name === name)) return send(res, 400, { error: 'ایجنتی با این نام هست' });
          // The folder it will keep its profile in, named before it starts so the first message can say where.
          const probe = interviews.start({ worker: '', name, role, desk, skill });
          const folder = `freelance-team/people/${probe.slug}`;
          const r = floor.workers.spawn(desk, by, interviewPrompt(name, role, skill, folder), false, 'agent');
          if (typeof r === 'string') {
            interviews.discard(probe);
            return send(res, 400, { error: r });
          }
          probe.worker = r.id;
          floor.workers.describe(r.id, { name, role: `${role}: پروفایل تو در ${folder}/skill.md و memory.md است؛ در شروع هر کار بخوانشان و بعد از هر کار نکته‌های تازه را به memory.md اضافه کن.` });
          ctx.toastFloor(floor, `🧑‍💼 ${by} ${name} را برای مصاحبه آورد`);
          return send(res, 200, { ok: true, interview: probe.id });
        }
        case 'say': {
          const r = interviews.bossSay(str(body.id, 20), body.text);
          if (!r.ok) return send(res, 400, { error: r.error });
          tell(floor, r.notices, by);
          return send(res, 200, { ok: true });
        }
        case 'hired':
        case 'reject':
        case 'skip': {
          const id = str(body.id, 20);
          const i = interviews.get(id);
          const r = interviews.decide(id, body.action === 'hired' ? 'hire' : body.action);
          if (!r.ok || !i) return send(res, 400, { error: r.ok ? 'No such interview' : r.error });
          if (body.action === 'reject') void floor.sendHome(i.worker);
          else tell(floor, [{ to: i.worker, text: body.action === 'hired' ? 'مدیرعامل تو را استخدام کرد. از حالا کار می‌گیری؛ در شروع هر کار skill.md و memory.md خودت را بخوان.' : 'مدیرعامل مصاحبه را رد کرد و تو را همین‌طور استخدام کرد. پروفایلت (skill.md و memory.md) را نگاه کن و منتظر کار باش.' }], by);
          return send(res, 200, { ok: true });
        }
        default:
          return send(res, 400, { error: 'action is hire, say, hired, reject or skip' });
      }
    },
  },
} satisfies Record<string, Route>;
