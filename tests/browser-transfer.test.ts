import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { downloaded, uploadable } from '../src/server/browser-transfer.js';

test('only files of the project, Codex pictures and downloads can be uploaded', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'xfer-'));
  try {
    const floor = path.join(root, 'floor');
    const home = path.join(root, 'home');
    const env = { HOME: home, USERPROFILE: home } as NodeJS.ProcessEnv;
    mkdirSync(path.join(floor, '.agent-office', 'worker-browsers'), { recursive: true });
    mkdirSync(path.join(floor, '.agent-office', 'downloads', 'w'), { recursive: true });
    mkdirSync(path.join(home, '.codex', 'generated_images', 'a'), { recursive: true });
    mkdirSync(path.join(root, 'elsewhere'), { recursive: true });
    const mine = path.join(floor, 'pic.webp');
    const cookies = path.join(floor, '.agent-office', 'worker-browsers', 'x.cookies.json');
    const download = path.join(floor, '.agent-office', 'downloads', 'w', '1-pic.webp');
    const made = path.join(home, '.codex', 'generated_images', 'a', 'x.png');
    const outside = path.join(root, 'elsewhere', 'secret.txt');
    for (const f of [mine, cookies, download, made, outside]) writeFileSync(f, 'x');

    assert.equal(uploadable(floor, mine, env), path.resolve(mine));
    assert.equal(uploadable(floor, 'pic.webp', env), path.resolve(mine));
    assert.equal(uploadable(floor, made, env), path.resolve(made));
    assert.equal(uploadable(floor, download, env), path.resolve(download));
    assert.throws(() => uploadable(floor, cookies, env), /outside/);
    assert.throws(() => uploadable(floor, outside, env), /outside/);
    assert.throws(() => uploadable(floor, '../elsewhere/secret.txt', env), /outside/);
    assert.throws(() => uploadable(floor, path.join(floor, 'missing.png'), env), /no such file/);
    assert.throws(() => uploadable(floor, '', env), /full path/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('downloaded lists what a browser saved, newest first', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dl-'));
  try {
    assert.deepEqual(downloaded(path.join(dir, 'none')), []);
    writeFileSync(path.join(dir, '1-a.png'), 'x');
    writeFileSync(path.join(dir, '2-b.png'), 'xy');
    assert.deepEqual(downloaded(dir).map((f) => [path.basename(f.path), f.bytes]), [['2-b.png', 2], ['1-a.png', 1]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
