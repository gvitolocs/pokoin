import { For, Match, Show, Switch } from 'solid-js';
import { useParams } from '@solidjs/router';
import { guideHref, LANGUAGE_HUBS, RARITY_HUBS, SEO_GUIDES } from '@market/seo.js';
import { EmptyDesk, PageHead } from '../components/Desk.jsx';
import SeoCrumbs from '../components/desk/SeoCrumbs.jsx';
import SeoHead from '../components/SeoHead.jsx';

/** Guide bodies (same copy and links as market/src/pages/Guides.jsx). */
const BODIES = {
  'pokemon-card-condition-guide': () => (
    <>
      <p>
        Pokoin listings use the same condition axis as the card desk shop filters:
        NM, SP, MP, PL, and Poor. Those values live on the listing, not on a
        separate URL.
      </p>
      <ul>
        <li><strong>NM</strong> — Near Mint</li>
        <li><strong>SP</strong> — Slightly Played</li>
        <li><strong>MP</strong> — Moderately Played</li>
        <li><strong>PL</strong> — Played</li>
        <li><strong>Poor</strong> — Heavily worn or damaged</li>
      </ul>
      <p>
        Do not index every condition combination. Open the card desk and filter
        the shop row there.
      </p>
    </>
  ),
  'pokemon-card-rarity-guide': () => (
    <>
      <p>
        Catalog rarities come from CardTrader / leftover identity, not from
        invented tags. Each rarity below is a real hub:
      </p>
      <ol class="hub-index hub-index-wide">
        <For each={RARITY_HUBS}>
          {(row) => (
            <li>
              <a href={`/marketplace/en/rarities/${row.slug}`}>{row.name}</a>
            </li>
          )}
        </For>
      </ol>
    </>
  ),
  'how-to-value-pokemon-cards': () => (
    <>
      <p>
        The listed cheapest PKN on a card desk is the current ask. The sold-price
        graph is inferred from CardTrader listing stacks that left the book, not
        a PSA population report.
      </p>
      <p>
        Compare printings of the same Pokémon on the species hub, then open the
        card desk for that exact set and collector number.
      </p>
      <p>
        Print language hubs:
        {' '}
        <For each={LANGUAGE_HUBS}>
          {(row, index) => (
            <span>
              <Show when={index()}>{', '}</Show>
              <a href={`/marketplace/en/languages/${row.slug}`}>{row.name}</a>
            </span>
          )}
        </For>
        .
      </p>
    </>
  ),
};

function GuidesIndex() {
  return (
    <div class="page desk hub-page">
      <SeoHead
        title="Pokémon Card Guides | Pokoin"
        description="Short Pokoin guides: card condition, rarity, and how listed PKN and sold graphs work."
        canonical="/marketplace/en/guides"
      />
      <SeoCrumbs items={[
        { name: 'Marketplace', href: '/marketplace' },
        { name: 'Guides' },
      ]} />
      <PageHead kicker="Guides" title="Guides" />
      <ol class="hub-index hub-index-wide">
        <For each={SEO_GUIDES}>
          {(row) => (
            <li>
              <a href={guideHref(row.slug)}>{row.title}</a>
            </li>
          )}
        </For>
      </ol>
    </div>
  );
}

function Guide(props) {
  return (
    <div class="page desk hub-page">
      <SeoHead
        title={props.guide.documentTitle}
        description={props.guide.lede}
        canonical={guideHref(props.guide.slug)}
      />
      <SeoCrumbs items={[
        { name: 'Marketplace', href: '/marketplace' },
        { name: 'Guides', href: '/marketplace/en/guides' },
        { name: props.guide.title },
      ]} />
      <PageHead kicker="Guide" title={props.guide.title} />
      <article class="guide-body">{BODIES[props.guide.slug]?.()}</article>
    </div>
  );
}

/** /marketplace/:lang/guides(/:slug) (market/src/pages/Guides.jsx). */
export default function Guides() {
  const params = useParams();
  const guide = () => SEO_GUIDES.find((row) => row.slug === params.slug) || null;
  return (
    <Switch>
      <Match when={!params.slug}><GuidesIndex /></Match>
      <Match when={!guide()}>
        <div class="page desk hub-page">
          <EmptyDesk title="Unknown guide" lede="Open the guides index.">
            <a class="btn" href="/marketplace/en/guides">Guides</a>
          </EmptyDesk>
        </div>
      </Match>
      <Match when={guide()} keyed>{(row) => <Guide guide={row} />}</Match>
    </Switch>
  );
}
