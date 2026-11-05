// Giving one agent's browser the login of another's, when the person says so (the 🌐 tab, "🔗 ورود از ایجنت دیگر").
// A site's login lives in cookies, and often in the page's localStorage (a token); both are copied for the one site
// chosen, nothing else. The login is written next to the receiver's profile and put back every time its browser opens,
// so it is there after a restart too. It is an account of the person's own, shared between their own agents, and the
// copy is noted in the receiver's browser log.
import { readFileSync, writeFileSync } from 'node:fs';
import type { BrowserContext } from 'playwright-core';

type Cookie = Awaited<ReturnType<BrowserContext['cookies']>>[number];
export interface LoginState {
  host: string;
  cookies: Cookie[];
  origins: { origin: string; items: { name: string; value: string }[] }[];
}

/** Whether a cookie's domain (".example.com") covers a host ("admin.example.com"). */
export const covers = (domain: string, host: string) => {
  const d = domain.replace(/^\./, '').toLowerCase();
  const h = host.toLowerCase();
  return h === d || h.endsWith(`.${d}`);
};

/** The login of one site as this browser has it: its cookies and the localStorage of its pages. */
export async function readLogin(context: BrowserContext, host: string): Promise<LoginState> {
  const state = await context.storageState();
  return {
    host,
    cookies: state.cookies.filter((c) => covers(c.domain, host)),
    origins: state.origins
      .filter((o) => {
        try {
          return new URL(o.origin).hostname.toLowerCase() === host.toLowerCase();
        } catch {
          return false;
        }
      })
      .map((o) => ({ origin: o.origin, items: o.localStorage.map((i) => ({ name: i.name, value: i.value })) })),
  };
}

/** Puts a login into a browser: the cookies now, and the localStorage whenever a page of that site loads (never over what the page has set). */
export async function applyLogin(context: BrowserContext, login: LoginState): Promise<void> {
  if (login.cookies.length) await context.addCookies(login.cookies);
  for (const { origin, items } of login.origins) {
    const put = ({ origin: o, items: kv }: { origin: string; items: { name: string; value: string }[] }) => {
      if (location.origin !== o) return;
      for (const { name, value } of kv) if (localStorage.getItem(name) === null) localStorage.setItem(name, value);
    };
    await context.addInitScript(put, { origin, items });
    // A page of that site that is already open gets it too.
    for (const page of context.pages()) {
      if (page.url().startsWith(origin)) await page.evaluate(put, { origin, items }).catch(() => {});
    }
  }
}

/** The logins kept for a profile, written next to it. */
export function loadLogins(file: string): LoginState[] {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(raw) ? (raw as LoginState[]).filter((l) => l && typeof l.host === 'string' && Array.isArray(l.cookies) && Array.isArray(l.origins)) : [];
  } catch {
    return [];
  }
}

export function keepLogin(file: string, login: LoginState): void {
  const others = loadLogins(file).filter((l) => l.host !== login.host);
  writeFileSync(file, JSON.stringify([...others, login]), { mode: 0o600 });
}

/** The sites an agent has been to, from its browser log: where its login could be taken from. */
export function hostsFromLog(lines: string[]): string[] {
  const count = new Map<string, number>();
  for (const line of lines) {
    try {
      const row = JSON.parse(line) as { action?: string; detail?: string; url?: string };
      const address = row.action === 'open' ? row.detail : row.url;
      if (address && /^https?:/i.test(address)) {
        const host = new URL(address).hostname;
        count.set(host, (count.get(host) ?? 0) + 1);
      }
    } catch {
      // A line that isn't one of ours.
    }
  }
  return [...count].sort((a, b) => b[1] - a[1]).map(([host]) => host);
}

