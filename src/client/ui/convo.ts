import './convo.css';
import { h } from './dom';
import { rich, type Source } from './richtext';

// One conversation as the person sees it, for the meeting room and the interview (the terminal chat has its own,
// tied to an agent's session). It keeps what is typed in the box (and the draft even if the window is closed
// or the page redrawn around it), only ever adds the messages that are new or changed to the list (so scrolling,
// selecting and typing are never disturbed), sticks to the newest message unless you scrolled up (and then offers
// a button to jump down), shows who is writing now, and reads messages as light markdown.

export interface ConvoMsg {
  id: string;
  /** me: the person at the window; them: another; system: a line in the middle (a round, a note). */
  side: 'me' | 'them' | 'system';
  name?: string;
  /** What the speaker is (a post), shown small beside the name. */
  sub?: string;
  color?: string;
  text: string;
  at?: number;
  /** A small label on the message, like "← علی" for a question to one person. */
  tag?: string;
  /** The message is a divider (a round, a day): shown as a line with its text. */
  divider?: boolean;
}

export interface ConvoOpts {
  /** Where the draft is kept: one per conversation. */
  draftKey: string;
  placeholder: string;
  /** Sends the text; resolves to whether it went (the draft stays when it didn't). */
  send(text: string): Promise<boolean>;
  maxLength?: number;
  source?: Source;
  /** Shown while there are no messages. */
  empty?: string;
}

export interface Convo {
  el: HTMLElement;
  setMessages(messages: ConvoMsg[]): void;
  /** Who is writing now; empty for no one. */
  setTyping(names: string[]): void;
  /** A line above the box: what is being waited for, or what is wrong. */
  setStatus(text: string, tone?: 'info' | 'warn'): void;
  /** Something beside the box (a recipient to pick, buttons). */
  addTool(el: HTMLElement): void;
  /** What can be said now: the box and the button go grey with the reason. */
  setEnabled(on: boolean, why?: string): void;
  focus(): void;
}

const NEAR = 90;
const MAX_ROWS_PX = 170;

const clock = (at: number) => new Date(at).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
const dayOf = (at: number) => new Date(at).toLocaleDateString('fa-IR', { weekday: 'long', month: 'long', day: 'numeric' });
const dayKey = (at: number) => new Date(at).toDateString();
const initial = (name: string) => [...name.trim()][0] ?? '؟';

function remember(key: string): string {
  try {
    return sessionStorage.getItem(`convo:${key}`) ?? '';
  } catch {
    return '';
  }
}
function keep(key: string, text: string) {
  try {
    if (text) sessionStorage.setItem(`convo:${key}`, text);
    else sessionStorage.removeItem(`convo:${key}`);
  } catch {
    // Without storage the draft lives as long as the box does.
  }
}

export function createConvo(opts: ConvoOpts): Convo {
  const source: Source = opts.source ?? (() => undefined);
  const max = opts.maxLength ?? 3000;
  const list = h('div.cv-list', { role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions' });
  const typing = h('div.cv-typing.hidden', { 'aria-hidden': 'true' }, h('span.cv-typing-text'), h('i'), h('i'), h('i'));
  const empty = h('div.cv-empty', {}, opts.empty ?? 'هنوز پیامی نیست.');
  const jump = h('button.cv-jump.hidden', { type: 'button', 'aria-label': 'رفتن به تازه‌ترین پیام' }, '↓ پیام تازه');
  const status = h('div.cv-status.hidden', { role: 'status' });
  const tools = h('div.cv-tools.hidden');
  const input = h('textarea', { rows: '1', maxlength: String(max), placeholder: opts.placeholder, dir: 'auto', 'aria-label': opts.placeholder }) as HTMLTextAreaElement;
  const count = h('span.cv-count.hidden');
  const sendBtn = h('button.btn.primary.cv-send', { type: 'button' }, 'ارسال ↵');
  const box = h('div.cv-box', {}, tools, h('div.cv-row', {}, input, sendBtn), count);
  const el = h('section.cv', {}, h('div.cv-scroll', {}, list, empty, typing), jump, status, box);
  const scroller = el.firstElementChild as HTMLElement;

  const nodes = new Map<string, HTMLElement>();
  let order: string[] = [];
  let unread = 0;
  let sending = false;
  let enabled = true;
  let why = '';

  const near = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < NEAR;
  const toEnd = () => { scroller.scrollTop = scroller.scrollHeight; };
  const syncJump = () => {
    jump.classList.toggle('hidden', unread === 0);
    jump.textContent = unread > 1 ? `↓ ${unread.toLocaleString('fa-IR')} پیام تازه` : '↓ پیام تازه';
  };
  // A browser puts a scrolled box back to the top when it is taken out of the page and put in again, which is what a
  // window that redraws itself does to the conversation. Where it was left (at the end, or this far up) is remembered,
  // and put back as soon as it is shown again.
  let saved = { top: 0, stick: true };
  scroller.addEventListener('scroll', () => {
    saved = { top: scroller.scrollTop, stick: near() };
    if (saved.stick && unread) { unread = 0; syncJump(); }
  });
  new ResizeObserver(() => {
    if (!el.isConnected || !scroller.clientHeight) return;
    if (saved.stick) toEnd();
    else if (Math.abs(scroller.scrollTop - saved.top) > 1) scroller.scrollTop = saved.top;
  }).observe(scroller);
  jump.addEventListener('click', () => { toEnd(); unread = 0; syncJump(); input.focus(); });

  const fit = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, MAX_ROWS_PX)}px`;
    const left = max - input.value.length;
    count.classList.toggle('hidden', left > max * 0.2);
    count.textContent = `${left.toLocaleString('fa-IR')} نویسه مانده`;
  };
  const refresh = () => {
    input.disabled = !enabled;
    sendBtn.disabled = !enabled || sending || !input.value.trim();
    sendBtn.textContent = sending ? 'در حال ارسال…' : 'ارسال ↵';
    sendBtn.title = enabled ? '' : why;
    input.title = enabled ? '' : why;
  };

  const send = async () => {
    const text = input.value.trim();
    if (!text || sending || !enabled) return;
    sending = true;
    refresh();
    const ok = await opts.send(text).catch(() => false);
    sending = false;
    if (ok) {
      input.value = '';
      keep(opts.draftKey, '');
      fit();
      requestAnimationFrame(toEnd);
    }
    refresh();
    input.focus();
  };
  input.addEventListener('input', () => { keep(opts.draftKey, input.value); fit(); refresh(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void send();
    }
  });
  sendBtn.addEventListener('click', () => void send());
  input.value = remember(opts.draftKey);
  fit();
  refresh();

  const bubble = (m: ConvoMsg): HTMLElement => {
    if (m.divider) return h('div.cv-divider', { 'data-id': m.id, 'data-text': m.text }, h('span', {}, m.text));
    if (m.side === 'system') return h('div.cv-system', { 'data-id': m.id, 'data-text': m.text, dir: 'auto' }, ...rich(m.text, source));
    const me = m.side === 'me';
    return h('article.cv-msg', { class: me ? 'me' : 'them', 'data-id': m.id, 'data-text': m.text },
      me ? null : h('span.cv-av', { style: m.color ? `background:${m.color}` : '' }, initial(m.name ?? '')),
      h('div.cv-bub', {},
        h('div.cv-meta', {}, h('b', {}, m.name ?? (me ? 'شما' : '')), m.sub ? h('small', {}, m.sub) : null, m.tag ? h('span.cv-tag', {}, m.tag) : null, m.at ? h('time', { datetime: new Date(m.at).toISOString() }, clock(m.at)) : null),
        h('div.cv-body', { dir: 'auto' }, ...rich(m.text, source))));
  };

  /** The list with a divider before the first message of each new day. */
  const withDays = (messages: ConvoMsg[]): ConvoMsg[] => {
    const out: ConvoMsg[] = [];
    let last = '';
    for (const m of messages) {
      if (m.at) {
        const k = dayKey(m.at);
        if (k !== last) {
          out.push({ id: `day:${k}`, side: 'system', divider: true, text: dayOf(m.at) });
          last = k;
        }
      }
      out.push(m);
    }
    return out;
  };

  const api: Convo = {
    el,
    setMessages(messages) {
      const items = withDays(messages);
      const stick = near() || order.length === 0;
      const ids = items.map((m) => m.id);
      const same = order.length <= ids.length && order.every((id, i) => id === ids[i]);
      let added = 0;
      if (!same) {
        // Something was taken out or came in the middle: draw again, keeping the place.
        const top = scroller.scrollTop;
        for (const n of nodes.values()) n.remove();
        nodes.clear();
        order = [];
        for (const m of items) {
          const n = bubble(m);
          nodes.set(m.id, n);
          list.append(n);
          order.push(m.id);
        }
        scroller.scrollTop = top;
        added = items.filter((m) => m.side !== 'me' && !m.divider).length ? 0 : 0;
      } else {
        for (const m of items) {
          const have = nodes.get(m.id);
          if (have) {
            if (have.dataset.text !== m.text) {
              const fresh = bubble(m);
              have.replaceWith(fresh);
              nodes.set(m.id, fresh);
            }
          } else {
            const n = bubble(m);
            nodes.set(m.id, n);
            list.append(n);
            order.push(m.id);
            if (!m.divider && m.side !== 'me') added++;
          }
        }
      }
      empty.classList.toggle('hidden', items.length > 0);
      if (stick) {
        requestAnimationFrame(toEnd);
        unread = 0;
      } else if (added) unread += added;
      syncJump();
    },
    setTyping(names) {
      typing.classList.toggle('hidden', names.length === 0);
      typing.querySelector('.cv-typing-text')!.textContent = names.length ? `${names.slice(0, 3).join('، ')} ${names.length > 1 ? 'در حال نوشتن‌اند' : 'در حال نوشتن است'}` : '';
      if (names.length && near()) requestAnimationFrame(toEnd);
    },
    setStatus(text, tone = 'info') {
      status.classList.toggle('hidden', !text);
      status.classList.toggle('warn', tone === 'warn');
      status.textContent = text;
    },
    addTool(tool) {
      tools.classList.remove('hidden');
      tools.append(tool);
    },
    setEnabled(on, reason = '') {
      enabled = on;
      why = reason;
      refresh();
    },
    focus() {
      input.focus();
    },
  };
  return api;
}
