import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BrowserFiles } from '../src/server/browser-files.js';
import { covers, hostsFromLog, keepLogin, loadLogins, readLogin } from '../src/server/browser-login.js';

test('a cookie domain covers its host and subdomains only', () => {
  assert.ok(covers('.example.com', 'admin.example.com'));
  assert.ok(covers('example.com', 'example.com'));
  assert.ok(!covers('example.com', 'badexample.com'));
  assert.ok(!covers('admin.example.com', 'example.com'));
});

test('readLogin keeps only the chosen site', async () => {
  const context = {
    storageState: async () => ({
      cookies: [
        { name: 'a', value: '1', domain: '.site.com' },
        { name: 'b', value: '2', domain: 'other.com' },
      ],
      origins: [
        { origin: 'https://site.com', localStorage: [{ name: 't', value: 'x' }] },
        { origin: 'https://other.com', localStorage: [{ name: 'u', value: 'y' }] },
      ],
    }),
  };
  const login = await readLogin(context as never, 'site.com');
  assert.deepEqual(login.cookies.map((c) => c.name), ['a']);
  assert.deepEqual(login.origins.map((o) => o.origin), ['https://site.com']);
});

test('logins are kept per host and read back', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'login-'));
  try {
    const file = path.join(dir, 'x.logins.json');
    assert.deepEqual(loadLogins(file), []);
    keepLogin(file, { host: 'a.com', cookies: [], origins: [] });
    keepLogin(file, { host: 'b.com', cookies: [], origins: [] });
    keepLogin(file, { host: 'a.com', cookies: [], origins: [{ origin: 'https://a.com', items: [] }] });
    const all = loadLogins(file);
    assert.equal(all.length, 2);
    assert.equal(all.find((l) => l.host === 'a.com')?.origins.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hostsFromLog lists visited sites, most visited first', () => {
  const lines = [
    JSON.stringify({ action: 'open', detail: 'https://a.com/x' }),
    JSON.stringify({ action: 'click', url: 'https://b.com/' }),
    JSON.stringify({ action: 'click', url: 'https://b.com/y' }),
    'not json',
  ];
  assert.deepEqual(hostsFromLog(lines), ['b.com', 'a.com']);
});

test('BrowserFiles remembers the last page, what was open, and the activity', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'files-'));
  try {
    const files = new BrowserFiles(dir);
    assert.equal(files.last('w'), undefined);
    files.remember('w', 'about:blank');
    assert.equal(files.last('w'), undefined);
    files.remember('w', 'https://a.com/p');
    assert.equal(files.last('w')?.url, 'https://a.com/p');
    files.markOpen('w', true);
    files.markOpen('v', true);
    files.markOpen('w', false);
    assert.deepEqual(files.wasOpen(), ['v']);
    files.note('w', 'agent', 'open', 'https://a.com');
    files.note('w', 'person', 'click', 'b');
    assert.deepEqual(files.activity('w', 10).map((a) => a.action), ['open', 'click']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
