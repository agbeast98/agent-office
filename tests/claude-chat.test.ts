import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ClaudeChatReader, claudeMessages } from '../src/server/claude-chat.js';

const line = (o: unknown) => `${JSON.stringify(o)}\n`;
const user = (content: unknown, extra = {}) => line({ type: 'user', timestamp: '2026-11-02T10:00:00.000Z', message: { role: 'user', content }, ...extra });
const assistant = (blocks: unknown[]) => line({ type: 'assistant', timestamp: '2026-11-02T10:00:05.000Z', message: { role: 'assistant', content: blocks } });

test('keeps prompts and answers, and drops reasoning, tool calls, results, side chains and Claude Code notes', () => {
  const raw = [
    user('سلام، مصاحبه را شروع کن'),
    assistant([{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'سؤال اول: چه خدماتی می‌دهی؟' }, { type: 'tool_use', name: 'Read', input: {} }]),
    user([{ type: 'tool_result', tool_use_id: 'x', content: 'file body' }]),
    user('<system-reminder>ignore</system-reminder>'),
    user('<command-name>/clear</command-name>'),
    user('side', { isSidechain: true }),
    user('meta', { isMeta: true }),
    'not json\n',
    user([{ type: 'text', text: 'سایت اختصاصی و وردپرس' }]),
  ].join('');
  const messages = claudeMessages(raw, 's1');
  assert.deepEqual(messages.map((m) => [m.role, m.text]), [
    ['user', 'سلام، مصاحبه را شروع کن'],
    ['assistant', 'سؤال اول: چه خدماتی می‌دهی؟'],
    ['user', 'سایت اختصاصی و وردپرس'],
  ]);
  assert.equal(messages[0].at, '2026-11-02T10:00:00.000Z');
});

test('ids are the session and the byte offset of the line, so they stay put as the file grows', () => {
  const first = user('اول');
  const second = assistant([{ type: 'text', text: 'دوم' }]);
  const messages = claudeMessages(first + second, 'abc');
  assert.equal(messages[0].id, 'abc:0');
  assert.equal(messages[1].id, `abc:${Buffer.byteLength(first)}`);
  assert.equal(claudeMessages(first + second + user('سوم'), 'abc')[1].id, messages[1].id);
});

test('only the latest messages are kept, and a very long one is cut', () => {
  const many = Array.from({ length: 250 }, (_, i) => user(`m${i}`)).join('');
  const kept = claudeMessages(many, 's');
  assert.equal(kept.length, 200);
  assert.equal(kept.at(-1)?.text, 'm249');
  assert.ok(claudeMessages(user('x'.repeat(40_000)), 's')[0].text.length <= 30_001);
});

test('reads a transcript under Claude’s projects folder, answers an unchanged one cheaply and picks up new lines', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'claude-chat-'));
  const prev = process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.CLAUDE_CONFIG_DIR = root;
    const dir = path.join(root, 'projects', 'proj');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'sess.jsonl');
    writeFileSync(file, user('سلام') + assistant([{ type: 'text', text: 'پاسخ' }]));
    const reader = new ClaudeChatReader();
    const page = reader.read(file, 'sess');
    assert.equal(page.status, 'ready');
    assert.equal(page.messages.length, 2);
    assert.equal(page.unchanged, undefined);
    const again = reader.read(file, 'sess', page.cursor);
    assert.deepEqual(again, { status: 'ready', cursor: page.cursor, messages: [], unchanged: true });
    appendFileSync(file, user('پیام تازه'));
    const grown = reader.read(file, 'sess', page.cursor);
    assert.equal(grown.unchanged, undefined);
    assert.equal(grown.messages.at(-1)?.text, 'پیام تازه');
    assert.ok(grown.cursor > page.cursor);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
    rmSync(root, { recursive: true, force: true });
  }
});

test('waits when there is no transcript yet, and refuses files outside Claude’s folder, links included', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'claude-chat-'));
  const prev = process.env.CLAUDE_CONFIG_DIR;
  try {
    process.env.CLAUDE_CONFIG_DIR = path.join(root, 'cfg');
    mkdirSync(path.join(root, 'cfg', 'projects', 'p'), { recursive: true });
    const outside = path.join(root, 'secret.jsonl');
    writeFileSync(outside, user('private'));
    const reader = new ClaudeChatReader();
    const waiting = { status: 'waiting', cursor: 0, messages: [] };
    assert.deepEqual(reader.read(undefined, 's'), waiting);
    assert.deepEqual(reader.read(path.join(root, 'cfg', 'projects', 'p', 'nope.jsonl'), 's'), waiting);
    assert.deepEqual(reader.read(outside, 's'), waiting);
    assert.deepEqual(reader.read(path.join(root, 'cfg', 'projects', 'p', 'a.txt'), 's'), waiting);
    try {
      symlinkSync(outside, path.join(root, 'cfg', 'projects', 'p', 'link.jsonl'));
      assert.deepEqual(reader.read(path.join(root, 'cfg', 'projects', 'p', 'link.jsonl'), 's'), waiting);
    } catch {
      // Making a link needs a privilege some machines don't give.
    }
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
    rmSync(root, { recursive: true, force: true });
  }
});
