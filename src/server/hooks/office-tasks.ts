import type http from 'node:http';
import type { Floor } from '../floor.js';
import type { Ctx } from '../office/context.js';
import { readBody, send } from '../http/util.js';
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
    default:
      return send(res, 400, { error: 'action is create, request, update or note' });
  }
  if (!result.ok) return send(res, 400, { error: result.error });
  tell(floor, result.notices, me.name);
  ctx.toastFloor(floor, `📋 ${me.name}: ${body.action === 'note' ? 'note on' : body.action === 'update' ? 'updated' : body.action === 'request' ? 'asked the manager for' : 'created'} ${result.task?.id} «${result.task?.title}»`);
  return send(res, 200, { task: result.task && view(result.task), told: result.notices.map((n) => floor.workers.get(n.to)?.name).filter(Boolean) });
}
