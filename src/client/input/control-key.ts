/** Native activation belongs to the focused control, rather than chat or gameplay. */
export function nativeControlKey(e: { key: string; target: EventTarget | null }): boolean {
  if (e.key !== 'Enter' && e.key !== ' ') return false;
  const target = e.target as (EventTarget & { closest?: (selector: string) => unknown }) | null;
  return !!target?.closest?.('button, a[href], [role="button"], [role="link"], summary');
}
