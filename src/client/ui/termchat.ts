import './termchat.css';
import { h } from './dom';
import { store } from '../state';
import { IMAGE, rich, type Source } from './richtext';

interface ChatMessage { id: string; role: 'user' | 'assistant'; text: string; at?: string }
interface ChatPage { status: 'waiting' | 'ready' | 'unsupported'; cursor: number; messages: ChatMessage[]; unchanged?: boolean }

export interface TermChat {
  panel: HTMLElement;
  show(): void;
  hide(): void;
  dispose(): void;
}

/** A sent message the agent's own session hasn't echoed back for this long is worth a look at the terminal. */
const UNCONFIRMED_MS = 20_000;
const STATUS_FA: Record<string, string> = { working: 'در حال کار', idle: 'آماده', done: 'پاسخ داده', needs_input: 'منتظر پاسخ شما', starting: 'در حال شروع', exited: 'خاموش' };

/** Terminals drop half-spaces (ZWNJ) and fold line breaks, so a sent message is matched to its echo without them. */
const squash = (t: string) => t.replace(/[‌‍\s]+/g, '');
const same = (echo: string, sent: string) => squash(echo).endsWith(squash(sent));

export function termChat(workerId: string, sendPrompt: (prompt: string) => boolean, agentName = 'ایجنت'): TermChat {
  const list = h('div.term-chat-list', { role: 'log', 'aria-live': 'polite', 'aria-label': `گفت‌وگو با ${agentName}` });
  const state = h('p.term-chat-state', { role: 'status' }, 'در حال بارگذاری گفت‌وگو…');
  const input = h('textarea', { rows: '2', maxlength: '20000', placeholder: `پیام به ${agentName} (Enter ارسال، Shift+Enter خط تازه)`, 'aria-label': `پیام به ${agentName}`, dir: 'auto' }) as HTMLTextAreaElement;
  const send = h('button.btn.primary', { type: 'submit' }, 'ارسال ↵');
  const form = h('form.term-chat-compose', {}, input, send);
  const live = h('span.term-chat-live', {}, '● در انتظار');
  const agentState = h('span.term-chat-agent', {});
  const typing = h('div.term-chat-typing.hidden', { 'aria-hidden': 'true' }, h('span', {}, `${agentName} در حال پاسخ`), h('i'), h('i'), h('i'));
  const panel = h('section.term-chat', { 'aria-label': `گفت‌وگو با ${agentName}` },
    h('header.term-chat-head', {}, h('div', {}, h('strong', {}, `گفت‌وگو با ${agentName}`), h('span', {}, 'پیام‌ها و پاسخ‌های نهایی از نشست خود ایجنت خوانده می‌شوند؛ جزئیات کار در تب ترمینال است.')), h('div.term-chat-badges', {}, agentState, live)),
    state, list, form);
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

  /** A picture of the agent's own folder (or Codex's generated_images) is loaded through the office; any other address is not shown as a picture. */
  const source: Source = (target) => {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target) && !/^file:/i.test(target)) return undefined;
    return IMAGE.test(target) ? `/api/chat-image?${new URLSearchParams({ floor: store.floor ?? '', path: target })}` : undefined;
  };
  const worker = () => store.workers.get(workerId);
  const working = () => ['working', 'starting'].includes(worker()?.status ?? '');

  const renderAgent = () => {
    const status = worker()?.status ?? 'exited';
    agentState.textContent = STATUS_FA[status] ?? status;
    agentState.className = `term-chat-agent ${status}`;
    typing.classList.toggle('hidden', !working());
    if (!typing.classList.contains('hidden') && list.lastElementChild !== typing) list.append(typing);
  };

  const renderState = (page: ChatPage) => {
    const hasMessages = page.messages.length > 0 || list.querySelector('.term-chat-message') !== null;
    const stale = pendingMessages.some((p) => p.at && Date.now() - Date.parse(p.at) > UNCONFIRMED_MS);
    live.classList.toggle('waiting', page.status === 'waiting');
    live.classList.toggle('unsupported', page.status === 'unsupported');
    live.classList.toggle('error', requestError);
    live.textContent = requestError ? '● خطا' : page.status === 'ready' ? '● همگام' : page.status === 'unsupported' ? '● پشتیبانی‌نشده' : '● در انتظار اتصال';
    if (requestError) state.textContent = 'گفت‌وگو فعلاً بارگذاری نشد. دوباره تلاش می‌کنم…';
    else if (draftPending) state.textContent = 'ارسال نشد: ترمینال ایجنت آماده‌ی دریافت نیست. متن شما در کادر مانده؛ کمی بعد دوباره بزنید.';
    else if (stale) state.textContent = `هنوز تأییدی از ${agentName} نرسیده. اگر منتظر مجوز یا تأیید است، تب ترمینال را باز کنید.`;
    else if (pendingMessages.length) state.textContent = 'پیام به ترمینال فرستاده شد؛ به‌محض ثبت در نشست ایجنت اینجا تأیید می‌شود.';
    else if (page.status === 'waiting') state.textContent = 'اتصال به نشست ایجنت هنوز برقرار نیست. بعد از اولین پیام یا اولین گزارش ایجنت برقرار می‌شود؛ تا آن موقع پیام‌ها فقط در ترمینال دیده می‌شوند.';
    else if (page.status === 'unsupported') state.textContent = 'برای این ایجنت گفت‌وگوی جداگانه در دسترس نیست.';
    else if (!hasMessages) state.textContent = `هنوز پیامی ثبت نشده. از پایین به ${agentName} پیام بده.`;
    state.classList.toggle('hidden', page.status === 'ready' && hasMessages && !requestError && !draftPending && !pendingMessages.length);
    state.classList.toggle('warn', requestError || draftPending || stale);
  };

  const timeOf = (at?: string) => (at && Number.isFinite(Date.parse(at)) ? h('time', { datetime: at }, new Date(at).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' })) : null);

  const makeBubble = (message: ChatMessage) => {
    const local = message.id.startsWith('local-');
    const bubble = h('article.term-chat-message', { class: `${message.role}${local ? ' sending' : ''}`, 'data-message-id': message.id, 'data-text': message.text },
      h('div.term-chat-meta', {}, h('span', {}, message.role === 'assistant' ? agentName : 'شما'), timeOf(message.at), local ? h('span.term-chat-delivery', {}, 'در حال ارسال به ترمینال…') : null),
      h('div.term-chat-body', {}, ...rich(message.text, source)));
    nodes.set(message.id, bubble);
    return bubble;
  };

  const renderMessages = (messages: ChatMessage[]) => {
    const nextSession = messages.find((message) => !message.id.startsWith('local-'))?.id.split(':', 1)[0] ?? '';
    // A new session (the agent was restarted, or moved to another engine) goes under a divider; what came before stays.
    if (nextSession && session && nextSession !== session) list.append(h('div.term-chat-divider', {}, h('span', {}, 'نشست تازه‌ی ایجنت')));
    if (nextSession) session = nextSession;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 72;
    let removedHeight = 0;
    for (const message of messages) {
      const existing = nodes.get(message.id);
      if (existing) {
        if (existing.dataset.text !== message.text) {
          existing.dataset.text = message.text;
          existing.querySelector('.term-chat-body')?.replaceChildren(...rich(message.text, source));
        }
        continue;
      }
      list.append(makeBubble(message));
    }
    while (list.querySelectorAll('.term-chat-message').length > 200) {
      const oldest = list.querySelector<HTMLElement>('.term-chat-message');
      if (!oldest) break;
      if (!nearBottom) removedHeight += oldest.getBoundingClientRect().height + 14;
      nodes.delete(oldest.dataset.messageId ?? '');
      oldest.remove();
    }
    renderAgent();
    if (nearBottom) list.scrollTop = list.scrollHeight;
    else if (removedHeight) list.scrollTop = Math.max(0, list.scrollTop - removedHeight);
  };

  const visibleMessages = (remote: ChatMessage[]) => {
    const unmatched = [...pendingMessages];
    for (const message of remote) {
      if (message.role !== 'user') continue;
      const index = unmatched.findIndex((pending) => same(message.text, pending.text)
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
    return [...remote, ...unmatched];
  };

  const poll = async () => {
    if (!visible || disposed) return;
    const floor = store.floor;
    if (!floor) return;
    renderAgent();
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
      if (page.status === 'ready' && page.unchanged && !pendingMessages.length) return;
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
    setTimeout(() => input.focus(), 0);
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
    renderState(lastPage ?? { status: 'waiting', cursor, messages: [] });
    list.scrollTop = list.scrollHeight;
    input.focus();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  return { panel, show, hide, dispose: () => { disposed = true; hide(); } };
}
