import { useCallback, useEffect, useState } from 'react';
import { getBearer } from '../auth.jsx';
import { fetchSellerApiGrants, sellerApiGrantAction } from '../api.js';

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

/**
 * Tokens that let an inventory app keep this seller's Pokoin stock in step
 * and hear about their sales. A token is shown once, when it is created.
 */
export default function SellerApiPanel() {
  const [grants, setGrants] = useState(null);
  const [app, setApp] = useState('cardrails');
  const [name, setName] = useState('');
  const [created, setCreated] = useState(null);
  const [copied, setCopied] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await fetchSellerApiGrants(await getBearer());
      setGrants(Array.isArray(data?.grants) ? data.grants : []);
    } catch (err) {
      setGrants([]);
      setError(err?.message || 'Could not load your API tokens.');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const run = useCallback(async (body, done) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const data = await sellerApiGrantAction(await getBearer(), body);
      done?.(data);
      await load();
    } catch (err) {
      setError(err?.message || 'That did not work. Try again.');
    } finally {
      setBusy(false);
    }
  }, [load]);

  const onCreate = (event) => {
    event.preventDefault();
    const client = app || name.trim();
    if (!client) {
      setError('Name the app this token is for.');
      return;
    }
    run({ action: 'create', client, label: app ? '' : name.trim() }, (data) => {
      setCreated(data);
      setCopied('');
      setName('');
    });
  };

  const copy = async (key, value) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
    } catch (_) {
      setCopied('');
    }
  };

  return (
    <div className="seller-api">
      <p className="page-lede">
        A token lets an inventory app such as{' '}
        <a href={CARD_RAILS_URL} target="_blank" rel="noreferrer">Card Rails</a>{' '}
        set the quantity of your Pokoin listings, list cards for you and receive your Pokoin sales.
        It cannot spend PKN, read your orders&rsquo; buyers or sign in as you. Revoke it any time.
      </p>

      {created?.token ? (
        <div className="seller-api-created" role="status">
          <strong>Copy this token now — it is not shown again.</strong>
          <div className="ct-token-row">
            <label className="ct-token-field">
              <span className="sr-only">New Pokoin API token</span>
              <input type="text" readOnly value={created.token} onFocus={(event) => event.target.select()} />
            </label>
            <button type="button" className="btn" onClick={() => copy('token', created.token)}>
              {copied === 'token' ? 'Copied' : 'Copy token'}
            </button>
          </div>
          <p className="page-lede muted">
            Paste it into {grantAppName(created.grant)} where it asks for your Pokoin grant.
            Webhooks to this app are signed with its own secret, which the app reads through the API.
          </p>
          <div className="ct-connect-actions">
            <button type="button" className="btn ghost" onClick={() => setCreated(null)}>Done</button>
          </div>
        </div>
      ) : null}

      {grants === null ? <p className="page-lede muted">Loading tokens…</p> : null}
      {grants?.length ? (
        <ul className="seller-api-list">
          {grants.map((grant) => (
            <li key={grant.id} className="seller-api-row">
              <span className="seller-api-text">
                <strong>{grantAppName(grant)}</strong>
                <span className="setup-meta">
                  <code>{grant.tokenPrefix}…</code>
                  {' · '}
                  {grant.lastUsedAt ? `last used ${when(grant.lastUsedAt)}` : 'never used'}
                  {' · '}
                  {grant.webhookUrl ? `webhook → ${new URL(grant.webhookUrl).host}` : 'no webhook'}
                </span>
              </span>
              <span className="ct-connect-actions">
                {grant.webhookUrl ? (
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={busy}
                    onClick={() => run({ action: 'test', id: grant.id }, () => setNotice('Test webhook queued.'))}
                  >
                    Send test
                  </button>
                ) : null}
                <button
                  type="button"
                  className="btn ghost"
                  disabled={busy}
                  onClick={() => {
                    if (!window.confirm(`Revoke the ${grantAppName(grant)} token? The app stops syncing with Pokoin at once.`)) return;
                    run({ action: 'revoke', id: grant.id }, () => {
                      if (created?.grant?.id === grant.id) setCreated(null);
                    });
                  }}
                >
                  Revoke
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <form className="ct-connect-form" onSubmit={onCreate}>
        <div className="ct-token-row">
          <label className="ct-token-field">
            <span className="sr-only">App</span>
            <select value={app} onChange={(event) => setApp(event.target.value)}>
              {SELLER_API_APPS.map((option) => (
                <option key={option.name} value={option.client}>{option.name}</option>
              ))}
            </select>
          </label>
          {app ? null : (
            <label className="ct-token-field">
              <span className="sr-only">App name</span>
              <input
                type="text"
                placeholder="App name"
                maxLength={40}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
          )}
          <button type="submit" className="btn" disabled={busy}>
            {busy ? 'Working…' : 'Create token'}
          </button>
        </div>
      </form>
      {notice ? <p className="ct-connect-ok" role="status">{notice}</p> : null}
      {error ? <p className="ct-connect-err" role="alert">{error}</p> : null}
    </div>
  );
}
