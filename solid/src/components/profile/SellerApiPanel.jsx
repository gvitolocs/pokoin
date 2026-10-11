import { createSignal, For, onSettled, Show } from 'solid-js';
import { fetchSellerApiGrants, sellerApiGrantAction } from '@market/api.js';
import { getBearer } from '../../stores/auth.js';

/** Where Card Rails takes the token. */
export const CARD_RAILS_URL = 'https://cardrails.vercel.app';

/** The apps a seller picks from; anything else is named by hand. */
export const SELLER_API_APPS = [
  { client: 'cardrails', name: 'Card Rails' },
  { client: '', name: 'Another app' },
];

export function grantAppName(grant) {
  if (grant?.client === 'cardrails') return 'Card Rails';
  return grant?.label || grant?.client || 'App';
}

function when(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function webhookHost(url) {
  try {
    return new URL(url).host;
  } catch (_) {
    return '';
  }
}

/**
 * Tokens that let an inventory app keep this seller's Pokoin stock in step
 * and hear about their sales (market/src/components/SellerApiPanel.jsx).
 * A token is shown once, when it is created.
 */
export default function SellerApiPanel() {
  const [grants, setGrants] = createSignal(null);
  const [app, setApp] = createSignal('cardrails');
  const [name, setName] = createSignal('');
  const [created, setCreated] = createSignal(null);
  const [copied, setCopied] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [notice, setNotice] = createSignal('');

  async function bearer() {
    const token = await getBearer();
    if (!token) throw new Error('Sign in to manage your API tokens.');
    return token;
  }

  async function load() {
    try {
      const data = await fetchSellerApiGrants(await bearer());
      setGrants(() => (Array.isArray(data?.grants) ? data.grants : []));
    } catch (err) {
      setGrants(() => []);
      setError(err?.message || 'Could not load your API tokens.');
    }
  }

  onSettled(() => {
    load();
  });

  async function run(body, done) {
    if (busy()) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const data = await sellerApiGrantAction(await bearer(), body);
      done?.(data);
      await load();
    } catch (err) {
      setError(err?.message || 'That did not work. Try again.');
    } finally {
      setBusy(false);
    }
  }

  function onCreate(event) {
    event.preventDefault();
    const client = app() || name().trim();
    if (!client) {
      setError('Name the app this token is for.');
      return;
    }
    run({ action: 'create', client, label: app() ? '' : name().trim() }, (data) => {
      setCreated(() => data);
      setCopied(false);
      setName('');
    });
  }

  async function copyToken() {
    try {
      await navigator.clipboard.writeText(created()?.token || '');
      setCopied(true);
    } catch (_) {
      setCopied(false);
    }
  }

  function revoke(grant) {
    if (!window.confirm(`Revoke the ${grantAppName(grant)} token? The app stops syncing with Pokoin at once.`)) return;
    run({ action: 'revoke', id: grant.id }, () => {
      if (created()?.grant?.id === grant.id) setCreated(null);
    });
  }

  return (
    <div class="seller-api">
      <p class="page-lede">
        A token lets an inventory app such as{' '}
        <a href={CARD_RAILS_URL} target="_blank" rel="noreferrer">Card Rails</a>{' '}
        set the quantity of your Pokoin listings, list cards for you and receive your Pokoin sales.
        It cannot spend PKN, read your orders&rsquo; buyers or sign in as you. Revoke it any time.
      </p>

      <Show when={created()?.token}>
        <div class="seller-api-created" role="status">
          <strong>Copy this token now — it is not shown again.</strong>
          <div class="ct-token-row">
            <label class="ct-token-field">
              <span class="sr-only">New Pokoin API token</span>
              <input type="text" readOnly value={created()?.token || ''} onFocus={(event) => event.currentTarget.select()} />
            </label>
            <button type="button" class="btn" onClick={copyToken}>{copied() ? 'Copied' : 'Copy token'}</button>
          </div>
          <p class="page-lede muted">
            Paste it into {grantAppName(created()?.grant)} where it asks for your Pokoin grant.
            Webhooks to this app are signed with its own secret, which the app reads through the API.
          </p>
          <div class="ct-connect-actions">
            <button type="button" class="btn ghost" onClick={() => setCreated(null)}>Done</button>
          </div>
        </div>
      </Show>

      <Show when={grants() === null}><p class="page-lede muted">Loading tokens…</p></Show>
      <Show when={grants()?.length}>
        <ul class="seller-api-list">
          <For each={grants()}>
            {(grant) => (
              <li class="seller-api-row">
                <span class="seller-api-text">
                  <strong>{grantAppName(grant)}</strong>
                  <span class="setup-meta">
                    <code>{grant.tokenPrefix}…</code>
                    {' · '}
                    {grant.lastUsedAt ? `last used ${when(grant.lastUsedAt)}` : 'never used'}
                    {' · '}
                    {grant.webhookUrl ? `webhook → ${webhookHost(grant.webhookUrl)}` : 'no webhook'}
                  </span>
                </span>
                <span class="ct-connect-actions">
                  <Show when={grant.webhookUrl}>
                    <button
                      type="button"
                      class="btn ghost"
                      disabled={busy()}
                      onClick={() => run({ action: 'test', id: grant.id }, () => setNotice('Test webhook queued.'))}
                    >
                      Send test
                    </button>
                  </Show>
                  <button type="button" class="btn ghost" disabled={busy()} onClick={() => revoke(grant)}>Revoke</button>
                </span>
              </li>
            )}
          </For>
        </ul>
      </Show>

      <form class="ct-connect-form" onSubmit={onCreate}>
        <div class="ct-token-row">
          <label class="ct-token-field">
            <span class="sr-only">App</span>
            <select value={app()} onChange={(event) => setApp(event.currentTarget.value)}>
              <For each={SELLER_API_APPS}>
                {(option) => <option value={option.client}>{option.name}</option>}
              </For>
            </select>
          </label>
          <Show when={!app()}>
            <label class="ct-token-field">
              <span class="sr-only">App name</span>
              <input
                type="text"
                placeholder="App name"
                maxLength={40}
                value={name()}
                onInput={(event) => setName(event.currentTarget.value)}
              />
            </label>
          </Show>
          <button type="submit" class="btn" disabled={busy()}>{busy() ? 'Working…' : 'Create token'}</button>
        </div>
      </form>
      <Show when={notice()}><p class="ct-connect-ok" role="status">{notice()}</p></Show>
      <Show when={error()}><p class="ct-connect-err" role="alert">{error()}</p></Show>
    </div>
  );
}
