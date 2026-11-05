import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import { BrowserStream } from './browser-stream.js';
import { hasScreen, openRealWindow, type RealWindow } from './browser-window.js';

/** 'ask': the agent needs the person's say-so before anything that sends or confirms; 'auto': it doesn't. */
export type BrowserMode = 'ask' | 'auto';

/** Something the agent wanted to do that waits for the person (see WorkerBrowsers.guard). */
export interface BrowserRequest {
  action: 'click' | 'press';
  label: string;
  selector?: string;
  key?: string;
  url: string;
  at: number;
  /** Pays, deletes or moves money: it asks the person even when the browser is in 'auto'. */
  risky?: boolean;
}

export interface BrowserView {
  workerId: string;
  open: boolean;
  url?: string;
  title?: string;
  control: 'agent' | 'person';
  mode: BrowserMode;
  pending?: BrowserRequest;
  error?: string;
  /** The agent's browser is closed while the person logs in, in an ordinary Chrome window on the office's screen. */
  real?: boolean;
  /** Pictures, video and fonts are not loaded while the agent drives: faster, lighter. */
  light?: boolean;
}

/** One input of the person on the live picture: the mouse, the wheel, a key or typed text. */
export interface RawInput {
  t: 'move' | 'down' | 'up' | 'wheel' | 'key' | 'text';
  x?: number;
  y?: number;
  button?: 'left' | 'right' | 'middle';
  dx?: number;
  dy?: number;
  key?: string;
  text?: string;
}

const KEYS = ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'];
/** A browser nobody has used or looked at for this long is closed (its profile and logins stay) and opens again when needed. */
const IDLE_MS = 15 * 60_000;
const SWEEP_MS = 60_000;
/** Chrome flags that make a hidden browser lighter and quicker to start. */
const LEAN_ARGS = ['--disable-background-networking', '--disable-extensions', '--disable-features=Translate,MediaRouter', '--mute-audio', '--no-first-run'];

/** How long an approval (or a refusal) of one action on one page holds. */
const DECISION_MS = 2 * 60_000;
/** How often a browser's logins are written down, and how long a login that had no end date is kept. */
const COOKIE_SAVE_MS = 60_000;
const SESSION_COOKIE_DAYS = 30;
/** Buttons and links that send, confirm, pay or delete, in Persian and English. */
const SENSITIVE = /(ارسال|ثبت|تایید|تأیید|پرداخت|حذف|انتشار|خرید|پیشنهاد|submit|send|publish|confirm|pay|delete|remove|buy|order|apply|post|bid|checkout)/i;

/** Money and deletions: never left to the agent alone, whatever the mode (docs/team-policy.md). */
const RISKY = /(پرداخت|حذف|خرید|برداشت|انتقال|واریز|payment|pay now|checkout|delete|withdraw|transfer|purchase)/i;

interface Session {
  context: BrowserContext;
  page: Page;
  control: 'agent' | 'person';
  saver?: ReturnType<typeof setInterval>;
  error?: string;
}

/** A dedicated, persistent browser profile per worker. No user's regular Chrome profile is reused. */
export class WorkerBrowsers {
  private sessions = new Map<string, Promise<Session>>();
  private live = new Map<string, Session>();
  private used = new Map<string, number>();
  private light = new Set<string>();
  private real = new Map<string, RealWindow>();
  /** The live picture, pushed as the page changes (see browser-stream.ts). */
  readonly stream = new BrowserStream(async (workerId) => (await this.sessions.get(workerId)?.catch(() => undefined))?.page as never);
  private root: string;
  private closing = false;
  private modes = new Map<string, BrowserMode>();
  private pending = new Map<string, BrowserRequest>();
  /** Asked before the agent opens or sends anything in a site: throws what to tell the agent when its rules don't allow it (see security.ts). */
  gate?: (workerId: string, kind: 'open' | 'write', address: string, detail: string) => void;
  /** Told when something starts waiting for the person (the manager's computer and the phone listen). */
  onPending?: (workerId: string, request: BrowserRequest) => void;
  /** What the person approved ('allow') or turned down ('deny'), by worker, action and page, until it expires. */
  private decisions = new Map<string, { verdict: 'allow' | 'deny'; until: number }>();

  constructor(dataDir: string) {
    this.root = path.join(dataDir, 'worker-browsers');
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    try {
      const saved = JSON.parse(readFileSync(path.join(this.root, 'modes.json'), 'utf8')) as Record<string, unknown>;
      for (const [id, mode] of Object.entries(saved)) if (mode === 'auto' || mode === 'ask') this.modes.set(id, mode);
    } catch {
      // No choices made yet: every browser asks.
    }
    try {
      for (const id of JSON.parse(readFileSync(path.join(this.root, 'light.json'), 'utf8')) as string[]) this.light.add(String(id));
    } catch {
      // Nothing is light yet.
    }
    const sweeper = setInterval(() => void this.sweep(), SWEEP_MS);
    sweeper.unref();
  }

  /** Closes the browsers nobody has needed for a while. */
  private async sweep(now = Date.now()) {
    for (const [workerId, s] of this.live) {
      if (s.control === 'agent' && !this.pending.has(workerId) && !this.stream.viewers(workerId) && now - (this.used.get(workerId) ?? now) > IDLE_MS) {
        this.note(workerId, 'agent', 'idle-closed');
        await this.close(workerId, false);
      }
    }
  }

  setLight(workerId: string, on: unknown) {
    if (on) this.light.add(workerId);
    else this.light.delete(workerId);
    try {
      writeFileSync(path.join(this.root, 'light.json'), JSON.stringify([...this.light]), { mode: 0o600 });
    } catch {
      // The choice still holds until the office restarts.
    }
    return this.view(workerId);
  }

  mode(workerId: string): BrowserMode {
    return this.modes.get(workerId) ?? 'ask';
  }

  setMode(workerId: string, mode: unknown) {
    if (mode !== 'ask' && mode !== 'auto') throw new Error('The mode is ask or auto.');
    this.modes.set(workerId, mode);
    this.pending.delete(workerId);
    try {
      writeFileSync(path.join(this.root, 'modes.json'), JSON.stringify(Object.fromEntries(this.modes)), { mode: 0o600 });
    } catch {
      // The choice still holds until the office restarts.
    }
    this.note(workerId, 'person', 'mode', mode);
    return this.view(workerId);
  }

  /** One line of what happened in this browser, for whoever wants to check on it later. Typed text is never written down. */
  private note(workerId: string, actor: 'agent' | 'person', action: string, detail = '', url = '') {
    try {
      appendFileSync(`${this.profile(workerId)}.log.jsonl`, `${JSON.stringify({ at: new Date().toISOString(), actor, action, detail: detail.slice(0, 200), url: url.slice(0, 300) })}\n`, { mode: 0o600 });
    } catch {
      // A log that can't be written is not a reason to stop the page.
    }
  }

  /** The last lines of this browser's log. */
  history(workerId: string, lines = 100): string[] {
    try {
      return readFileSync(`${this.profile(workerId)}.log.jsonl`, 'utf8').trim().split('\n').slice(-lines);
    } catch {
      return [];
    }
  }

  private cookieFile(workerId: string) {
    return `${this.profile(workerId)}.cookies.json`;
  }

  /** Writes down this browser's cookies, the ones that would otherwise be lost when Chrome closes included. */
  private async saveCookies(workerId: string, context: BrowserContext) {
    try {
      this.storeCookies(workerId, await context.cookies());
    } catch {
      // The browser may be closing: the last save stands.
    }
  }

  private storeCookies(workerId: string, all: Awaited<ReturnType<BrowserContext['cookies']>>) {
    const cookies = all.map((c) => (c.expires > 0 ? c : { ...c, expires: Math.floor(Date.now() / 1000) + SESSION_COOKIE_DAYS * 86_400 }));
    writeFileSync(this.cookieFile(workerId), JSON.stringify(cookies), { mode: 0o600 });
  }

  private async restoreCookies(workerId: string, context: BrowserContext) {
    try {
      const cookies = JSON.parse(readFileSync(this.cookieFile(workerId), 'utf8'));
      if (Array.isArray(cookies) && cookies.length) await context.addCookies(cookies);
    } catch {
      // Nothing saved yet, or not readable: the person logs in again.
    }
  }

  private key(workerId: string, action: string, target: string, url: string) {
    return `${workerId}|${action}|${target}|${url.split('#')[0]}`;
  }

  /**
   * In 'ask' mode the agent can't send, confirm, pay or delete on its own: the first try is kept
   * for the person to approve or turn down, and the agent is told to wait; once approved, the same
   * action on the same page goes through (for a couple of minutes).
   */
  private guard(workerId: string, s: Session, request: Omit<BrowserRequest, 'url' | 'at'>, sensitive: boolean) {
    // Its rules (the security agent's firewall) come before the person's say-so: sending is only allowed where they say.
    if (sensitive) this.gate?.(workerId, 'write', s.page.url(), request.label);
    const risky = RISKY.test(request.label);
    if (!sensitive || (this.mode(workerId) === 'auto' && !risky)) return;
    const url = s.page.url();
    const key = this.key(workerId, request.action, request.selector ?? request.key ?? '', url);
    const decision = this.decisions.get(key);
    if (decision && decision.until > Date.now()) {
      this.decisions.delete(key);
      if (decision.verdict === 'allow') return;
      throw new Error(`The person said no to "${request.label}". Do not try again; ask them what to do instead.`);
    }
    const waiting: BrowserRequest = { ...request, url, at: Date.now(), ...(risky ? { risky } : {}) };
    this.pending.set(workerId, waiting);
    this.onPending?.(workerId, waiting);
    this.note(workerId, 'agent', 'waiting-for-approval', `${request.action}: ${request.label}`, url);
    throw new Error(`"${request.label}" sends or confirms something, so it needs the person's approval. It is waiting in the 🌐 Browser tab. Tell them, then try the very same action again once they say they approved it.`);
  }

  /** Everything waiting for the person, across the team's browsers. */
  waiting(): { workerId: string; request: BrowserRequest }[] {
    return [...this.pending].map(([workerId, request]) => ({ workerId, request }));
  }

  approve(workerId: string, verdict: 'allow' | 'deny') {
    const request = this.pending.get(workerId);
    if (!request) throw new Error('Nothing is waiting for approval.');
    this.pending.delete(workerId);
    this.decisions.set(this.key(workerId, request.action, request.selector ?? request.key ?? '', request.url), { verdict, until: Date.now() + DECISION_MS });
    this.note(workerId, 'person', verdict === 'allow' ? 'approved' : 'refused', request.label, request.url);
    return this.view(workerId);
  }

  private profile(workerId: string) {
    return path.join(this.root, createHash('sha256').update(workerId).digest('hex').slice(0, 32));
  }

  private async session(workerId: string): Promise<Session> {
    if (this.closing) throw new Error('The office is shutting down; try again after it restarts.');
    if (this.real.has(workerId)) throw new Error('The person is logging in to a site in a real Chrome window on the office\'s screen. Wait: the browser is yours again when they close it. Do other work meanwhile.');
    this.used.set(workerId, Date.now());
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
          args: process.platform === 'linux' ? ['--no-sandbox', ...LEAN_ARGS] : LEAN_ARGS,
        });
        // Light: while the agent drives, no pictures, video or fonts (the person's own control shows the page whole).
        await context.route('**/*', (route) => (this.light.has(workerId) && this.live.get(workerId)?.control !== 'person' && ['image', 'media', 'font'].includes(route.request().resourceType()) ? route.abort() : route.continue()));
        // Functions sent to the page are compiled in the office; a build step that wraps them in a __name helper must not break there.
        await context.addInitScript('window.__name = window.__name || ((f) => f);');
        await this.restoreCookies(workerId, context);
        const page = context.pages()[0] ?? (await context.newPage());
        const session: Session = { context, page, control: 'agent' };
        this.live.set(workerId, session);
        context.on('close', () => {
          if (this.live.get(workerId) === session) this.live.delete(workerId);
          this.stream.end(workerId);
        });
        // A login that is only a "session" cookie dies with Chrome, so the logins are kept and put back at the next start.
        session.saver = setInterval(() => void this.saveCookies(workerId, context), COOKIE_SAVE_MS);
        session.saver.unref();
        return session;
      })();
      this.sessions.set(workerId, opening);
      opening.catch(() => this.sessions.delete(workerId));
    }
    return opening;
  }

  async navigate(workerId: string, address: unknown, actor: 'agent' | 'person' = 'agent') {
    const url = checkedUrl(address);
    if (actor === 'agent') this.gate?.(workerId, 'open', url, url);
    const s = await this.session(workerId);
    if (s.control !== actor) throw new Error(`The browser is currently controlled by ${s.control === 'person' ? 'you' : 'the agent'}.`);
    // Answered is enough to show the page: a slow site gets a few more seconds to build it, not an error that leaves the browser blank.
    await s.page.goto(url, { waitUntil: 'commit', timeout: 30_000 });
    await s.page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
    this.note(workerId, actor, 'open', url);
    return this.view(workerId);
  }

  async view(workerId: string): Promise<BrowserView> {
    const opening = this.sessions.get(workerId);
    if (this.real.has(workerId)) return { workerId, open: false, real: true, control: 'person', mode: this.mode(workerId), light: this.light.has(workerId) };
    if (!opening) return { workerId, open: false, control: 'agent', mode: this.mode(workerId), light: this.light.has(workerId) };
    try {
      const s = await opening;
      const pending = this.pending.get(workerId);
      return { workerId, open: true, url: s.page.url(), title: await s.page.title().catch(() => ''), control: s.control, mode: this.mode(workerId), ...(pending ? { pending } : {}), ...(s.error ? { error: s.error } : {}), light: this.light.has(workerId) };
    } catch (error) {
      return { workerId, open: false, control: 'agent', mode: this.mode(workerId), error: errorMessage(error) };
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
    const el = s.page.locator(target).first();
    if (actor === 'agent') {
      const found = await el.evaluate((node: Element) => {
        const input = node as HTMLInputElement;
        const type = (node.getAttribute('type') ?? '').toLowerCase();
        const text = (node.textContent || input.value || node.getAttribute('aria-label') || node.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        const submits = (node.tagName === 'BUTTON' && (type === '' || type === 'submit') && !!node.closest('form')) || (node.tagName === 'INPUT' && (type === 'submit' || type === 'image'));
        return { text, submits };
      }, undefined, { timeout: 5000 }).catch(() => undefined);
      if (!found) throw new Error('No element matches that selector.');
      this.guard(workerId, s, { action: 'click', label: found.text || target, selector: target }, found.submits || SENSITIVE.test(found.text));
    }
    await el.click({ timeout: 8000 });
    this.note(workerId, actor, 'click', target, s.page.url());
    return this.view(workerId);
  }

  async type(workerId: string, selector: unknown, text: unknown, actor: 'agent' | 'person' = 'agent') {
    const s = await this.session(workerId);
    if (s.control !== actor) throw new Error('The browser is currently under human control.');
    const target = checkedSelector(selector);
    if (typeof text !== 'string' || text.length > 5000) throw new Error('Text must be at most 5000 characters.');
    const field = s.page.locator(target).first();
    if (actor === 'agent' && (await field.evaluate((node: Element) => (node.getAttribute('type') ?? '').toLowerCase() === 'password', undefined, { timeout: 5000 }).catch(() => false))) {
      throw new Error('Passwords are typed by the person (Take control), never by the agent.');
    }
    await field.fill(text, { timeout: 8000 });
    this.note(workerId, actor, 'type', `${target} (${text.length} characters)`, s.page.url());
    return this.view(workerId);
  }

  /** The things on the page that can be clicked or filled, each with a selector the agent can pass to click and type. */
  async snapshot(workerId: string, actor: 'agent' | 'person' = 'agent') {
    const s = await this.session(workerId);
    if (s.control !== actor) throw new Error('The browser is currently under human control.');
    const items = await s.page.evaluate(() => {
      const path = (el: Element): string => {
        if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) return `#${CSS.escape(el.id)}`;
        const parts: string[] = [];
        for (let node: Element | null = el; node && node !== document.body && parts.length < 6; node = node.parentElement) {
          const same: Element[] = node.parentElement ? [...node.parentElement.children].filter((c) => c.tagName === node!.tagName) : [];
          parts.unshift(`${node.tagName.toLowerCase()}${same.length > 1 ? `:nth-of-type(${same.indexOf(node) + 1})` : ''}`);
        }
        return parts.join(' > ');
      };
      const visible = (el: Element) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
      };
      return [...document.querySelectorAll('a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [onclick]')]
        .filter(visible)
        .slice(0, 80)
        .map((el) => {
          const input = el as HTMLInputElement;
          const type = (el.getAttribute('type') ?? '').toLowerCase();
          const label = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || (el.textContent ?? '') || input.value || el.getAttribute('name') || '').replace(/\s+/g, ' ').trim().slice(0, 80);
          return { kind: el.tagName.toLowerCase() + (type ? `[${type}]` : ''), label, selector: path(el), ...(el.tagName === 'A' ? { href: (el as HTMLAnchorElement).href.slice(0, 200) } : {}) };
        });
    });
    return { url: s.page.url(), title: await s.page.title().catch(() => ''), items };
  }

  async press(workerId: string, key: unknown, actor: 'agent' | 'person' = 'agent') {
    const s = await this.session(workerId);
    if (s.control !== actor) throw new Error('The browser is currently under human control.');
    if (typeof key !== 'string' || !['Enter', 'Tab', 'Escape', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageDown', 'PageUp', 'Home', 'End'].includes(key)) throw new Error('That key is not available.');
    if (actor === 'agent' && key === 'Enter') {
      const inForm = await s.page.evaluate(() => !!(document.activeElement as HTMLInputElement | null)?.form).catch(() => false);
      this.guard(workerId, s, { action: 'press', label: 'Enter', key }, inForm);
    }
    await s.page.keyboard.press(key);
    this.note(workerId, actor, 'press', key, s.page.url());
    return this.view(workerId);
  }

  async scroll(workerId: string, direction: unknown, actor: 'agent' | 'person' = 'agent') {
    const s = await this.session(workerId);
    if (s.control !== actor) throw new Error('The browser is currently under human control.');
    if (direction !== 'down' && direction !== 'up' && direction !== 'top' && direction !== 'bottom') throw new Error('Scroll down, up, top or bottom.');
    await s.page.evaluate((d: string) => {
      if (d === 'top') window.scrollTo(0, 0);
      else if (d === 'bottom') window.scrollTo(0, document.body.scrollHeight);
      else window.scrollBy(0, (d === 'down' ? 1 : -1) * Math.round(window.innerHeight * 0.8));
    }, direction);
    return this.view(workerId);
  }

  async wait(workerId: string, seconds: unknown, actor: 'agent' | 'person' = 'agent') {
    const s = await this.session(workerId);
    if (s.control !== actor) throw new Error('The browser is currently under human control.');
    const n = typeof seconds === 'number' && Number.isFinite(seconds) ? Math.min(15, Math.max(0.5, seconds)) : 2;
    await s.page.waitForTimeout(n * 1000);
    return this.view(workerId);
  }

  async select(workerId: string, selector: unknown, value: unknown, actor: 'agent' | 'person' = 'agent') {
    const s = await this.session(workerId);
    if (s.control !== actor) throw new Error('The browser is currently under human control.');
    if (typeof value !== 'string' || value.length > 200) throw new Error('Give the option to pick, up to 200 characters.');
    const target = checkedSelector(selector);
    const el = s.page.locator(target).first();
    await el.selectOption({ label: value }, { timeout: 8000 }).catch(() => el.selectOption(value, { timeout: 8000 }));
    this.note(workerId, actor, 'select', target, s.page.url());
    return this.view(workerId);
  }

  async control(workerId: string, value: 'agent' | 'person') {
    const s = await this.session(workerId);
    s.control = value;
    this.note(workerId, 'person', value === 'person' ? 'took-control' : 'released-control', '', s.page.url());
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

  /** What the person does on the live picture, one event at a time and without waiting for the page to answer. */
  async rawInput(workerId: string, ev: RawInput): Promise<void> {
    const s = await this.session(workerId);
    if (s.control !== 'person') throw new Error('Take control of the browser before interacting with the page.');
    const { page } = s;
    const x = bounded(ev.x, 0, 1280);
    const y = bounded(ev.y, 0, 800);
    const button = ev.button === 'right' || ev.button === 'middle' ? ev.button : 'left';
    if (ev.t === 'move') await page.mouse.move(x, y);
    else if (ev.t === 'down') {
      await page.mouse.move(x, y);
      await page.mouse.down({ button });
    } else if (ev.t === 'up') {
      await page.mouse.move(x, y);
      await page.mouse.up({ button });
    } else if (ev.t === 'wheel') await page.mouse.wheel(delta(ev.dx), delta(ev.dy));
    else if (ev.t === 'text') await page.keyboard.insertText(typeof ev.text === 'string' ? ev.text.slice(0, 1000) : '');
    else if (ev.t === 'key') {
      if (!ev.key || !KEYS.includes(ev.key)) throw new Error('That key is not available.');
      await page.keyboard.press(ev.key);
    } else throw new Error('Unknown input.');
  }

  /** The agent's browser is closed and the same profile opened in a real Chrome window, for the person to log in by hand. */
  async openReal(workerId: string, address?: unknown) {
    if (this.real.has(workerId)) throw new Error('The real window is already open.');
    if (!hasScreen()) throw new Error('This machine has no screen to show a window on: a real window can only be opened on the computer the office runs on.');
    const executable = chromePath() ?? chromium.executablePath();
    if (!executable || !existsSync(executable)) throw new Error('No Chrome was found to open.');
    const current = this.live.get(workerId)?.page.url();
    const url = typeof address === 'string' && address.trim() ? checkedUrl(address) : current && /^https?:/.test(current) ? current : 'https://www.google.com';
    await this.close(workerId, false);
    const win = await openRealWindow({
      executable,
      profile: this.profile(workerId),
      url,
      onCookies: (cookies) => {
        try {
          this.storeCookies(workerId, cookies);
        } catch {
          // The last write stands.
        }
      },
      onClosed: () => {
        this.real.delete(workerId);
        this.note(workerId, 'person', 'real-window-closed');
      },
    });
    this.real.set(workerId, win);
    this.note(workerId, 'person', 'real-window-opened', url);
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
    this.live.delete(workerId);
    this.stream.end(workerId);
    if (opening) {
      await opening
        .then(async (s) => {
          clearInterval(s.saver);
          if (!removeProfile) await this.saveCookies(workerId, s.context);
          await s.context.close();
        })
        .catch(() => {});
    }
    if (removeProfile) {
      rmSync(this.profile(workerId), { recursive: true, force: true });
      rmSync(this.cookieFile(workerId), { force: true });
    }
  }

  /** Close Chrome before the office exits so a restarted office can safely reopen these profiles. */
  async shutdown() {
    this.closing = true;
    for (const win of this.real.values()) win.stop();
    const sessions = [...this.sessions.entries()];
    this.sessions.clear();
    await Promise.allSettled(sessions.map(async ([workerId, opening]) => {
      const session = await opening.catch(() => undefined);
      if (!session) return;
      clearInterval(session.saver);
      await this.saveCookies(workerId, session.context);
      await session.context.close();
    }));
  }
}

function checkedUrl(input: unknown): string {
  if (typeof input !== 'string' || input.length > 2048) throw new Error('Give an http:// or https:// address (up to 2048 characters).');
  // "karlancer.com" with no scheme is meant as https.
  const address = /^[a-z][a-z0-9+.-]*:/i.test(input.trim()) ? input.trim() : `https://${input.trim()}`;
  let url: URL;
  try { url = new URL(address); } catch { throw new Error('That is not a valid web address.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http:// and https:// addresses are allowed.');
  if (url.username || url.password) throw new Error('Addresses with embedded passwords are not allowed.');
  return url.href;
}

function checkedSelector(input: unknown): string {
  if (typeof input !== 'string' || !input.trim() || input.length > 500) throw new Error('Give a CSS selector up to 500 characters.');
  return input;
}

/** A scroll amount from the person: a number within reason, else none. */
function delta(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(2000, Math.max(-2000, value)) : 0;
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
