import './worker-browser.css';
import { h, toast } from './dom';
import { fa } from './fa-locale';
import { store } from '../state';

interface BrowserState { open: boolean; url?: string; title?: string; control: 'agent' | 'person'; mode?: 'ask' | 'auto'; pending?: { action: 'click' | 'press'; label: string; url: string }; error?: string }

/** The owner-facing window into the private browser session belonging to one worker. */
export function workerBrowser(workerId: string): { panel: HTMLElement; visible(on: boolean): void; dispose(): void } {
  const address = h('input.wb-address', { type: 'url', placeholder: 'https://…', 'aria-label': 'Browser address', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
  const go = h('button.btn.wb-go', { type: 'submit', title: 'Open this address' }, 'Go');
  const back = h('button.btn.wb-nav', { type: 'button', 'aria-label': 'Back', title: 'Back' }, '‹');
  const forward = h('button.btn.wb-nav', { type: 'button', 'aria-label': 'Forward', title: 'Forward' }, '›');
  const reload = h('button.btn.wb-nav', { type: 'button', 'aria-label': 'Reload', title: 'Reload' }, '↻');
  const take = h('button.btn.wb-take', { type: 'button' }, 'Take control');
  const status = h('span.wb-status', {}, 'Browser is ready when you are');
  const mode = h('select.wb-mode', { 'aria-label': 'ارسال و تأیید توسط ایجنت', title: 'وقتی ایجنت بخواهد چیزی را ارسال، ثبت، پرداخت یا حذف کند' },
    h('option', { value: 'ask' }, '🛡️ ارسال با تأیید من'), h('option', { value: 'auto' }, '⚡ خودکار، بدون پرسیدن')) as HTMLSelectElement;
  const askText = h('span.wb-ask-text');
  const allow = h('button.btn.wb-allow', { type: 'button' }, '✓ تأیید');
  const deny = h('button.btn.wb-deny', { type: 'button' }, '✕ رد');
  const ask = h('div.wb-ask.hidden', { role: 'alert', dir: 'rtl', lang: 'fa' }, askText, allow, deny);
  const title = h('span.wb-title', {}, 'Private worker browser');
  const image = h('img.wb-page', { alt: 'Live screenshot of this worker’s private browser page', draggable: 'false' }) as HTMLImageElement;
  const empty = h('div.wb-empty', {}, h('div.wb-globe', {}, '◉'), h('h3', {}, 'A browser for this desk'), h('p', {}, 'The page the agent opens appears here. Its browsing session is isolated from your personal Chrome profile.'), h('button.btn.primary', { type: 'button' }, 'Open browser'));
  const frame = h('div.wb-viewport', { role: 'application', tabindex: '0', 'aria-label': 'Browser preview. Take control to click or type.' }, empty, image);
  const form = h('form.wb-toolbar', {}, back, forward, reload, address, go, take);
  const panel = h('section.worker-browser', { 'aria-label': 'Worker browser' }, form, h('div.wb-meta', {}, title, mode, status), ask, frame, h('footer.wb-footer', {}, h('span', {}, '🔒 Isolated profile · shared with the people in this office'), h('span', {}, 'Human and agent controls take turns')));
  const qs = () => new URLSearchParams({ floor: store.floor ?? '', worker: workerId });
  const endpoint = (name: string) => `/api/worker-browser/${name}?${qs().toString()}`;
  let shown = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let state: BrowserState = { open: false, control: 'agent' };
  let busy = false;
  let imageUrl = '';

  const request = async (action: string, extra: Record<string, unknown> = {}) => {
    if (busy) return;
    busy = true;
    try {
      const response = await fetch(endpoint('action'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...extra }) });
      const result = await response.json() as BrowserState & { error?: string };
      if (!response.ok) throw new Error(result.error || `Browser action failed (${response.status})`);
      state = result;
      address.value = result.url ?? address.value;
      title.textContent = result.title || result.url || fa('Private worker browser');
      paintState();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Browser action failed', 'warn');
    } finally {
      busy = false;
      if (shown) void refresh();
    }
  };

  const refresh = async () => {
    if (!shown || busy) return;
    try {
      const response = await fetch(endpoint('view'), { cache: 'no-store' });
      if (!response.ok) throw new Error('The browser status could not be loaded.');
      state = await response.json() as BrowserState;
      address.value = state.url ?? address.value;
      title.textContent = state.title || state.url || fa('Private worker browser');
      paintState();
      if (state.open) {
        const imageResponse = await fetch(endpoint('screenshot'), { cache: 'no-store' });
        if (!imageResponse.ok) throw new Error('The browser preview is not available yet.');
        if (imageUrl) URL.revokeObjectURL(imageUrl);
        imageUrl = URL.createObjectURL(await imageResponse.blob());
        image.src = imageUrl;
      } else { image.removeAttribute('src'); if (imageUrl) URL.revokeObjectURL(imageUrl); imageUrl = ''; }
    } catch (error) {
      state = { open: false, control: 'agent', error: error instanceof Error ? error.message : 'Browser preview unavailable.' };
      paintState();
      image.removeAttribute('src');
      if (imageUrl) URL.revokeObjectURL(imageUrl);
      imageUrl = '';
    }
  };

  const paintState = () => {
    const isOpen = state.open;
    frame.classList.toggle('open', isOpen);
    empty.classList.toggle('hidden', isOpen);
    image.classList.toggle('hidden', !isOpen);
    panel.classList.toggle('person-control', state.control === 'person');
    take.textContent = state.control === 'person' ? `✓ ${fa('Human control · resume agent')}` : fa('Take control');
    take.setAttribute('aria-pressed', String(state.control === 'person'));
    status.textContent = state.error ? fa(state.error) : isOpen ? state.control === 'person' ? fa('The browser is under human control') : fa('The agent is using this browser') : fa('Browser is ready when you are');
    status.classList.toggle('error', !!state.error);
    mode.value = state.mode ?? 'ask';
    ask.classList.toggle('hidden', !state.pending);
    if (state.pending) askText.textContent = `ایجنت می‌خواهد «${state.pending.label}» را ${state.pending.action === 'press' ? 'با Enter بفرستد' : 'بزند'} (${state.pending.url}). اجازه می‌دهید؟`;
    back.disabled = forward.disabled = reload.disabled = !isOpen || state.control !== 'person';
    go.disabled = !address.value.trim();
  };

  empty.querySelector('button')!.addEventListener('click', () => {
    const url = address.value.trim() || 'https://www.google.com';
    void request('open', { url });
  });
  mode.addEventListener('change', () => void request('mode', { mode: mode.value }));
  allow.addEventListener('click', () => void request('allow'));
  deny.addEventListener('click', () => void request('deny'));
  take.addEventListener('click', () => void request(state.control === 'person' ? 'release' : 'take'));
  back.addEventListener('click', () => void request('back'));
  forward.addEventListener('click', () => void request('forward'));
  reload.addEventListener('click', () => void request('reload'));
  form.addEventListener('submit', (event) => { event.preventDefault(); void request(state.open ? 'navigate' : 'open', { url: address.value.trim() }); });
  address.addEventListener('input', paintState);

  frame.addEventListener('click', (event) => {
    if (!state.open || state.control !== 'person') return;
    const rect = image.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    void request('input', { kind: 'click', x: (event.clientX - rect.left) * (1280 / rect.width), y: (event.clientY - rect.top) * (800 / rect.height) });
    frame.focus();
  });
  frame.addEventListener('keydown', (event) => {
    if (!state.open || state.control !== 'person' || event.ctrlKey || event.metaKey || event.altKey) return;
    const keyMap: Record<string, string> = { Enter: 'Enter', Tab: 'Tab', Escape: 'Escape', Backspace: 'Backspace', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight' };
    if (keyMap[event.key]) {
      event.preventDefault();
      void request('input', { kind: 'key', key: keyMap[event.key] });
    } else if (event.key.length === 1) {
      event.preventDefault();
      void request('input', { kind: 'text', text: event.key });
    }
  });
  paintState();

  return {
    panel,
    visible(on) {
      shown = on;
      if (timer) clearInterval(timer);
      timer = undefined;
      if (on) { void refresh(); timer = setInterval(() => void refresh(), 1200); }
    },
    dispose() {
      if (timer) clearInterval(timer);
      if (state.control === 'person') void request('release');
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    },
  };
}
