import { Link, useParams } from 'react-router-dom';
import { EmptyDesk, PageHead } from '../components/Desk.jsx';
import SeoCrumbs from '../components/SeoCrumbs.jsx';
import SeoHead from '../components/SeoHead.jsx';
import { guideHref, LANGUAGE_HUBS, RARITY_HUBS, SEO_GUIDES } from '../seo.js';

const BODIES = {
  'pokemon-card-condition-guide': (
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
  'pokemon-card-rarity-guide': (
    <>
      <p>
        Catalog rarities come from CardTrader / leftover identity, not from
        invented tags. Each rarity below is a real hub:
      </p>
      <ol className="hub-index hub-index-wide">
        {RARITY_HUBS.map((row) => (
          <li key={row.slug}>
            <Link to={`/marketplace/en/rarities/${row.slug}`}>{row.name}</Link>
          </li>
        ))}
      </ol>
    </>
  ),
  'how-to-value-pokemon-cards': (
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
        {LANGUAGE_HUBS.map((row, index) => (
          <span key={row.slug}>
            {index ? ', ' : null}
            <Link to={`/marketplace/en/languages/${row.slug}`}>{row.name}</Link>
          </span>
        ))}
        .
      </p>
    </>
  ),
};

function GuidesIndex() {
  return (
    <div className="page desk hub-page">
      <SeoHead
        title="Pokémon Card Guides | Pokoin"
        description="Short Pokoin guides: card condition, rarity, and how listed PKN and sold graphs work."
        canonical="/marketplace/en/guides"
      />
      <SeoCrumbs items={[
        { name: 'Marketplace', href: '/marketplace' },
        { name: 'Guides' },
      ]} />
      <PageHead
        kicker="Guides"
        title="Guides"
      />
      <ol className="hub-index hub-index-wide">
        {SEO_GUIDES.map((row) => (
          <li key={row.slug}>
            <Link to={guideHref(row.slug)}>{row.title}</Link>
          </li>
        ))}
      </ol>
    </div>
  );
}

export default function Guides() {
  const { slug } = useParams();
  const guide = SEO_GUIDES.find((row) => row.slug === slug) || null;
  if (!slug) {
    return <GuidesIndex />;
  }
  if (!guide) {
    return (
      <div className="page desk hub-page">
        <EmptyDesk title="Unknown guide" lede="Open the guides index.">
          <Link className="btn" to="/marketplace/en/guides">Guides</Link>
        </EmptyDesk>
      </div>
    );
  }
  return (
    <div className="page desk hub-page">
      <SeoHead
        title={guide.documentTitle}
        description={guide.lede}
        canonical={guideHref(guide.slug)}
      />
      <SeoCrumbs items={[
        { name: 'Marketplace', href: '/marketplace' },
        { name: 'Guides', href: '/marketplace/en/guides' },
        { name: guide.title },
      ]} />
      <PageHead kicker="Guide" title={guide.title} />
      <article className="guide-body">
        {BODIES[guide.slug]}
      </article>
    </div>
  );
}
