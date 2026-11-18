import { createEffect, createSignal, For, Match, Show, Switch } from 'solid-js';
import { useLocation } from '@solidjs/router';
import { useGameNavigate } from '../lib/game-navigate.js';
import { fetchExpansionSymbols, saveExpansionSymbol } from '@market/api.js';
import { Alert, DeskPanel, EmptyDesk, PageHead, Thread } from '../components/Desk.jsx';
import { accountAdmin } from '../stores/account.js';
import { getBearer, signedIn } from '../stores/auth.js';
import { RequireSignIn } from './tools/auth-gate.jsx';
import { usePageTitle } from './tools/board.jsx';

function shapeRow(row) {
  return {
    name: row.name || '',
    symbolImageUrl: row.symbolImageUrl || row.symbol_image_url || '',
    logoImageUrl: row.logoImageUrl || row.logo_image_url || '',
    sourceAssetCode: row.sourceAssetCode || row.source_asset_code || '',
  };
}

function AdminDesk() {
  const location = useLocation();
  const navigate = useGameNavigate();
  const [rows, setRows] = createSignal([]);
  const [filter, setFilter] = createSignal('');
  const [query, setQuery] = createSignal('');
  const [missing, setMissing] = createSignal(false);
  const [error, setError] = createSignal('');
  const [loading, setLoading] = createSignal(false);
  const edit = () => location.pathname.includes('/edit');
  const admin = () => accountAdmin();

  createEffect(
    () => ({ on: signedIn() && admin() && edit(), query: query(), missing: missing() }),
    ({ on, query: q, missing: missingOnly }) => {
      if (!on) return undefined;
      let cancelled = false;
      setLoading(true);
      getBearer()
        .then((token) => fetchExpansionSymbols(token, { query: q, missingOnly }))
        .then((data) => {
          if (cancelled) return;
          setRows((data.expansions || []).map(shapeRow));
          setError('');
        })
        .catch((err) => {
          if (!cancelled) setError(err.message || 'Admin load failed.');
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
      return () => {
        cancelled = true;
      };
    },
  );

  async function save(row) {
    try {
      const token = await getBearer();
      await saveExpansionSymbol({
        name: row.name,
        symbolImageUrl: row.symbolImageUrl,
        logoImageUrl: row.logoImageUrl,
        sourceAssetCode: row.sourceAssetCode,
      }, token);
    } catch (err) {
      setError(err.message || 'Save failed.');
    }
  }

  const patchRow = (name, patch) => {
    setRows((current) => current.map((item) => (item.name === name ? { ...item, ...patch } : item)));
  };

  return (
    <div class="page desk">
      <PageHead
        kicker="Ops"
        title="Admin"
        lede={admin() ? 'Admin role active. Expansion symbols only.' : 'Signed in without the admin role.'}
      />
      <Switch>
        <Match when={!admin()}>
          <EmptyDesk title="No admin tools" lede="This Firebase uid is not marked admin." />
        </Match>
        <Match when={!edit()}>
          <DeskPanel flush title="Tools">
            <div class="thread-list">
              <Thread to="/marketplace/admin/edit" title="Marketplace logo editor" meta="Expansion symbols" />
              <Thread to="/marketplace" title="Open marketplace" meta="Public shop" />
            </div>
          </DeskPanel>
        </Match>
        <Match when={edit()}>
          <DeskPanel
            title="Filter"
            actions={(
              <>
                <button class="btn" type="button" onClick={() => setQuery(filter())}>Load</button>
                <button class="btn ghost" type="button" onClick={() => navigate('/admin')}>Back</button>
              </>
            )}
          >
            <label class="sell-field">
              Name
              <input value={filter()} onInput={(event) => setFilter(event.currentTarget.value)} />
            </label>
            <label class="page-lede">
              <input type="checkbox" checked={missing()} onChange={(event) => setMissing(event.currentTarget.checked)} /> Missing logo only
            </label>
          </DeskPanel>
          <Alert>{error()}</Alert>
          <Show when={loading()}>
            <DeskPanel title="Expansions"><div class="skeleton-line" /></DeskPanel>
          </Show>
          <div class="thread-list">
            <For each={rows()} keyed={(row) => row.name}>
              {(row) => (
                <form
                  class="desk-panel"
                  onSubmit={(event) => {
                    event.preventDefault();
                    save(row());
                  }}
                >
                  <h2>{row().name}</h2>
                  <div class="desk-body">
                    <label class="sell-field">
                      Symbol URL
                      <input
                        value={row().symbolImageUrl}
                        onInput={(event) => patchRow(row().name, { symbolImageUrl: event.currentTarget.value })}
                      />
                    </label>
                    <label class="sell-field">
                      Logo URL
                      <input
                        value={row().logoImageUrl}
                        onInput={(event) => patchRow(row().name, { logoImageUrl: event.currentTarget.value })}
                      />
                    </label>
                  </div>
                  <div class="desk-actions">
                    <button class="btn" type="submit">Save</button>
                  </div>
                </form>
              )}
            </For>
          </div>
        </Match>
      </Switch>
    </div>
  );
}

/** /admin, /marketplace/admin and the expansion-symbol editor. */
export default function Admin() {
  const location = useLocation();
  usePageTitle('Admin · Pokoin');
  return (
    <RequireSignIn from={location.pathname || '/admin'}>
      <AdminDesk />
    </RequireSignIn>
  );
}
