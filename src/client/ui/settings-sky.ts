// ⚙️ Settings' Outside, under Building: what the sky's doing, and which clock it keeps, for everyone
// (see server/sky.ts).
import type { Net } from '../net';
import { store } from '../state';
import { h } from './dom';
import { describeSky } from '../world/sky';
import { fa } from './fa-locale';

/**
 * The setting, made by `frame` from what goes in it: the sky now (`outside`, see describeSky), the
 * real time of day or a whole day and night every hour as buttons, and a note. Kept up to date until `off`.
 */
export function outsideSetting(net: Net, outside: { now: string; live: boolean }, frame: (body: Node[]) => HTMLElement): { section: HTMLElement; off: () => void } {
  const row = h('div.seg', { role: 'radiogroup', 'aria-label': fa('The sky’s clock') });
  const now = h('p.outside-now');
  const note = h('p.setting-note');
  const paint = () => {
    const real = !!store.sky?.realTime;
    const skyText = store.sky ? describeSky(store.sky) : outside.now;
    const parts = /^(.+?) · (.+?) outside(?: · (.+))?$/.exec(skyText);
    now.textContent = parts ? `${fa(parts[1])} · ${parts[2]} بیرون${parts[3] ? ` · ${parts[3]}` : ''}` : fa(skyText);
    row.replaceChildren(
      ...[true, false].map((r) =>
        h(
          'button.btn',
          {
            type: 'button',
            role: 'radio',
            'aria-checked': String(real === r),
            class: real === r ? 'on' : '',
            onclick: () => r !== !!store.sky?.realTime && net.send({ t: 'sky.clock', real: r }),
          },
          fa(r ? '🕰️ Real time (24 h)' : '⏩ A day every hour'),
        ),
      ),
    );
    note.textContent = `${fa('Everyone sees the same sky:')} ${fa(real ? 'the real time of day' : 'a whole day and night every hour')}, ${fa(outside.live ? 'and the live weather where it is.' : 'and weather that comes and goes. Start the office with')} ${outside.live ? '' : '--city'} ${outside.live ? '' : fa('to use a real city’s forecast.')}`.trim();
  };
  paint();
  return { section: frame([now, row, note]), off: store.on('sky', paint) };
}
