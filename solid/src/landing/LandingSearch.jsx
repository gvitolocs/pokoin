import { createEffect, createMemo, createSignal, createUniqueId, For, onSettled, Show } from 'solid-js';
import { cardHref, imageSrc } from '@market/api.js';
import { searchHref } from '@market/search-kind.js';
import { Action, track } from '@market/track.js';
import { createLiveSuggest } from '../lib/live-suggest.js';

const LIMIT = 8;

function thumb(card) {
  try {
    return imageSrc({ id: card.id, name: card.name, image: card.image, gridImageUrl: card.image }, 'suggest') || card.image;
  } catch (_) {
    return card.image || '';
  }
}

/**
 * The hero search's typeahead: the header search bar's engine
 * (createLiveSuggest) painted under the landing's own input. Enter without a
 * highlighted row submits the form (/marketplace/search?q=…).
 */
export default function LandingSearch(props) {
  const form = props.form;
  const input = props.input;
  const listId = createUniqueId();
  const [query, setQuery] = createSignal(input.value || '');
  const [open, setOpen] = createSignal(document.activeElement === input);
  const [active, setActive] = createSignal(-1);
  const results = createLiveSuggest(query, { limit: LIMIT });
  const term = () => query().trim();
  const shown = createMemo(() => (open() && term() ? results() : []));
  const allHref = () => searchHref(term());

  createEffect(
    () => [term(), results().length],
    () => {
      setActive(-1);
    },
  );

  createEffect(
    () => [shown().length > 0, active()],
    ([expanded, index]) => {
      input.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      if (expanded && index >= 0) input.setAttribute('aria-activedescendant', `${listId}-${index}`);
      else input.removeAttribute('aria-activedescendant');
      form.classList.toggle('is-open', expanded);
    },
  );

  const go = (href) => {
    setOpen(false);
    window.location.assign(href);
  };

  const pick = (card, rank) => {
    track(Action.clickTile, card, { resultRank: rank, surface: 'landing-search' });
  };

  onSettled(() => {
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', listId);
    input.setAttribute('aria-expanded', 'false');
    const onInput = () => {
      setQuery(input.value);
      setOpen(true);
    };
    const onFocus = () => setOpen(true);
    const onKey = (event) => {
      const rows = shown();
      if (event.key === 'Escape') {
        if (open()) {
          event.preventDefault();
          setOpen(false);
        }
        return;
      }
      if (!rows.length) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActive((index) => (index + 1) % (rows.length + 1));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActive((index) => (index <= 0 ? rows.length : index - 1));
      } else if (event.key === 'Enter' && active() >= 0) {
        event.preventDefault();
        const card = rows[active()];
        if (card) {
          pick(card, active());
          go(cardHref(card));
        } else {
          go(allHref());
        }
      }
    };
    const onPointer = (event) => {
      if (!form.contains(event.target)) setOpen(false);
    };
    input.addEventListener('input', onInput);
    input.addEventListener('focus', onFocus);
    input.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      input.removeEventListener('input', onInput);
      input.removeEventListener('focus', onFocus);
      input.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  });

  return (
    <Show when={shown().length}>
      <ul class="hero-suggest-list" id={listId} role="listbox" aria-label="Suggestions">
        <For each={shown()}>
          {(card, index) => (
            <li
              id={`${listId}-${index()}`}
              role="option"
              aria-selected={active() === index() ? 'true' : 'false'}
              class={{ 'is-active': active() === index() }}
            >
              <a
                href={cardHref(card)}
                tabindex="-1"
                onClick={() => pick(card, index())}
                onPointerEnter={() => setActive(index())}
              >
                <span class="hero-suggest-thumb">
                  <Show when={thumb(card)}>
                    <img src={thumb(card)} alt="" width="40" height="56" loading="lazy" decoding="async" />
                  </Show>
                </span>
                <span class="hero-suggest-text">
                  <strong>{card.name}</strong>
                  <span>{[card.set, card.number].filter(Boolean).join(' · ').replace(/\s*\|\s*/g, ' · ')}</span>
                </span>
              </a>
            </li>
          )}
        </For>
        <li
          id={`${listId}-${shown().length}`}
          role="option"
          aria-selected={active() === shown().length ? 'true' : 'false'}
          class={['hero-suggest-all', { 'is-active': active() === shown().length }]}
        >
          <a href={allHref()} tabindex="-1" onPointerEnter={() => setActive(shown().length)}>
            See all results for “{term()}” <span aria-hidden="true">→</span>
          </a>
        </li>
      </ul>
    </Show>
  );
}
