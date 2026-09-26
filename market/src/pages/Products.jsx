import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { fetchGradedCards, fetchSearch } from '../api.js';
import CardSelectGrid from '../components/CardSelectGrid.jsx';
import CardTile from '../components/CardTile.jsx';
import { SkeletonTile } from '../components/Carousel.jsx';
import { Alert, EmptyDesk, PageHead } from '../components/Desk.jsx';

const PRODUCTS = {
  box: {
    title: 'Booster boxes',
    query: 'booster box',
    productType: 'booster_box',
    unit: 'products',
    lede: 'Marketplace search for booster boxes.',
  },
  pack: {
    title: 'Booster packs',
    query: 'booster',
    productType: 'booster_pack',
    unit: 'products',
    lede: 'Marketplace search for booster packs.',
  },
  graded: {
    title: 'Graded cards',
    mode: 'graded',
    unit: 'cards',
    lede: 'PSA, BGS, CGC, and other slabbed listings from sellers on Pokoin.',
  },
  jumbo: {
    title: 'Jumbo cards',
    query: 'jumbo oversized',
    productType: 'jumbo',
    unit: 'cards',
    lede: 'Oversized jumbo printings — their own product type, across every era.',
  },
  nft: {
    title: 'NFT',
    query: 'nft',
    productType: '',
    unit: 'products',
    lede: 'Live NFT catalog search. Owned holdings and shipping requests live on /collection after nft_only checkout.',
  },
};

function loadAisle(spec, { offset = 0, limit = 48 } = {}) {
  if (spec.mode === 'graded') {
    return fetchGradedCards({ limit });
  }
  return fetchSearch({
    query: spec.query,
    productType: spec.productType,
    offset,
    limit,
  });
}

export default function Products() {
  const { kind = 'box' } = useParams();
  const spec = PRODUCTS[kind] || PRODUCTS.box;
  const [cards, setCards] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    document.title = `${spec.title} · Pokoin`;
    let cancelled = false;
    setLoading(true);
    loadAisle(spec, { limit: 48 })
      .then((data) => {
        if (cancelled) return;
        setCards(data.cards || []);
        setHasMore(Boolean(data.hasMore));
        setError('');
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Product search failed.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [kind, spec]);

  async function loadMore() {
    if (spec.mode === 'graded') return;
    const data = await loadAisle(spec, {
      offset: cards.length,
      limit: 48,
    });
    const extra = data.cards || [];
    setCards((current) => [...current, ...extra]);
    setHasMore(Boolean(data.hasMore));
  }

  const emptyLede = kind === 'graded'
    ? 'No active PSA / BGS / CGC listings yet. List a graded card from inventory or Scan Connect.'
    : 'Try another product type or search from the bar.';

  return (
    <div className="page desk">
      <PageHead
        kicker="Products"
        title={spec.title}
        lede={spec.lede}
      />
      <nav className="comp-tabs" aria-label="Product types">
        {Object.entries(PRODUCTS).map(([id, row]) => (
          <Link key={id} className={kind === id ? 'on' : undefined} to={`/product/${id}`}>
            {row.title}
          </Link>
        ))}
      </nav>
      <div className="shop-toolbar">
        <p className="result-count">
          {loading
            ? 'Loading…'
            : (cards.length
              ? <><strong>{cards.length.toLocaleString('en-US')}{hasMore ? '+' : ''}</strong> {spec.unit}</>
              : (kind === 'graded' ? 'No graded cards listed.' : 'No products in that search.'))}
        </p>
      </div>
      <Alert>{error}</Alert>
      {!loading && !cards.length && !error ? (
        <EmptyDesk title="Nothing in this aisle" lede={emptyLede}>
          <Link className="btn" to="/marketplace">Shop</Link>
        </EmptyDesk>
      ) : (
        <CardSelectGrid className="grid" cards={loading ? [] : cards}>
          {loading
            ? Array.from({ length: 12 }, (_, index) => <SkeletonTile key={index} />)
            : cards.map((card, index) => (
                <CardTile key={card.id} card={card} rank={index} />
              ))}
        </CardSelectGrid>
      )}
      {hasMore ? <button className="more" type="button" onClick={loadMore}>Load more</button> : null}
    </div>
  );
}
