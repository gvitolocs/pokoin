import { createEffect, createSignal, For, Show, untrack } from 'solid-js';
import { fetchPortfolioHistory, formatPknNumber } from '@market/api.js';
import { listConversations } from '@market/chat-client.js';
import { openThread } from '@market/chat-dock-store.js';
import { chatPersonName } from '@market/chat-format.js';
import { GAMES, game, gameSiteHref } from '@market/game.js';
import { loadPortfolioHistory, peekPortfolioHistory } from '@market/portfolio-history-cache.js';
import { sparkline } from '@market/portfolio-sparkline.js';
import { DASHBOARD_SCAN } from '@market/punchouts.js';
import { chatDock } from '../lib/chat-dock-loader.js';
import { accountProfile } from '../stores/account.js';
import { authUser, getBearer, signedIn } from '../stores/auth.js';

/**
 * Header hover cards (market/src/components/NavPreviews.jsx). One lazy
 * chunk: Chrome imports it on the first hover / focus of a nav icon and
 * renders a preview only while its icon is hovered.
 */
export function MarketPreview() {
  const current = game().id;
  const others = Object.values(GAMES).filter((row) => row.id !== current);
  return (
    <div class="nav-preview" role="region" aria-label="Card games">
      <ul>
        <For each={others}>
          {(row) => <li><a href={gameSiteHref(row.id)} target="_self">{row.name}</a></li>}
        </For>
      </ul>
    </div>
  );
}

export function MessagesPreview() {
  const [rows, setRows] = createSignal([]);
  const [ready, setReady] = createSignal(false);

  createEffect(signedIn, (on) => {
    if (!on) return undefined;
    let live = true;
    getBearer().then((token) => listConversations(token)).then((result) => {
      if (!live) return;
      setRows((result?.conversations || []).slice(0, 6));
      setReady(true);
    }).catch(() => {
      if (live) setReady(true);
    });
    return () => {
      live = false;
    };
  });

  return (
    <div class="nav-preview" role="region" aria-label="Recent messages">
      <strong>Recent messages</strong>
      <Show when={!signedIn()}><p>Sign in to see your messages.</p></Show>
      <Show when={signedIn() && ready() && !rows().length}><p>No messages yet.</p></Show>
      <Show when={rows().length}>
        <ul>
          <For each={rows()}>
            {(row) => (
              <li>
                <button
                  type="button"
                  onClick={() => {
                    openThread(row.peerUid, row.peerUsername, undefined, {
                      displayName: row.peerDisplayName,
                      photoUrl: row.peerPhotoUrl,
                    });
                    chatDock.warm();
                  }}
                >
                  <strong>{chatPersonName(row)}</strong>
                  <span>{row.preview || 'No messages yet'}</span>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}

export function DashboardPreview() {
  const uid = () => String(authUser()?.uid || accountProfile()?.uid || '');
  const [days, setDays] = createSignal(untrack(() => peekPortfolioHistory(uid()) || []));
  const [pending, setPending] = createSignal(untrack(() => Boolean(signedIn() && !peekPortfolioHistory(uid()))));

  createEffect(
    () => (signedIn() ? uid() : ''),
    (owner) => {
      if (!owner) return undefined;
      let live = true;
      const cached = peekPortfolioHistory(owner);
      if (cached) setDays(cached);
      setPending(!cached);
      loadPortfolioHistory(owner, () => getBearer().then((token) => fetchPortfolioHistory(token)))
        .then((series) => {
          if (live) setDays(series);
        })
        .catch(() => {
          if (live) setDays([]);
        })
        .finally(() => {
          if (live) setPending(false);
        });
      return () => {
        live = false;
      };
    },
  );

  const points = () => sparkline(days());
  const last = () => (days().length ? days()[days().length - 1].totalPkn : 0);

  return (
    <div class="nav-preview nav-preview-dash" role="region" aria-label="Dashboard">
      <div>
        <strong>Assets</strong>
        <Show when={pending()}><p>Loading your collection…</p></Show>
        <Show when={!pending() && !days().length}>
          <p>{signedIn() ? 'Scan cards to start the graph.' : 'Sign in to see your collection.'}</p>
        </Show>
        <Show when={points()}>
          <p class="nav-preview-total">{formatPknNumber(last())} PKN</p>
          <svg viewBox="0 0 260 88" width="260" height="88" aria-hidden="true">
            <polyline points={points()} fill="none" stroke="#ffd33d" stroke-width="2.5" />
          </svg>
        </Show>
      </div>
      <a class="nav-scan" href={DASHBOARD_SCAN} aria-label="Scan cards">
        <svg viewBox="0 0 72 100" width="72" height="100" aria-hidden="true">
          <rect x="1" y="1" width="70" height="98" rx="7" fill="#17131f" stroke="#6f5414" stroke-width="2" />
          <rect x="7" y="7" width="58" height="86" rx="4" fill="none" stroke="#ffd33d" stroke-width="2" />
          <path d="M11 20V11h9M52 11h9v9M11 80v9h9M52 89h9v-9" fill="none" stroke="#ffd33d" stroke-width="1.5" stroke-linecap="round" />
          <circle cx="36" cy="50" r="20" fill="#211b2b" stroke="#ffd33d" stroke-width="2" />
          <path d="M17 50h38" fill="none" stroke="#ffd33d" stroke-width="3" />
          <circle cx="36" cy="50" r="7" fill="#17131f" stroke="#ffd33d" stroke-width="3" />
          <circle cx="36" cy="50" r="2.5" fill="#ffd33d" />
        </svg>
        <strong>Scan cards</strong>
      </a>
    </div>
  );
}
