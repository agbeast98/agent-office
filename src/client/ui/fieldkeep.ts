// A window that redraws itself every few seconds must not wipe what the person is typing. `keepFields` redraws a
// container and then puts back what was in its boxes (text, selects, which box had the cursor and where), matching
// the box by its kind, its placeholder or label and its place among the same: so a half-written note, decision or
// task survives the redraws, wherever the person clicked in the meantime.

type Box = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

const SKIP = new Set(['checkbox', 'radio', 'button', 'submit', 'hidden', 'file']);

function boxes(root: HTMLElement): { key: string; el: Box }[] {
  const seen = new Map<string, number>();
  return [...root.querySelectorAll<Box>('input, textarea, select')]
    .filter((el) => !(el instanceof HTMLInputElement && SKIP.has(el.type)))
    .map((el) => {
      const base = `${el.tagName}|${el.getAttribute('placeholder') ?? el.getAttribute('aria-label') ?? el.getAttribute('name') ?? ''}`;
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      return { key: `${base}|${n}`, el };
    });
}

export function keepFields(root: HTMLElement, draw: () => void) {
  const saved = new Map<string, string>();
  for (const { key, el } of boxes(root)) if (el.value) saved.set(key, el.value);
  const active = document.activeElement as Box | null;
  const focusKey = active && root.contains(active) ? boxes(root).find((b) => b.el === active)?.key : undefined;
  const caret = active && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : undefined;
  draw();
  for (const { key, el } of boxes(root)) {
    const v = saved.get(key);
    if (v !== undefined && !el.value) {
      if (el instanceof HTMLSelectElement && ![...el.options].some((o) => o.value === v)) continue;
      el.value = v;
    }
    if (key === focusKey) {
      el.focus({ preventScroll: true });
      if (caret && 'setSelectionRange' in el && caret[0] !== null && caret[1] !== null) {
        try {
          el.setSelectionRange(caret[0], caret[1]);
        } catch {
          // A box that takes no selection.
        }
      }
    }
  }
}
