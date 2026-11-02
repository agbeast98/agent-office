/** The manager's computer: the monitor on the boss's desk upstairs, and the 👑 in the menu, open the team's tasks. */
import type { Ctx } from '../../core/context';
import { aside, hintTitle, key, onE } from '../../core/hint';
import { openManager } from './ui';
import { toast } from '../../ui/dom';
import { store } from '../../state';

// The kinds of thing you can use that this defines (see InteractKinds in world/types.ts).
declare module '../../world/types' {
  interface InteractKinds {
    manager: true;
  }
}

export function installManager(ctx: Ctx) {
  const show = () => (store.floor ? openManager(store.floor) : toast('اول با آسانسور به یک طبقه برو', 'warn'));
  ctx.interactions.define('manager', {
    reach: 3,
    hint: () => ({ k: 'manager', parts: [hintTitle('👑 کامپیوتر مدیر'), aside('کارها و دستورها'), key('E', 'باز کردن')] }),
    use: onE(() => show()),
  });
  // A worker sat down at the meeting table: the team meeting tells it what it is about.
  window.addEventListener('office:seated', (e) => {
    if (!store.floor) return;
    void fetch(`/api/team/meeting?floor=${encodeURIComponent(store.floor)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'arrived', worker: (e as CustomEvent<string>).detail }) }).catch(() => {});
  });
  return { showManager: show };
}
