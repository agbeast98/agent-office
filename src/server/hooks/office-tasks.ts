import type http from 'node:http';
import type { Floor } from '../floor.js';
import type { Ctx } from '../office/context.js';
import { readBody, send } from '../http/util.js';
import { askAboutInterview, writeRoster } from '../hiring-glue.js';
import { findWorker } from '../office-workers.js';
import type { Notice, Outcome, TeamTask } from '../team-tasks.js';

/** What a worker is shown of a task. */
export const view = (t: TeamTask) => ({
  id: t.id,
  title: t.title,
  detail: t.detail,
  status: t.status,
  priority: t.priority,
  assignee: t.assignee?.name,
  createdBy: t.createdBy,
  request: t.request || undefined,
  due: t.due,
  updated: new Date(t.updatedAt).toISOString(),
  notes: t.notes.slice(-5).map((n) => `${n.by}: ${n.text}`),
});

/** Tells the workers a change concerns, waking one that is asleep. A worker that can't be reached isn't a reason to fail the change. */
export function tell(floor: Floor, notices: Notice[], by: string) {
  for (const n of notices) {
    const w = floor.workers.get(n.to);
    if (!w || w.kind !== 'agent') continue;
    const err = floor.workers.prompt(n.to, n.text, by);
    if (err === 'Worker is not running') floor.workers.resume(n.to, n.text);
  }
}

/**
 * The team's tasks, for any worker on the floor (see team-tasks.ts, and bin/office-workers.js, which
 * calls this). GET lists them; POST says what to do in `action`: create, update, note or request.
 * The worker's own hook token says who's asking, and the manager's word is the one that counts.
 */
export async function officeTasks(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const workerId = url.searchParams.get('worker') ?? '';
  const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const floor = ctx.workerFloor(workerId);
  const me = floor?.workers.authenticate(workerId, token);
  if (!floor || !me) return send(res, 401, { error: 'Send your own AGENT_OFFICE_WORKER_ID as ?worker= and AGENT_OFFICE_HOOK_TOKEN as the bearer token' });
  const tasks = floor.teamTasks;
  const workers = floor.workers.list();
  const by = tasks.actorOf(me, workers);
  const boss = tasks.manager(workers);

  if (req.method === 'GET' && url.searchParams.get('roster') === '1') {
    const name = (id: string) => floor.workers.get(id)?.name ?? id;
    const agents = workers.filter((w) => w.kind === 'agent');
    const inTeam = new Set(floor.teams.teams.flatMap((t) => [t.manager, ...t.members]));
    return send(res, 200, {
      you: { name: me.name, team: floor.teams.teamOf(me.id)?.name, manager: floor.teams.isManager(me.id) || undefined, can_call: floor.comms.reach(me.id, agents.map((w) => w.id)).canCall.map(name) },
      teams: floor.teams.teams.map((t) => ({ name: t.name, manager: name(t.manager), members: t.members.map((m) => ({ name: name(m), post: (floor.workers.get(m)?.role ?? '').split(':')[0] })) })),
      alone: agents.filter((w) => !inTeam.has(w.id)).map((w) => ({ name: w.name, post: (w.role ?? '').split(':')[0] })),
      file: 'freelance-team/people/ROSTER.md',
    });
  }
  if (req.method === 'GET' && url.searchParams.get('meeting') === '1') {
    const m = floor.teamMeetings.current;
    return send(res, 200, m ? { id: m.id, topic: m.topic, mode: m.mode, round: m.round, of_rounds: m.mode === 'debate' ? m.rounds : undefined, voted: m.mode === 'vote' ? m.votes.some((v) => v.id === me.id) : undefined, result: m.result, members: m.members.map((x) => x.name), agenda: m.agenda.map((a) => a.text), asked_you: m.asked.includes(me.id) || undefined, decisions: m.decisions.map((d) => d.text), summary: m.summary, said: m.said.filter((s) => !s.note).map((s) => ({ round: s.round, by: s.by, ...(s.to ? { to: s.to.name } : {}), text: s.text })) } : { none: true });
  }
  if (req.method === 'GET') {
    const q = url.searchParams;
    const list = tasks.list({ status: q.get('status') ?? undefined, mine: q.get('mine') === '1' ? me.id : undefined, open: q.get('all') !== '1' });
    return send(res, 200, { you: { id: me.id, name: me.name, manager: by.boss }, manager: boss?.name, tasks: list.map(view) });
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'GET /office/tasks, or POST it an action' });

  let body: Record<string, unknown>;
  try {
    const value = JSON.parse((await readBody(req, 20_000)) || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return send(res, 400, { error: 'Send a JSON object' });
    body = value as Record<string, unknown>;
  } catch {
    return send(res, 400, { error: 'Send JSON' });
  }

  const id = typeof body.id === 'string' ? body.id : '';
  let result: Outcome;
  switch (body.action) {
    case 'create':
    case 'request':
      result = tasks.create(body.action === 'request' ? { ...by, boss: false } : by, body, workers);
      break;
    case 'update':
      result = tasks.update(by, id, body, workers);
      break;
    case 'note':
      result = tasks.note(by, id, body.text, workers);
      break;
    case 'call_member': {
      const to = typeof body.to === 'string' ? findWorker(workers.filter((x) => x.kind === 'agent'), body.to) : 'Say whom to call';
      if (typeof to === 'string') return send(res, 400, { error: to });
      const r = floor.comms.send(me.id, to.id, typeof body.text === 'string' ? body.text : '');
      if (!r.ok) return send(res, 403, { error: r.error });
      const note = r.msg.status === 'queued'
        ? `${to.name} الان سرش شلوغ است؛ پیام در صف می‌ماند و وقتی کارش تمام شد به او می‌رسد.`
        : `پیام به ${to.name} داده شد؛ جوابش را وقتی داد خودش با call_member برای تو می‌فرستد. منتظر نمان؛ کار دیگرت را ادامه بده.`;
      return send(res, 200, { ok: true, id: r.msg.id, status: r.msg.status, note });
    }
    case 'interview_say':
    case 'interview_finish': {
      const r = body.action === 'interview_say' ? floor.interviews.say(me.id, body.text) : floor.interviews.finish(me.id, body);
      if (!r.ok) return send(res, 400, { error: r.error });
      if (body.action === 'interview_finish') {
        void floor.notifier.send(`🎤 ${me.name} مصاحبه را تمام کرد؛ منتظر تصمیم شماست (🧑‍💼 استخدام)`);
        if (r.ok && 'interview' in r) askAboutInterview(floor, r.interview, true);
        writeRoster(floor);
      }
      return send(res, 200, { ok: true });
    }
    case 'team_advise':
    case 'propose_hire':
    case 'propose_adopt': {
      const team = floor.teams.teams.find((t) => t.manager === me.id);
      if (!team) return send(res, 403, { error: 'فقط مدیر یک تیم این ابزار را دارد' });
      if (body.action === 'team_advise') {
        const said = typeof body.interview === 'string' && body.interview ? floor.interviews.managerSay(body.interview, me.name, body.text) : floor.teams.say(team.id, 'manager', body.text);
        if (!said.ok) return send(res, 400, { error: said.error });
        if (!body.interview) void floor.notifier.send(`🧭 ${me.name} نظرش را درباره‌ی تیم ${team.name} نوشت (🧑‍💼 استخدام ← تیم‌ها)`);
        return send(res, 200, { ok: true });
      }
      let proposal;
      if (body.action === 'propose_hire') proposal = floor.teams.propose(me.id, me.name, { kind: 'hire', role: body.role, skill: body.skill, why: body.why });
      else {
        const w = typeof body.worker === 'string' ? findWorker(workers.filter((x) => x.kind === 'agent'), body.worker) : 'Say which worker';
        if (typeof w === 'string') return send(res, 400, { error: w });
        proposal = floor.teams.propose(me.id, me.name, { kind: 'adopt', role: w.role, why: body.why, worker: w.id });
      }
      if (!proposal.ok) return send(res, 400, { error: proposal.error });
      void floor.notifier.send(`🧭 ${me.name} پیشنهاد داد: ${body.action === 'propose_hire' ? `استخدام «${String(body.role)}»` : 'عضو شدن یک نفر مستقل'} (🧑‍💼 استخدام ← تیم‌ها)`);
      return send(res, 200, { ok: true, proposal: proposal.proposal.id });
    }
    case 'meeting_say':
    case 'meeting_vote':
    case 'meeting_decision':
    case 'meeting_summary': {
      const meetings = floor.teamMeetings;
      const bossOnly = { ok: false as const, error: 'Only the manager records decisions and the summary' };
      const m = body.action === 'meeting_say' ? meetings.say({ id: me.id, name: me.name }, body.text, body.to) : body.action === 'meeting_vote' ? meetings.vote({ id: me.id, name: me.name }, body.choice, body.reason) : !by.boss ? bossOnly : body.action === 'meeting_decision' ? meetings.decide(me.name, body.text) : meetings.setSummary(body.text);
      if (!m.ok) return send(res, 400, { error: m.error });
      tell(floor, m.notices, me.name);
      return send(res, 200, { ok: true, said: m.meeting.said.length });
    }
    default:
      return send(res, 400, { error: 'action is create, request, update or note' });
  }
  if (!result.ok) return send(res, 400, { error: result.error });
  tell(floor, result.notices, me.name);
  // A task the manager makes while a meeting is on is kept with that meeting.
  if (body.action === 'create' && by.boss && result.task) floor.teamMeetings.linkTask(result.task.id);
  if (result.task && !result.task.flow && (result.task.status === 'review' || result.task.status === 'blocked')) {
    void floor.notifier.send(`${result.task.status === 'review' ? '🔍 منتظر بازبینی' : '⛔ گیرکرده'}: ${result.task.id} «${result.task.title}» (${me.name})`);
  }
  ctx.toastFloor(floor, `📋 ${me.name}: ${body.action === 'note' ? 'note on' : body.action === 'update' ? 'updated' : body.action === 'request' ? 'asked the manager for' : 'created'} ${result.task?.id} «${result.task?.title}»`);
  return send(res, 200, { task: result.task && view(result.task), told: result.notices.map((n) => floor.workers.get(n.to)?.name).filter(Boolean) });
}
