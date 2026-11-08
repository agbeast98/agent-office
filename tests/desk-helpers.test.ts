import test from 'node:test';
import assert from 'node:assert/strict';
import { stillTyped } from '../src/server/workers/desk-helpers.js';
import type { Worker } from '../src/server/workers/types.js';

/** A worker whose terminal shows these lines, the last at the bottom. */
const showing = (lines: string[]) =>
  ({ term: { buffer: { active: { length: lines.length, getLine: (i: number) => ({ translateToString: () => lines[i] }) } } } }) as unknown as Worker;

const prompt = 'جلسه‌ی تیمی (نظرخواهی، دور ۱). نظر و پیشنهادت را کوتاه و روشن با ابزار meeting_say ثبت کن، یک بار.';

test('a prompt that is still in the input box is noticed, even wrapped and without its half-spaces', () => {
  const stuck = showing(['• کار قبلی تمام شد', '› یادآوری نقش شما: مدیر تیم', 'جلسهی تیمی (نظرخواهی، دور ۱). نظر و پیشنهادت را کوتاه', 'و روشن با ابزار meeting_say ثبت کن، یک بار.', '', 'GPT-6-Luna high · ~\\playground']);
  assert.equal(stillTyped(stuck, prompt), true);
});

test('a prompt that went is not noticed: the box is empty again', () => {
  const sent = showing(['› جلسهی تیمی … ثبت کن، یک بار.', '• چشم، ثبت می‌کنم.', 'Worked for 4s', '› Ask Codex to do anything', 'GPT-6-Luna high · ~\\playground']);
  assert.equal(stillTyped(sent, prompt), false, 'the text above is the message in the conversation, not in the box');
});

test('no terminal, or a text with nothing to compare, is never "still typed"', () => {
  assert.equal(stillTyped({} as Worker, prompt), false);
  assert.equal(stillTyped(showing(['abc']), 'abc'), false);
});

test('a long paste Codex folded into "[Pasted Content … chars]" is still noticed in the box', () => {
  const folded = showing(['Worked for 36s • Nov 7 at 7:14 PM', '› [Pasted Content 3927 chars]', '', 'GPT-6-Luna high · ~\playground']);
  assert.equal(stillTyped(folded, prompt), true);
});
