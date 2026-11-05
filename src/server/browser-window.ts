// A real Chrome window for the person to log in to a site that won't let a hidden, automated browser through (a
// captcha, a challenge): the agent's browser is closed, the same profile is opened in an ordinary Chrome on the
// screen of the machine the office runs on, and the person does it all with their own mouse. While the window is
// open its cookies are read now and then (over Chrome's debugging port, on this machine only) and written down, so
// a login that is only a "session" cookie is not lost when the window closes; then the agent's browser opens on the
// same profile again. Nothing here solves or skips a challenge: a person does.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from 'playwright-core';

const COOKIE_EVERY_MS = 5_000;

export interface RealWindow {
  /** Closes the window (and ends the watching). */
  stop(): void;
  readonly child: ChildProcess;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/** Whether a window can be shown on this machine at all (a server with no screen can't). */
export function hasScreen(platform = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
  return platform === 'win32' || platform === 'darwin' || !!(env.DISPLAY || env.WAYLAND_DISPLAY);
}

export async function openRealWindow(opts: {
  executable: string;
  profile: string;
  url: string;
  /** All the cookies of the window, whenever they are read. */
  onCookies: (cookies: Awaited<ReturnType<import('playwright-core').BrowserContext['cookies']>>) => void;
  /** The window was closed. */
  onClosed: () => void;
}): Promise<RealWindow> {
  const port = await freePort();
  const child = spawn(opts.executable, [`--user-data-dir=${opts.profile}`, `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check', opts.url], { detached: true, stdio: 'ignore' });
  child.unref();
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  const finish = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    void browser?.close().catch(() => {});
    opts.onClosed();
  };
  child.once('exit', finish);
  child.once('error', finish);
  // Connect once Chrome listens, and read the cookies as long as it is open.
  void (async () => {
    for (let i = 0; i < 20 && !stopped; i++) {
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 4_000 });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (!browser || stopped) return;
    const read = async () => {
      try {
        const context = browser?.contexts()[0];
        if (context) opts.onCookies(await context.cookies());
      } catch {
        // The window may be closing: the last read stands.
      }
    };
    timer = setInterval(() => void read(), COOKIE_EVERY_MS);
    timer.unref();
    browser.on('disconnected', () => void 0);
  })();
  return {
    child,
    stop() {
      if (!stopped) child.kill();
      finish();
    },
  };
}
