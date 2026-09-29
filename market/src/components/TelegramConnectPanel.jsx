import { useEffect, useState } from 'react';
import { pokoConnectAction } from '../api.js';
import { useAuth } from '../auth.jsx';

const BOT_USERNAME = 'pokoinpos_bot';

export default function TelegramConnectPanel() {
  const { getBearer } = useAuth();
  const [status, setStatus] = useState(null);
  const [codeInfo, setCodeInfo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  async function refresh() {
    setError('');
    try {
      const bearer = await getBearer();
      if (!bearer) throw new Error('Sign in to manage your Poko links.');
      const data = await pokoConnectAction(bearer, { action: 'my_status' });
      setStatus(data || { linked: false, telegram: { linked: false }, discord: { linked: false } });
    } catch (err) {
      setError(err.message || 'Could not load connect status.');
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function getCode(event) {
    event.preventDefault();
    if (busy) return;
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
    if (busy) return;
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

  const telegram = status?.telegram || { linked: Boolean(status?.linked), username: status?.telegramUsername || '' };
  const discord = status?.discord || { linked: false };

  return (
    <div className="tg-connect">
      <p className="tg-connect-note">
        Link Poko on Telegram and/or Discord with one profile code. Linked chats share the same
        private memory as website Messages — never another user&apos;s. ✨
      </p>

      {telegram.linked ? (
        <div className="tg-connect-row">
          <p className="tg-connect-ok">
            Telegram{telegram.username ? ` @${telegram.username}` : ''} connected
          </p>
          <button type="button" className="btn ghost" disabled={busy} onClick={() => disconnect('telegram')}>
            Disconnect Telegram
          </button>
        </div>
      ) : null}

      {discord.linked ? (
        <div className="tg-connect-row">
          <p className="tg-connect-ok">
            Discord{discord.username ? ` @${discord.username}` : ''} connected
          </p>
          <button type="button" className="btn ghost" disabled={busy} onClick={() => disconnect('discord')}>
            Disconnect Discord
          </button>
        </div>
      ) : null}

      {codeInfo ? (
        <div className="tg-code-box">
          <p className="tg-code-label">Your link code (expires in {codeInfo.expiresAtMinutes} minutes, works once):</p>
          <p className="tg-code">{codeInfo.code}</p>
          <p>
            <a className="btn" href={`https://t.me/${BOT_USERNAME}?start=connect_${codeInfo.code}`} target="_blank" rel="noreferrer">
              Open Telegram &amp; link
            </a>
          </p>
          <p className="tg-connect-note">
            Telegram: message @{BOT_USERNAME} with <code>/connect {codeInfo.code}</code>
          </p>
          <p className="tg-connect-note">
            Discord: DM Poko (or an allowed channel) with <code>/connect {codeInfo.code}</code>
          </p>
          <button type="button" className="btn ghost" onClick={() => setCodeInfo(null)}>Use a different code later</button>
        </div>
      ) : (
        <form className="tg-connect-actions" onSubmit={getCode}>
          <button type="submit" className="btn" disabled={busy}>Get link code</button>
        </form>
      )}

      {message ? <p className="tg-connect-ok">{message}</p> : null}
      {error ? <p className="tg-connect-err" role="alert">{error}</p> : null}
    </div>
  );
}
