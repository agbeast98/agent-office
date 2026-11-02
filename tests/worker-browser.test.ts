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
<button id="plain" type="button" onclick="document.title='clicked'">نمایش</button>`;

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
    rmSync(dir, { recursive: true, force: true });
  }
});
