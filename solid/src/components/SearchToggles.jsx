import { createEffect, createSignal, For, Show } from 'solid-js';
import { useLocation, useNavigate } from '@solidjs/router';
import { GAMES, game, gameIconSrc, gameSiteHref, sellerDeskUsesGameOverride, setScanGameOverride } from '@market/game.js';
import {
  PRINT_LANGS,
  SEARCH_LANGS,
  flagSrc,
  langMeta,
  printLangMeta,
  searchLangFromPath,
  searchLanguageNavigationPath,
  setPrintLang,
  setSearchLang,
} from '@market/locale.js';
import { dismissWhileOpen } from '../lib/dismiss.js';
import { printLang, searchLang } from '../stores/locale.js';

function Caret() {
  return (
    <svg class="lang-caret" viewBox="0 0 12 8" width="10" height="7" aria-hidden="true">
      <path fill="currentColor" d="M1.2 1.5h9.6L6 6.8z" />
    </svg>
  );
}

function GlobeIcon(props) {
  return (
    <svg class="print-lang-all" viewBox="0 0 24 24" width={props.size} height={props.size} aria-hidden={props.size ? 'true' : undefined}>
      <path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
    </svg>
  );
}

/** Card title language (market Chrome.jsx LangToggle). The URL language wins. */
export function LangToggle() {
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = createSignal(false);
  let box;
  dismissWhileOpen(open, () => box, () => setOpen(false));
  createEffect(() => searchLangFromPath(location.pathname), (fromPath) => {
    if (fromPath) setSearchLang(fromPath);
  });
  const current = () => langMeta(searchLang());
  function pick(code) {
    setSearchLang(code);
    setOpen(false);
    const nextPath = searchLanguageNavigationPath(location.pathname, code);
    if (nextPath !== location.pathname) navigate(`${nextPath}${location.search || ''}`);
  }
  return (
    <div class="lang-toggle" ref={(node) => { box = node; }}>
      <button
        type="button"
        aria-label={`Card title language, ${current().label}`}
        aria-haspopup="listbox"
        aria-expanded={open() ? 'true' : 'false'}
        title={current().label}
        onClick={() => setOpen((value) => !value)}
      >
        <img src={flagSrc(current().code)} alt="" width="40" height="40" />
        <Caret />
      </button>
      <Show when={open()}>
        <ul class="lang-menu" role="listbox" aria-label="Card title language">
          <For each={SEARCH_LANGS}>
            {(item) => (
              <li role="option" aria-selected={(item.code === searchLang()) ? 'true' : 'false'}>
                <button type="button" class={{ 'is-active': item.code === searchLang() }} onClick={() => pick(item.code)}>
                  <img src={flagSrc(item.code)} alt="" width="22" height="22" />
                  <span>{item.label}</span>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}

/** Print family chip (market Chrome.jsx PrintLangToggle). */
export function PrintLangToggle() {
  const [open, setOpen] = createSignal(false);
  let box;
  dismissWhileOpen(open, () => box, () => setOpen(false));
  const current = () => printLangMeta(printLang());
  return (
    <div class="print-lang-toggle" ref={(node) => { box = node; }}>
      <button
        type="button"
        aria-label={`Card print language, ${current().label}`}
        aria-haspopup="listbox"
        aria-expanded={open() ? 'true' : 'false'}
        title={current().label}
        onClick={() => setOpen((value) => !value)}
      >
        <span class="search-lens" aria-hidden="true">
          <span class="search-lens-mark">
            <Show when={current().flag} fallback={<GlobeIcon />}>
              <img src={flagSrc(current().flag)} alt="" />
            </Show>
          </span>
          <svg class="search-go-icon" viewBox="0 0 24 24" width="30" height="30">
            <circle cx="9.2" cy="9.2" r="7.1" fill="none" stroke="currentColor" stroke-width="1.7" />
            <path d="M14.3 14.3 21.2 21.2" fill="none" stroke="currentColor" stroke-width="2.15" stroke-linecap="round" />
          </svg>
        </span>
        <Caret />
      </button>
      <Show when={open()}>
        <ul class="lang-menu" role="listbox" aria-label="Card print language">
          <For each={PRINT_LANGS}>
            {(item) => (
              <li role="option" aria-selected={(item.code === printLang()) ? 'true' : 'false'}>
                <button
                  type="button"
                  class={{ 'is-active': item.code === printLang() }}
                  onClick={() => {
                    setPrintLang(item.code);
                    setOpen(false);
                  }}
                >
                  <Show when={item.flag} fallback={<GlobeIcon size="22" />}>
                    <img src={flagSrc(item.flag)} alt="" width="22" height="22" />
                  </Show>
                  <span>{item.label}</span>
                  <em>{item.tag || (item.flag ? item.flag.toUpperCase() : 'ALL')}</em>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}

function GameIcon(props) {
  const src = () => `url(${gameIconSrc(props.game)})`;
  return <span class="game-icon" style={{ '-webkit-mask-image': src(), 'mask-image': src() }} aria-hidden="true" />;
}

/** Game switcher (market Chrome.jsx GameSelect): another game is another host or path. */
export function GameSelect() {
  const current = game();
  const [open, setOpen] = createSignal(false);
  let box;
  dismissWhileOpen(open, () => box, () => setOpen(false));
  function pick(id) {
    setOpen(false);
    if (id === current.id) return;
    if (sellerDeskUsesGameOverride(window.location.hostname, window.location.pathname)) {
      setScanGameOverride(id);
      window.location.reload();
      return;
    }
    window.location.assign(gameSiteHref(id, window.location.pathname));
  }
  return (
    <div class="game-select" ref={(node) => { box = node; }}>
      <button
        type="button"
        aria-label={`Game, ${current.name}`}
        aria-haspopup="listbox"
        aria-expanded={open() ? 'true' : 'false'}
        title={current.name}
        onClick={() => setOpen((value) => !value)}
      >
        <GameIcon game={current} />
        <Caret />
      </button>
      <Show when={open()}>
        <ul class="lang-menu game-menu" role="listbox" aria-label="Game">
          <For each={Object.values(GAMES)}>
            {(item) => (
              <li role="option" aria-selected={(item.id === current.id) ? 'true' : 'false'}>
                <button type="button" class={{ 'is-active': item.id === current.id }} onClick={() => pick(item.id)}>
                  <GameIcon game={item} />
                  <span>{item.name}</span>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}
