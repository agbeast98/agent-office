// The loopback-only server for the workers' own calls: their agents' hook events, and the office's
// queue and workers for the board agents and the office-workers command.
import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Ctx } from '../office/context.js';
import { readBody, send } from '../http/util.js';
import { officeQueue } from './office-queue.js';
import { officeWorkers } from './office-workers.js';
import { officeTasks } from './office-tasks.js';
import { officeGuard, officeSecurity } from './office-security.js';
import { folderGate } from '../folder-gate.js';
import { profileGate } from '../profile-gate.js';
import { providerHook } from '../providers/index.js';
import type { AgentProvider } from '../../shared/providers.js';

/** Starts the hook server, and says which port it listens on. */
export async function startHookServer(ctx: Ctx): Promise<{ hookServer: http.Server; hookPort: number }> {
  const hookServer = http.createServer(async (req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      return send(res, 400, {});
    }
    if (url.pathname === '/office/queue') return officeQueue(ctx, req, res, url);
    if (url.pathname === '/office/workers' || url.pathname.startsWith('/office/workers/')) return officeWorkers(ctx, req, res, url);
    if (url.pathname === '/office/tasks') return officeTasks(ctx, req, res, url);
    if (url.pathname === '/office/security') return officeSecurity(ctx, req, res, url);
    if (url.pathname === '/office/guard') return officeGuard(ctx, req, res, url);
    if (url.pathname === '/office/browser') {
      if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' });
      const workerId = url.searchParams.get('worker') ?? '';
      const floor = ctx.workerFloor(workerId);
      const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (!floor?.workers.authenticate(workerId, token)) return send(res, 401, { error: 'This worker cannot access its browser.' });
      let body: Record<string, unknown>;
      try {
        const value = JSON.parse(await readBody(req, 12_000));
        if (!value || typeof value !== 'object' || Array.isArray(value)) return send(res, 400, { error: 'Bad request' });
        body = value as Record<string, unknown>;
      } catch {
        return send(res, 400, { error: 'Bad request' });
      }
      try {
        const browsers = floor.workerBrowsers;
        if (body.action === 'open') return send(res, 200, await browsers.navigate(workerId, body.url, 'agent'));
        if (body.action === 'view') return send(res, 200, await browsers.view(workerId));
        if (body.action === 'text') return send(res, 200, { text: await browsers.text(workerId, 'agent') });
        if (body.action === 'click') return send(res, 200, await browsers.click(workerId, body.selector, 'agent'));
        if (body.action === 'type') return send(res, 200, await browsers.type(workerId, body.selector, body.text, 'agent'));
        if (body.action === 'back') return send(res, 200, await browsers.back(workerId, 'agent'));
        if (body.action === 'forward') return send(res, 200, await browsers.forward(workerId, 'agent'));
        if (body.action === 'reload') return send(res, 200, await browsers.reload(workerId, 'agent'));
        if (body.action === 'snapshot') return send(res, 200, await browsers.snapshot(workerId));
        if (body.action === 'press') return send(res, 200, await browsers.press(workerId, body.key, 'agent'));
        if (body.action === 'scroll') return send(res, 200, await browsers.scroll(workerId, body.direction, 'agent'));
        if (body.action === 'wait') return send(res, 200, await browsers.wait(workerId, body.seconds, 'agent'));
        if (body.action === 'select') return send(res, 200, await browsers.select(workerId, body.selector, body.value, 'agent'));
        if (body.action === 'upload') return send(res, 200, await browsers.upload(workerId, body.selector, body.path, 'agent'));
        if (body.action === 'downloads') return send(res, 200, browsers.downloads(workerId));
        if (body.action === 'screenshot') return send(res, 200, { data: (await browsers.screenshot(workerId)).toString('base64') });
        return send(res, 400, { error: 'Unknown browser action' });
      } catch (error) {
        return send(res, 400, { error: error instanceof Error ? error.message : 'Browser action failed' });
      }
    }
    // Each provider with hooks has its route, /hooks/<provider> (see providers/).
    const route = url.pathname.startsWith('/hooks/') ? url.pathname.slice('/hooks/'.length) : '';
    const hook = providerHook(route);
    if (req.method !== 'POST' || !hook) return send(res, 404, { ok: false });
    let payload: unknown = {};
    try {
      const body = await readBody(req);
      payload = body ? JSON.parse(body) : {};
    } catch {
      if (hook.strictJson) return send(res, 400, { ok: false });
      // permissive: a bad payload still counts as the event
    }
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const workerId = url.searchParams.get('worker') ?? '';
    const workers = ctx.workerFloor(workerId)?.workers;
    if (!workers) return send(res, 401, {});
    const event = url.searchParams.get('event') ?? '';
    // Codex asks before each tool too (PreToolUse): the profile lock answers in its own words.
    if (route === 'codex' && event === 'PreToolUse') {
      const floor = ctx.workerFloor(workerId);
      const me = floor?.workers.authenticate(workerId, token);
      const raw = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
      let input = raw.tool_input;
      if (typeof input === 'string') {
        try {
          input = JSON.parse(input);
        } catch {
          // a patch sent as plain text
        }
      }
      const gated = { tool_name: raw.tool_name, tool_input: input, cwd: raw.cwd };
      const locked = floor && me ? profileGate(floor, me, gated) ?? folderGate(floor, me, gated) : undefined;
      if (locked) return send(res, 200, { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: locked } });
    }
    const ok = workers.handleProviderHook(route as AgentProvider, workerId, token, event, payload);
    send(res, ok ? 200 : 401, {});
  });
  // Workers' terminals outlive a restart of the office (see ptys.ts) with this address in their
  // environment, so listen where the last office did when that port is free.
  const hookPortPath = path.join(ctx.cfg.dataDir, 'hook-port');
  const listenHooks = (port: number) =>
    new Promise<void>((resolve, reject) => {
      hookServer.once('error', reject);
      hookServer.listen(port, '127.0.0.1', () => {
        hookServer.off('error', reject);
        resolve();
      });
    });
  let lastHookPort = 0;
  try {
    lastHookPort = Number(readFileSync(hookPortPath, 'utf8')) || 0;
  } catch {
    // first start
  }
  await listenHooks(lastHookPort).catch(() => listenHooks(0));
  const hookPort = (hookServer.address() as { port: number }).port;
  writeFileSync(hookPortPath, String(hookPort), { mode: 0o600 });
  return { hookServer, hookPort };
}
