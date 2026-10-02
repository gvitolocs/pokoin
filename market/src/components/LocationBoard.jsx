import { Link } from 'react-router-dom';
import {
  conditionChipSrc,
  conditionShort,
  conditionTone,
  listingLanguageFlag,
} from '../listing-meta.js';
import { homepageDerivativeUrl, ownCatalogImage, preferFullImage } from '../image-urls.js';
import { groupBoxStacks, listingBox } from '../inventory-listings.js';

function StackThumb({ row }) {
  const src = homepageDerivativeUrl(ownCatalogImage(
    { id: row?.cardId || row?.card_id },
    preferFullImage(row?.cardImageUrl || row?.card_image_url || ''),
  ));
  const name = row?.cardName || row?.name || 'Listing';
  if (src) {
    return <img className="inv-thumb" src={src} alt="" loading="lazy" width="40" height="56" />;
  }
  return <span className="inv-thumb is-empty" aria-hidden="true">{String(name).slice(0, 1).toUpperCase()}</span>;
}

function stackLabel(stack) {
  return stack === 0 ? 'Cards in the box' : `Stack ${stack}`;
}

function stackHref(stack) {
  const id = String(stack.cardId || '');
  return /^\d+$/.test(id) ? `/marketplace/en/cards/${id}` : '/marketplace';
}

/**
 * One box: every listing stored in it, grouped per divider stack and ordered
 * by stack number, then position inside the stack (when the location carries
 * one), then listed date. Unnumbered rows land under "In the box" at the end.
 */
export default function LocationBoard({ rows, location, formatPrice }) {
  // The URL may carry a full slot string (…/location/megaevoluzionietb·2-4) —
  // the box is the part before the first separator.
  const box = listingBox(location) || location;
  const stacks = groupBoxStacks(rows, box);
  const dividerCount = stacks.filter((stack) => stack.stack > 0).length;
  const postings = stacks.reduce((sum, stack) => sum + stack.postingCount, 0);
  const copies = stacks.reduce((sum, stack) => sum + stack.copies, 0);

  return (
    <section className="inv-board" aria-label={`Cards in ${box}`}>
      <div className="inv-summary">
        {dividerCount > 0 ? <div className="inv-stat"><strong>{dividerCount}</strong><span>Stacks</span></div> : null}
        <div className="inv-stat"><strong>{postings}</strong><span>Postings</span></div>
        <div className="inv-stat is-gold"><strong>{copies}</strong><span>Copies</span></div>
      </div>

      <p className="loc-box-line">
        Box <strong>{box}</strong>
        {box !== location ? <span className="loc-box-alt"> (opened as {location})</span> : null}
      </p>

      {!stacks.length ? (
        <p className="inv-empty">Nothing stored in this box.</p>
      ) : (
        <div className="loc-list">
          {stacks.map((stack) => (
            <div key={stack.stack} className="loc-stack">
              <div className="loc-stack-title">
                <span className="loc-stack-no">{stackLabel(stack.stack)}</span>
                <span className="loc-count">
                  <strong>{stack.postingCount}</strong>
                  {' '}
                  {stack.postingCount === 1 ? 'posting' : 'postings'}
                  {' · '}
                  {stack.copies} {stack.copies === 1 ? 'copy' : 'copies'}
                </span>
              </div>
              <div className="loc-postings">
                {stack.postings.map((row) => {
                  const href = stackHref(row);
                  const language = row?.language ? listingLanguageFlag(row.language) : null;
                  const slotPosition = row.slotPosition ? ` · pos ${row.slotPositionText || row.slotPosition}` : '';
                  return (
                    <Link key={row.id || `${row.cardId}-${row.pricePkn}`} className="loc-posting" to={href}>
                      <StackThumb row={row} />
                      <span className="inv-card-txt">
                        <strong>{row?.cardName || row?.name || 'Listing'}</strong>
                        <span className="inv-card-sub">
                          {row?.setName || ''}{row?.collectorNumber ? `${row?.setName ? ' · ' : ''}#${row.collectorNumber}` : ''}
                          {slotPosition}
                        </span>
                      </span>
                      <span className="loc-stack-meta">
                        <img
                          className={`shop-cond is-${conditionTone(row.condition)}`}
                          src={conditionChipSrc(row.condition)}
                          alt={conditionShort(row.condition) || 'NM'}
                          title={conditionShort(row.condition) || 'NM'}
                          width="34"
                          height="24"
                          loading="lazy"
                        />
                        {language ? <img className="inv-flag" src={language.src} alt={language.code} width="18" height="18" loading="lazy" /> : null}
                        <span className="inv-qty num">{Math.max(0, Number(row?.quantityAvailable ?? row?.quantity_available ?? 0) || 0)}×</span>
                        <span className="inv-price num">{formatPrice(row?.pricePkn ?? row?.price_pkn)}</span>
                        <span className={`inv-status ${String(row?.status || '').toLowerCase() === 'paused' ? 'is-paused' : 'is-live'}`}>
                          {String(row?.status || '').toLowerCase() === 'paused' ? 'Paused' : 'Live'}
                        </span>
                      </span>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
