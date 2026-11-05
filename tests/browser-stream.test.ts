import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BrowserStream, type CdpLike, type StreamPage } from '../src/server/browser-stream.js';
import { hasScreen } from '../src/server/browser-window.js';

class FakeRes extends EventEmitter {
  head?: { status: number; headers: Record<string, string> };
  chunks: Buffer[] = [];
  writableEnded = false;
  destroyed = false;
  writableNeedDrain = false;
  writeHead(status: number, headers: Record<string, string>) {
    this.head = { status, headers };
  }
  write(chunk: Buffer | string) {
    this.chunks.push(Buffer.from(chunk));
    return true;
  }
  end(chunk?: string) {
    if (chunk) this.chunks.push(Buffer.from(chunk));
    this.writableEnded = true;
  }
  text() {
    return Buffer.concat(this.chunks).toString('latin1');
  }
  frames() {
    return (this.text().match(/Content-Type: image\/jpeg/g) ?? []).length;
  }
}

function fakePage() {
  const sent: { method: string; params?: Record<string, unknown> }[] = [];
  const handlers = new Map<string, (p: any) => void>();
  let detached = false;
  const cdp: CdpLike = {
    send: async (method, params) => void sent.push({ method, params }),
    on: (event, handler) => void handlers.set(event, handler),
    detach: async () => void (detached = true),
  };
  let shots = 0;
  const page: StreamPage = {
    screenshot: async () => Buffer.from(`shot${++shots}`),
    context: () => ({ newCDPSession: async () => cdp }),
  };
  const frame = (text: string, sessionId = 1) => handlers.get('Page.screencastFrame')?.({ data: Buffer.from(text).toString('base64'), sessionId });
  return { page, sent, frame, detached: () => detached, shots: () => shots };
}

const tick = () => new Promise((r) => setImmediate(r));

test('a browser that is not open answers 404, and an open one starts with a picture', async () => {
  const none = new BrowserStream(async () => undefined);
  const r = new FakeRes();
  await none.attach('w', r as never);
  assert.equal(r.head?.status, 404);
  const f = fakePage();
  const stream = new BrowserStream(async () => f.page);
  const a = new FakeRes();
  await stream.attach('w', a as never);
  assert.equal(a.head?.status, 200);
  assert.match(a.head?.headers['content-type'] ?? '', /^multipart\/x-mixed-replace; boundary=/);
  assert.equal(a.frames(), 1, 'a first picture at once');
  assert.ok(a.text().includes('shot1'));
  assert.deepEqual(f.sent.map((s) => s.method), ['Page.startScreencast']);
  assert.equal(stream.viewers('w'), 1);
});

test('frames go to every viewer and are acknowledged; a slow viewer misses frames instead of stopping the rest', async () => {
  const f = fakePage();
  const stream = new BrowserStream(async () => f.page);
  const a = new FakeRes();
  const b = new FakeRes();
  await stream.attach('w', a as never);
  await stream.attach('w', b as never);
  assert.equal(f.sent.filter((s) => s.method === 'Page.startScreencast').length, 1, 'one screencast for two viewers');
  f.frame('one', 11);
  b.writableNeedDrain = true;
  f.frame('two', 12);
  await tick();
  assert.ok(a.text().includes('one') && a.text().includes('two'));
  assert.ok(b.text().includes('one') && !b.text().includes('two'), 'the slow one skipped the second');
  assert.deepEqual(f.sent.filter((s) => s.method === 'Page.screencastFrameAck').map((s) => s.params?.sessionId), [11, 12]);
});

test('the screencast stops when the last viewer goes, and starts again for the next', async () => {
  const f = fakePage();
  const stream = new BrowserStream(async () => f.page);
  const a = new FakeRes();
  const b = new FakeRes();
  await stream.attach('w', a as never);
  await stream.attach('w', b as never);
  a.emit('close');
  await tick();
  assert.equal(f.sent.some((s) => s.method === 'Page.stopScreencast'), false, 'one viewer is still looking');
  b.emit('close');
  await tick();
  await tick();
  assert.ok(f.sent.some((s) => s.method === 'Page.stopScreencast'));
  assert.ok(f.detached());
  assert.equal(stream.viewers('w'), 0);
  const c = new FakeRes();
  await stream.attach('w', c as never);
  assert.equal(f.sent.filter((s) => s.method === 'Page.startScreencast').length, 2);
});

test('when the browser goes away every stream is ended', async () => {
  const f = fakePage();
  const stream = new BrowserStream(async () => f.page);
  const a = new FakeRes();
  await stream.attach('w', a as never);
  stream.end('w');
  assert.equal(a.writableEnded, true);
  assert.equal(stream.viewers('w'), 0);
});

test('a real window needs a screen to show it on', () => {
  assert.equal(hasScreen('win32', {}), true);
  assert.equal(hasScreen('darwin', {}), true);
  assert.equal(hasScreen('linux', {}), false);
  assert.equal(hasScreen('linux', { DISPLAY: ':0' }), true);
  assert.equal(hasScreen('linux', { WAYLAND_DISPLAY: 'wayland-0' }), true);
});
