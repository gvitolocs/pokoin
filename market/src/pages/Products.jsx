import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { fetchSearch } from '../api.js';
import CardTile from '../components/CardTile.jsx';
import { SkeletonTile } from '../components/Carousel.jsx';

const PRODUCTS = {
  box: { title: 'Booster boxes', query: 'booster box', productType: 'booster_box' },
  pack: { title: 'Booster packs', query: 'booster', productType: 'booster_pack' },
  graded: { title: 'Graded cards', query: 'graded', productType: '' },
  nft: { title: 'NFT', query: 'nft', productType: '' },
};

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
    fetchSearch({ query: spec.query, productType: spec.productType, limit: 48 })
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
  }, [kind, spec.query, spec.productType, spec.title]);

  async function loadMore() {
    const data = await fetchSearch({
      query: spec.query,
      productType: spec.productType,
      offset: cards.length,
      limit: 48,
    });
    const extra = data.cards || [];
    setCards((current) => [...current, ...extra]);
    setHasMore(Boolean(data.hasMore));
  }

  return (
    <div className="page">
      <p className="eyebrow">Products</p>
      <h1>{spec.title}</h1>
      <nav className="comp-tabs" aria-label="Product types">
        {Object.entries(PRODUCTS).map(([id, row]) => (
          <Link key={id} className={kind === id ? 'on' : undefined} to={`/product/${id}`}>
            {row.title}
          </Link>
        ))}
      </nav>
      {kind === 'nft' ? (
        <p className="muted">
          Live NFT catalog search. Owned holdings and shipping requests live on /nft after nft_only checkout.
        </p>
      ) : (
        <p className="muted">Marketplace search for {spec.query}.</p>
      )}
      {error ? <p className="status error">{error}</p> : null}
      <div className="grid">
        {loading
          ? Array.from({ length: 12 }, (_, index) => <SkeletonTile key={index} />)
          : cards.map((card, index) => (
              <CardTile key={card.id} card={card} rank={index} />
            ))}
      </div>
      {!loading && !cards.length && !error ? <p className="muted">No products in that search.</p> : null}
      {hasMore ? <button className="more" type="button" onClick={loadMore}>Load more</button> : null}
    </div>
  );
}
