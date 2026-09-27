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
      if (!bearer) throw new Error('Sign in to manage your Telegram link.');
      const data = await pokoConnectAction(bearer, { action: 'my_status' });
      setStatus(data || { linked: false });
    } catch (err) {
      setError(err.message || 'Could not load Telegram status.');
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
      if (!bearer) throw new Error('Sign in to manage your Telegram link.');
      const data = await pokoConnectAction(bearer, { action: 'create_code' });
      setCodeInfo({ code: data.code, expiresAtMinutes: data.expiresAtMinutes || 15 });
    } catch (err) {
      setError(err.message || 'Could not create a link code.');
    } finally {
      setBusy(false);
    }
  }

  async function disconnect(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const bearer = await getBearer();
      if (!bearer) throw new Error('Sign in to manage your Telegram link.');
      await pokoConnectAction(bearer, { action: 'unlink_me' });
      setCodeInfo(null);
      setMessage('Telegram disconnected.');
      await refresh();
    } catch (err) {
      setError(err.message || 'Could not disconnect Telegram.');
    } finally {
      setBusy(false);
    }
  }

  if (status?.linked) {
    return (
      <div className="tg-connect">
        <p className="tg-connect-ok">Connected to Telegram{status.telegramUsername ? ` as @${status.telegramUsername}` : ''} ✨</p>
        <p className="tg-connect-note">
          Poko remembers your conversations privately on Telegram. Message
          {' '}<a href={`https://t.me/${BOT_USERNAME}`} target="_blank" rel="noreferrer">@{BOT_USERNAME}</a> anytime.
        </p>
        <form className="tg-connect-actions" onSubmit={disconnect}>
          <button type="submit" className="btn ghost" disabled={busy}>Disconnect Telegram</button>
        </form>
        {message ? <p className="tg-connect-ok">{message}</p> : null}
        {error ? <p className="tg-connect-err" role="alert">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="tg-connect">
      <p className="tg-connect-note">
        Link your Pokoin profile to the Poko Telegram assistant — it lets Poko recognize
        you and keep your chats personal. ✨
      </p>
      {codeInfo ? (
        <div className="tg-code-box">
          <p className="tg-code-label">Your link code (expires in {codeInfo.expiresAtMinutes} minutes, works once):</p>
          <p className="tg-code">{codeInfo.code}</p>
          <ol className="tg-steps">
            <li>Open our Telegram bot:</li>
          </ol>
          <p>
            <a className="btn" href={`https://t.me/${BOT_USERNAME}?start=connect_${codeInfo.code}`} target="_blank" rel="noreferrer">
              Open Telegram &amp; link
            </a>
          </p>
          <p className="tg-connect-note">Or message @{BOT_USERNAME} and send: <code>/connect {codeInfo.code}</code></p>
          <button type="button" className="btn ghost" onClick={() => setCodeInfo(null)}>Use a different code later</button>
        </div>
      ) : (
        <form className="tg-connect-actions" onSubmit={getCode}>
          <button type="submit" className="btn" disabled={busy}>Get link code</button>
        </form>
      )}
      {error ? <p className="tg-connect-err" role="alert">{error}</p> : null}
    </div>
  );
}
