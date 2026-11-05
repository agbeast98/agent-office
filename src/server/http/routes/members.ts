// The 👥 اعضای تیم page of the manager's computer (see client/features/manager/members.ts): every agent with its
// engine and model, team, tasks and cost, and a person's skill.md and memory.md to read and edit. Changing
// the engine or model goes through the hiring route's `switch`; renaming through the team route's `person`.
import { str } from '../../office/input.js';
import { readBody, sameOrigin, send } from '../util.js';
import type { Route } from '../router.js';
import { floorParam } from './files.js';
import { missingMembers, restoreMembers } from '../../team-snapshot.js';

const FILES = { skill: 'skill.md', memory: 'memory.md' } as const;
const TEXT_MAX = 20_000;

export const membersRoutes = {
  /** GET /api/members?floor=<id> */
  list: {
    method: 'GET',
    path: '/api/members',
    auth: 'session',
    handle(ctx, { res, url }) {
      const floor = floorParam(ctx, url);
      if (!floor) return send(res, 404, { error: 'No such floor' });
      const agents = floor.workers.list().filter((w) => w.kind === 'agent');
      const tasks = floor.teamTasks.all();
      const boss = floor.teamTasks.manager(agents);
      const members = agents.map((w) => {
        const team = floor.teams.teamOf(w.id);
        const mine = tasks.filter((t) => t.assignee?.id === w.id);
        const count = (status: string) => mine.filter((t) => t.status === status).length;
        const talk = floor.interviews.latestFor(w.id);
        const u = w.usage;
        return {
          id: w.id,
          name: w.name,
          role: w.role,
          status: w.status,
          activity: w.activity,
          provider: w.provider,
          model: w.model,
          runsOn: u?.model,
          effort: w.effort,
          desk: w.deskId,
          since: w.createdAt,
          team: team && { id: team.id, name: team.name, manager: floor.teams.isManager(w.id) },
          boss: boss?.id === w.id,
          slug: talk?.slug,
          interview: talk?.status,
          usage: u && { cost: u.cost, costKnown: u.costKnown, input: u.input, output: u.output, calls: u.calls },
          counts: { todo: count('todo'), doing: count('doing'), review: count('review'), blocked: count('blocked'), done: count('done') },
          tasks: [...mine].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 30).map((t) => ({ id: t.id, title: t.title, status: t.status, updatedAt: t.updatedAt })),
        };
      });
      return send(res, 200, { members, missing: missingMembers(floor).map((m) => ({ name: m.name, role: (m.role ?? '').split(':')[0].trim(), provider: m.provider })) });
    },
  },
  /** GET /api/members/profile?floor=<id>&worker=<id> */
  profile: {
    method: 'GET',
    path: '/api/members/profile',
    auth: 'session',
    handle(ctx, { res, url }) {
      const floor = floorParam(ctx, url);
      if (!floor) return send(res, 404, { error: 'No such floor' });
      const talk = floor.interviews.latestFor(url.searchParams.get('worker') ?? '');
      if (!talk) return send(res, 200, { slug: null, skill: null, memory: null });
      return send(res, 200, { slug: talk.slug, skill: floor.interviews.fileFor(talk, FILES.skill) ?? '', memory: floor.interviews.fileFor(talk, FILES.memory) ?? '' });
    },
  },
  /** POST /api/members/action?floor=<id>: { action: save, worker, file: skill | memory, text } */
  action: {
    method: 'POST',
    path: '/api/members/action',
    auth: 'session',
    async handle(ctx, { req, res, url, session }) {
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
      if (body.action === 'restore') {
        const out = restoreMembers(floor, session.account?.name ?? 'مدیرعامل');
        return out.restored.length || !out.failed.length ? send(res, 200, { ok: true, ...out }) : send(res, 400, { error: out.failed.join('؛ ') });
      }
      if (body.action !== 'save') return send(res, 400, { error: 'Unknown action' });
      const file = body.file === 'skill' || body.file === 'memory' ? FILES[body.file] : undefined;
      if (!file) return send(res, 400, { error: 'کدام فایل؟' });
      const text = str(body.text, TEXT_MAX).replace(/\r\n?/g, '\n');
      if (!text.trim()) return send(res, 400, { error: 'متن خالی است' });
      if (!floor.interviews.saveFile(str(body.worker, 32), file, text)) return send(res, 400, { error: 'این نفر پروفایلی ندارد' });
      return send(res, 200, { ok: true });
    },
  },
} satisfies Record<string, Route>;
