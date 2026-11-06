// Files going into and out of a worker's browser (see worker-browser.ts): an agent picks a local file for a site's
// upload box (a picture to put in a draft, say) and the files the browser downloads are kept where the agent can find
// them. Only files in the floor's own folder or Codex's generated_images can be uploaded, never the office's own data
// (profiles, logins, cookies), and only the downloads folder of that data.
import { mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { BrowserContext, Page } from 'playwright-core';

const MAX_BYTES = 25 * 1024 * 1024;

const inside = (root: string, target: string) => {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/** The file a path in an agent's request means, as a real path, or an error saying why it may not be uploaded. */
export function uploadable(floorDir: string, raw: unknown, env: NodeJS.ProcessEnv = process.env): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 1000 || raw.includes('\0')) throw new Error('Give the full path of the file to upload.');
  const home = env.HOME || env.USERPROFILE || homedir();
  const p = raw.trim().replace(/^file:\/\//i, '').replace(/^\/([A-Za-z]:)/, '$1');
  const file = real(path.resolve(floorDir, p.startsWith('~') ? path.join(home, p.slice(1)) : p));
  const data = real(path.join(floorDir, '.agent-office'));
  const codex = real(path.join(env.CODEX_HOME || path.join(home, '.codex'), 'generated_images'));
  const allowed = (inside(real(floorDir), file) && (!inside(data, file) || inside(path.join(data, 'downloads'), file))) || inside(codex, file);
  if (!allowed) throw new Error("That file is outside this project's folder (or is the office's own data); only files in the project folder, in Codex's generated_images or downloaded by the browser can be uploaded.");
  let stat;
  try {
    stat = statSync(file);
  } catch {
    throw new Error('There is no such file.');
  }
  if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('It must be a file of at most 25 MB.');
  return file;
}

/** Puts a file into the upload box a selector names, or into the file picker the clicked element opens. */
export async function putFile(page: Page, selector: string, file: string): Promise<void> {
  const el = page.locator(selector).first();
  const isInput = await el.evaluate((n: Element) => n.tagName === 'INPUT' && (n as HTMLInputElement).type === 'file', undefined, { timeout: 5000 }).catch(() => {
    throw new Error('No element matches that selector.');
  });
  if (isInput) return el.setInputFiles(file, { timeout: 8000 });
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 8000 }), el.click({ timeout: 8000 })]);
  await chooser.setFiles(file);
}

/** Whatever the browser downloads is saved in this folder under its own name, and noted. */
export function keepDownloads(context: BrowserContext, dir: string, saved: (file: string) => void): void {
  const watch = (page: Page) =>
    page.on('download', (download) => {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const name = download.suggestedFilename().replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 120) || 'download';
      const file = path.join(dir, `${Date.now()}-${name}`);
      download.saveAs(file).then(() => saved(file), () => undefined);
    });
  context.pages().forEach(watch);
  context.on('page', watch);
}

/** The files this browser has downloaded, newest first, with their sizes. */
export function downloaded(dir: string): { path: string; bytes: number }[] {
  try {
    return readdirSync(dir)
      .map((n) => ({ path: path.join(dir, n), bytes: statSync(path.join(dir, n)).size }))
      .sort((a, b) => b.path.localeCompare(a.path))
      .slice(0, 20);
  } catch {
    return [];
  }
}
