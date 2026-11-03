import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GUARD_MAX, Security, hostOf, programOf } from '../src/server/security.js';

const SEO = { id: 'seo', name: 'کامران' };
const fresh = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'security-'));
  const sec = new Security(dir, path.join(dir, 'rules.md'));
  sec.setGuardian('sec', true);
  sec.guard('sec', 'seo', true);
  return { dir, sec, done: () => rmSync(dir, { recursive: true, force: true }) };
};

test('hosts and programs are read the way rules name them', () => {
  assert.equal(hostOf('https://www.Khateweb.com/blog/new?x=1'), 'khateweb.com');
  assert.equal(hostOf('blog.khateweb.com'), 'blog.khateweb.com');
  assert.equal(programOf('  "C:\\Program Files\\Git\\bin\\git.exe" status'), 'git');
  assert.equal(programOf('curl -s https://x.com'), 'curl');
});

test('an agent nobody guards is never held', () => {
  const { sec, done } = fresh();
  try {
    assert.equal(sec.check({ id: 'free', name: 'مصاحبه‌گر' }, 'shell', 'curl', 'curl https://evil.example').verdict, 'allow');
  } finally { done(); }
});

test('rules let the agent read freely but send, fetch and run only what they name; the rest is held once', () => {
  const { sec, done } = fresh();
  try {
    sec.setRules('seo', { write: 'khateweb.com', commands: ['git status'], blocked: ['evil.example'], web: [] });
    assert.equal(sec.check(SEO, 'open', 'anything.org', 'https://anything.org').verdict, 'allow', 'reading is open');
    assert.equal(sec.check(SEO, 'write', 'blog.khateweb.com', 'ارسال').verdict, 'allow', 'a subdomain of an allowed site');
    assert.equal(sec.check(SEO, 'shell', 'git', 'git status -s').verdict, 'allow');
    const other = sec.check(SEO, 'write', 'medium.com', 'انتشار');
    assert.equal(other.verdict, 'hold');
    assert.ok(other.verdict === 'hold' && other.fresh);
    const again = sec.check(SEO, 'write', 'medium.com', 'انتشار');
    assert.ok(again.verdict === 'hold' && !again.fresh && again.hold.id === (other.verdict === 'hold' ? other.hold.id : ''), 'the same thing is not held twice');
    const sh = sec.check(SEO, 'shell', 'curl', 'curl https://medium.com');
    assert.equal(sh.verdict, 'hold');
    const bad = sec.check(SEO, 'open', 'evil.example', 'https://evil.example');
    assert.ok(bad.verdict === 'deny' && /ممنوع/.test(bad.reason));
    assert.equal(sec.check(SEO, 'file', path.join(tmpdir(), 'x', 'a.md'), 'Read', [path.join(tmpdir(), 'x')]).verdict, 'allow', 'its own folder');
    assert.equal(sec.check(SEO, 'file', path.join(tmpdir(), 'y', 'a.md'), 'Read', [path.join(tmpdir(), 'x')]).verdict, 'hold', 'outside it');
    sec.setRules('seo', { browse: false });
    assert.equal(sec.check(SEO, 'open', 'anything.org', 'x').verdict, 'hold', 'when reading is closed too');
  } finally { done(); }
});

test('the security agent allows for a while, refuses, or asks; the agent is told what became of it', () => {
  const { sec, done } = fresh();
  try {
    const held = sec.check(SEO, 'write', 'medium.com', 'انتشار');
    assert.ok(held.verdict === 'hold');
    const id = held.verdict === 'hold' ? held.hold.id : '';
    const asked = sec.decide(id, 'ask', 'security', 'مطمئن نیستم');
    assert.ok(asked.ok && asked.hold.status === 'asked');
    assert.equal(sec.decide(id, 'allow', 'security').ok, false, 'once asked, only the person decides');
    const out = sec.decide(id, 'allow', 'you', 'اشکال ندارد', 30);
    assert.ok(out.ok);
    assert.deepEqual(out.notices.map((n) => n.to), ['seo']);
    assert.match(out.notices[0].text, /تأیید شد/);
    assert.equal(sec.check(SEO, 'write', 'medium.com', 'انتشار').verdict, 'allow', 'allowed for a while');
    assert.equal(sec.decide(id, 'deny', 'you').ok, false, 'decided once');

    const second = sec.check(SEO, 'shell', 'rm', 'rm -rf x');
    const id2 = second.verdict === 'hold' ? second.hold.id : '';
    const refused = sec.decide(id2, 'deny', 'security', 'خطرناک');
    assert.ok(refused.ok && /رد شد/.test(refused.notices[0].text));
    assert.equal(sec.check(SEO, 'shell', 'rm', 'rm -rf x').verdict, 'hold', 'one answer from the security agent is not a rule');
  } finally { done(); }
});

test('two answers from the person the same way make a rule, and it is never asked again', () => {
  const { sec, done } = fresh();
  try {
    for (let i = 0; i < 2; i++) {
      const c = sec.check(SEO, 'open', 'casino.example', 'x');
      // Reading is open, so close it to get the question at all.
      assert.equal(c.verdict, 'allow');
    }
    sec.setRules('seo', { browse: false });
    const first = sec.check(SEO, 'open', 'casino.example', 'x');
    const out1 = sec.decide(first.verdict === 'hold' ? first.hold.id : '', 'deny', 'you');
    assert.ok(out1.ok && !out1.learned, 'one answer is not yet a rule');
    const second = sec.check(SEO, 'open', 'casino.example', 'x');
    assert.equal(second.verdict, 'hold', 'asked again');
    const out2 = sec.decide(second.verdict === 'hold' ? second.hold.id : '', 'deny', 'you');
    assert.ok(out2.ok && out2.learned?.verdict === 'deny');
    const third = sec.check(SEO, 'open', 'casino.example', 'x');
    assert.ok(third.verdict === 'deny' && /قانون امنیت/.test(third.reason), 'refused outright, with nobody asked');

    // A rule learned the other way lets it through without asking.
    for (let i = 0; i < 2; i++) {
      const c = sec.check(SEO, 'shell', 'git', 'git push');
      sec.decide(c.verdict === 'hold' ? c.hold.id : '', 'allow', 'you');
    }
    assert.equal(sec.check(SEO, 'shell', 'git', 'git pull').verdict, 'allow');
    // Mixed answers start over; and a rule can be taken back.
    sec.forget('shell:git');
    assert.equal(sec.check(SEO, 'shell', 'git', 'git pull').verdict, 'hold');
  } finally { done(); }
});

test('a security agent guards at most five, and not itself or a security agent', () => {
  const { sec, done } = fresh();
  try {
    for (let i = 1; i < GUARD_MAX; i++) assert.equal(sec.guard('sec', `a${i}`, true), undefined);
    assert.equal(sec.guards.sec.length, GUARD_MAX);
    assert.match(sec.guard('sec', 'a6', true) ?? '', /at most 5/);
    assert.equal(sec.guard('sec', 'seo', false), undefined, 'taking one off frees a place');
    assert.equal(sec.guard('sec', 'a6', true), undefined);
    assert.match(sec.guard('sec', 'sec', true) ?? '', /itself/);
    sec.setGuardian('sec2', true);
    assert.match(sec.guard('sec', 'sec2', true) ?? '', /not guarded/);
    assert.equal(sec.guard('sec2', 'a1', true), undefined, 'moving one to another guard');
    assert.equal(sec.guardOf('a1'), 'sec2');
    assert.equal(sec.guards.sec.includes('a1'), false);
  } finally { done(); }
});

test('it is all kept across a restart and written out for people to read', () => {
  const { dir, sec, done } = fresh();
  try {
    sec.setRules('seo', { write: ['khateweb.com'], blocked: ['evil.example'] });
    const c = sec.check(SEO, 'write', 'medium.com', 'x');
    sec.decide(c.verdict === 'hold' ? c.hold.id : '', 'deny', 'you');
    const again = new Security(dir, path.join(dir, 'rules.md'));
    assert.deepEqual(again.rules('seo').write, ['khateweb.com']);
    assert.equal(again.guardOf('seo'), 'sec');
    assert.equal(again.holds[0].status, 'denied');
    again.writeMirror((id) => ({ sec: 'شبنم', seo: 'کامران' })[id as 'sec'] ?? id);
    const text = readFileSync(path.join(dir, 'rules.md'), 'utf8');
    for (const w of ['نگهبان: شبنم (1 از 5)', '### کامران', 'khateweb.com', 'evil.example']) assert.ok(text.includes(w), w);
  } finally { done(); }
});
