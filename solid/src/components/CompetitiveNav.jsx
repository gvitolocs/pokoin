import { For, Show } from 'solid-js';
import { useLocation } from '@solidjs/router';
import { COMP_NAV, FLAG, SPRITE, competitiveData } from '@market/competitive.js';
import CardArt from './CardArt.jsx';
import { PageHead } from './Desk.jsx';

/** Head and section tabs shared by the competitive pages (market/src/components/CompetitiveNav.jsx). */
export default function CompetitiveNav() {
  const location = useLocation();
  const data = competitiveData();
  const title = () => {
    const active = COMP_NAV.find((row) => row.match(location.pathname));
    return !active || active.label === 'Overview' ? 'Competitive' : active.label;
  };
  return (
    <>
      <PageHead
        kicker="Play"
        title={title()}
        lede={`${data.formatLabel} · Pokoin snapshot (Oracle assets, not Limitless CDN)`}
      />
      <nav class="comp-tabs" aria-label="Competitive">
        <For each={COMP_NAV}>
          {(row) => (
            <a class={{ on: row.match(location.pathname) }} href={row.to}>{row.label}</a>
          )}
        </For>
      </nav>
    </>
  );
}

/** Country flag sprite; nothing without a code. */
export function Flag(props) {
  return (
    <Show when={props.cc}>
      <CardArt class="comp-flag" src={FLAG(props.cc)} alt={props.cc} fallback="hide" />
    </Show>
  );
}

/** Deck sprite; nothing for a deck without one. */
export function Sprite(props) {
  return (
    <Show when={props.deck?.sprite}>
      <CardArt class="comp-sprite" src={SPRITE(props.deck.sprite)} alt="" fallback="hide" />
    </Show>
  );
}

/** The "not in the snapshot" page every competitive detail route falls back to. */
export function NotInSnapshot(props) {
  return (
    <div class="page desk comp-page">
      <CompetitiveNav />
      <p class="status error">{props.children}</p>
    </div>
  );
}
