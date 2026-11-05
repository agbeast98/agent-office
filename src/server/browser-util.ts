import { existsSync } from 'node:fs';
import type { Page } from 'playwright-core';
import path from 'node:path';

// Small helpers of the worker browser: checking what an agent passes in, and finding Chrome.

export function checkedUrl(input: unknown): string {
  if (typeof input !== 'string' || input.length > 2048) throw new Error('Give an http:// or https:// address (up to 2048 characters).');
  // "karlancer.com" with no scheme is meant as https.
  const address = /^[a-z][a-z0-9+.-]*:/i.test(input.trim()) ? input.trim() : `https://${input.trim()}`;
  let url: URL;
  try { url = new URL(address); } catch { throw new Error('That is not a valid web address.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http:// and https:// addresses are allowed.');
  if (url.username || url.password) throw new Error('Addresses with embedded passwords are not allowed.');
  return url.href;
}

export function checkedSelector(input: unknown): string {
  if (typeof input !== 'string' || !input.trim() || input.length > 500) throw new Error('Give a CSS selector up to 500 characters.');
  return input;
}

/** A scroll amount from the person: a number within reason, else none. */
export function delta(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(2000, Math.max(-2000, value)) : 0;
}

export function bounded(value: unknown, min: number, max: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function errorMessage(error: unknown) { return error instanceof Error ? error.message.slice(0, 300) : 'Could not start the browser.'; }

export function chromePath(): string | undefined {
  const env = process.env.AGENT_OFFICE_CHROME;
  const candidates = env ? [env] : process.platform === 'win32'
    ? [path.join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'), path.join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe'), path.join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe')]
    : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'] : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find((candidate) => candidate && existsSync(candidate));
}

/** The things on the page that can be clicked or filled, each with a selector the agent can pass to click and type. */
export async function snapshotPage(page: Page) {
    const items = await page.evaluate(() => {
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
  return { url: page.url(), title: await page.title().catch(() => ''), items };
}
