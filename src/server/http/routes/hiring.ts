// The 🧑‍💼 استخدام window of the manager's computer (see client/features/manager/hiring.ts): the map of the
// floor's desks, hiring at a free desk (alone, into a team, or as the manager of a new one) with a name, a post and
// a description of the job, the new agent's first interview (see team-interviews.ts) until the person hires or
// rejects it, and the teams: their members, what their managers propose and say (see team-teams.ts).
import { DESK_BY_ID, SEATS, deskBuilt } from '../../../shared/layout.js';
import { askAboutInterview, askAdvice, tellManager, writeRoster } from '../../hiring-glue.js';
import { tell } from '../../hooks/office-tasks.js';
import { str } from '../../office/input.js';
import { AGENT_EFFORTS, isAgentProvider } from '../../../shared/providers.js';
import { continuedInterview, interviewPrompt, reviewPrompt } from '../../team-interviews.js';
import { readBody, sameOrigin, send } from '../util.js';
import type { Route } from '../router.js';
import { floorParam } from './files.js';

/** When each firing was asked for (floor:worker), so the second step has to follow the first. */
const fireAsked = new Map<string, number>();
const FIRE_WINDOW_MS = 5 * 60_000;

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
        return w && { id: w.id, name: w.name, role: w.role, status: w.status, provider: w.provider, interview: interviews.open(w.id)?.id, interviewedAt: interviews.lastInterviewed(w.id) };
      };
      const inTeam = new Set(floor.teams.teams.flatMap((t) => [t.manager, ...t.members]));
      return send(res, 200, {
        paused: ctx.ledger.hiringPaused ?? null,
        company: interviews.company(),
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
  /** POST /api/hiring/action?floor=<id>: { action: hire | switch | company | say | askManager | hired | reject | skip | advise | adopt | leave | proposal, ... } */
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
      if (typeof body.text === 'string' && body.action === 'company') body.text = body.text.slice(0, 12_000);
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
          interviews.ensureCompany();
          // The folder it will keep its profile in, named before it starts so the first message can say where.
          const probe = interviews.start({ worker: '', name, role, desk, skill, team: team?.id, isManager: mode === 'newteam' });
          const folder = `freelance-team/people/${probe.slug}`;
          const managerName = team ? floor.workers.get(team.manager)?.name : undefined;
          const about = mode === 'solo' ? undefined : { name: team?.name ?? teamName, manager: managerName, isManager: mode === 'newteam' };
          const provider = isAgentProvider(body.provider) ? body.provider : undefined;
          const r = floor.workers.spawn(desk, by, interviewPrompt(name, role, skill, folder, about), false, 'agent', provider);
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
        case 'switch': {
          // The same person on another engine (say Codex instead of Claude): a new worker at the same desk that
          // reads the profile it already has, then takes the old one's place in the team.
          const id = str(body.worker, 32);
          const old = floor.workers.get(id);
          const provider = isAgentProvider(body.provider) ? body.provider : undefined;
          const last = interviews.all().filter((i) => i.worker === id).pop();
          // A worker already gone (a switch that failed half-way) is brought back from its profile.
          if (!provider || (old ? old.kind !== 'agent' : !last)) return bad('ایجنت یا موتور درست نیست');
          const model = str(body.model, 120).trim() || undefined;
          const effort = AGENT_EFFORTS.find((e) => e === body.effort);
          if (old && provider === old.provider && model === old.model && effort === old.effort) return bad('همین الان روی همین موتور و مدل است');
          const openIv = interviews.open(id);
          // Before anyone is sent home: a new worker can't start while hiring is paused (budget), and he'd be lost.
          if (ctx.ledger.hiringPaused) return bad(ctx.ledger.hiringPaused);
          const team = teams.teamOf(id);
          const manager = team && !teams.isManager(id) ? floor.workers.get(team.manager)?.name : undefined;
          const keep = old
            ? { name: old.name, role: old.role ?? '', desk: old.deskId }
            : { name: last!.name, role: `${last!.role}: پروفایل تو در freelance-team/people/${last!.slug}/skill.md و memory.md است؛ در شروع هر کار بخوانشان و بعد از هر کار نکته‌های تازه را به memory.md اضافه کن.`, desk: last!.desk };
          if (old) {
            const home = await floor.sendHome(id);
            if (home.error) return bad(home.error);
          }
          const folder = last ? `freelance-team/people/${last.slug}` : undefined;
          const intro = [
            `تو «${keep.name}» هستی؛ همان آدمی که قبلاً با سمت «${keep.role.split(':')[0]}» در این دفتر کار می‌کرد و حالا موتور اجرایت عوض شده است. هیچ کاری نکن و مصاحبه‌ی تازه‌ای در کار نیست.`,
            team ? (teams.isManager(id) ? `تو مدیر تیم «${team.name}» هستی.` : `تو عضو تیم «${team.name}» هستی${manager ? ` و مدیرت ${manager} است` : ''}.`) : '',
            `فایل‌های freelance-team/company.md (کسب‌وکار)، ${folder ? `${folder}/skill.md و memory.md (پروفایل خودت)` : 'پروفایل خودت'} و freelance-team/people/ROSTER.md (تیم) را یک بار بخوان و بعد منتظر کار بمان. در شروع هر کار دوباره پروفایلت را بخوان و بعد از هر کار نکته‌های تازه را به memory.md اضافه کن.`,
          ].filter(Boolean).join(String.fromCharCode(10).repeat(2));
          // In the middle of an interview, the new engine takes it up where it was left: the same questions and what has been said.
          const start = openIv ? continuedInterview(openIv, team ? { name: team.name, manager, isManager: teams.isManager(id) } : undefined) : intro;
          const made = floor.workers.spawn(keep.desk, by, start, false, 'agent', provider, model, effort);
          if (typeof made === 'string') {
            // Back on the engine it had, so a failed switch never loses someone.
            const back = old ? floor.workers.spawn(keep.desk, by, start, false, 'agent', old.provider, old.model, old.effort) : undefined;
            if (back && typeof back !== 'string') {
              floor.workers.describe(back.id, { name: keep.name, role: keep.role });
              teams.swap(id, back.id);
              interviews.swap(id, back.id);
            }
            return bad(made);
          }
          floor.workers.describe(made.id, { name: keep.name, role: keep.role });
          teams.swap(id, made.id);
          interviews.swap(id, made.id);
          writeRoster(floor);
          ctx.toastFloor(floor, `🔁 ${keep.name} حالا با ${provider}${model ? ` (${model})` : ''} کار می‌کند`);
          return send(res, 200, { ok: true });
        }
        case 'company': {
          if (typeof body.text !== 'string') return bad('متن لازم است');
          if (!interviews.saveCompany(body.text)) return bad('ذخیره نشد');
          return send(res, 200, { ok: true });
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
        case 'review':
        case 'reviewMany': {
          // Hired agents are interviewed again: each is asked about its own work (and evaluated), and proposes changes to its profile.
          const ids = body.action === 'review' ? [str(body.worker, 32)] : Array.isArray(body.workers) ? body.workers.slice(0, 40).map((x) => str(x, 32)) : [];
          const started: string[] = [];
          const skipped: string[] = [];
          for (const id of ids) {
            const w = floor.workers.get(id);
            const r = w && w.kind === 'agent' ? interviews.review(w.id) : undefined;
            if (!w || !r?.ok) {
              skipped.push(w?.name ?? id);
              continue;
            }
            const i = r.interview;
            const team = i.team ? teams.get(i.team) : undefined;
            const about = team ? { name: team.name, manager: floor.workers.get(team.manager)?.name, isManager: !!i.isManager } : undefined;
            tell(floor, [{ to: w.id, text: reviewPrompt(i.name, i.role, `freelance-team/people/${i.slug}`, about) }], by);
            started.push(i.name);
          }
          if (!started.length) return bad(ids.length === 1 && skipped.length ? 'این ایجنت الان در مصاحبه است یا پروفایل ندارد' : 'کسی برای مصاحبه‌ی مجدد پیدا نشد');
          writeRoster(floor);
          ctx.toastFloor(floor, `🔄 ${by} مصاحبه‌ی مجدد ${started.length.toLocaleString('fa-IR')} نفر را شروع کرد`);
          return send(res, 200, { ok: true, started, skipped });
        }
        case 'fireAsk':
        case 'fire': {
          // Firing takes two steps: asking (which says what will happen), then, within five minutes, the person's name typed in.
          const id = str(body.worker, 32);
          const w = floor.workers.get(id);
          if (!w || w.kind !== 'agent') return bad('چنین ایجنتی نیست');
          const team = teams.teamOf(id);
          if (team && teams.isManager(id) && team.members.length) return bad(`او مدیر تیم «${team.name}» است و تیم هنوز ${team.members.length.toLocaleString('fa-IR')} عضو دارد: اول اعضا را به تیم دیگری بدهید یا اخراج کنید`);
          if (body.action === 'fireAsk') {
            fireAsked.set(`${floor.id}:${id}`, Date.now());
            const open = floor.teamTasks.list({ open: true }).filter((t) => t.assignee?.id === id).length;
            return send(res, 200, { ok: true, name: w.name, team: team?.name, openTasks: open });
          }
          const at = fireAsked.get(`${floor.id}:${id}`);
          if (!at || Date.now() - at > FIRE_WINDOW_MS) return bad('اول مرحله‌ی اول (اخراج) را بزنید و تأیید کنید');
          if (str(body.name, 60).trim() !== w.name) return bad('نام را درست ننوشتید؛ اخراج انجام نشد');
          fireAsked.delete(`${floor.id}:${id}`);
          const open = interviews.open(id);
          if (open) interviews.settle(open.id, 'keep');
          teams.leave(id);
          teams.dropEmpty(id);
          const home = await floor.sendHome(id);
          if (home.error) return bad(home.error);
          writeRoster(floor);
          ctx.toastFloor(floor, `🚪 ${by} ${w.name} را اخراج کرد`);
          return send(res, 200, { ok: true });
        }
        case 'apply':
        case 'keep': {
          const i = interviews.get(str(body.id, 20));
          const r = interviews.settle(str(body.id, 20), body.action);
          if (!r.ok || !i) return bad(r.ok ? 'No such interview' : r.error);
          tell(floor, [{ to: i.worker, text: body.action === 'apply'
            ? 'مدیرعامل پیشنهاد بازبینی‌ات را تأیید کرد و پروفایل تو به‌روز شد. skill.md و memory.md را دوباره بخوان و از حالا طبق آن‌ها کار کن.'
            : 'مدیرعامل پروفایل تو را بدون تغییر نگه داشت. مصاحبه‌ی بازبینی تمام شد؛ همان قواعد قبلی معتبر است.' }], by);
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
          return bad('action is hire, switch, company, say, askManager, hired, reject, skip, review, reviewMany, fireAsk, fire, apply, keep, advise, adopt, leave or proposal');
      }
    },
  },
} satisfies Record<string, Route>;
