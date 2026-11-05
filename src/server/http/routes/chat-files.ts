// The pictures an agent mentions in the chat tab (client/ui/termchat.ts): a path or a link in its answer is shown
// as the picture itself. Only an image file (png, jpg, webp, gif) inside the floor's folder or Codex's own
// generated_images folder is ever served, whatever path the agent wrote.
import { createReadStream, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Route } from '../router.js';
import { send } from '../util.js';
import { floorParam } from './files.js';

const TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const MAX_BYTES = 25 * 1024 * 1024;

const inside = (root: string, target: string) => {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** The file a link or path in an answer means, as a real path, or undefined if it is not an image the office may show. */
export function chatImage(floorDir: string, raw: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  let p = raw.trim();
  if (!p || p.length > 1000 || p.includes('\0')) return undefined;
  try {
    p = decodeURIComponent(p);
  } catch {
    // Not percent-encoded: as it is.
  }
  p = p.replace(/^file:\/\//i, '').replace(/^\/([A-Za-z]:)/, '$1');
  if (p.startsWith('~')) p = path.join(homedir(), p.slice(1));
  const file = path.resolve(floorDir, p);
  const type = TYPES[path.extname(file).toLowerCase()];
  if (!type) return undefined;
  try {
    const real = realpathSync(file);
    const codex = path.join(env.CODEX_HOME || path.join(env.HOME || homedir(), '.codex'), 'generated_images');
    const roots = [floorDir, codex].map((r) => {
      try {
        return realpathSync(r);
      } catch {
        return path.resolve(r);
      }
    });
    const stat = statSync(real);
    return stat.isFile() && stat.size <= MAX_BYTES && roots.some((r) => inside(r, real)) ? real : undefined;
  } catch {
    return undefined;
  }
}

export const chatFileRoutes = {
  /** GET /api/chat-image?floor=<id>&path=<what the agent wrote> */
  image: {
    method: 'GET',
    path: '/api/chat-image',
    auth: 'session',
    handle(ctx, { res, url }) {
      const floor = floorParam(ctx, url);
      if (!floor) return send(res, 404, { error: 'No such floor' });
      const file = chatImage(floor.dir, url.searchParams.get('path') ?? '');
      if (!file) return send(res, 404, { error: 'No such picture' });
      const stat = statSync(file);
      res.writeHead(200, {
        'content-type': TYPES[path.extname(file).toLowerCase()],
        'content-length': String(stat.size),
        'cache-control': 'private, max-age=60',
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'same-origin',
      });
      createReadStream(file).on('error', () => res.destroy()).pipe(res);
    },
  },
} satisfies Record<string, Route>;
