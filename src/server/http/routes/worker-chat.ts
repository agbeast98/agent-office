import type { Route } from '../router.js';
import type { Ctx } from '../../office/context.js';
import { send } from '../util.js';

function ownerWorker(ctx: Ctx, url: URL) {
  const floor = ctx.floors.get(url.searchParams.get('floor') ?? '');
  const workerId = (url.searchParams.get('worker') ?? '').slice(0, 32);
  return floor && workerId && floor.workers.get(workerId) ? { floor, workerId } : undefined;
}

/** The office puts the person's role reminder in front of what they typed; the conversation shows only what they typed. */
function tidy<M extends { role: string; text: string }>(m: M): M[] {
  if (m.role !== 'user') return [m];
  // Claude Code wraps a pasted prompt (which is how the office types one) in <pasted_content> tags in its transcript.
  const text = m.text
    .replace(/^\s*<pasted_content[^>]*>\s*/, '')
    .replace(/\s*<\/pasted_content>\s*$/, '')
    .replace(/^یادآوری نقش شما:[^\n]*\n\n/, '')
    .trim();
  return text ? [{ ...m, text }] : [];
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
      const chat = found.floor.workers.conversation(found.workerId, Number.isSafeInteger(after) ? after : 0);
      return send(res, 200, { ...chat, messages: chat.messages.flatMap(tidy) }, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    },
  },
} satisfies Record<string, Route>;
