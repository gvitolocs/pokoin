import { createMemo, createSignal, For, onSettled, Show } from 'solid-js';
import { flagSrc, printFlagFromNationality } from '@market/locale.js';
import {
  EXPANSION_LANG_FILTERS,
  countExpansionLangGroups,
  expansionsBoardUrl,
  filterExpansions,
  qwenAgrees,
  shouldApplyQwenNationality,
} from '@market/ocr-expansions.js';
import data from '@market/../public/review/ocr.json';
import TestDock from '../components/TestDock.jsx';
import { BoardBar, BoardToggle, usePageTitle, ZoomDialog } from './tools/board.jsx';

const asset = (file) => `${import.meta.env.BASE_URL}${file.replace(/^\//, '')}?v=${data.revision}`;

const FLAG = { japanese: 'JP', western: 'EN', chinese: 'CN', korean: 'KO' };
const QWEN_NAT = { english: 'western', japanese: 'japanese', chinese: 'chinese', korean: 'korean' };

function Zone(props) {
  const text = () => (props.lines || []).join('\n').trim();
  return (
    <div class="ocr-zone">
      <p class="sanitize-kicker">{props.title}</p>
      <pre>{text() || '—'}</pre>
    </div>
  );
}

function PrintFlag(props) {
  const flag = () => printFlagFromNationality(props.nationality);
  return (
    <Show when={flag()}>
      {(printFlag) => (
        <img class="ocr-print-flag" src={flagSrc(printFlag().code)} alt="" width="32" height="32" />
      )}
    </Show>
  );
}

function artistTitle(card) {
  if (card.artist_ocr) {
    const db = card.illustrator && card.illustrator !== card.artist_ocr ? ` · DB ${card.illustrator}` : '';
    return `Artist · OCR ${card.artist_ocr}${db}`;
  }
  return card.illustrator ? `Artist · DB ${card.illustrator}` : 'Artist';
}

function ExpansionRow(props) {
  const row = () => props.row;
  const agree = () => qwenAgrees(row().nationality, row().qwen_print);
  const apply = () => shouldApplyQwenNationality(row().nationality, row().qwen_print, row().ocr_junk);
  const qwenNat = () => QWEN_NAT[row().qwen_print];
  return (
    <section class={['ocr-expansion', { 'ocr-disagree': !agree() }]}>
      <header class="ocr-expansion-head">
        <PrintFlag nationality={row().nationality} />
        <Show when={qwenNat() && !agree()}><PrintFlag nationality={qwenNat()} /></Show>
        <h2>{row().name}</h2>
        <span class="ocr-nat">{row().nationality}</span>
        <Show when={row().ocr_junk === true}><span class="ocr-qwen-miss">junk</span></Show>
        <Show when={row().ocr_junk === false}><span class="ocr-qwen">english OCR</span></Show>
        <Show when={row().ocr_junk && row().qwen_print}>
          <span class={['ocr-qwen', { 'ocr-qwen-miss': !agree() }]}>
            qwen {row().qwen_print}
            {apply() ? ' · would set' : ''}
          </span>
        </Show>
        <span class="ocr-total">
          {row().cards.length} of {row().total}
          {row().listed === false ? ' · unlisted' : ''}
        </span>
      </header>
      <Show when={row().qwen_why}><p class="ocr-why">{row().qwen_why}</p></Show>
      <div class="ocr-expansion-row">
        <For each={row().cards || []}>
          {(card) => (
            <figure>
              <button
                type="button"
                class="sanitize-frame"
                onClick={() => props.onZoom({ src: card.image, label: card.name })}
              >
                <img src={card.image} alt={card.name} width="180" height="251" loading="lazy" />
              </button>
              <figcaption>
                <a
                  class="linkish"
                  href={`https://pokoin.com/marketplace/en/cards/${card.id}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {card.name}
                </a>
                <span>{card.num}</span>
              </figcaption>
            </figure>
          )}
        </For>
      </div>
    </section>
  );
}

/** Expansion print-language OCR board (market/src/pages/Ocr.jsx). */
export default function Ocr() {
  const [guides, setGuides] = createSignal(true);
  const [zoom, setZoom] = createSignal(null);
  const [board, setBoard] = createSignal(null);
  const [loadError, setLoadError] = createSignal('');
  const [group, setGroup] = createSignal('japanese');
  const [query, setQuery] = createSignal('');
  usePageTitle('Expansion print language · test.pokoin.com');

  onSettled(() => {
    let cancelled = false;
    fetch(expansionsBoardUrl())
      .then((response) => {
        if (!response.ok) throw new Error(`expansions ${response.status}`);
        return response.json();
      })
      .then((payload) => {
        if (!cancelled) setBoard(() => payload);
      })
      .catch((error) => {
        if (!cancelled) setLoadError(error.message || 'expansions failed');
      });
    return () => {
      cancelled = true;
    };
  });

  const expansions = () => board()?.expansions || [];
  const counts = createMemo(() => countExpansionLangGroups(expansions()));
  const visible = createMemo(() => filterExpansions(expansions(), { group: group(), query: query() }));
  const openZoom = (shot) => setZoom(() => shot);

  return (
    <div class="sanitize">
      <BoardBar host={`test.pokoin.com · OCR · ${board()?.revision || data.revision}`}>
        <BoardToggle checked={guides()} onChange={setGuides}>Zones</BoardToggle>
      </BoardBar>

      <main class="sanitize-main ocr-main">
        <p class="sanitize-kicker">Leftover scans · JP products pinned jpko · <a class="linkish" href="/ocr/artists">artist table</a></p>
        <h1>Expansion print language</h1>
        <p class="sanitize-lead">
          Gym / construction / intro / gift-box leftovers with Japanese
          faces are <code>japanese</code> (jpko), not western. English Jungle,
          Fossil, and EX Holon Phantoms stay western. Ascended Heroes leftover
          thumbs are English Mega ex boxes of a western set.
        </p>
        <p class="sanitize-note">
          {board()
            ? `${board().count} expansions · ${board().engine || board().model || 'PP-OCRv5'} · click a scan to zoom`
            : (loadError() || 'Loading expansions…')}
        </p>

        <div class="ocr-filters">
          <For each={EXPANSION_LANG_FILTERS}>
            {(chip) => (
              <button type="button" class={group() === chip.id ? 'on' : ''} onClick={() => setGroup(chip.id)}>
                {chip.label}
                {board() ? ` ${counts()[chip.id]}` : ''}
              </button>
            )}
          </For>
          <input
            type="search"
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            placeholder="Filter by expansion name"
            aria-label="Filter by expansion name"
          />
        </div>

        <For each={visible()}>{(row) => <ExpansionRow row={row} onZoom={openZoom} />}</For>

        <details class="ocr-sample" id="ocr-sample">
          <summary>PP-OCRv5 English · same 10 cards</summary>
          <p class="sanitize-lead">
            {data.engine}. {data.device}. {data.upsample}. Gold = name, blue =
            attacks, red = artist. English cards first. Not live CDN.
          </p>
          <p class="sanitize-note">{data.rule}</p>
          <For each={data.cards}>
            {(card) => (
              <article class="ocr-card">
                <figure class="sanitize-shot">
                  <button
                    type="button"
                    class="sanitize-frame"
                    onClick={() => openZoom({ src: asset(card.image), label: card.name })}
                  >
                    <img src={asset(card.image)} alt={card.name} />
                    <Show when={guides()}><span class="ocr-guides" aria-hidden="true" /></Show>
                  </button>
                  <figcaption>
                    <strong>
                      <Show when={FLAG[card.nationality]}>
                        <span class="espurr-flag">{FLAG[card.nationality]}</span>
                      </Show>{' '}{card.name}
                    </strong>
                    <span>{card.expansion} · {card.number}</span>
                    <span class="sanitize-metric">
                      {card.source_kind} {card.source_size}
                      {card.leftover_size && !card.source_kind.startsWith('leftover')
                        ? ` · leftover was ${card.leftover_size}`
                        : ''}
                    </span>
                    <span class="sanitize-metric">
                      {card.ocr_s}s · {card.line_count} lines · work {card.work_size}
                    </span>
                    <span>
                      <a class="linkish" href={card.desk} target="_blank" rel="noreferrer">desk {card.card_id}</a>
                      {' · leftover '}
                      {card.ct_id}
                    </span>
                  </figcaption>
                </figure>
                <div class="ocr-zones">
                  <Zone title="Name" lines={card.name_zone} />
                  <Zone title="Attacks / rules" lines={card.attack_zone} />
                  <Zone title={artistTitle(card)} lines={card.artist_zone} />
                </div>
              </article>
            )}
          </For>
        </details>
      </main>

      <TestDock />
      <ZoomDialog shot={zoom()} onClose={() => setZoom(null)} />
    </div>
  );
}
