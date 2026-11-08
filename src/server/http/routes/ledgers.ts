// The person's side of what agents need from them, what went wrong, and how members were judged (see
// team-ledgers.ts and the 📥 درخواست از شما, ⚠️ اشتباهات pages of the manager's computer).
import { str } from '../../office/input.js';
import { readBody, sameOrigin, send } from '../util.js';
import type { Route } from '../router.js';
import { floorParam } from './files.js';

async function body(req: Parameters<Route['handle']>[1]['req'], res: Parameters<Route['handle']>[1]['res']): Promise<Record<string, unknown> | undefined> {
  try {
    const value = JSON.parse(await readBody(req, 40_000));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // Fall through.
  }
  send(res, 400, { error: 'Bad request' });
  return undefined;
}

export const ledgerRoutes = {
  /** GET /api/ledgers?floor=<id>: requests, mistakes and evaluations. */
  state: {
    method: 'GET',
    path: '/api/ledgers',
    auth: 'session',
    handle(ctx, { res, url }) {
      const floor = floorParam(ctx, url);
      if (!floor) return send(res, 404, { error: 'No such floor' });
      return send(res, 200, { requests: [...floor.requests.items].reverse(), mistakes: [...floor.mistakes.items].reverse(), evals: [...floor.evals.items].reverse() });
    },
  },
  /**
   * POST /api/ledgers/action?floor=<id>:
   *  { action: request_done | request_declined | request_open, id, note? }  the person answers an agent's request
   *  { action: mistake_add, what, did?, cause?, lesson?, who?, by? }        the person writes a mistake down
   *  { action: mistake_status, id, status: open | learned | wontfix, note? }
   *  { action: eval_status, id, status: proposed | approved | applied | declined }
   */
  action: {
    method: 'POST',
    path: '/api/ledgers/action',
    auth: 'session',
    async handle(ctx, { req, res, url, session }) {
      if (!sameOrigin(req, ctx.cfg)) return send(res, 403, { error: 'Forbidden' });
      const floor = floorParam(ctx, url);
      if (!floor) return send(res, 404, { error: 'No such floor' });
      const b = await body(req, res);
      if (!b) return undefined;
      const by = session.account?.name ?? 'مدیرعامل';
      const id = str(b.id, 32);
      switch (b.action) {
        case 'request_done':
        case 'request_declined':
        case 'request_open': {
          const verdict = b.action === 'request_done' ? 'done' : b.action === 'request_declined' ? 'declined' : 'open';
          const r = floor.requests.resolve(id, verdict, str(b.note, 1000));
          if (!r) return send(res, 400, { error: 'چنین درخواستی نیست' });
          if (verdict !== 'open') {
            const said = verdict === 'done' ? (r.scope ? `تأیید کرد: هشت ساعت می‌توانی «${r.scope.file}» را تغییر بدهی` : 'انجام داد؛ می‌توانی ادامه بدهی') : 'انجامش نداد؛ بدون آن ادامه بده یا راه دیگری بگو';
            floor.comms.notify(r.from, `📥 مدیرعامل درخواست ${r.id} «${r.title}» را ${said}.${r.note ? ` توضیحش: ${r.note}` : ''}`);
          }
          return send(res, 200, { ok: true });
        }
        case 'mistake_add': {
          const who = typeof b.whoId === 'string' ? floor.workers.get(b.whoId) : undefined;
          const kind = b.by === 'assistant' || b.by === 'system' || b.by === 'agent' ? b.by : 'ceo';
          const byName = kind === 'assistant' ? 'دستیار' : kind === 'system' ? 'سیستم' : kind === 'agent' ? str(b.who, 60) || 'ایجنت' : by;
          const r = floor.mistakes.report(b, kind, byName, who && who.kind === 'agent' ? { id: who.id, name: who.name } : undefined);
          return r.ok ? send(res, 200, { ok: true }) : send(res, 400, { error: r.error });
        }
        case 'mistake_status': {
          const status = b.status === 'learned' || b.status === 'wontfix' ? b.status : 'open';
          return floor.mistakes.setStatus(id, status, str(b.note, 500)) ? send(res, 200, { ok: true }) : send(res, 400, { error: 'چنین اشتباهی ثبت نشده' });
        }
        case 'eval_status': {
          const status = ['approved', 'applied', 'declined'].includes(String(b.status)) ? (b.status as 'approved' | 'applied' | 'declined') : 'proposed';
          return floor.evals.setStatus(id, status) ? send(res, 200, { ok: true }) : send(res, 400, { error: 'چنین ارزیابی‌ای نیست' });
        }
        default:
          return send(res, 400, { error: 'Unknown action' });
      }
    },
  },
} satisfies Record<string, Route>;
