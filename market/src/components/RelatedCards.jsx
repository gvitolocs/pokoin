import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { overlayCatalogTilePrices } from '../api.js';
import CardSelectGrid from './CardSelectGrid.jsx';
import CardTile from './CardTile.jsx';

export default function RelatedCards({
  card,
  related = [],
  speciesName,
  speciesHref,
  /** When true, parent CardSelectGrid already owns selection (desk + related). */
  embedded = false,
}) {
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
  const tiles = priced.slice(0, 12).map((row, index) => (
    // Every tile starts loading with the panel, behind the desk scan.
    <CardTile key={row.id} card={row} rank={index} eagerLimit={12} artPriority="low" />
  ));
  return (
    <section className="panel related-panel">
      <header className="panel-head">
        <h2>Related cards</h2>
        {speciesHref && speciesName ? (
          <Link to={speciesHref}>All {speciesName}</Link>
        ) : null}
      </header>
      {embedded ? (
        <div className="grid related-grid">{tiles}</div>
      ) : (
        <CardSelectGrid className="grid related-grid" cards={priced.slice(0, 12)}>
          {tiles}
        </CardSelectGrid>
      )}
    </section>
  );
}
