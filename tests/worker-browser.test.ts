import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkerBrowsers } from '../src/server/worker-browser.js';

const PAGE = `<!doctype html><meta charset="utf-8"><title>تست</title>
<a id="more" href="/more">بیشتر</a>
<form method="post" action="/sent">
  <input id="name" name="name" placeholder="نام">
  <input id="pass" name="pass" type="password">
  <select id="kind" name="kind"><option>سایت</option><option>سئو</option></select>
  <button id="go" type="submit">ارسال پیشنهاد</button>
</form>
<button id="plain" type="button" onclick="document.title='clicked'">نمایش</button>
<button id="pay" type="button">پرداخت نهایی</button>`;

const chrome = () => [process.env.AGENT_OFFICE_CHROME, 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].some((p) => p && existsSync(p));

test('the worker browser asks before it sends, reads the page, and never types a password', { skip: !chrome() && 'no Chrome here', timeout: 120_000 }, async () => {
  const sent: string[] = [];
  const server = createServer((req, res) => {
    if (req.url === '/sent') {
      sent.push(req.method ?? '');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<title>sent</title>done');
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const dir = mkdtempSync(path.join(tmpdir(), 'wb-test-'));
  const browsers = new WorkerBrowsers(dir);
  const id = 'w1';
  try {
    await browsers.navigate(id, base);

    // It lists what is on the page, with selectors to use.
    const snap = await browsers.snapshot(id);
    assert.ok(snap.items.some((i) => i.label === 'ارسال پیشنهاد' && i.selector === '#go'));
    assert.ok(snap.items.some((i) => i.kind === 'input[password]'));

    // A plain button goes through without asking.
    await browsers.click(id, '#plain');
    assert.equal((await browsers.view(id)).title, 'clicked');

    // Typing is logged by length only; a password is never typed by the agent.
    await browsers.type(id, '#name', 'متن خصوصی');
    await assert.rejects(browsers.type(id, '#pass', 'secret'), /Passwords are typed by the person/);
    await browsers.select(id, '#kind', 'سئو');

    // Sending asks first: the click is held, and the page was not sent.
    assert.equal((await browsers.view(id)).mode, 'ask');
    await assert.rejects(browsers.click(id, '#go'), /needs the person's approval/);
    let view = await browsers.view(id);
    assert.equal(view.pending?.label, 'ارسال پیشنهاد');
    assert.deepEqual(sent, []);

    // Turned down: the agent is told not to try again, and nothing is sent.
    await browsers.approve(id, 'deny');
    assert.equal((await browsers.view(id)).pending, undefined);
    await assert.rejects(browsers.click(id, '#go'), /said no/);
    assert.deepEqual(sent, []);

    // Asked again, approved: the same click goes through, once.
    await assert.rejects(browsers.click(id, '#go'), /needs the person's approval/);
    await browsers.approve(id, 'allow');
    await browsers.click(id, '#go');
    await browsers.view(id);
    assert.deepEqual(sent, ['POST']);

    // Enter inside a form is a send too.
    await browsers.navigate(id, base);
    await browsers.click(id, '#name');
    await assert.rejects(browsers.press(id, 'Enter'), /needs the person's approval/);

    // Hands-off mode lets it through, and the choice is kept for the next start.
    view = await browsers.setMode(id, 'auto');
    assert.equal(view.mode, 'auto');
    assert.equal(new WorkerBrowsers(dir).mode(id), 'auto');
    await browsers.click(id, '#go');
    assert.equal(sent.length, 2);

    // Paying and deleting ask the person even in hands-off mode, and the office is told.
    const told: string[] = [];
    browsers.onPending = (w, r) => told.push(`${w}:${r.label}`);
    await browsers.navigate(id, base);
    await assert.rejects(browsers.click(id, '#pay'), /needs the person's approval/);
    assert.equal((await browsers.view(id)).pending?.risky, true);
    assert.deepEqual(told, ['w1:پرداخت نهایی']);
    assert.deepEqual(browsers.waiting().map((a) => a.workerId), ['w1']);
    await browsers.approve(id, 'deny');
    assert.deepEqual(browsers.waiting(), []);

    // While the person has the browser, the agent can't touch it.
    await browsers.control(id, 'person');
    await assert.rejects(browsers.snapshot(id), /human control/);

    // The log says what happened, and holds none of what was typed.
    const log = browsers.history(id).join('\n');
    assert.match(log, /waiting-for-approval/);
    assert.match(log, /"approved"|approved/);
    assert.match(log, /refused/);
    assert.ok(!log.includes('متن خصوصی') && !log.includes('secret'));
  } finally {
    await browsers.shutdown();
    server.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('a login that is only a session cookie survives the browser closing, and goes with the worker', { skip: !chrome() && 'no Chrome here', timeout: 120_000 }, async () => {
  const seen: (string | undefined)[] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers.cookie);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'sid=logged-in; Path=/; HttpOnly' });
    res.end('<title>ok</title>ok');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const dir = mkdtempSync(path.join(tmpdir(), 'wb-cookie-'));
  const all: WorkerBrowsers[] = [];
  const make = () => { const b = new WorkerBrowsers(dir); all.push(b); return b; };
  try {
    const first = make();
    await first.navigate('w2', base);
    await first.shutdown();

    const second = make();
    const before = seen.length;
    await second.navigate('w2', base);
    // The page's own request, not the favicon Chrome asks for after it.
    assert.match(seen[before] ?? '', /sid=logged-in/);

    // Sent home with its profile: the next start is logged out again.
    await second.close('w2');
    const third = make();
    const again = seen.length;
    await third.navigate('w2', base);
    assert.ok(!(seen[again] ?? '').includes('sid='));
    await third.shutdown();
  } finally {
    server.close();
    await Promise.allSettled(all.map((b) => b.shutdown()));
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* Chrome may still be letting go of the folder */ }
  }
});

test('the firewall is asked before an agent opens a page, and what it throws is what the agent is told', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'wb-gate-'));
  const browsers = new WorkerBrowsers(dir);
  const asked: string[] = [];
  browsers.gate = (worker, kind, address) => {
    asked.push(`${worker}:${kind}:${address}`);
    throw new Error('نگه داشته شد (H-1)');
  };
  try {
    await assert.rejects(browsers.navigate('w9', 'https://example.org/a'), /نگه داشته شد/);
    assert.deepEqual(asked, ['w9:open:https://example.org/a']);
    assert.equal((await browsers.view('w9')).open, false, 'no browser was started for it');
  } finally {
    await browsers.shutdown();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
