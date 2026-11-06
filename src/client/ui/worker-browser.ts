import './worker-browser.css';
import { h, toast } from './dom';
import { fa } from './fa-locale';
import { store } from '../state';

interface BrowserState { open: boolean; url?: string; title?: string; control: 'agent' | 'person'; mode?: 'ask' | 'auto'; pending?: { action: 'click' | 'press'; label: string; url: string }; error?: string; real?: boolean; light?: boolean; last?: { url: string; at: number } }
interface Row { at: string; actor: 'agent' | 'person'; action: string; detail?: string; url?: string }
interface Source { id: string; name: string; hosts: string[] }
type RawInput = { t: 'move' | 'down' | 'up' | 'wheel' | 'key' | 'text'; x?: number; y?: number; button?: 'left' | 'right' | 'middle'; dx?: number; dy?: number; key?: string; text?: string };

/** The page is 1280×800 in the browser; the picture is scaled to fit, and clicks are scaled back. */
const PAGE_W = 1280;
const PAGE_H = 800;
/** The status is read this often; the picture itself is pushed (see server/browser-stream.ts). */
const STATUS_MS = 2500;
/** If the live picture can't be had (a proxy that holds it back), one screenshot at this pace instead. */
const FALLBACK_MS = 1200;
const ACTION_FA: Record<string, string> = {
  open: 'باز کرد', click: 'کلیک کرد', type: 'تایپ کرد', select: 'انتخاب کرد', press: 'کلید زد', scroll: 'اسکرول کرد', back: 'برگشت', 'took-control': 'کنترل را گرفت', 'released-control': 'کنترل را برگرداند',
  'waiting-for-approval': 'منتظر تأیید ماند', approved: 'تأیید شد', refused: 'رد شد', mode: 'حالت ارسال را عوض کرد', resumed: 'به آخرین صفحه برگشت', 'login-copied': 'ورود از ایجنت دیگر گرفت', 'real-window-opened': 'پنجره‌ی واقعی را باز کرد', 'real-window-closed': 'پنجره‌ی واقعی را بست', 'idle-closed': 'بسته شد (بی‌استفاده)',
};
const SPECIAL_KEYS = ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'];

/** The owner-facing window into the private browser session belonging to one worker. */
export function workerBrowser(workerId: string): { panel: HTMLElement; visible(on: boolean): void; dispose(): void } {
  const address = h('input.wb-address', { type: 'url', placeholder: 'https://…', 'aria-label': 'Browser address', autocomplete: 'off', spellcheck: 'false' }) as HTMLInputElement;
  const go = h('button.btn.wb-go', { type: 'submit', title: 'Open this address' }, 'Go');
  const back = h('button.btn.wb-nav', { type: 'button', 'aria-label': 'Back', title: 'Back' }, '‹');
  const forward = h('button.btn.wb-nav', { type: 'button', 'aria-label': 'Forward', title: 'Forward' }, '›');
  const reload = h('button.btn.wb-nav', { type: 'button', 'aria-label': 'Reload', title: 'Reload' }, '↻');
  const take = h('button.btn.wb-take', { type: 'button' }, 'Take control');
  const realBtn = h('button.btn.wb-real', { type: 'button', title: 'مرورگر ایجنت بسته می‌شود و همان پروفایل در یک Chrome معمولی روی صفحه‌ی همین کامپیوتر باز می‌شود تا خودتان وارد شوید یا چالش سایت را با ماوس خودتان رد کنید. بعد از بستن پنجره، ایجنت با همان ورود ادامه می‌دهد.' }, '🔑 ورود با پنجره‌ی واقعی');
  const status = h('span.wb-status', {}, 'Browser is ready when you are');
  const mode = h('select.wb-mode', { 'aria-label': 'ارسال و تأیید توسط ایجنت', title: 'وقتی ایجنت بخواهد چیزی را ارسال، ثبت، پرداخت یا حذف کند' },
    h('option', { value: 'ask' }, '🛡️ ارسال با تأیید من'), h('option', { value: 'auto' }, '⚡ خودکار، بدون پرسیدن')) as HTMLSelectElement;
  const light = h('input', { type: 'checkbox', 'aria-label': 'حالت سبک' }) as HTMLInputElement;
  const lightLabel = h('label.wb-light', { title: 'وقتی ایجنت کار می‌کند عکس، ویدیو و فونت بارگذاری نشود: سریع‌تر و سبک‌تر. وقتی خودتان کنترل را می‌گیرید صفحه کامل است.' }, light, ' حالت سبک');
  const askText = h('span.wb-ask-text');
  const allow = h('button.btn.wb-allow', { type: 'button' }, '✓ تأیید');
  const deny = h('button.btn.wb-deny', { type: 'button' }, '✕ رد');
  const ask = h('div.wb-ask.hidden', { role: 'alert', dir: 'rtl', lang: 'fa' }, askText, allow, deny);
  const title = h('span.wb-title', {}, 'Private worker browser');
  const image = h('img.wb-page', { alt: 'Live picture of this worker’s private browser page', draggable: 'false' }) as HTMLImageElement;
  const emptyText = h('p', {}, 'The page the agent opens appears here. Its browsing session is isolated from your personal Chrome profile.');
  const resumeBtn = h('button.btn.primary', { type: 'button' }, 'باز کردن دوباره‌ی آخرین صفحه');
  const empty = h('div.wb-empty', {}, h('div.wb-globe', {}, '◉'), h('h3', {}, 'A browser for this desk'), emptyText, resumeBtn, h('button.btn.primary.wb-open', { type: 'button' }, 'Open browser'));
  const frame = h('div.wb-viewport', { role: 'application', tabindex: '0', 'aria-label': 'Browser preview. Take control to click or type.' }, empty, image);
  const activityList = h('div.wb-act-list');
  const activity = h('details.wb-activity', { open: true }, h('summary', {}, '📜 آخرین کارهای این مرورگر'), activityList);
  const loginFrom = h('select', { 'aria-label': 'ورود از کدام ایجنت' }) as HTMLSelectElement;
  const loginHost = h('select', { 'aria-label': 'برای کدام سایت' }) as HTMLSelectElement;
  const loginBtn = h('button.btn', { type: 'button' }, '🔗 گرفتن ورود');
  const shareNote = h('p.muted', {}, 'سایت‌هایی که فقط آخرین ورود هر حساب را معتبر نگه می‌دارند (مثل پنل خط وب)، با هر ورود تازه ورود بقیه را می‌بندند. راه درست: یک بار وارد شوید، بعد ورود همین مرورگر را به همه‌ی ایجنت‌ها بدهید و دیگر کسی دوباره وارد نشود.');
  const shareHost = h('select', { 'aria-label': 'ورود کدام سایت' }) as HTMLSelectElement;
  const shareBtn = h('button.btn.primary', { type: 'button' }, '📣 ورود این مرورگر را به همه‌ی ایجنت‌ها بده');
  const loginBox = h('details.wb-login', {}, h('summary', {}, '🔗 ورود از ایجنت دیگر'), h('p.muted', {}, 'اگر در مرورگر یک ایجنت دیگر به سایتی وارد شده‌اید، همان ورود (کوکی‌ها و توکن صفحه، فقط برای همان یک سایت) به مرورگر این ایجنت هم داده می‌شود؛ لازم نیست دوباره وارد شوید.'), h('div.wb-login-row', {}, loginFrom, loginHost, loginBtn), shareNote, h('div.wb-login-row', {}, shareHost, shareBtn));
  const form = h('form.wb-toolbar', {}, back, forward, reload, address, go, take, realBtn);
  const panel = h('section.worker-browser', { 'aria-label': 'Worker browser' }, form, h('div.wb-meta', {}, title, lightLabel, mode, status), ask, frame, activity, loginBox, h('footer.wb-footer', {}, h('span', {}, '🔒 Isolated profile · shared with the people in this office'), h('span', {}, 'Human and agent controls take turns')));
  const qs = () => new URLSearchParams({ floor: store.floor ?? '', worker: workerId });
  const endpoint = (name: string) => `/api/worker-browser/${name}?${qs().toString()}`;
  let shown = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let state: BrowserState = { open: false, control: 'agent' };
  let busy = false;
  let imageUrl = '';
  /** The live picture is on (the <img> has the stream), or it failed and screenshots are used. */
  let live = false;
  let fallback = false;
  let failures = 0;
  /** A closed browser with a last page is opened again once each time the tab is shown. */
  let resumed = false;
  let activityKey = '';

  const request = async (action: string, extra: Record<string, unknown> = {}) => {
    if (busy) return;
    busy = true;
    try {
      const response = await fetch(endpoint('action'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...extra }) });
      const result = await response.json() as BrowserState & { error?: string };
      if (!response.ok) throw new Error(result.error || `Browser action failed (${response.status})`);
      apply(result);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Browser action failed', 'warn');
    } finally {
      busy = false;
      if (shown) void refresh();
    }
  };

  const apply = (next: BrowserState) => {
    state = next;
    address.value = state.url ?? address.value;
    title.textContent = state.title || state.url || fa('Private worker browser');
    paintState();
    syncPicture();
    if (shown && !state.open && state.last && !state.real && !resumed) {
      resumed = true;
      setTimeout(() => void request('resume'), 60);
    }
  };

  /** The picture follows the browser: the stream while it is open and shown, nothing otherwise. */
  const syncPicture = () => {
    const want = shown && state.open && !fallback;
    if (want && !live) {
      live = true;
      image.src = `${endpoint('stream')}&t=${Date.now()}`;
    } else if (!want && live) {
      live = false;
      image.removeAttribute('src');
    }
    if (!state.open || !shown) {
      if (!live) image.removeAttribute('src');
      if (imageUrl) URL.revokeObjectURL(imageUrl);
      imageUrl = '';
    }
  };

  const startTimer = () => {
    if (timer) clearInterval(timer);
    timer = shown ? setInterval(() => void refresh(), fallback ? FALLBACK_MS : STATUS_MS) : undefined;
  };

  const refresh = async () => {
    if (!shown || busy) return;
    try {
      const response = await fetch(endpoint('view'), { cache: 'no-store' });
      if (!response.ok) throw new Error('The browser status could not be loaded.');
      apply(await response.json() as BrowserState);
      void loadActivity();
      if (state.open && fallback) {
        const imageResponse = await fetch(endpoint('screenshot'), { cache: 'no-store' });
        if (!imageResponse.ok) throw new Error('The browser preview is not available yet.');
        if (imageUrl) URL.revokeObjectURL(imageUrl);
        imageUrl = URL.createObjectURL(await imageResponse.blob());
        image.src = imageUrl;
      }
    } catch (error) {
      state = { open: false, control: 'agent', error: error instanceof Error ? error.message : 'Browser preview unavailable.' };
      paintState();
      syncPicture();
    }
  };

  const relTime = (iso: string) => new Date(iso).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  /** What this browser did lately, and whose login could be copied: read with the status, drawn only when it changed. */
  const loadActivity = async () => {
    try {
      const res = await fetch(endpoint('activity'), { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as { activity: Row[]; sources: Source[]; own: string[] };
      const key = JSON.stringify(data);
      if (key === activityKey) return;
      activityKey = key;
      activityList.replaceChildren(...(data.activity.length ? data.activity.map((r) => h('div.wb-act', { class: r.actor }, h('time', {}, relTime(r.at)), h('b', {}, r.actor === 'person' ? 'شما' : 'ایجنت'), h('span', {}, ACTION_FA[r.action] ?? r.action), r.detail && !/^main >|^div:/.test(r.detail) ? h('small', { dir: 'ltr' }, r.detail) : null, r.url ? h('small.wb-act-url', { dir: 'ltr' }, r.url) : null)) : [h('div.wb-act-empty', {}, 'هنوز کاری در این مرورگر ثبت نشده.')]));
      const keep = loginFrom.value;
      loginFrom.replaceChildren(h('option', { value: '' }, 'از کدام ایجنت؟'), ...data.sources.map((x) => h('option', { value: x.id }, x.name)));
      loginFrom.value = data.sources.some((x) => x.id === keep) ? keep : '';
      fillHosts(data.sources);
      sources = data.sources;
      const keepHost = shareHost.value;
      shareHost.replaceChildren(...data.own.map((hst) => h('option', { value: hst }, hst)));
      if (data.own.includes(keepHost)) shareHost.value = keepHost;
      shareHost.classList.toggle('hidden', !data.own.length);
      shareBtn.classList.toggle('hidden', !data.own.length);
      loginBox.classList.toggle('hidden', !data.sources.length && !data.own.length);
    } catch {
      // The next status read tries again.
    }
  };
  let sources: Source[] = [];
  const fillHosts = (list: Source[]) => {
    const hosts = list.find((x) => x.id === loginFrom.value)?.hosts ?? [];
    loginHost.replaceChildren(...hosts.map((hst) => h('option', { value: hst }, hst)));
  };
  loginFrom.addEventListener('change', () => fillHosts(sources));
  loginBtn.addEventListener('click', () => {
    if (!loginFrom.value || !loginHost.value) return;
    if (!confirm(`ورود ${loginHost.value} از مرورگر «${loginFrom.selectedOptions[0].textContent}» به این مرورگر هم داده شود؟`)) return;
    void request('copyLogin', { from: loginFrom.value, host: loginHost.value }).then(() => toast('ورود گرفته شد؛ صفحه را دوباره باز کنید'));
  });

  shareBtn.addEventListener('click', () => {
    if (!shareHost.value) return;
    if (!confirm(`ورود ${shareHost.value} از این مرورگر به مرورگر همه‌ی ایجنت‌های دیگر هم داده شود؟ (ورودهای قبلی آن‌ها جایگزین می‌شود)`)) return;
    void request('shareLogin', { host: shareHost.value }).then(() => toast('ورود به همه‌ی ایجنت‌ها داده شد'));
  });

  const paintState = () => {
    const isOpen = state.open;
    frame.classList.toggle('open', isOpen);
    empty.classList.toggle('hidden', isOpen);
    image.classList.toggle('hidden', !isOpen);
    panel.classList.toggle('person-control', state.control === 'person');
    take.textContent = state.control === 'person' ? `✓ ${fa('Human control · resume agent')}` : fa('Take control');
    take.setAttribute('aria-pressed', String(state.control === 'person'));
    status.textContent = state.real ? 'پنجره‌ی واقعی Chrome روی صفحه‌ی این کامپیوتر باز است؛ وارد شوید و آن را ببندید' : state.error ? fa(state.error) : isOpen ? state.control === 'person' ? fa('The browser is under human control') : fa('The agent is using this browser') : fa('Browser is ready when you are');
    status.classList.toggle('error', !!state.error && !state.real);
    resumeBtn.classList.toggle('hidden', !(state.last && !state.real && !isOpen));
    emptyText.textContent = state.last && !state.real && !isOpen ? `مرورگر بسته است. آخرین صفحه: ${state.last.url}` : state.real ? 'پنجره‌ی Chrome روی صفحه‌ی این کامپیوتر باز شده. وارد سایت شوید یا چالش را خودتان حل کنید و بعد پنجره را ببندید؛ مرورگر ایجنت با همان ورود دوباره باز می‌شود.' : 'The page the agent opens appears here. Its browsing session is isolated from your personal Chrome profile.';
    mode.value = state.mode ?? 'ask';
    light.checked = !!state.light;
    realBtn.disabled = !!state.real;
    ask.classList.toggle('hidden', !state.pending);
    if (state.pending) askText.textContent = `ایجنت می‌خواهد «${state.pending.label}» را ${state.pending.action === 'press' ? 'با Enter بفرستد' : 'بزند'} (${state.pending.url}). اجازه می‌دهید؟`;
    back.disabled = forward.disabled = reload.disabled = !isOpen || state.control !== 'person';
    go.disabled = !address.value.trim() || !!state.real;
  };

  // ---- What the person does on the picture: sent one after another, without waiting for the page ----

  let queue: Promise<unknown> = Promise.resolve();
  let pendingMove: RawInput | undefined;
  const sendInput = (ev: RawInput) => {
    queue = queue.then(() => fetch(endpoint('input'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ev) })
      .then(async (r) => { if (!r.ok && r.status !== 204) { const out = (await r.json().catch(() => ({}))) as { error?: string }; if (out.error) toast(out.error, 'warn'); } })
      .catch(() => undefined));
  };
  /** Mouse moves are many: only the latest one waits its turn. */
  const sendMove = (ev: RawInput) => {
    const had = pendingMove;
    pendingMove = ev;
    if (had) return;
    setTimeout(() => {
      const next = pendingMove;
      pendingMove = undefined;
      if (next) sendInput(next);
    }, 50);
  };
  const at = (event: MouseEvent) => {
    const rect = image.getBoundingClientRect();
    return rect.width && rect.height ? { x: (event.clientX - rect.left) * (PAGE_W / rect.width), y: (event.clientY - rect.top) * (PAGE_H / rect.height) } : undefined;
  };
  const person = () => state.open && state.control === 'person';
  const button = (event: MouseEvent): 'left' | 'right' | 'middle' => (event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left');

  resumeBtn.addEventListener('click', () => void request('resume'));
  empty.querySelector('.wb-open')!.addEventListener('click', () => {
    const url = address.value.trim() || 'https://www.google.com';
    void request('open', { url });
  });
  mode.addEventListener('change', () => void request('mode', { mode: mode.value }));
  light.addEventListener('change', () => void request('light', { on: light.checked }));
  realBtn.addEventListener('click', () => {
    if (!confirm('مرورگر ایجنت بسته می‌شود و یک پنجره‌ی Chrome معمولی روی صفحه‌ی همین کامپیوتر باز می‌شود. خودتان وارد شوید یا چالش را رد کنید و بعد پنجره را ببندید. ادامه؟')) return;
    void request('real', { url: address.value.trim() || undefined });
  });
  allow.addEventListener('click', () => void request('allow'));
  deny.addEventListener('click', () => void request('deny'));
  take.addEventListener('click', () => void request(state.control === 'person' ? 'release' : 'take'));
  back.addEventListener('click', () => void request('back'));
  forward.addEventListener('click', () => void request('forward'));
  reload.addEventListener('click', () => void request('reload'));
  form.addEventListener('submit', (event) => { event.preventDefault(); void request(state.open ? 'navigate' : 'open', { url: address.value.trim() }); });
  address.addEventListener('input', paintState);

  image.addEventListener('load', () => { failures = 0; });
  image.addEventListener('error', () => {
    // The stream failed to come: try it once more, then fall back to screenshots.
    if (!live || !shown) return;
    live = false;
    if (++failures >= 2) {
      fallback = true;
      startTimer();
      void refresh();
    } else syncPicture();
  });

  frame.addEventListener('mousedown', (event) => {
    if (!person()) return;
    const p = at(event);
    if (!p) return;
    event.preventDefault();
    frame.focus();
    sendInput({ t: 'down', ...p, button: button(event) });
  });
  frame.addEventListener('mouseup', (event) => {
    if (!person()) return;
    const p = at(event);
    if (p) sendInput({ t: 'up', ...p, button: button(event) });
  });
  frame.addEventListener('mousemove', (event) => {
    if (!person()) return;
    const p = at(event);
    if (p) sendMove({ t: 'move', ...p });
  });
  frame.addEventListener('contextmenu', (event) => { if (person()) event.preventDefault(); });
  frame.addEventListener('wheel', (event) => {
    if (!person()) return;
    event.preventDefault();
    sendInput({ t: 'wheel', dx: event.deltaX, dy: event.deltaY });
  }, { passive: false });
  frame.addEventListener('keydown', (event) => {
    if (!person() || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    if (SPECIAL_KEYS.includes(event.key)) {
      event.preventDefault();
      sendInput({ t: 'key', key: event.key });
    } else if (event.key.length === 1) {
      event.preventDefault();
      sendInput({ t: 'text', text: event.key });
    }
  });
  frame.addEventListener('paste', (event) => {
    if (!person()) return;
    const text = event.clipboardData?.getData('text');
    if (text) {
      event.preventDefault();
      sendInput({ t: 'text', text: text.slice(0, 1000) });
    }
  });
  paintState();

  return {
    panel,
    visible(on) {
      shown = on;
      if (!on) resumed = false;
      startTimer();
      syncPicture();
      if (on) void refresh();
    },
    dispose() {
      if (timer) clearInterval(timer);
      shown = false;
      syncPicture();
      if (state.control === 'person') void request('release');
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    },
  };
}
