import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BrowserFiles } from '../src/server/browser-files.js';
import { applyLogin, covers, hostsFromLog, keepLogin, loadLogins, readLogin } from '../src/server/browser-login.js';

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

test('a copied token replaces an older one once, and a refreshed one is left alone after that', async () => {
  let script: ((a: unknown) => void) | undefined;
  const context = { addCookies: async () => {}, addInitScript: async (fn: (a: unknown) => void) => { script = fn; }, pages: () => [] };
  const store = new Map<string, string>([['token', 'old']]);
  (globalThis as Record<string, unknown>).location = { origin: 'https://a.com' };
  (globalThis as Record<string, unknown>).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  try {
    await applyLogin(context as never, { host: 'a.com', at: 5, cookies: [], origins: [{ origin: 'https://a.com', items: [{ name: 'token', value: 'new' }] }] });
    const arg = { origin: 'https://a.com', items: [{ name: 'token', value: 'new' }], at: '5' };
    script!(arg);
    assert.equal(store.get('token'), 'new');
    store.set('token', 'refreshed by the site');
    script!(arg);
    assert.equal(store.get('token'), 'refreshed by the site');
    script!({ ...arg, at: '6', items: [{ name: 'token', value: 'newer' }] });
    assert.equal(store.get('token'), 'newer');
  } finally {
    delete (globalThis as Record<string, unknown>).location;
    delete (globalThis as Record<string, unknown>).localStorage;
  }
});
