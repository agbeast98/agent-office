import test from 'node:test';
import assert from 'node:assert/strict';
import { popupPosition } from '../src/client/ui/popup-position';

test('dropdown stays within narrow viewport for anchors on either side', () => {
  for (const anchor of [{ left: 8, right: 52, bottom: 100 }, { left: 180, right: 312, bottom: 48 }]) {
    const p = popupPosition(anchor, 560, { width: 320, height: 568 });
    assert.ok(p.left >= 8);
    assert.ok(p.left + p.maxWidth <= 312);
    assert.ok(p.top + p.maxHeight <= 560);
  }
});

test('short landscape and keyboard viewport still leave dropdown scrollable', () => {
  const p = popupPosition({ left: 700, right: 830, bottom: 350 }, 380, { width: 844, height: 390 });
  assert.equal(p.left, 450);
  assert.ok(p.maxHeight >= 120);
  assert.ok(p.top + p.maxHeight <= 382);
  const zoom = popupPosition({ left: 12, right: 56, bottom: 120 }, 560, { width: 320, height: 240, left: 10, top: 20 });
  assert.ok(zoom.left >= 18);
  assert.ok(zoom.top + zoom.maxHeight <= 252);
});
