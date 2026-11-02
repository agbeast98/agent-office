import type { Route } from '../router.js';
import type { Ctx } from '../../office/context.js';
import { send } from '../util.js';

function ownerWorker(ctx: Ctx, url: URL) {
  const floor = ctx.floors.get(url.searchParams.get('floor') ?? '');
  const workerId = (url.searchParams.get('worker') ?? '').slice(0, 32);
  return floor && workerId && floor.workers.get(workerId) ? { floor, workerId } : undefined;
}

export const workerChatRoutes = {
  transcript: {
    method: 'GET',
    path: '/api/worker-chat',
    auth: 'session',
    handle(ctx, { res, url }) {
      const found = ownerWorker(ctx, url);
      if (!found) return send(res, 404, { error: 'No such worker' });
      const raw = url.searchParams.get('after') ?? '0';
      const after = /^\d{1,16}$/.test(raw) ? Number(raw) : 0;
      return send(res, 200, found.floor.workers.conversation(found.workerId, Number.isSafeInteger(after) ? after : 0), { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    },
  },
} satisfies Record<string, Route>;
