import { useEffect, useLayoutEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { cardFromCatalogRow, cardHref, fetchCard, fetchExactNameCards, fetchLastMedianPknMap, fetchVersionSet } from '../api.js';
import { mergePrintingRows, printLangBadge, splitVersionPage } from '../card-versions.js';
import { eraHref } from '../set-logos.js';
import { realPublicCardId } from '../card-stub.js';
import { applyLastMedianPrices } from '../pkn.js';
import CardTile from '../components/CardTile.jsx';
import { SkeletonTile } from '../components/Carousel.jsx';
import { Alert, EmptyDesk, PageHead } from '../components/Desk.jsx';

function TileGrid({ rows, cardId, flags }) {
  return (
    <div className="grid versions-grid">
      {rows.map((row, index) => {
        const flag = flags ? printLangBadge(row) : '';
        const on = String(row.id) === String(cardId);
        return (
          <div key={row.id} className={on ? 'version-tile on' : 'version-tile'}>
            {flag ? <span className="espurr-flag">{flag}</span> : null}
            <CardTile card={row} rank={index} />
          </div>
        );
      })}
    </div>
  );
}

export default function Versions() {
  const { lang = 'en', cardId: rawCardId, slug } = useParams();
  const cardId = realPublicCardId(rawCardId);
  const navigate = useNavigate();
  const location = useLocation();
  const [payload, setPayload] = useState(null);
  const [nameRows, setNameRows] = useState([]);
  const [medians, setMedians] = useState({});
  const [error, setError] = useState('');

  useLayoutEffect(() => {
    if (String(rawCardId) === String(cardId)) {
      return;
    }
    navigate(
      `${location.pathname.replace(`/cards/${rawCardId}`, `/cards/${cardId}`)}${location.search}`,
      { replace: true },
    );
  }, [rawCardId, cardId, location.pathname, location.search, navigate]);

  useEffect(() => {
    document.title = 'Versions · Pokoin';
    let cancelled = false;
    setPayload(null);
    setNameRows([]);
    Promise.all([
      fetchVersionSet(cardId),
      fetchCard(cardId, { lang }).catch(() => null),
    ])
      .then(([data, page]) => {
        if (cancelled) return;
        setPayload(data);
        const name = data?.printings?.find((row) => String(row.id) === String(cardId))?.name
          || data?.printings?.[0]?.name
          || page?.card?.name
          || 'Card';
        document.title = `${name} · versions · Pokoin`;
        setError('');
        const rarities = (page?.rarities || []).map(cardFromCatalogRow).filter((row) => row.id);
        if (rarities.length) {
          setNameRows(rarities);
        }
        if (name && name !== 'Card') {
          fetchExactNameCards(name, { lang }).then((rows) => {
            if (!cancelled && rows.length) {
              setNameRows((current) => mergePrintingRows(current, rows));
            }
          }).catch(() => {});
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Versions failed.');
      });
    return () => {
      cancelled = true;
    };
  }, [cardId, lang]);

  const artCards = (payload?.printings || []).map(cardFromCatalogRow).filter((row) => row.id);
  const current = artCards.find((row) => String(row.id) === String(cardId))
    || nameRows.find((row) => String(row.id) === String(cardId))
    || artCards[0]
    || nameRows[0];
  const groups = splitVersionPage({ current, nameRows, artRows: artCards });
  const pricedVersions = applyLastMedianPrices(groups.versions, medians);
  const pricedEras = (groups.eras || []).map((group) => ({
    ...group,
    rows: applyLastMedianPrices(group.rows, medians),
  }));
  const eraRows = pricedEras.flatMap((group) => group.rows);

  useEffect(() => {
    const ids = [...pricedVersions, ...eraRows].map((row) => row.id).filter(Boolean);
    if (!ids.length) {
      setMedians({});
      return undefined;
    }
    let cancelled = false;
    fetchLastMedianPknMap(ids).then((byId) => {
      if (!cancelled) {
        setMedians(byId);
      }
    }).catch(() => {
      if (!cancelled) {
        setMedians({});
      }
    });
    return () => {
      cancelled = true;
    };
  }, [payload, nameRows]);

  useEffect(() => {
    const hash = String(location.hash || '').replace('#', '');
    if (!hash || !payload) {
      return undefined;
    }
    const node = document.getElementById(hash);
    if (node) {
      node.scrollIntoView({ block: 'start' });
    }
    return undefined;
  }, [location.hash, payload, nameRows]);

  const versionCount = pricedVersions.length;
  const eraCount = eraRows.length;
  const ready = Boolean(payload) || Boolean(error);
  const setName = String(current?.set || current?.set_name || '').trim();
  const cardName = String(current?.name || '').trim();
  const headTitle = cardName && setName && setName !== cardName
    ? `${cardName} - ${setName}`
    : (cardName || 'Versions');
  const showRarity = pricedVersions.length > 1;
  const headCount = showRarity ? versionCount : eraCount;

  return (
    <div className="page desk versions-page">
      <nav className="crumbs">
        <Link to="/marketplace">Marketplace</Link>
        <span>/</span>
        {current ? <Link to={cardHref(current)}>{current.name}</Link> : <span>{slug || cardId}</span>}
        <span>/</span>
        <span>Versions</span>
      </nav>
      <PageHead
        title={(
          <>
            {headTitle}
            {ready && headCount ? (
              <span className="versions-count">
                {headCount} {headCount === 1 ? 'version' : 'versions'}
              </span>
            ) : null}
          </>
        )}
      />
      <Alert>{error}</Alert>
      {!ready && !error ? (
        <div className="grid versions-grid">
          {Array.from({ length: 6 }, (_, index) => <SkeletonTile key={index} />)}
        </div>
      ) : null}
      {ready && !pricedVersions.length && !eraRows.length ? (
        <EmptyDesk title="No versions" lede="This printing has no rarity pair or artwork group yet." />
      ) : null}
      {showRarity ? (
        <section className="versions-section" id="versions">
          <h2>Rarity Lineup</h2>
          <TileGrid rows={pricedVersions} cardId={cardId} />
        </section>
      ) : null}
      {pricedEras.map((group) => (
        <section className="versions-section" id={group.id} key={group.id}>
          <h2>
            <Link className="era-link" to={eraHref(group.label)}>{group.label}</Link>
          </h2>
          <TileGrid rows={group.rows} cardId={cardId} flags />
        </section>
      ))}
    </div>
  );
}
