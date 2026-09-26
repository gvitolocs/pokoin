import { useState } from 'react';
import { Link } from 'react-router-dom';
import { setSlug } from '../api.js';
import { flagSrc, printFlagFromNationality } from '../locale.js';
import { bundleReference, writeListingDrag } from '../chat-listing.js';
import { expansionCode, expansionLogoSrc } from '../set-logos.js';
import ExpansionMark from './ExpansionMark.jsx';

function SetGuideLogo({ row }) {
  const logo = expansionLogoSrc(row);
  const [wordmarkDead, setWordmarkDead] = useState(false);
  const showMark = !logo || wordmarkDead;
  return (
    <div className={`set-guide-logo${showMark ? ' is-mark' : ''}`}>
      {showMark ? (
        <span className="set-shortcut is-on">
          <ExpansionMark
            setName={row.name}
            symbolUrl={row.expansionSymbolUrl || row.symbolImageUrl || row.defaultSymbolUrl}
          />
        </span>
      ) : (
        <img
          src={logo}
          alt=""
          draggable
          onDragStart={(event) => {
            const slug = row.slug || '';
            writeListingDrag(event, bundleReference({
              kind: 'expansion',
              slug,
              name: row.name,
              imageUrl: logo,
              path: slug ? `/marketplace/sets/${slug}` : '',
            }));
          }}
          onError={() => setWordmarkDead(true)}
        />
      )}
    </div>
  );
}

export default function SetGuideGrid({ rows = [] }) {
  return (
    <div className="set-guide-grid">
      {rows.map((row) => {
        const slug = row.slug || setSlug(row.name);
        const code = expansionCode({ ...row, slug });
        const count = row.cardCount || row.count || row.cards || '';
        const printFlag = printFlagFromNationality(row.nationality);
        return (
          <Link className="set-guide-card" key={slug || row.name} to={`/marketplace/sets/${slug}`}>
            <SetGuideLogo row={{ ...row, slug }} />
            <strong className={printFlag ? 'has-print-flag' : undefined}>
              {printFlag ? (
                <span className="set-guide-print-flag">
                  <img src={flagSrc(printFlag.code)} alt="" width="28" height="28" />
                  <span className="sr-only">{printFlag.label}</span>
                </span>
              ) : null}
              <span>{row.name}</span>
            </strong>
            <div className="set-guide-meta">
              {code ? <span className="set-guide-code">{code}</span> : null}
              {count ? <span className="muted">{count}</span> : null}
            </div>
            <span className="set-guide-cta">
              Open set
              <span aria-hidden="true">→</span>
            </span>
          </Link>
        );
      })}
    </div>
  );
}
