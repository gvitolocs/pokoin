import { createSignal, For, Show } from 'solid-js';
import { CONDITIONS } from '@market/card-desk.js';
import { conditionChipSrc } from '@market/listing-meta.js';
import { flagSrc } from '@market/locale.js';
import { isPriceSort, menuStep, nextPriceSort, priceArrow, SHOP_SORTS } from '@market/shop-header.js';
import { SHOP_ICO } from '@market/shop-icons.js';
import { dismissWhileOpen } from './ListingLangPick.jsx';

export function Ico(props) {
  return (
    <svg viewBox="0 0 24 24" width={props.size || 16} height={props.size || 16} aria-hidden="true">
      <path fill="currentColor" fill-rule="evenodd" d={SHOP_ICO[props.name]} />
    </svg>
  );
}

/** A header button that opens a compact listbox under it (outside click / Escape / pick close it). */
function HeaderMenu(props) {
  const [open, setOpen] = createSignal(false);
  let root;
  let trigger;
  let list;
  dismissWhileOpen(open, setOpen, () => root);

  const options = () => Array.from(list?.querySelectorAll('[role="option"]') || []);
  function focusAt(index) {
    options()[index]?.focus();
  }
  function show() {
    setOpen(true);
    queueMicrotask(() => {
      const rows = options();
      const at = rows.findIndex((row) => row.getAttribute('aria-selected') === 'true');
      rows[at >= 0 ? at : 0]?.focus();
    });
  }
  function close(refocus) {
    setOpen(false);
    if (refocus) trigger?.focus();
  }
  function onTriggerKey(event) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      show();
    }
  }
  function onMenuKey(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
      return;
    }
    if (event.key === 'Tab') {
      close(false);
      return;
    }
    const rows = options();
    const at = menuStep(event.key, rows.indexOf(document.activeElement), rows.length);
    if (at >= 0) {
      event.preventDefault();
      focusAt(at);
    }
  }

  return (
    <div class={['shop-hmenu', props.class, { 'is-open': open() }]} ref={(el) => { root = el; }}>
      <button
        type="button"
        ref={(el) => { trigger = el; }}
        class={['shop-hbtn', { 'is-active': props.active }]}
        aria-haspopup="listbox"
        aria-expanded={open() ? 'true' : 'false'}
        aria-label={props.label}
        title={props.label}
        onClick={() => (open() ? close(false) : show())}
        onKeyDown={onTriggerKey}
      >
        {props.children}
      </button>
      <Show when={open()}>
        <ul
          class={['lang-pick-menu shop-hlist', { 'is-end': props.end }]}
          role="listbox"
          aria-label={props.label}
          ref={(el) => { list = el; }}
          onKeyDown={onMenuKey}
        >
          {props.renderOptions(() => close(true))}
        </ul>
      </Show>
    </div>
  );
}

function Option(props) {
  return (
    <li>
      <button
        type="button"
        role="option"
        aria-selected={props.selected ? 'true' : 'false'}
        onClick={props.onPick}
      >
        {props.children}
        <Show when={props.selected}><em aria-hidden="true">✓</em></Show>
      </button>
    </li>
  );
}

function CondChip(props) {
  return (
    <img class="shop-cond" src={conditionChipSrc(props.value)} alt="" width="40" height="28" draggable="false" />
  );
}

function LangFlag(props) {
  return <img src={flagSrc(props.code)} alt="" width="16" height="16" draggable="false" />;
}

/**
 * Column headers of the card page Shop table. Condition, Language and Price
 * are the filters (same state the old selects drove); a trailing sort button
 * keeps the other sort orders reachable. Aligned to the .shop-terminal row grid.
 */
export default function ShopHeader(props) {
  const conditionLabel = () => CONDITIONS.find((row) => row.value === props.condition)?.label || 'Any condition';
  const sortLabel = () => SHOP_SORTS.find((row) => row.value === props.sort)?.label || 'Sort';
  return (
    <div class="shop-header" role="group" aria-label="Shop filters">
      <span class="shop-hcell shop-hseller shop-label">
        <Ico name="seller" />
        <span>Seller</span>
      </span>
      <span class="shop-hcell shop-hfacets">
        <span class="shop-hfacet-txt" />
        <HeaderMenu
          label={`Condition: ${conditionLabel()}`}
          active={Boolean(props.condition)}
          renderOptions={(done) => (
            <For each={CONDITIONS}>
              {(row) => (
                <Option
                  selected={row.value === props.condition}
                  onPick={() => { props.onCondition(row.value); done(); }}
                >
                  <Show when={row.value} fallback={<span class="shop-hopt-any">{row.label}</span>}>
                    <CondChip value={row.value} />
                    <span>{row.label}</span>
                  </Show>
                </Option>
              )}
            </For>
          )}
        >
          <Show when={props.condition} fallback={<Ico name="condition" />}>
            <CondChip value={props.condition} />
          </Show>
          <Ico name="chevron" size={14} />
        </HeaderMenu>
        <Show when={props.languages.length} fallback={<span />}>
          <HeaderMenu
            label={`Language: ${props.language || 'Any'}`}
            active={Boolean(props.language)}
            renderOptions={(done) => (
              <>
                <Option selected={!props.language} onPick={() => { props.onLanguage(''); done(); }}>
                  <span class="shop-hopt-any">Any</span>
                </Option>
                <For each={props.languages}>
                  {(code) => (
                    <Option
                      selected={code === props.language}
                      onPick={() => { props.onLanguage(code); done(); }}
                    >
                      <LangFlag code={code} />
                      <span>{code}</span>
                    </Option>
                  )}
                </For>
              </>
            )}
          >
            <Show when={props.language} fallback={<Ico name="language" />}>
              <LangFlag code={props.language} />
            </Show>
            <Ico name="chevron" size={14} />
          </HeaderMenu>
        </Show>
      </span>
      <span class="shop-hcell shop-hprice">
        <button
          type="button"
          class={['shop-hbtn', { 'is-active': isPriceSort(props.sort) }]}
          aria-label={props.sort === 'price-desc' ? 'Price, highest first' : 'Price, lowest first'}
          title={props.sort === 'price-desc' ? 'Highest price first' : 'Lowest price first'}
          onClick={() => props.onSort(nextPriceSort(props.sort))}
        >
          <span class="shop-hword">Price</span>
          <Ico name={priceArrow(props.sort)} size={14} />
        </button>
      </span>
      <span class="shop-hcell shop-hqty" role="img" aria-label="Quantity" title="Quantity">
        <Ico name="stack" />
      </span>
      <span class="shop-hcell shop-hsort">
        <HeaderMenu
          end
          label={`Sort: ${sortLabel()}`}
          active={!isPriceSort(props.sort)}
          renderOptions={(done) => (
            <For each={SHOP_SORTS}>
              {(row) => (
                <Option
                  selected={row.value === props.sort}
                  onPick={() => { props.onSort(row.value); done(); }}
                >
                  <span>{row.label}</span>
                </Option>
              )}
            </For>
          )}
        >
          <Ico name="sort" />
        </HeaderMenu>
      </span>
    </div>
  );
}
