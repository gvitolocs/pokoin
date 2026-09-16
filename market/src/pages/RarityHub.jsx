import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { fetchSearch } from '../api.js';
import CardTile from '../components/CardTile.jsx';
import { SkeletonTile } from '../components/Carousel.jsx';
import { Alert, EmptyDesk, PageHead } from '../components/Desk.jsx';
import SeoCrumbs from '../components/SeoCrumbs.jsx';
import SeoHead from '../components/SeoHead.jsx';
import { searchRarity } from '../search-filters.js';
import { RARITY_HUBS, rarityFromSlug, rarityHref, raritySlug } from '../seo.js';

function rarityMatches(card, hub) {
  const value = raritySlug(searchRarity(card));
  if (!value) {
    return false;
  }
  if (value === hub.slug) {
    return true;
  }
  if (hub.slug === 'promo') {
    return value.includes('promo');
  }
  if (hub.slug === 'full-art') {
    return value.includes('full-art') || value.includes('fullart');
  }
  return value.includes(hub.slug);
}

function RarityIndex({ lang }) {
  return (
    <div className="page desk hub-page">
      <SeoHead
        title="Pokémon Card Rarities | Pokoin"
        description="Browse Pokémon TCG cards by rarity: Common, Illustration Rare, Special Illustration Rare, Full-Art, Promo, and more."
        canonical={`/marketplace/${lang}/rarities`}
      />
      <SeoCrumbs items={[
        { name: 'Marketplace', href: '/marketplace' },
        { name: 'Rarities' },
      ]} />
      <PageHead
        kicker="Catalog"
        title="Rarities"
      />
      <ol className="hub-index hub-index-wide">
        {RARITY_HUBS.map((row) => (
          <li key={row.slug}>
            <Link to={rarityHref(row.slug, lang)}>{row.name}</Link>
          </li>
        ))}
      </ol>
    </div>
  );
}

export default function RarityHub() {
  const { lang = 'en', slug } = useParams();
  const hub = slug ? rarityFromSlug(slug) : null;
  const [cards, setCards] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!hub) {
      setCards(null);
      return undefined;
    }
    let cancelled = false;
    setCards(null);
    fetchSearch({ query: hub.name, limit: 48, lang, productType: 'card' })
      .then((data) => {
        if (cancelled) return;
        setCards((data.cards || []).filter((card) => rarityMatches(card, hub)));
        setError('');
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Rarity cards failed.');
      });
    return () => {
      cancelled = true;
    };
  }, [hub?.slug, lang]);

  const shown = useMemo(() => cards || [], [cards]);

  if (!slug) {
    return <RarityIndex lang={lang} />;
  }
  if (!hub) {
    return (
      <div className="page desk hub-page">
        <EmptyDesk title="Unknown rarity" lede="Open the rarity index.">
          <Link className="btn" to={`/marketplace/${lang}/rarities`}>Rarities</Link>
        </EmptyDesk>
      </div>
    );
  }

  const title = `${hub.name} Pokémon Cards | Pokoin`;
  const description = `${hub.name} Pokémon TCG printings on Pokoin. Compare sets, languages, and listings.`;
  return (
    <div className="page desk hub-page">
      <SeoHead
        title={title}
        description={description}
        canonical={rarityHref(hub.slug, lang)}
      />
      <SeoCrumbs items={[
        { name: 'Marketplace', href: '/marketplace' },
        { name: 'Rarities', href: `/marketplace/${lang}/rarities` },
        { name: hub.name },
      ]} />
      <PageHead kicker="Rarity" title={hub.name} />
      <p className="result-count">
        {cards == null ? 'Loading…' : <><strong>{shown.length}</strong> cards</>}
      </p>
      <Alert>{error}</Alert>
      {cards && !shown.length ? (
        <EmptyDesk title="No cards in this rarity" lede="Try another rarity or open a set desk." />
      ) : (
        <div className="grid">
          {cards == null
            ? Array.from({ length: 12 }, (_, index) => <SkeletonTile key={index} />)
            : shown.map((card, index) => (
              <CardTile key={card.id} card={card} rank={index} />
            ))}
        </div>
      )}
    </div>
  );
}
