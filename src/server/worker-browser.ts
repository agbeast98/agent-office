import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright-core';

export interface BrowserView {
  workerId: string;
  open: boolean;
  url?: string;
  title?: string;
  control: 'agent' | 'person';
  error?: string;
}

interface Session {
  context: BrowserContext;
  page: Page;
  control: 'agent' | 'person';
  error?: string;
}

/** A dedicated, persistent browser profile per worker. No user's regular Chrome profile is reused. */
export class WorkerBrowsers {
  private sessions = new Map<string, Promise<Session>>();
  private root: string;
  private closing = false;

  constructor(dataDir: string) {
    this.root = path.join(dataDir, 'worker-browsers');
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  private profile(workerId: string) {
    return path.join(this.root, createHash('sha256').update(workerId).digest('hex').slice(0, 32));
  }

  private async session(workerId: string): Promise<Session> {
    if (this.closing) throw new Error('The office is shutting down; try again after it restarts.');
    let opening = this.sessions.get(workerId);
    if (!opening) {
      opening = (async () => {
        mkdirSync(this.profile(workerId), { recursive: true, mode: 0o700 });
        const executablePath = chromePath();
        const context = await chromium.launchPersistentContext(this.profile(workerId), {
          headless: true,
          ...(executablePath ? { executablePath } : {}),
          viewport: { width: 1280, height: 800 },
          acceptDownloads: false,
          permissions: [],
          args: process.platform === 'linux' ? ['--no-sandbox'] : [],
        });
        const page = context.pages()[0] ?? (await context.newPage());
        return { context, page, control: 'agent' as const };
      })();
      this.sessions.set(workerId, opening);
      opening.catch(() => this.sessions.delete(workerId));
    }
    return opening;
  }

  async navigate(workerId: string, address: unknown, actor: 'agent' | 'person' = 'agent') {
    const url = checkedUrl(address);
    const s = await this.session(workerId);
    if (s.control !== actor) throw new Error(`The browser is currently controlled by ${s.control === 'person' ? 'you' : 'the agent'}.`);
    await s.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    return this.view(workerId);
  }

  async view(workerId: string): Promise<BrowserView> {
    const opening = this.sessions.get(workerId);
    if (!opening) return { workerId, open: false, control: 'agent' };
    try {
      const s = await opening;
      return { workerId, open: true, url: s.page.url(), title: await s.page.title().catch(() => ''), control: s.control, ...(s.error ? { error: s.error } : {}) };
    } catch (error) {
      return { workerId, open: false, control: 'agent', error: errorMessage(error) };
    }
  }

  async screenshot(workerId: string): Promise<Buffer> {
    const opening = this.sessions.get(workerId);
    if (!opening) throw new Error('Open the browser first.');
    const s = await opening;
    return s.page.screenshot({ type: 'jpeg', quality: 72, timeout: 10_000 });
  }

  async back(workerId: string, actor: 'agent' | 'person') { return this.step(workerId, actor, async () => (await this.sessionPage(workerId)).goBack({ waitUntil: 'domcontentloaded', timeout: 15_000 })); }
  async forward(workerId: string, actor: 'agent' | 'person') { return this.step(workerId, actor, async () => (await this.sessionPage(workerId)).goForward({ waitUntil: 'domcontentloaded', timeout: 15_000 })); }
  async reload(workerId: string, actor: 'agent' | 'person') { return this.step(workerId, actor, async () => (await this.sessionPage(workerId)).reload({ waitUntil: 'domcontentloaded', timeout: 15_000 })); }

  async text(workerId: string, actor: 'agent' | 'person' = 'agent'): Promise<string> {
    const s = await this.session(workerId);
    if (s.control !== actor) throw new Error('The browser is currently under human control.');
    return (await s.page.locator('body').innerText({ timeout: 5000 }).catch(() => '')).slice(0, 20_000);
  }

  async click(workerId: string, selector: unknown, actor: 'agent' | 'person' = 'agent') {
    const s = await this.session(workerId);
    if (s.control !== actor) throw new Error('The browser is currently under human control.');
    const target = checkedSelector(selector);
    await s.page.locator(target).first().click({ timeout: 8000 });
    return this.view(workerId);
  }

  async type(workerId: string, selector: unknown, text: unknown, actor: 'agent' | 'person' = 'agent') {
    const s = await this.session(workerId);
    if (s.control !== actor) throw new Error('The browser is currently under human control.');
    const target = checkedSelector(selector);
    if (typeof text !== 'string' || text.length > 5000) throw new Error('Text must be at most 5000 characters.');
    await s.page.locator(target).first().fill(text, { timeout: 8000 });
    return this.view(workerId);
  }

  async control(workerId: string, value: 'agent' | 'person') {
    const s = await this.session(workerId);
    s.control = value;
    return this.view(workerId);
  }

  async input(workerId: string, data: { kind: 'click' | 'text' | 'key'; x?: number; y?: number; text?: string; key?: string }) {
    const s = await this.session(workerId);
    if (s.control !== 'person') throw new Error('Take control of the browser before interacting with the page.');
    if (data.kind === 'click') {
      const x = bounded(data.x, 0, 1280); const y = bounded(data.y, 0, 800);
      await s.page.mouse.click(x, y);
    } else if (data.kind === 'text') {
      const text = typeof data.text === 'string' ? data.text.slice(0, 1000) : '';
      await s.page.keyboard.insertText(text);
    } else if (data.kind === 'key') {
      if (!['Enter', 'Tab', 'Escape', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(data.key ?? '')) throw new Error('That key is not available.');
      await s.page.keyboard.press(data.key!);
    }
    return this.view(workerId);
  }

  private async sessionPage(workerId: string) { return (await this.session(workerId)).page; }
  private async step(workerId: string, actor: 'agent' | 'person', action: () => Promise<unknown>) {
    const s = await this.session(workerId);
    if (s.control !== actor) throw new Error(`The browser is currently controlled by ${s.control === 'person' ? 'you' : 'the agent'}.`);
    await action();
    return this.view(workerId);
  }

  async close(workerId: string, removeProfile = true) {
    const opening = this.sessions.get(workerId);
    this.sessions.delete(workerId);
    if (opening) await opening.then((s) => s.context.close()).catch(() => {});
    if (removeProfile) rmSync(this.profile(workerId), { recursive: true, force: true });
  }

  /** Close Chrome before the office exits so a restarted office can safely reopen these profiles. */
  async shutdown() {
    this.closing = true;
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map(async (opening) => {
      const session = await opening.catch(() => undefined);
      if (session) await session.context.close();
    }));
  }
}

function checkedUrl(input: unknown): string {
  if (typeof input !== 'string' || input.length > 2048) throw new Error('Give an http:// or https:// address (up to 2048 characters).');
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('That is not a valid web address.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http:// and https:// addresses are allowed.');
  if (url.username || url.password) throw new Error('Addresses with embedded passwords are not allowed.');
  return url.href;
}

function checkedSelector(input: unknown): string {
  if (typeof input !== 'string' || !input.trim() || input.length > 500) throw new Error('Give a CSS selector up to 500 characters.');
  return input;
}

function bounded(value: unknown, min: number, max: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function errorMessage(error: unknown) { return error instanceof Error ? error.message.slice(0, 300) : 'Could not start the browser.'; }

function chromePath(): string | undefined {
  const env = process.env.AGENT_OFFICE_CHROME;
  const candidates = env ? [env] : process.platform === 'win32'
    ? [path.join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'), path.join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe'), path.join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe')]
    : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find((candidate) => candidate && existsSync(candidate));
}
