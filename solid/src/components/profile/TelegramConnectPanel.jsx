import { createEffect, createSignal, onSettled, Show } from 'solid-js';
import { pokoConnectAction } from '@market/api.js';
import { getBearer } from '../../stores/auth.js';

const BOT_USERNAME = 'pokoinpos_bot';

/** Poko chat links: one profile code connects Telegram or Discord. */
export default function TelegramConnectPanel(props) {
  const [status, setStatus] = createSignal(null);
  const [codeInfo, setCodeInfo] = createSignal(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [message, setMessage] = createSignal('');

  async function refresh() {
    setError('');
    try {
      const bearer = await getBearer();
      if (!bearer) throw new Error('Sign in to manage your Poko links.');
      const data = await pokoConnectAction(bearer, { action: 'my_status' });
      setStatus(() => data || { linked: false, telegram: { linked: false }, discord: { linked: false } });
    } catch (err) {
      setError(err.message || 'Could not load connect status.');
    }
  }

  onSettled(() => {
    refresh();
  });
  createEffect(status, (value) => {
    if (value) props.onStatus?.(value);
  });

  async function getCode(event) {
    event.preventDefault();
    if (busy()) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const bearer = await getBearer();
      if (!bearer) throw new Error('Sign in to manage your Poko links.');
      const data = await pokoConnectAction(bearer, { action: 'create_code' });
      setCodeInfo({ code: data.code, expiresAtMinutes: data.expiresAtMinutes || 15 });
    } catch (err) {
      setError(err.message || 'Could not create a link code.');
    } finally {
      setBusy(false);
    }
  }

  async function disconnect(channel) {
    if (busy()) return;
    setBusy(true);
    setError('');
    try {
      const bearer = await getBearer();
      if (!bearer) throw new Error('Sign in to manage your Poko links.');
      await pokoConnectAction(bearer, { action: 'unlink_me', channel });
      setCodeInfo(null);
      setMessage(channel === 'discord' ? 'Discord disconnected.' : 'Telegram disconnected.');
      await refresh();
    } catch (err) {
      setError(err.message || 'Could not disconnect.');
    } finally {
      setBusy(false);
    }
  }

  const telegram = () => status()?.telegram || { linked: Boolean(status()?.linked), username: status()?.telegramUsername || '' };
  const discord = () => status()?.discord || { linked: false };

  return (
    <div class="tg-connect">
      <p class="tg-connect-note">
        Keep your Poko conversation going on Telegram or Discord. Linked chats share the
        private memory of your website Messages.
      </p>

      <Show when={telegram().linked}>
        <div class="tg-connect-row">
          <p class="tg-connect-ok">Telegram{telegram().username ? ` @${telegram().username}` : ''} connected</p>
          <button type="button" class="btn ghost" disabled={busy()} onClick={() => disconnect('telegram')}>Disconnect Telegram</button>
        </div>
      </Show>

      <Show when={discord().linked}>
        <div class="tg-connect-row">
          <p class="tg-connect-ok">Discord{discord().username ? ` @${discord().username}` : ''} connected</p>
          <button type="button" class="btn ghost" disabled={busy()} onClick={() => disconnect('discord')}>Disconnect Discord</button>
        </div>
      </Show>

      <Show
        when={codeInfo()}
        fallback={(
          <form class="tg-connect-actions" onSubmit={getCode}>
            <button type="submit" class="btn btn-telegram" disabled={busy()}>{busy() ? 'Creating…' : 'Get link code'}</button>
          </form>
        )}
      >
        {(info) => (
          <div class="tg-code-box">
            <p class="tg-code-label">Your link code (expires in {info().expiresAtMinutes} minutes, works once):</p>
            <p class="tg-code">{info().code}</p>
            <p>
              <a class="btn btn-telegram" href={`https://t.me/${BOT_USERNAME}?start=connect_${info().code}`} target="_blank" rel="noreferrer">
                Open Telegram &amp; link
              </a>
            </p>
            <p class="tg-connect-note">Telegram: message @{BOT_USERNAME} with <code>/connect {info().code}</code></p>
            <p class="tg-connect-note">Discord: DM Poko (or an allowed channel) with <code>/connect {info().code}</code></p>
            <button type="button" class="btn ghost" onClick={() => setCodeInfo(null)}>Use a different code later</button>
          </div>
        )}
      </Show>

      <Show when={message()}><p class="tg-connect-ok">{message()}</p></Show>
      <Show when={error()}><p class="tg-connect-err" role="alert">{error()}</p></Show>
    </div>
  );
}
