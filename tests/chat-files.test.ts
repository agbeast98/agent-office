import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chatImage } from '../src/server/http/routes/chat-files.js';

const slashes = (p: string) => p.split(path.sep).join('/');

test("only an image inside the floor or Codex's generated_images is ever served", () => {
  const root = mkdtempSync(path.join(tmpdir(), 'chatfiles-'));
  const floor = path.join(root, 'floor');
  const codex = path.join(root, 'codex');
  const outside = path.join(root, 'outside');
  mkdirSync(path.join(floor, 'freelance-team', 'deliveries'), { recursive: true });
  mkdirSync(path.join(codex, 'generated_images', 's1'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  const png = Buffer.from('iVBORw0KGgo=', 'base64');
  const mine = path.join(floor, 'freelance-team', 'deliveries', 'a.png');
  const made = path.join(codex, 'generated_images', 's1', 'b.png');
  const secret = path.join(outside, 'secret.png');
  writeFileSync(mine, png);
  writeFileSync(made, png);
  writeFileSync(secret, png);
  writeFileSync(path.join(floor, 'notes.txt'), 'x');
  const env = { CODEX_HOME: codex } as NodeJS.ProcessEnv;
  const same = (a?: string, b?: string) => assert.equal(a?.toLowerCase(), b?.toLowerCase());

  same(chatImage(floor, 'freelance-team/deliveries/a.png', env), mine);
  same(chatImage(floor, mine, env), mine);
  same(chatImage(floor, `/${slashes(mine)}`, env), mine, 'the /C:/… form Codex writes');
  same(chatImage(floor, encodeURIComponent(slashes(mine)), env), mine, 'percent-encoded');
  same(chatImage(floor, made, env), made, "Codex's own pictures");
  assert.equal(chatImage(floor, secret, env), undefined, 'outside both folders');
  assert.equal(chatImage(floor, '../outside/secret.png', env), undefined, 'a way out of the folder');
  assert.equal(chatImage(floor, 'notes.txt', env), undefined, 'not a picture');
  assert.equal(chatImage(floor, 'freelance-team/deliveries/missing.png', env), undefined);
  assert.equal(chatImage(floor, '', env), undefined);
  assert.equal(chatImage(floor, 'a\0.png', env), undefined);
  try {
    symlinkSync(secret, path.join(floor, 'link.png'));
    assert.equal(chatImage(floor, 'link.png', env), undefined, 'a link that leads outside');
  } catch {
    // Windows may not allow a link without privileges: the rest stands.
  }
  rmSync(root, { recursive: true, force: true });
});
