import { h } from '../../ui/dom';

// The change a re-interview proposes, shown line by line against the profile as it is now (see hiring.ts).

export interface Line { t: 'same' | 'add' | 'del'; text: string }

/** The lines of `after` against `before`: kept, added and removed ones, in order. */
export function lineDiff(before: string, after: string): Line[] {
  const a = before.replace(/\r\n?/g, '\n').trimEnd().split('\n');
  const b = after.replace(/\r\n?/g, '\n').trimEnd().split('\n');
  const n = a.length;
  const m = b.length;
  // Longest common subsequence, from the ends.
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: Line[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ t: 'same', text: a[i++] });
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ t: 'del', text: a[i++] });
    else out.push({ t: 'add', text: b[j++] });
  }
  while (i < n) out.push({ t: 'del', text: a[i++] });
  while (j < m) out.push({ t: 'add', text: b[j++] });
  return out;
}

/** A file's change as a box: only the changed lines and a line of context round them; «بدون تغییر» when there is none. */
export function diffBox(title: string, before: string, after: string): HTMLElement {
  const lines = lineDiff(before, after);
  const changed = lines.filter((l) => l.t !== 'same').length;
  const keep = lines.map((_, k) => lines.slice(Math.max(0, k - 1), k + 2).some((x) => x.t !== 'same'));
  const rows: HTMLElement[] = [];
  lines.forEach((l, k) => {
    if (!keep[k]) {
      if (keep[k - 1]) rows.push(h('div.hr-dl.gap', {}, '…'));
      return;
    }
    rows.push(h(`div.hr-dl.${l.t}`, { dir: 'auto' }, `${l.t === 'add' ? '+ ' : l.t === 'del' ? '− ' : '  '}${l.text}`));
  });
  return h('details.hr-diff', { open: changed > 0 }, h('summary', {}, `${title} · ${changed ? `${changed} خط تغییر` : 'بدون تغییر'}`), h('div.hr-dlines', {}, ...rows));
}
