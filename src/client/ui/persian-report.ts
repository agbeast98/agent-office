import type { Terminal } from '@xterm/xterm';
import { h } from './dom';
import './persian-report.css';

/** xterm has already interpreted cursor moves and escape codes. Join soft wraps
 * before handing logical lines to the browser's Unicode bidi renderer. */
export function reportText(buffer: Terminal['buffer']['active']): string {
  const lines: string[] = [];
  for (let row = Math.max(0, buffer.length - 500); row < buffer.length; row++) {
    const line = buffer.getLine(row);
    if (!line) continue;
    const continues = buffer.getLine(row + 1)?.isWrapped;
    const text = line.translateToString(!continues);
    if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  return lines.join('\n').trimEnd();
}

export function persianReport(read: () => string, send?: (prompt: string) => boolean) {
  const output = h('div.fa-output', { tabindex: 0, 'aria-label': 'متن خروجی این میز' });
  const prompt = h('textarea', { rows: 2, dir: 'auto', placeholder: 'پیامت را برای همین میز بنویس…', 'aria-label': 'پیام به این میز' });
  const feedback = h('span', { role: 'status' });
  const form = h('form.fa-compose', {}, prompt, h('div', {}, h('button.btn.primary', { type: 'submit' }, 'ارسال با درخواست پاسخ فارسی'), feedback));
  const el = h('section.fa-report.hidden', { lang: 'fa', dir: 'rtl', role: 'tabpanel', 'aria-label': 'گزارش فارسی' },
    h('strong', {}, 'خروجی زندهٔ این میز'), output, send ? form : null);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = prompt.value.trim();
    if (!text) return;
    if (send?.('پاسخ را به فارسی بنویس. نام فایل‌ها، دستورها و کد را به زبان اصلی حفظ کن.\n\n' + text)) {
      prompt.value = '';
      feedback.textContent = 'پیام برای این میز ارسال شد.';
    } else feedback.textContent = 'این میز هنوز آمادهٔ دریافت پیام نیست.';
  });
  let previous: string | undefined;
  function refresh() {
    if (el.classList.contains('hidden')) return;
    const text = read();
    if (text === previous) return;
    const follow = previous === undefined || output.scrollHeight - output.clientHeight - output.scrollTop < 6;
    previous = text;
    output.textContent = text || 'هنوز خروجی‌ای از این میز نرسیده است.';
    if (follow) output.scrollTop = output.scrollHeight;
  }
  return { el, refresh };
}
