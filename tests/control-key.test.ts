import test from 'node:test';
import assert from 'node:assert/strict';
import { Keys } from '../src/client/core/registry';
import { nativeControlKey } from '../src/client/input/control-key';

test('focused native controls keep activation without triggering chat or canceling the default', () => {
  for (const key of ['Enter', ' ']) {
    const keys = new Keys();
    let chat = 0;
    let prevented = false;
    keys.add('guard', (e) => nativeControlKey(e as typeof e & { target: EventTarget }));
    keys.bind({ key, preventDefault: true, run: () => { chat++; } });
    const target = { closest: () => ({ tagName: 'BUTTON' }) } as unknown as EventTarget;
    assert.equal(keys.handle({ key, code: key === 'Enter' ? 'Enter' : 'Space', repeat: false, target, preventDefault: () => { prevented = true; } } as Parameters<typeof keys.handle>[0]), 'guard');
    assert.equal(chat, 0);
    assert.equal(prevented, false);
  }
});

test('canvas Enter still reaches the chat shortcut', () => {
  const keys = new Keys();
  let chat = 0;
  keys.add('guard', (e) => nativeControlKey(e as typeof e & { target: EventTarget }));
  keys.bind({ key: 'Enter', run: () => { chat++; } });
  const target = { closest: () => null } as unknown as EventTarget;
  keys.handle({ key: 'Enter', code: 'Enter', repeat: false, target, preventDefault() {} } as Parameters<typeof keys.handle>[0]);
  assert.equal(chat, 1);
});
