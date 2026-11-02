import type { Route } from '../router.js';
import type { Ctx } from '../../office/context.js';
import { readBody, sameOrigin, send } from '../util.js';

function ownerFloor(ctx: Ctx, url: URL) {
  const floor = ctx.floors.get(url.searchParams.get('floor') ?? '');
  const workerId = (url.searchParams.get('worker') ?? '').slice(0, 32);
  return floor && workerId && floor.workers.get(workerId) ? { floor, workerId } : undefined;
}

export const workerBrowserRoutes = {
  view: {
    method: 'GET',
    path: '/api/worker-browser/view',
    auth: 'session',
    async handle(ctx, { res, url }) {
      const found = ownerFloor(ctx, url);
      if (!found) return send(res, 404, { error: 'No such worker' });
      return send(res, 200, await found.floor.workerBrowsers.view(found.workerId), { 'cache-control': 'no-store' });
    },
  },
  screenshot: {
    method: 'GET',
    path: '/api/worker-browser/screenshot',
    auth: 'session',
    async handle(ctx, { res, url }) {
      const found = ownerFloor(ctx, url);
      if (!found) return send(res, 404, { error: 'No such worker' });
      try {
        const image = await found.floor.workerBrowsers.screenshot(found.workerId);
        res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': String(image.length), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin' });
        return res.end(image);
      } catch (error) {
        return send(res, 404, { error: error instanceof Error ? error.message : 'The browser is not open.' });
      }
    },
  },
  action: {
    method: 'POST',
    path: '/api/worker-browser/action',
    auth: 'session',
    async handle(ctx, { req, res, url }) {
      if (!sameOrigin(req, ctx.cfg)) return send(res, 403, { error: 'Forbidden' });
      const found = ownerFloor(ctx, url);
      if (!found) return send(res, 404, { error: 'No such worker' });
      let body: Record<string, unknown>;
      try {
        const value = JSON.parse(await readBody(req, 12_000));
        if (!value || typeof value !== 'object' || Array.isArray(value)) return send(res, 400, { error: 'Bad request' });
        body = value as Record<string, unknown>;
      } catch (error) {
        return send(res, (error as Error).message === 'too large' ? 413 : 400, { error: 'Bad request' });
      }
      const browser = found.floor.workerBrowsers;
      try {
        if (body.action === 'take') return send(res, 200, await browser.control(found.workerId, 'person'));
        if (body.action === 'release') return send(res, 200, await browser.control(found.workerId, 'agent'));
        if (body.action === 'open') {
          await browser.control(found.workerId, 'person');
          return send(res, 200, await browser.navigate(found.workerId, body.url, 'person'));
        }
        if (body.action === 'navigate') return send(res, 200, await browser.navigate(found.workerId, body.url, 'person'));
        if (body.action === 'back') return send(res, 200, await browser.back(found.workerId, 'person'));
        if (body.action === 'forward') return send(res, 200, await browser.forward(found.workerId, 'person'));
        if (body.action === 'reload') return send(res, 200, await browser.reload(found.workerId, 'person'));
        if (body.action === 'input' && ['click', 'text', 'key'].includes(String(body.kind))) {
          const data = { kind: body.kind as 'click' | 'text' | 'key', x: body.x as number, y: body.y as number, text: body.text as string, key: body.key as string };
          return send(res, 200, await browser.input(found.workerId, data));
        }
        return send(res, 400, { error: 'Unknown browser action' });
      } catch (error) {
        return send(res, 400, { error: error instanceof Error ? error.message : 'Browser action failed' });
      }
    },
  },
} satisfies Record<string, Route>;
