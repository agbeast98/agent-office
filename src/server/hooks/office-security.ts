import type http from 'node:http';
import type { Floor } from '../floor.js';
import type { Ctx } from '../office/context.js';
import { readBody, send } from '../http/util.js';
import { announce, refusal, syncGuards, toolCheck } from '../security-glue.js';
import { profileGate } from '../profile-gate.js';
import { tell } from './office-tasks.js';

function authenticate(ctx: Ctx, req: http.IncomingMessage, url: URL) {
  const workerId = url.searchParams.get('worker') ?? '';
  const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const floor = ctx.workerFloor(workerId);
  const me = floor?.workers.authenticate(workerId, token);
  return floor && me ? { floor, me } : undefined;
}

/** Everything the security agent needs to decide: the holds of those it guards, with their rules. */
export function holdsFor(floor: Floor, guardian: string) {
  const mine = floor.security.guards[guardian] ?? [];
  const name = (id: string) => floor.workers.get(id)?.name ?? id;
  return {
    guarding: mine.map((id) => ({ name: name(id), rules: floor.security.rules(id) })),
    open: floor.security.holds.filter((h) => mine.includes(h.agent.id) && h.status === 'pending').map((h) => ({ id: h.id, agent: h.agent.name, kind: h.kind, target: h.target, detail: h.detail, held_minutes: Math.round((Date.now() - h.at) / 60_000) })),
    learned: floor.security.learned.map((l) => `${l.verdict}: ${l.key}`),
  };
}

/** The security agent's own calls: what's held for those it guards (GET), and its decision on one (POST {id, verdict, note, minutes}). */
export async function officeSecurity(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const who = authenticate(ctx, req, url);
  if (!who) return send(res, 401, { error: 'Send your own AGENT_OFFICE_WORKER_ID as ?worker= and AGENT_OFFICE_HOOK_TOKEN as the bearer token' });
  const { floor, me } = who;
  if (!(me.id in floor.security.guards)) return send(res, 403, { error: 'You are not a security agent: Mohammad makes one in 🛡 امنیت' });
  if (req.method === 'GET') return send(res, 200, holdsFor(floor, me.id));
  if (req.method !== 'POST') return send(res, 405, { error: 'GET or POST' });
  let body: Record<string, unknown>;
  try {
    body = JSON.parse((await readBody(req, 10_000)) || '{}') as Record<string, unknown>;
  } catch {
    return send(res, 400, { error: 'Send JSON' });
  }
  const id = typeof body.id === 'string' ? body.id : '';
  const hold = floor.security.holds.find((h) => h.id === id);
  if (!hold || !(floor.security.guards[me.id] ?? []).includes(hold.agent.id)) return send(res, 400, { error: 'That is not held for anyone you guard' });
  const verdict = body.verdict === 'allow' || body.verdict === 'deny' || body.verdict === 'ask' ? body.verdict : undefined;
  if (!verdict) return send(res, 400, { error: 'verdict is allow, deny or ask' });
  const out = floor.security.decide(id, verdict, 'security', typeof body.note === 'string' ? body.note : '', Number(body.minutes) || undefined);
  if (!out.ok) return send(res, 400, { error: out.error });
  tell(floor, out.notices, me.name);
  if (verdict === 'ask') void floor.notifier.send(`🛡 ${me.name} از شما می‌پرسد: ${hold.agent.name} ← ${hold.kind} «${hold.target}»`);
  floor.security.writeMirror((x) => floor.workers.get(x)?.name ?? x);
  syncGuards(floor);
  return send(res, 200, { ok: true, status: out.hold.status });
}

/**
 * Claude Code asks before every tool it is about to use (the PreToolUse hook, see providers/claude.ts) and
 * is answered with the decision it takes as its own: nothing for "go ahead", or a refusal with the reason.
 */
export async function officeGuard(ctx: Ctx, req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  const who = authenticate(ctx, req, url);
  if (!who || req.method !== 'POST') return send(res, 401, {});
  let payload: unknown = {};
  try {
    payload = JSON.parse((await readBody(req)) || '{}');
  } catch {
    return send(res, 200, {});
  }
  const locked = profileGate(who.floor, who.me, payload);
  if (locked) return send(res, 200, { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: locked } });
  const c = toolCheck(who.floor, who.me, payload);
  if (!c || c.verdict === 'allow') return send(res, 200, {});
  announce(who.floor, c);
  return send(res, 200, { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: refusal(c) } });
}
