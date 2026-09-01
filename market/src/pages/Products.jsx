import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { fetchSearch } from '../api.js';
import CardTile from '../components/CardTile.jsx';
import { SkeletonTile } from '../components/Carousel.jsx';
import { Alert, EmptyDesk, PageHead } from '../components/Desk.jsx';

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
    <div className="page desk">
      <PageHead
        kicker="Products"
        title={spec.title}
        lede={kind === 'nft'
          ? 'Live NFT catalog search. Owned holdings and shipping requests live on /nft after nft_only checkout.'
          : `Marketplace search for ${spec.query}. Empty query + booster_box is not used here.`}
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
              ? <><strong>{cards.length.toLocaleString('en-US')}{hasMore ? '+' : ''}</strong> products</>
              : 'No products in that search.')}
        </p>
      </div>
      <Alert>{error}</Alert>
      {!loading && !cards.length && !error ? (
        <EmptyDesk title="Nothing in this aisle" lede="Try another product type or search from the bar.">
          <Link className="btn" to="/marketplace">Shop</Link>
        </EmptyDesk>
      ) : (
        <div className="grid">
          {loading
            ? Array.from({ length: 12 }, (_, index) => <SkeletonTile key={index} />)
            : cards.map((card, index) => (
                <CardTile key={card.id} card={card} rank={index} />
              ))}
        </div>
      )}
      {hasMore ? <button className="more" type="button" onClick={loadMore}>Load more</button> : null}
    </div>
  );
}
