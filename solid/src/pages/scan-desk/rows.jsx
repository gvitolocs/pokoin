import { createEffect, createMemo, createSignal, For, onSettled, Show, untrack } from 'solid-js';
import { fetchExactNameCards, imageSrc } from '@market/api.js';
import { game, publicGamePath } from '@market/game.js';
import { cardReference, writeListingDrag } from '@market/chat-listing.js';
import { conditionChipSrc } from '@market/listing-meta.js';
import { flagSrc } from '@market/locale.js';
import {
  artworkVersionLabel,
  artworkVersionShortLabel,
  candidatesForPrintFamily,
  currentMatchesLanguageBucket,
  mergeArtworkCandidates,
  preferArtworkPrinting,
  remapListingLanguage,
  resolveArtworkRemap,
  shouldRemapArtwork,
  sortArtworkVersions,
} from '@market/scan-artwork-versions.js';
import {
  candidateList,
  CONDITIONS,
  FINISHES,
  LANGUAGES,
  PROBLEM_LABEL,
  quantityFieldCommit,
  slotText,
} from '@market/scan-model.js';
import { priceFieldCommit } from '@market/scan-pricing.js';
import { DRAFT_HOTKEY_LEGEND, dispatchDraftHotkey, draftLegendActive } from '@market/scan-shortcuts.js';
import { formatSellerPrice, priceInputFromPkn } from '@market/seller-currency.js';
import ThumbZoom from '../../components/ThumbZoom.jsx';
import { createLiveSuggest } from '../../lib/live-suggest.js';
import { loadVersionSet } from './version-sets.js';
import { watch } from './watch.js';

function thumbFor(cardId, name, imageUrl) {
  if (!cardId) return { thumb: '', hero: '' };
  const card = { id: cardId, card_id: cardId, name, imageUrl };
  try {
    return {
      thumb: imageSrc(card, 'suggest'),
      // Full-resolution leftover JPEG for the hover zoom (falls back to thumb).
      hero: imageSrc(card, 'hero'),
    };
  } catch (_) {
    return { thumb: '', hero: '' };
  }
}

/** Same-artwork printing select; remaps the row to the printing its language implies. */
function ArtworkVersionSelect(props) {
  const [printings, setPrintings] = createSignal(null);
  const remapTried = new Set();
  // The row language picks the printing. Batch language is only the fallback.
  const listingLanguage = () => remapListingLanguage(props.row.language, props.preferredLanguage);

  watch(
    () => [
      props.row.id,
      String(props.row.cardId || '').trim(),
      String(props.row.cardName || '').trim(),
      props.row.nationality,
      props.row.language,
      props.closed,
      listingLanguage(),
    ],
    ([id, cardId, cardName, , , closed, lang]) => {
      let cancelled = false;
      if (!cardId) {
        setPrintings(null);
        return undefined;
      }
      (async () => {
        const data = await loadVersionSet(cardId);
        if (cancelled) return;
        let rows = sortArtworkVersions(data?.printings || [], lang);
        setPrintings(rows);
        if (closed) return;
        const tryKey = `${id}\0${lang}\0${cardId}`;
        if (remapTried.has(tryKey)) return;
        remapTried.add(tryKey);
        let preferred = null;
        if (shouldRemapArtwork(rows, cardId, lang)) {
          preferred = preferArtworkPrinting(rows, cardId, lang);
        } else if (!currentMatchesLanguageBucket(rows, cardId, lang) && cardName) {
          // CLIP often misses a JP/CN sibling that still exists under the same
          // English name (Wondrous Patch → Nihil Zero). Exact-name fills that gap.
          const nameRows = await fetchExactNameCards(cardName).catch(() => []);
          if (cancelled) return;
          if (nameRows.length) {
            const merged = mergeArtworkCandidates(rows, nameRows);
            rows = sortArtworkVersions(merged, lang);
            setPrintings(rows);
            preferred = resolveArtworkRemap({
              clipPrintings: data?.printings || [],
              namePrintings: nameRows,
              currentId: cardId,
              listingLanguage: lang,
            });
          }
        }
        const nextId = String(preferred?.id || preferred?.card_id || '');
        if (nextId && nextId !== cardId) props.onPick(nextId);
      })();
      return () => { cancelled = true; };
    },
  );

  const fallback = () => [props.row.setName, props.row.collectorNumber].filter(Boolean).join(' · ');
  const value = () => {
    const list = printings() || [];
    return list.some((p) => String(p.id) === String(props.row.cardId))
      ? String(props.row.cardId)
      : String(list[0]?.id ?? '');
  };
  return (
    <Show when={!props.closed && props.row.cardId} fallback={<em>{fallback()}</em>}>
      <Show when={printings()} fallback={<em>{fallback() || '…'}</em>}>
        <Show
          when={printings().length > 1}
          fallback={<em>{printings()[0] ? artworkVersionLabel(printings()[0]) : fallback()}</em>}
        >
          <label class="c-version-wrap">
            <span class="c-version-tag">Version</span>
            <select
              class="c-version"
              value={value()}
              aria-label="Artwork version"
              tabindex={-1}
              title="Same artwork — pick which printing to list"
              onChange={(e) => props.onPick(e.currentTarget.value)}
            >
              <For each={printings()}>
                {(printing) => <option value={String(printing.id)}>{artworkVersionShortLabel(printing)}</option>}
              </For>
            </select>
          </label>
        </Show>
      </Show>
    </Show>
  );
}

function CandidateAlts(props) {
  const raw = () => candidateList(props.row);
  const [mapped, setMapped] = createSignal(untrack(raw));
  const lang = () => props.preferredLanguage || props.row.language || 'EN';

  watch(
    () => [props.row.id, lang(), raw().map((c) => c.cardId).join(',')],
    ([, language, ids]) => {
      let cancelled = false;
      if (!ids) {
        setMapped([]);
        return undefined;
      }
      Promise.all(untrack(raw).map(async (cand) => {
        const data = await loadVersionSet(cand.cardId);
        const rows = sortArtworkVersions(data?.printings || [], language);
        if (!rows.length) return cand;
        const preferred = preferArtworkPrinting(rows, cand.cardId, language);
        if (!preferred) return cand;
        return {
          ...cand,
          cardId: String(preferred.id || preferred.card_id || cand.cardId),
          name: preferred.name || cand.name,
          setName: preferred.set_name || preferred.setName || preferred.set || cand.setName,
          number: preferred.card_number || preferred.collector_number || preferred.number || cand.number,
          nationality: preferred.nationality || cand.nationality || '',
        };
      })).then((next) => {
        if (cancelled) return;
        const seen = new Set();
        const unique = next.filter((c) => {
          const id = String(c.cardId || '');
          if (!id || seen.has(id)) return false;
          seen.add(id);
          return true;
        });
        setMapped(candidatesForPrintFamily(unique, language));
      });
      return () => { cancelled = true; };
    },
  );

  return (
    <Show when={mapped().length}>
      <span class="c-cands">
        <For each={mapped().slice(0, 4)}>
          {(cand, i) => (
            <button
              type="button"
              class={cand.cardId === props.row.cardId ? 'on' : ''}
              onClick={() => props.onPick(cand.cardId)}
              title={`Alt+${i() + 1}`}
            >
              <b>{i() + 1}</b> {cand.setName || cand.name} {cand.number}
              <Show when={cand.score != null}><i>{Math.round(cand.score * 100)}%</i></Show>
            </button>
          )}
        </For>
      </span>
    </Show>
  );
}

const FLAG_FIELDS = ['firstEdition', 'signed', 'altered'];
const FLAG_SHORT = { firstEdition: '1st', signed: 'S', altered: 'A' };

/** One queue row. `row` is the live row. */
export function QueueRow(props) {
  const row = () => props.row;
  const stateLabel = () => {
    const r = row();
    if (r.status === 'submitted') return props.hidePrice ? 'Collected' : 'Listed';
    if (props.problem) return PROBLEM_LABEL[props.problem];
    if (r.recognitionState === 'manual') return 'Manual';
    return r.reviewed && r.recognitionState !== 'matched' ? 'Checked' : 'Matched';
  };
  const tone = () => {
    if (row().status === 'submitted') return 'ok';
    if (props.problem === 'no_printing') return 'bad';
    return props.problem ? 'warn' : 'ok';
  };
  const showCandidates = () => !props.closed && (row().recognitionState === 'ambiguous' || row().recognitionState === 'unmatched');
  const unidentified = () => !props.closed && !row().cardId;
  // Full LANG list — expansion remaps when the language implies another print.
  // Card desk still restricts via languagesForNationality.
  const langValue = () => (LANGUAGES.includes(row().language) ? row().language : (row().language || 'EN'));
  const thumbArt = createMemo(() => thumbFor(row().cardId, row().cardName, row().imageUrl));
  const zoomSrc = () => thumbArt().hero || thumbArt().thumb;
  const remapLang = () => remapListingLanguage(row().language, props.preferredLanguage);
  const currency = () => props.priceCurrency || 'PKN';
  const pick = (id) => {
    props.onPick(id);
    props.onReplaceDone();
  };

  return (
    <div
      class={['scan-row', { focused: props.focused, selected: props.selected, done: row().status === 'submitted' }]}
      role="row"
      aria-selected={String(Boolean(props.focused || props.selected))}
      data-row={row().id}
      onMouseDown={(event) => {
        if (event.target.closest('input,select,button,textarea')) return;
        props.onFocus(event);
      }}
    >
      <span class="c-num">{props.index + 1}</span>
      <span class="c-identity">
        <span
          class="c-art"
          draggable={String(Boolean(row().cardId || row().cardName))}
          onDragStart={(event) => {
            const r = row();
            if (!r.cardId && !r.cardName) return;
            writeListingDrag(event, cardReference({
              id: r.cardId,
              name: r.cardName,
              imageUrl: r.imageUrl || zoomSrc() || thumbArt().thumb,
              canonicalPath: r.cardId ? (publicGamePath(`/marketplace/en/cards/${r.cardId}`, game().id) || `/marketplace/en/cards/${r.cardId}`) : '',
            }));
          }}
        >
          <Show when={showCandidates() && props.image && props.image !== 'none'}>
            <img class="scan-shot" src={props.image} alt="Scanned card" />
          </Show>
          <Show when={thumbArt().thumb} fallback={<span class="art-empty" />}>
            <ThumbZoom src={zoomSrc()} full={Boolean(thumbArt().hero)} alt={row().cardName || ''}>
              <img src={thumbArt().thumb} alt="" loading="lazy" />
            </ThumbZoom>
          </Show>
        </span>
        <span class="c-card">
          <Show
            when={unidentified()}
            fallback={<strong>{row().cardName || (row().cardId ? `#${row().cardId}` : 'Not identified')}</strong>}
          >
            <ReplacePrinting inline onPick={pick} onClose={() => props.onReplaceDone()} seed="" />
          </Show>
          <ArtworkVersionSelect
            row={row()}
            closed={props.closed}
            preferredLanguage={remapLang()}
            onPick={(id) => props.onPick(id)}
          />
          <Show when={showCandidates()}>
            <CandidateAlts row={row()} preferredLanguage={remapLang()} onPick={(id) => props.onPick(id)} />
          </Show>
          <Show when={props.replacing && !unidentified()}>
            <ReplacePrinting onPick={pick} onClose={() => props.onReplaceDone()} seed={untrack(() => row().cardName)} />
          </Show>
        </span>
      </span>
      <span class="c-lang">
        <Show
          when={!props.closed}
          fallback={<img class="scan-lang-flag" src={flagSrc(langValue())} alt="" title={langValue()} width="18" height="18" />}
        >
          <label class="scan-icon-select" title={langValue()}>
            <img class="scan-lang-flag" src={flagSrc(langValue())} alt="" width="18" height="18" />
            <select
              value={langValue()}
              aria-label={`Language ${langValue()}`}
              onChange={(e) => props.onPatch({ language: e.currentTarget.value })}
              tabindex={-1}
            >
              <For each={LANGUAGES.includes(langValue()) ? LANGUAGES : [langValue(), ...LANGUAGES]}>
                {(code) => <option value={code}>{code}</option>}
              </For>
            </select>
          </label>
        </Show>
      </span>
      <span class="c-cond">
        <Show
          when={!props.closed}
          fallback={<img class="scan-cond-chip" src={conditionChipSrc(row().condition)} alt="" title={row().condition} width="28" height="20" />}
        >
          <label class="scan-icon-select" title={row().condition}>
            <img class="scan-cond-chip" src={conditionChipSrc(row().condition)} alt="" width="28" height="20" />
            <select
              value={row().condition}
              aria-label={`Condition ${row().condition}`}
              onChange={(e) => props.onPatch({ condition: e.currentTarget.value })}
              tabindex={-1}
            >
              <For each={CONDITIONS}>{(c) => <option value={c}>{c}</option>}</For>
            </select>
          </label>
        </Show>
      </span>
      <span class="c-finish">
        <Show when={!props.closed} fallback={row().foilState}>
          <select value={row().foilState} onChange={(e) => props.onPatch({ foilState: e.currentTarget.value })} tabindex={-1}>
            <For each={FINISHES}>{(f) => <option value={f.value}>{f.label}</option>}</For>
          </select>
        </Show>
      </span>
      <span class="c-flags">
        <For each={FLAG_FIELDS}>
          {(field) => (
            <button
              type="button"
              tabindex={-1}
              disabled={props.closed}
              class={row()[field] ? 'on' : ''}
              aria-pressed={String(Boolean(row()[field]))}
              onClick={() => props.onPatch({ [field]: !row()[field] })}
            >
              {FLAG_SHORT[field]}
            </button>
          )}
        </For>
      </span>
      <span
        class="c-loc"
        title={props.slot ? `Position ${props.slot.start}${props.slot.end > props.slot.start ? `–${props.slot.end}` : ''} inside the box` : undefined}
      >
        <Show
          when={!props.closed}
          fallback={(
            <>
              {row().location}
              <b class="loc-slot">{slotText(props.slot)}</b>
            </>
          )}
        >
          <input
            value={row().location ?? ''}
            tabindex={-1}
            maxlength={64}
            onBlur={(e) => {
              if (e.currentTarget.value !== row().location) props.onPatch({ location: e.currentTarget.value });
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
          />
          <Show when={row().location}><b class="loc-slot">{slotText(props.slot)}</b></Show>
        </Show>
      </span>
      <span class="c-qty">
        <Show when={!props.closed} fallback={row().quantity}>
          <input
            inputmode="numeric"
            aria-label={`Quantity for ${row().cardName || `row ${props.index + 1}`}`}
            title="Cards in this row (1–99)"
            tabindex={-1}
            maxlength={2}
            value={String(row().quantity ?? '')}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={(e) => {
              const commit = quantityFieldCommit(row(), e.currentTarget.value);
              if (commit.action === 'set') props.onPatch({ quantity: commit.quantity });
              else e.currentTarget.value = String(row().quantity);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
          />
        </Show>
      </span>
      <Show when={!props.hidePrice}>
        <span class={['c-price', { suggested: row().priceSuggested }]}>
          <Show when={!props.closed} fallback={formatSellerPrice(row().pricePkn, currency())}>
            <input
              inputmode="decimal"
              tabindex={-1}
              value={priceInputFromPkn(row().pricePkn, currency())}
              // While a suggested price is cleared for typing, it stays visible
              // as the placeholder: leaving the field empty keeps it.
              placeholder={row().priceSuggested && row().pricePkn != null ? priceInputFromPkn(row().pricePkn, currency()) : currency()}
              onFocus={(e) => {
                // Clicking in is the only thing that empties a suggested price;
                // switching versions re-suggests instead.
                props.onPriceFocus?.(row().id);
                if (row().priceSuggested) e.currentTarget.value = '';
              }}
              onBlur={(e) => {
                const r = row();
                const commit = priceFieldCommit(r, e.currentTarget.value, currency());
                if (commit.action === 'set') {
                  props.onPatch({ pricePkn: commit.pricePkn, ...(r.priceSuggested ? { priceSuggested: false } : {}) });
                  return;
                }
                if (commit.action === 'default') props.onPriceEmptied?.(r);
                e.currentTarget.value = priceInputFromPkn(r.pricePkn, currency());
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
              }}
            />
          </Show>
        </span>
      </Show>
      <span class={`c-state tone-${tone()}`}>{stateLabel()}</span>
      <span class="c-remove">
        <Show when={!props.closed}>
          <button
            type="button"
            class="scan-remove"
            tabindex={-1}
            title="Remove (Backspace)"
            aria-label={`Remove ${row().cardName || 'card'}`}
            onClick={(event) => {
              event.stopPropagation();
              props.onRemove?.();
            }}
          >
            ×
          </button>
        </Show>
      </span>
    </div>
  );
}

function PrintingSuggestList(props) {
  return (
    <Show when={props.results.length}>
      <span class="scan-replace-list" role="listbox">
        <For each={props.results}>
          {(card, i) => (
            <button
              type="button"
              role="option"
              aria-selected={String(i() === props.active)}
              class={i() === props.active ? 'on' : ''}
              onMouseDown={(e) => {
                e.preventDefault();
                props.onPick(card.id);
              }}
            >
              <Show when={card.image}><img src={card.image} alt="" /></Show>
              <span>{card.name}</span>
              <em>{[card.set, card.number].filter(Boolean).join(' ')}</em>
            </button>
          )}
        </For>
      </span>
    </Show>
  );
}

function suggestKeyDown(e, { results, active, setActive, onPick, onEscape }) {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    setActive((i) => Math.min(results.length - 1, i + 1));
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    setActive((i) => Math.max(0, i - 1));
  } else if (e.key === 'Enter' && results[active]) {
    e.preventDefault();
    onPick(results[active].id);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    onEscape?.();
  }
}

/** Header typeahead engine (liveSuggestGroups + fetchSuggestRanked). */
function createScanPrintingSuggest(query) {
  const results = createLiveSuggest(query, { kind: 'singles', limit: 20 });
  const [active, setActive] = createSignal(0);
  createEffect(query, () => { setActive(0); }, { defer: true });
  createEffect(results, (list) => {
    setActive((i) => (list.length ? Math.min(i, list.length - 1) : 0));
  });
  return { results, active, setActive };
}

function DraftHotkeyLegend(props) {
  const groups = [
    ['Condition', DRAFT_HOTKEY_LEGEND.condition],
    ['Language', DRAFT_HOTKEY_LEGEND.language],
    ['Flags', DRAFT_HOTKEY_LEGEND.toggles],
    ['Actions', DRAFT_HOTKEY_LEGEND.actions],
  ];
  return (
    <div class="scan-hotkey-legend" data-testid="hotkey-legend">
      <p class="scan-hotkey-legend-title">
        Use your keyboard or click a key to edit this card
      </p>
      <For each={groups}>
        {([title, entries]) => (
          <div class="scan-hotkey-row" role="group" aria-label={title}>
            <span class="scan-hotkey-row-label">{title}</span>
            <span class="scan-hotkey-chips">
              <For each={entries}>
                {(entry) => {
                  const active = () => draftLegendActive(entry, props.draft);
                  return (
                    <button
                      type="button"
                      class={['scan-hotkey-chip', { on: active() }]}
                      aria-pressed={String(Boolean(active()))}
                      title={`${entry.key} → ${entry.label}`}
                      onMouseDown={(event) => {
                        // Keep Qty focused (PT legend does the same).
                        event.preventDefault();
                        dispatchDraftHotkey(props.qtyInput(), entry);
                      }}
                    >
                      <kbd>{entry.key}</kbd>
                      <span>{entry.label}</span>
                    </button>
                  );
                }}
              </For>
            </span>
          </div>
        )}
      </For>
    </div>
  );
}

/**
 * Add card by name (header typeahead), then the PowerTools single-card draft:
 * Qty focused, hotkeys edit, Enter creates. `qtyRef` / `searchRef` receive the
 * Qty and search inputs; `qtyInput` reads the current Qty input.
 */
export function ManualAddBar(props) {
  const [query, setQuery] = createSignal('');
  const { results, active, setActive } = createScanPrintingSuggest(() => (props.draft ? '' : query()));
  const pick = (cardId) => {
    const card = results().find((row) => row.id === cardId) || { id: cardId };
    props.onPickCard(card);
    setQuery('');
    setActive(0);
  };
  const draft = () => props.draft;
  const finishLabel = () => FINISHES.find((f) => f.value === draft().foilState)?.label || draft().foilState;
  const flags = () => [
    draft().firstEdition ? '1st' : null,
    draft().signed ? 'Signed' : null,
    draft().altered ? 'Altered' : null,
  ].filter(Boolean).join(' · ');

  return (
    <Show
      when={draft()}
      fallback={(
        <section class="scan-manual-add" aria-label="Add card by name">
          <span class="scan-manual-add-label">Add card</span>
          <div class="scan-manual-add-field">
            <input
              ref={(el) => props.searchRef?.(el)}
              value={query()}
              placeholder="Same as header search — name, set, number…"
              aria-label="Search to add a card"
              autocomplete="off"
              onInput={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={(e) => suggestKeyDown(e, {
                results: results(),
                active: active(),
                setActive,
                onPick: pick,
                onEscape: () => {
                  if (query()) {
                    e.stopPropagation();
                    setQuery('');
                  } else {
                    e.currentTarget.blur();
                  }
                },
              })}
            />
            <PrintingSuggestList results={results()} active={active()} onPick={pick} />
          </div>
        </section>
      )}
    >
      <section class="scan-manual-add is-draft" aria-label="Article being added" data-testid="article-being-added">
        <span class="scan-manual-add-label">Adding</span>
        <div class="scan-draft-card">
          <Show when={draft().image} fallback={<span class="art-empty" />}><img src={draft().image} alt="" /></Show>
          <div class="scan-draft-copy">
            <strong>{draft().name || `#${draft().cardId}`}</strong>
            <em>{[draft().set, draft().number].filter(Boolean).join(' · ')}</em>
          </div>
        </div>
        <label class="scan-draft-qty">
          <span>Qty</span>
          <input
            ref={(el) => props.qtyRef?.(el)}
            data-pokoin-hotkeys="qty"
            data-testid="quanty-input-add-new-article"
            inputmode="numeric"
            autocomplete="off"
            value={draft().quantity === '' || draft().quantity == null ? '' : String(draft().quantity)}
            onInput={(e) => {
              const raw = e.currentTarget.value.replace(/\D/g, '').slice(0, 2);
              // Controlled like React: a rejected character is dropped from the field.
              e.currentTarget.value = raw;
              props.onDraftChange({ ...draft(), quantity: raw === '' ? '' : Number(raw) });
            }}
            onFocus={(e) => e.currentTarget.select()}
          />
        </label>
        <div class="scan-draft-attrs" aria-live="polite">
          <span>{draft().condition}</span>
          <span>{draft().language}</span>
          <span>{finishLabel()}</span>
          <Show when={flags()}><span>{flags()}</span></Show>
          <Show when={draft().location}><span>{draft().location}</span></Show>
        </div>
        <div class="scan-draft-actions">
          <button type="button" class="btn ghost" onClick={() => props.onCancelDraft()}>Cancel</button>
          <button type="button" class="btn ghost" onClick={() => props.onCreateCopy()} title="c">Create &amp; copy</button>
          <button type="button" class="btn" onClick={() => props.onCreate()} title="Enter">Create</button>
        </div>
        <DraftHotkeyLegend draft={draft()} qtyInput={props.qtyInput} />
      </section>
    </Show>
  );
}

function ReplacePrinting(props) {
  const [query, setQuery] = createSignal(untrack(() => props.seed || ''));
  let input;
  const { results, active, setActive } = createScanPrintingSuggest(query);
  onSettled(() => {
    input?.focus();
    input?.select();
  });
  return (
    <span class={props.inline ? 'scan-replace inline' : 'scan-replace'} role="dialog" aria-label="Replace printing">
      <input
        ref={(el) => { input = el; }}
        value={query()}
        placeholder="Same as header search — name, set, number…"
        onInput={(e) => setQuery(e.currentTarget.value)}
        onKeyDown={(e) => suggestKeyDown(e, {
          results: results(),
          active: active(),
          setActive,
          onPick: (id) => props.onPick(id),
          onEscape: () => props.onClose(),
        })}
      />
      <PrintingSuggestList results={results()} active={active()} onPick={(id) => props.onPick(id)} />
    </span>
  );
}
