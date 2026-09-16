import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { overlayCatalogTilePrices } from '../api.js';
import CardTile from './CardTile.jsx';

export default function RelatedCards({ card, related = [], speciesName, speciesHref }) {
  const relatedKey = (related || []).map((row) => String(row?.id || '')).join('|');
  const rows = useMemo(
    () => (related || []).filter((row) => row?.id && String(row.id) !== String(card?.id || '')),
    // Ids are the related set. New array identity from pickRelatedCards must not refetch.
    [relatedKey, card?.id],
  );
  const [priced, setPriced] = useState(rows);
  useEffect(() => {
    setPriced(rows);
    if (!rows.length) {
      return undefined;
    }
    let cancelled = false;
    overlayCatalogTilePrices(rows).then((next) => {
      if (!cancelled) {
        setPriced(next);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [rows, relatedKey]);

  if (!rows.length) {
    return null;
  }
  return (
    <section className="panel related-panel">
      <header className="panel-head">
        <h2>Related cards</h2>
        {speciesHref && speciesName ? (
          <Link to={speciesHref}>All {speciesName}</Link>
        ) : null}
      </header>
      <div className="grid related-grid">
        {priced.slice(0, 12).map((row, index) => (
          <CardTile key={row.id} card={row} rank={index} />
        ))}
      </div>
    </section>
  );
}
