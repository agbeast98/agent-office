/** Viewport-clamped dropdown coordinates, independent of text direction and anchor side. */
export function popupPosition(anchor: { left: number; right: number; bottom: number }, width: number, viewport: { width: number; height: number; left?: number; top?: number }) {
  const x = viewport.left ?? 0;
  const y = viewport.top ?? 0;
  const margin = 8;
  const availableWidth = Math.max(0, viewport.width - margin * 2);
  const actualWidth = Math.min(width, availableWidth);
  const preferred = (anchor.left + anchor.right) / 2 < x + viewport.width / 2 ? anchor.left : anchor.right - actualWidth;
  const left = Math.max(x + margin, Math.min(preferred, x + viewport.width - actualWidth - margin));
  const top = Math.max(y + margin, Math.min(anchor.bottom + margin, y + Math.max(margin, viewport.height - 128)));
  return { left, top, maxHeight: Math.max(0, y + viewport.height - top - margin), maxWidth: availableWidth };
}
