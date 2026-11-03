// The 🧑‍💼 استخدام window of the manager's computer (see client/features/manager/hiring.ts): the map of the
// floor's desks, hiring at a free desk (alone, into a team, or as the manager of a new one) with a name, a post and
// a description of the job, the new agent's first interview (see team-interviews.ts) until the person hires or
// rejects it, and the teams: their members, what their managers propose and say (see team-teams.ts).
import { DESK_BY_ID, SEATS, deskBuilt } from '../../../shared/layout.js';
import { askAboutInterview, askAdvice, tellManager, writeRoster } from '../../hiring-glue.js';
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
      const person = (id: string) => {
        const w = workers.find((x) => x.id === id);
        return w && { id: w.id, name: w.name, role: w.role, status: w.status, interview: interviews.open(w.id)?.id };
      };
      const inTeam = new Set(floor.teams.teams.flatMap((t) => [t.manager, ...t.members]));
      return send(res, 200, {
        paused: ctx.ledger.hiringPaused ?? null,
        desks: SEATS.filter((d) => !d.station && !d.room && !d.beanbag && deskBuilt(d, wing)).map((d) => {
          const w = at(d.id);
          return { id: d.id, label: d.label, x: d.x, z: d.z, rotY: d.rotY, worker: w && { id: w.id, name: w.name, role: w.role, status: w.status }, interview: w ? interviews.open(w.id)?.id : undefined };
        }),
        interviews: interviews.all().filter((i) => i.status === 'talking' || i.status === 'review').map((i) => ({ ...i, skillFile: interviews.fileFor(i, 'skill.md'), memoryFile: interviews.fileFor(i, 'memory.md') })),
        teams: floor.teams.teams.map((t) => ({
          id: t.id,
          name: t.name,
          manager: person(t.manager) ?? null,
          members: t.members.map(person).filter(Boolean),
          advice: floor.teams.advice.filter((a) => a.team === t.id).slice(-60),
          proposals: floor.teams.proposals.filter((p) => p.team === t.id && p.status === 'pending').map((p) => ({ ...p, workerName: p.worker ? person(p.worker)?.name : undefined })),
        })),
        alone: workers.filter((w) => !inTeam.has(w.id)).map((w) => person(w.id)),
      });
    },
  },
  /** POST /api/hiring/action?floor=<id>: { action: hire | say | askManager | hired | reject | skip | advise | adopt | leave | proposal, ... } */
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
      const { interviews, teams } = floor;
      const bad = (error: string) => send(res, 400, { error });
      switch (body.action) {
        case 'hire': {
          const desk = str(body.desk, 32);
          const name = str(body.name, 60).trim();
          let role = str(body.role, 120).trim();
          const skill = str(body.skill, 3000).trim();
          const mode = body.mode === 'team' || body.mode === 'newteam' ? body.mode : 'solo';
          const seat = DESK_BY_ID.get(desk);
          if (!seat || seat.station || seat.room || seat.beanbag) return bad('یک میز را انتخاب کنید');
          if (!name) return bad('نام لازم است');
          if (!role) return bad('سمت لازم است');
          if (floor.workers.list().some((w) => w.kind === 'agent' && w.name === name)) return bad('ایجنتی با این نام هست');
          const team = mode === 'team' ? teams.get(str(body.team, 20)) : undefined;
          const teamName = mode === 'newteam' ? str(body.teamName, 60).trim() : '';
          if (mode === 'team') {
            if (!team) return bad('تیم را انتخاب کنید');
            if (!floor.workers.get(team.manager)) return bad('این تیم مدیر ندارد');
            if (interviews.open(team.manager)) return bad('اول مصاحبه‌ی مدیر تیم را تمام کنید و او را استخدام کنید');
          }
          if (mode === 'newteam') {
            if (!teamName) return bad('نام تیم لازم است');
            if (teams.teams.some((t) => t.name === teamName)) return bad('تیمی با این نام هست');
            if (!/مدیر|manager/i.test(role)) role = `مدیر تیم ${teamName}`;
          }
          // The folder it will keep its profile in, named before it starts so the first message can say where.
          const probe = interviews.start({ worker: '', name, role, desk, skill, team: team?.id, isManager: mode === 'newteam' });
          const folder = `freelance-team/people/${probe.slug}`;
          const managerName = team ? floor.workers.get(team.manager)?.name : undefined;
          const about = mode === 'solo' ? undefined : { name: team?.name ?? teamName, manager: managerName, isManager: mode === 'newteam' };
          const r = floor.workers.spawn(desk, by, interviewPrompt(name, role, skill, folder, about), false, 'agent');
          if (typeof r === 'string') {
            interviews.discard(probe);
            return bad(r);
          }
          probe.worker = r.id;
          if (mode === 'newteam') {
            const made = teams.create(teamName, r.id);
            if (made.ok) probe.team = made.team.id;
          } else if (team) teams.add(team.id, r.id);
          const duty = mode === 'newteam' ? `مدیر و هماهنگ‌کننده‌ی تیم ${teamName}؛ فهرست تیم را در شروع هر کار از freelance-team/people/ROSTER.md بخوان و نیروی لازم را با propose_hire پیشنهاد بده. ` : '';
          floor.workers.describe(r.id, { name, role: `${role}: ${duty}پروفایل تو در ${folder}/skill.md و memory.md است؛ در شروع هر کار بخوانشان و بعد از هر کار نکته‌های تازه را به memory.md اضافه کن.` });
          if (typeof body.proposal === 'string') teams.resolve(body.proposal, 'accepted');
          writeRoster(floor);
          ctx.toastFloor(floor, `🧑‍💼 ${by} ${name} را برای مصاحبه آورد`);
          return send(res, 200, { ok: true, interview: probe.id });
        }
        case 'say': {
          const r = interviews.bossSay(str(body.id, 20), body.text);
          if (!r.ok) return bad(r.error);
          tell(floor, r.notices, by);
          return send(res, 200, { ok: true });
        }
        case 'askManager': {
          const i = interviews.get(str(body.id, 20));
          if (!i?.team || i.isManager) return bad('این نفر در تیمی نیست که مدیری داشته باشد');
          askAboutInterview(floor, i, false);
          return send(res, 200, { ok: true });
        }
        case 'hired':
        case 'reject':
        case 'skip': {
          const id = str(body.id, 20);
          const i = interviews.get(id);
          const r = interviews.decide(id, body.action === 'hired' ? 'hire' : body.action);
          if (!r.ok || !i) return bad(r.ok ? 'No such interview' : r.error);
          if (body.action === 'reject') {
            teams.leave(i.worker);
            teams.dropEmpty(i.worker);
            void floor.sendHome(i.worker);
          } else {
            tell(floor, [{ to: i.worker, text: body.action === 'hired' ? 'مدیرعامل تو را استخدام کرد. از حالا کار می‌گیری؛ در شروع هر کار skill.md و memory.md خودت و ROSTER.md را بخوان.' : 'مدیرعامل مصاحبه را رد کرد و تو را همین‌طور استخدام کرد. پروفایلت (skill.md و memory.md) را نگاه کن و منتظر کار باش.' }], by);
            if (i.team && !i.isManager) tellManager(floor, i.team, `${i.name} (${i.role}) به تیم پیوست؛ پروفایلش در freelance-team/people/${i.slug}/ است. فهرست تیم را ببین (team_roster) و اگر لازم است نظرت را درباره‌ی نیروهای دیگر بگو.`, by);
          }
          writeRoster(floor);
          return send(res, 200, { ok: true });
        }
        case 'advise': {
          const team = teams.get(str(body.team, 20));
          if (!team) return bad('چنین تیمی نیست');
          if (!floor.workers.get(team.manager)) return bad('این تیم مدیر ندارد');
          if (interviews.open(team.manager)) return bad('مدیر هنوز در مصاحبه است');
          const said = teams.say(team.id, 'boss', body.text);
          if (!said.ok) return bad(said.error);
          askAdvice(floor, team.id, said.advice.text, by);
          return send(res, 200, { ok: true });
        }
        case 'adopt': {
          const w = floor.workers.get(str(body.worker, 32));
          if (!w || w.kind !== 'agent') return bad('چنین ایجنتی نیست');
          const r = teams.add(str(body.team, 20), w.id);
          if (!r.ok) return bad(r.error);
          tell(floor, [{ to: w.id, text: `از حالا عضو تیم «${r.team.name}» هستی. مدیرت ${floor.workers.get(r.team.manager)?.name ?? ''} است؛ کار را از او بگیر و فهرست تیم را در freelance-team/people/ROSTER.md ببین.` }], by);
          tellManager(floor, r.team.id, `${w.name} (${(w.role ?? '').split(':')[0] || 'بدون سمت'}) از مستقل‌ها به تیمت پیوست؛ پروفایلش را در freelance-team/people/ بخوان.`, by);
          writeRoster(floor);
          return send(res, 200, { ok: true });
        }
        case 'leave': {
          if (!teams.leave(str(body.worker, 32))) return bad('او عضو تیمی نیست (مدیر تیم را نمی‌شود برداشت)');
          writeRoster(floor);
          return send(res, 200, { ok: true });
        }
        case 'proposal': {
          const r = teams.resolve(str(body.id, 20), body.verdict === 'accepted' ? 'accepted' : 'dismissed');
          if (!r.ok) return bad(r.error);
          if (r.proposal.status === 'accepted' && r.proposal.kind === 'adopt') writeRoster(floor);
          return send(res, 200, { ok: true });
        }
        default:
          return bad('action is hire, say, askManager, hired, reject, skip, advise, adopt, leave or proposal');
      }
    },
  },
} satisfies Record<string, Route>;
