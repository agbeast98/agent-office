import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Notifier } from '../src/server/notify.js';

test('with no file it says nothing, and once the person fills it in it sends to Telegram, not twice in a row', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'notify-'));
  const calls: { url: string; body: string }[] = [];
  const n = new Notifier(dir, async (url, init) => { calls.push({ url, body: init.body }); return { ok: true }; });
  try {
    assert.equal(n.configured, false);
    assert.equal(await n.send('سلام'), false);
    assert.equal(calls.length, 0);

    writeFileSync(path.join(dir, 'notify.json'), JSON.stringify({ telegramToken: '1:abc', chatId: 42 }));
    assert.equal(n.configured, true);
    assert.equal(await n.send('  منتظر   تأیید  '), true);
    assert.equal(calls[0].url, 'https://api.telegram.org/bot1:abc/sendMessage');
    assert.deepEqual(JSON.parse(calls[0].body), { chat_id: '42', text: 'منتظر تأیید' });
    assert.equal(await n.send('منتظر تأیید'), false, 'the same words within minutes are not sent again');
    assert.equal(await n.send('   '), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a broken file or a failing network is never a reason to stop', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'notify-'));
  const n = new Notifier(dir, async () => { throw new Error('offline'); });
  try {
    writeFileSync(path.join(dir, 'notify.json'), '{ nope');
    assert.equal(n.configured, false);
    writeFileSync(path.join(dir, 'notify.json'), JSON.stringify({ telegramToken: 't', chatId: 'c' }));
    assert.equal(await n.send('x'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
