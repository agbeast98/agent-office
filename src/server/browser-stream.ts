// A live picture of a worker's browser, pushed as it changes: Chrome's own screencast (CDP Page.startScreencast)
// is sent to every viewer as a multipart/x-mixed-replace stream, which a plain <img> shows with no script, at
// ten frames a second or more instead of one screenshot every second. The screencast runs only while someone is
// looking and stops when the last viewer goes. A viewer that can't keep up misses frames instead of slowing the rest.
import type { ServerResponse } from 'node:http';
import type { Page } from 'playwright-core';

const BOUNDARY = 'officeframe';
const KEEPALIVE_MS = 10_000;
const QUALITY = 60;
/** Chrome draws 60 times a second; every second frame is plenty to follow a page and half the bytes. */
const EVERY_NTH = 2;
const WIDTH = 1280;
const HEIGHT = 800;

interface Feed {
  viewers: Set<ServerResponse>;
  last?: Buffer;
  stop?: () => Promise<void>;
  keepalive?: NodeJS.Timeout;
  starting?: boolean;
}

/** The minimum of a Playwright page the stream needs: a screenshot, and a CDP session to ask for frames. */
export interface StreamPage {
  screenshot(options: { type: 'jpeg'; quality: number; timeout: number }): Promise<Buffer>;
  context(): { newCDPSession(page: Page): Promise<CdpLike> };
}
export interface CdpLike {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, handler: (params: any) => void): unknown;
  detach(): Promise<void>;
}

function part(frame: Buffer): Buffer[] {
  return [Buffer.from(`--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`), frame, Buffer.from('\r\n')];
}

export class BrowserStream {
  private feeds = new Map<string, Feed>();

  /** `pageOf`: the worker's page if its browser is open (never opens one). */
  constructor(private pageOf: (workerId: string) => Promise<StreamPage | undefined>) {}

  viewers(workerId: string): number {
    return this.feeds.get(workerId)?.viewers.size ?? 0;
  }

  /** Answers the request with the stream; it ends when the viewer goes or the browser closes. */
  async attach(workerId: string, res: ServerResponse): Promise<void> {
    const page = await this.pageOf(workerId);
    if (!page) {
      res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: 'The browser is not open.' }));
      return;
    }
    res.writeHead(200, {
      'content-type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      'cache-control': 'no-store, no-transform',
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'same-origin',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    let feed = this.feeds.get(workerId);
    if (!feed) {
      feed = { viewers: new Set() };
      this.feeds.set(workerId, feed);
    }
    feed.viewers.add(res);
    const leave = () => void this.leave(workerId, res);
    res.on('close', leave);
    res.on('error', leave);
    // Something to look at at once; the screencast sends only when the page changes.
    try {
      const first = feed.last ?? (await page.screenshot({ type: 'jpeg', quality: QUALITY, timeout: 10_000 }));
      feed.last = first;
      this.write(res, first);
    } catch {
      // The first screencast frame will do.
    }
    if (!feed.stop && !feed.starting) await this.start(workerId, feed, page);
  }

  private async start(workerId: string, feed: Feed, page: StreamPage) {
    feed.starting = true;
    try {
      const cdp = await page.context().newCDPSession(page as unknown as Page);
      cdp.on('Page.screencastFrame', (frame: { data: string; sessionId: number }) => {
        const buffer = Buffer.from(frame.data, 'base64');
        feed.last = buffer;
        for (const res of feed.viewers) this.write(res, buffer);
        void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
      });
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: QUALITY, maxWidth: WIDTH, maxHeight: HEIGHT, everyNthFrame: EVERY_NTH });
      feed.stop = async () => {
        await cdp.send('Page.stopScreencast').catch(() => {});
        await cdp.detach().catch(() => {});
      };
      // A page that doesn't change sends nothing; proxies and the browser still want to hear something now and then.
      feed.keepalive = setInterval(() => {
        if (feed.last) for (const res of feed.viewers) this.write(res, feed.last);
      }, KEEPALIVE_MS);
      feed.keepalive.unref();
      if (!feed.viewers.size) await this.close(workerId);
    } catch {
      this.end(workerId);
    } finally {
      feed.starting = false;
    }
  }

  /** One frame to one viewer, unless it is still swallowing the last: it misses this one. */
  private write(res: ServerResponse, frame: Buffer) {
    if (res.writableEnded || res.destroyed || res.writableNeedDrain) return;
    for (const chunk of part(frame)) res.write(chunk);
  }

  private async leave(workerId: string, res: ServerResponse) {
    const feed = this.feeds.get(workerId);
    if (!feed) return;
    feed.viewers.delete(res);
    if (!feed.viewers.size) await this.close(workerId);
  }

  /** No one is looking: the screencast stops. */
  private async close(workerId: string) {
    const feed = this.feeds.get(workerId);
    if (!feed || feed.viewers.size) return;
    this.feeds.delete(workerId);
    clearInterval(feed.keepalive);
    await feed.stop?.();
  }

  /** The browser closed or went away: every viewer's stream ends. */
  end(workerId: string) {
    const feed = this.feeds.get(workerId);
    if (!feed) return;
    this.feeds.delete(workerId);
    clearInterval(feed.keepalive);
    for (const res of feed.viewers) res.end();
    void feed.stop?.();
  }
}
