import './termchat.css';
import { h } from './dom';
import { store } from '../state';

interface ChatMessage { id: string; role: 'user' | 'assistant'; text: string; at?: string }
interface ChatPage { status: 'waiting' | 'ready' | 'unsupported'; cursor: number; messages: ChatMessage[]; unchanged?: boolean }

export interface TermChat {
  panel: HTMLElement;
  show(): void;
  hide(): void;
  dispose(): void;
}

export function termChat(workerId: string, sendPrompt: (prompt: string) => boolean): TermChat {
  const list = h('div.term-chat-list', { role: 'log', 'aria-live': 'polite', 'aria-label': 'Agent conversation' });
  const state = h('p.term-chat-state', { role: 'status' }, 'Loading conversation…');
  const input = h('textarea', { rows: '2', maxlength: '20000', placeholder: 'پیام فارسی یا انگلیسی بنویس…', 'aria-label': 'پیام به ایجنت', dir: 'auto' }) as HTMLTextAreaElement;
  const send = h('button.btn.primary', { type: 'submit' }, 'ارسال ↵');
  const form = h('form.term-chat-compose', {}, input, send);
  const live = h('span.term-chat-live', {}, '● زنده');
  const panel = h('section.term-chat', { 'aria-label': 'گفت‌وگوی ایجنت' }, h('header.term-chat-head', {}, h('div', {}, h('strong', {}, 'گفت‌وگوی ایجنت'), h('span', {}, 'پیام‌ها از نشست خود ایجنت خوانده می‌شوند')), live), state, list, form);
  const nodes = new Map<string, HTMLElement>();
  let visible = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let cursor = 0;
  let sequence = 0;
  let disposed = false;
  let requestError = false;
  let draftPending = false;
  let lastPage: ChatPage | undefined;
  let remoteMessages: ChatMessage[] = [];
  const pendingMessages: ChatMessage[] = [];
  let session = '';
  let localSequence = 0;

  const renderState = (page: ChatPage) => {
    const hasMessages = page.messages.length > 0 || list.childElementCount > 0;
    live.classList.toggle('waiting', page.status === 'waiting');
    live.classList.toggle('unsupported', page.status === 'unsupported');
    live.classList.toggle('error', requestError);
    live.textContent = requestError ? '● خطا' : page.status === 'ready' ? '● آماده' : page.status === 'unsupported' ? '● پشتیبانی‌نشده' : '● در انتظار';
    if (requestError) state.textContent = 'گفت‌وگو فعلاً بارگذاری نشد. دوباره تلاش می‌کنم…';
    else if (draftPending) state.textContent = 'اتصال برقرار شد؛ متن شما در کادر مانده و هنوز ارسال نشده. برای ارسال دوباره بزن.';
    else if (pendingMessages.length) state.textContent = 'پیام به نشست ایجنت فرستاده شد؛ پاسخ وقتی اتصال گفت‌وگوی ایجنت برقرار باشد اینجا نمایش داده می‌شود.';
    else if (page.status === 'waiting') state.textContent = 'اتصال گفت‌وگو با نشست ایجنت هنوز آماده نیست؛ فعلاً پیام‌ها و پاسخ‌ها ممکن است در ترمینال دیده شوند.';
    else if (page.status === 'unsupported') state.textContent = 'برای این ایجنت گفت‌وگوی جداگانه در دسترس نیست.';
    else if (!page.messages.length && !list.childElementCount) state.textContent = 'هنوز پیامی ثبت نشده. از پایین به ایجنت پیام بده.';
    state.classList.toggle('hidden', page.status === 'ready' && hasMessages && !requestError && !draftPending && !pendingMessages.length);
  };

  const makeBubble = (message: ChatMessage) => {
    const time = message.at && Number.isFinite(Date.parse(message.at))
      ? h('time', { datetime: message.at }, new Date(message.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
      : null;
    const bubble = h('article.term-chat-message', { class: message.role, dir: 'auto', 'data-message-id': message.id },
      h('div.term-chat-meta', {}, message.role === 'assistant' ? 'ایجنت' : message.id.startsWith('local-') ? 'شما · ارسال به نشست' : 'شما', time), h('p', {}, message.text));
    nodes.set(message.id, bubble);
    return bubble;
  };

  const renderMessages = (messages: ChatMessage[]) => {
    const nextSession = messages.find((message) => !message.id.startsWith('local-'))?.id.split(':', 1)[0] ?? '';
    if (nextSession && session && nextSession !== session) {
      list.replaceChildren();
      nodes.clear();
    }
    if (nextSession) session = nextSession;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 72;
    let removedHeight = 0;
    for (const message of messages) {
      const existing = nodes.get(message.id);
      if (existing) {
        const body = existing.querySelector('p');
        if (body && body.textContent !== message.text) body.textContent = message.text;
        continue;
      }
      list.append(makeBubble(message));
    }
    while (list.children.length > 160) {
      const oldest = list.firstElementChild as HTMLElement | null;
      if (!oldest) break;
      if (!nearBottom) removedHeight += oldest.getBoundingClientRect().height + 14;
      nodes.delete(oldest.dataset.messageId ?? '');
      oldest.remove();
    }
    if (nearBottom) list.scrollTop = list.scrollHeight;
    else if (removedHeight) list.scrollTop = Math.max(0, list.scrollTop - removedHeight);
  };

  const visibleMessages = (remote: ChatMessage[]) => {
    const unmatched = [...pendingMessages];
    for (const message of remote) {
      if (message.role !== 'user') continue;
      const index = unmatched.findIndex((pending) => pending.text === message.text
        && (!pending.at || !message.at || Date.parse(message.at) >= Date.parse(pending.at) - 5_000));
      if (index >= 0) unmatched.splice(index, 1);
    }
    for (let i = pendingMessages.length - 1; i >= 0; i--) {
      if (!unmatched.includes(pendingMessages[i])) {
        nodes.get(pendingMessages[i].id)?.remove();
        nodes.delete(pendingMessages[i].id);
        pendingMessages.splice(i, 1);
      }
    }
    return [...unmatched, ...remote];
  };

  const poll = async () => {
    if (!visible || disposed) return;
    const floor = store.floor;
    if (!floor) return;
    const current = ++sequence;
    try {
      const q = new URLSearchParams({ floor, worker: workerId, after: String(cursor) });
      const response = await fetch(`/api/worker-chat?${q}`, { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw new Error('Conversation unavailable');
      const page = await response.json() as ChatPage;
      if (current !== sequence || disposed) return;
      requestError = false;
      lastPage = page;
      if (Number.isSafeInteger(page.cursor) && page.cursor >= 0) cursor = page.cursor;
      if (page.status === 'unsupported') remoteMessages = [];
      else if (page.status === 'ready' && !page.unchanged) remoteMessages = page.messages;
      renderState(page); // Also clears a transient network error when the response is unchanged.
      if (page.status === 'ready' && page.unchanged) return;
      renderMessages(visibleMessages(remoteMessages));
      renderState(page);
    } catch {
      if (current === sequence && visible) {
        requestError = true;
        renderState(lastPage ?? { status: 'waiting', cursor, messages: [] });
      }
    }
  };

  const show = () => {
    visible = true;
    void poll();
    if (!timer) timer = setInterval(() => void poll(), 1500);
  };
  const hide = () => {
    visible = false;
    sequence++;
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const prompt = input.value.trim();
    if (!prompt || send.hasAttribute('disabled')) return;
    send.setAttribute('disabled', '');
    const sent = sendPrompt(prompt);
    send.removeAttribute('disabled');
    if (!sent) {
      draftPending = true;
      renderState(lastPage ?? { status: 'waiting', cursor, messages: [] });
      input.focus();
      return;
    }
    draftPending = false;
    input.value = '';
    pendingMessages.push({ id: `local-${++localSequence}`, role: 'user', text: prompt, at: new Date().toISOString() });
    renderMessages(visibleMessages(remoteMessages));
    if (lastPage) renderState(lastPage);
    input.focus();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  return { panel, show, hide, dispose: () => { disposed = true; hide(); } };
}
