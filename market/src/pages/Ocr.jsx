import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import TestDock from '../components/TestDock.jsx';
import { flagSrc, printFlagFromNationality } from '../locale.js';
import {
  EXPANSION_LANG_FILTERS,
  countExpansionLangGroups,
  expansionsBoardUrl,
  filterExpansions,
  qwenAgrees,
  shouldApplyQwenNationality,
} from '../ocr-expansions.js';
import data from '../../public/review/ocr.json';

const asset = (file) => `${import.meta.env.BASE_URL}${file.replace(/^\//, '')}?v=${data.revision}`;

function Flag({ lang }) {
  const label = { japanese: 'JP', western: 'EN', chinese: 'CN', korean: 'KO' }[lang];
  if (!label) return null;
  return <span className="espurr-flag">{label}</span>;
}

function Zone({ title, lines }) {
  const text = (lines || []).join('\n').trim();
  return (
    <div className="ocr-zone">
      <p className="sanitize-kicker">{title}</p>
      <pre>{text || '—'}</pre>
    </div>
  );
}

function PrintFlag({ nationality }) {
  const printFlag = printFlagFromNationality(nationality);
  if (!printFlag) {
    return null;
  }
  return (
    <img
      className="ocr-print-flag"
      src={flagSrc(printFlag.code)}
      alt=""
      width="32"
      height="32"
    />
  );
}

export default function Ocr() {
  const [guides, setGuides] = useState(true);
  const [zoom, setZoom] = useState(null);
  const [board, setBoard] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [group, setGroup] = useState('japanese');
  const [query, setQuery] = useState('');
  const zoomRef = useRef(null);

  useEffect(() => {
    document.title = 'Expansion print language · test.pokoin.com';
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(expansionsBoardUrl())
      .then((response) => {
        if (!response.ok) {
          throw new Error(`expansions ${response.status}`);
        }
        return response.json();
      })
      .then((payload) => {
        if (!cancelled) {
          setBoard(payload);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setLoadError(error.message || 'expansions failed');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useLayoutEffect(() => {
    if (!zoom) {
      return undefined;
    }
    const el = zoomRef.current;
    if (el && !el.open) {
      el.showModal();
    }
    return undefined;
  }, [zoom]);

  const expansions = board?.expansions || [];
  const counts = useMemo(() => countExpansionLangGroups(expansions), [expansions]);
  const visible = useMemo(
    () => filterExpansions(expansions, { group, query }),
    [expansions, group, query],
  );

  return (
    <div className="sanitize">
      <header className="sanitize-bar">
        <a className="brand" href="https://pokoin.com/" aria-label="Pokoin">
          <img src="/home/logo.png" alt="" width="40" height="40" />
          <span>Pokoin</span>
        </a>
        <p className="sanitize-host">
          test.pokoin.com · OCR · {board?.revision || data.revision}
        </p>
        <label className="sanitize-toggle">
          <input
            type="checkbox"
            checked={guides}
            onChange={(event) => setGuides(event.target.checked)}
          />
          Zones
        </label>
      </header>

      <main className="sanitize-main ocr-main">
        <p className="sanitize-kicker">Leftover scans · JP products pinned jpko · <Link className="linkish" to="/ocr/artists">artist table</Link></p>
        <h1>Expansion print language</h1>
        <p className="sanitize-lead">
          Gym / construction / intro / gift-box leftovers with Japanese
          faces are <code>japanese</code> (jpko), not western. English Jungle,
          Fossil, and EX Holon Phantoms stay western. Ascended Heroes leftover
          thumbs are English Mega ex boxes of a western set.
        </p>
        <p className="sanitize-note">
          {board
            ? `${board.count} expansions · ${board.engine || board.model || 'PP-OCRv5'} · click a scan to zoom`
            : (loadError || 'Loading expansions…')}
        </p>

        <div className="ocr-filters">
          {EXPANSION_LANG_FILTERS.map((chip) => (
            <button
              key={chip.id}
              type="button"
              className={group === chip.id ? 'on' : ''}
              onClick={() => setGroup(chip.id)}
            >
              {chip.label}
              {board ? ` ${counts[chip.id]}` : ''}
            </button>
          ))}
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by expansion name"
            aria-label="Filter by expansion name"
          />
        </div>

        {visible.map((row) => {
          const agree = qwenAgrees(row.nationality, row.qwen_print);
          const apply = shouldApplyQwenNationality(
            row.nationality,
            row.qwen_print,
            row.ocr_junk,
          );
          const qwenNat = {
            english: 'western',
            japanese: 'japanese',
            chinese: 'chinese',
            korean: 'korean',
          }[row.qwen_print];
          return (
          <section
            key={`${row.expansion_id || row.nationality}:${row.name}`}
            className={agree ? 'ocr-expansion' : 'ocr-expansion ocr-disagree'}
          >
            <header className="ocr-expansion-head">
              <PrintFlag nationality={row.nationality} />
              {qwenNat && !agree ? <PrintFlag nationality={qwenNat} /> : null}
              <h2>{row.name}</h2>
              <span className="ocr-nat">{row.nationality}</span>
              {row.ocr_junk === true ? (
                <span className="ocr-qwen-miss">junk</span>
              ) : row.ocr_junk === false ? (
                <span className="ocr-qwen">english OCR</span>
              ) : null}
              {row.ocr_junk && row.qwen_print ? (
                <span className={agree ? 'ocr-qwen' : 'ocr-qwen ocr-qwen-miss'}>
                  qwen {row.qwen_print}
                  {apply ? ' · would set' : ''}
                </span>
              ) : null}
              <span className="ocr-total">
                {row.cards.length} of {row.total}
                {row.listed === false ? ' · unlisted' : ''}
              </span>
            </header>
            {row.qwen_why ? <p className="ocr-why">{row.qwen_why}</p> : null}
            <div className="ocr-expansion-row">
              {(row.cards || []).map((card) => (
                <figure key={card.ct_id}>
                  <button
                    type="button"
                    className="sanitize-frame"
                    onClick={() => setZoom({ src: card.image, label: card.name })}
                  >
                    <img
                      src={card.image}
                      alt={card.name}
                      width="180"
                      height="251"
                      loading="lazy"
                    />
                  </button>
                  <figcaption>
                    <a
                      className="linkish"
                      href={`https://pokoin.com/marketplace/en/cards/${card.id}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {card.name}
                    </a>
                    <span>{card.num}</span>
                  </figcaption>
                </figure>
              ))}
            </div>
          </section>
          );
        })}

        <details className="ocr-sample" id="ocr-sample">
          <summary>PP-OCRv5 English · same 10 cards</summary>
          <p className="sanitize-lead">
            {data.engine}. {data.device}. {data.upsample}. Gold = name, blue =
            attacks, red = artist. English cards first. Not live CDN.
          </p>
          <p className="sanitize-note">{data.rule}</p>
          {data.cards.map((card) => (
            <article key={card.ct_id} className="ocr-card">
              <figure className="sanitize-shot">
                <button
                  type="button"
                  className="sanitize-frame"
                  onClick={() => setZoom({ src: asset(card.image), label: card.name })}
                >
                  <img src={asset(card.image)} alt={card.name} />
                  {guides ? <span className="ocr-guides" aria-hidden="true" /> : null}
                </button>
                <figcaption>
                  <strong>
                    <Flag lang={card.nationality} /> {card.name}
                  </strong>
                  <span>{card.expansion} · {card.number}</span>
                  <span className="sanitize-metric">
                    {card.source_kind} {card.source_size}
                    {card.leftover_size && !card.source_kind.startsWith('leftover')
                      ? ` · leftover was ${card.leftover_size}`
                      : ''}
                  </span>
                  <span className="sanitize-metric">
                    {card.ocr_s}s · {card.line_count} lines · work {card.work_size}
                  </span>
                  <span>
                    <a className="linkish" href={card.desk} target="_blank" rel="noreferrer">
                      desk {card.card_id}
                    </a>
                    {' · leftover '}
                    {card.ct_id}
                  </span>
                </figcaption>
              </figure>
              <div className="ocr-zones">
                <Zone title="Name" lines={card.name_zone} />
                <Zone title="Attacks / rules" lines={card.attack_zone} />
                <Zone
                  title={
                    card.artist_ocr
                      ? `Artist · OCR ${card.artist_ocr}${card.illustrator && card.illustrator !== card.artist_ocr ? ` · DB ${card.illustrator}` : ''}`
                      : (card.illustrator ? `Artist · DB ${card.illustrator}` : 'Artist')
                  }
                  lines={card.artist_zone}
                />
              </div>
            </article>
          ))}
        </details>
      </main>

      <TestDock />

      {zoom ? (
        <dialog
          ref={zoomRef}
          className="zoom"
          onClose={() => setZoom(null)}
          onClick={(event) => {
            if (event.target === zoomRef.current) {
              setZoom(null);
            }
          }}
        >
          <img
            src={zoom.src}
            alt={zoom.label}
            onClick={() => setZoom(null)}
          />
        </dialog>
      ) : null}
    </div>
  );
}
