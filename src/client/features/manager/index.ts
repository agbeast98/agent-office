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
  return { showManager: show };
}
