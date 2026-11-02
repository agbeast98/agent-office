import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Ledger } from '../src/server/usage.js';

test('locking hiring stops every new agent, and the lock outlives a restart', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hiring-lock-'));
  const make = () => new Ledger(dir, { pauseHiring: false }, () => {}, () => {});
  try {
    const open = make();
    assert.equal(open.hiringLocked, false);
    assert.equal(open.hiringPaused, undefined);

    open.setHiringLocked(true);
    assert.match(open.hiringPaused ?? '', /قفل/);

    const again = make();
    assert.equal(again.hiringLocked, true);
    assert.match(again.hiringPaused ?? '', /قفل/);

    again.setHiringLocked(false);
    assert.equal(make().hiringPaused, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
