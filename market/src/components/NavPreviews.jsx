import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchPortfolioHistory, formatPknNumber } from '../api.js';
import { useAuth } from '../auth.jsx';
import { listConversations } from '../chat-client.js';
import { openThread } from '../chat-dock-store.js';
import { GAMES, game, gameSiteHref } from '../game.js';
import { loadPortfolioHistory, peekPortfolioHistory } from '../portfolio-history-cache.js';
import { DASHBOARD_SCAN } from '../punchouts.js';

export function NavHover({ id, pop, setPop, children, preview }) {
  return (
    <span
      className="nav-hover"
      onMouseEnter={() => setPop(id)}
      onMouseLeave={() => setPop((cur) => (cur === id ? '' : cur))}
      onFocus={() => setPop(id)}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        setPop((cur) => (cur === id ? '' : cur));
      }}
    >
      {children}
      {pop === id ? preview : null}
    </span>
  );
}

export function MarketPreview() {
  const current = game().id;
  const others = Object.values(GAMES).filter((row) => row.id !== current);
  return (
    <div className="nav-preview" role="region" aria-label="Card games">
      <ul>
        {others.map((row) => (
          <li key={row.id}>
            <a href={gameSiteHref(row.id)}>{row.name}</a>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function MessagesPreview() {
  const { signedIn, getBearer } = useAuth();
  const [rows, setRows] = useState([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!signedIn) return undefined;
    let live = true;
    getBearer().then((token) => listConversations(token)).then((result) => {
      if (!live) return;
      setRows((result?.conversations || []).slice(0, 6));
      setReady(true);
    }).catch(() => {
      if (live) setReady(true);
    });
    return () => { live = false; };
  }, [signedIn, getBearer]);

  return (
    <div className="nav-preview" role="region" aria-label="Recent messages">
      <strong>Recent messages</strong>
      {!signedIn ? <p>Sign in to see your messages.</p> : null}
      {signedIn && ready && !rows.length ? <p>No messages yet.</p> : null}
      {rows.length ? (
        <ul>
          {rows.map((row) => (
            <li key={row.peerUid || row.pairKey}>
              <button type="button" onClick={() => openThread(row.peerUid, row.peerUsername)}>
                <strong>@{row.peerUsername || 'Pokoin user'}</strong>
                <span>{row.preview || 'No messages yet'}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function sparkline(days) {
  const values = days.map((day) => day.totalPkn);
  if (!values.length) return '';
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = Math.max(max - min, 1);
  const width = 260;
  const height = 88;
  return values.map((value, index) => {
    const x = values.length === 1 ? width / 2 : (index / (values.length - 1)) * width;
    const y = height - 6 - ((value - min) / span) * (height - 12);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}

export function DashboardPreview() {
  const { signedIn, user, profile, getBearer } = useAuth();
  const uid = user?.uid || profile?.uid || '';
  const [days, setDays] = useState(() => peekPortfolioHistory(uid) || []);
  const [pending, setPending] = useState(Boolean(signedIn && !peekPortfolioHistory(uid)));

  useEffect(() => {
    if (!signedIn || !uid) return undefined;
    let live = true;
    const cached = peekPortfolioHistory(uid);
    if (cached) setDays(cached);
    setPending(!cached);
    loadPortfolioHistory(uid, () => getBearer().then((token) => fetchPortfolioHistory(token)))
      .then((series) => {
        if (!live) return;
        setDays(series);
      })
      .catch(() => {
        if (live) setDays([]);
      })
      .finally(() => {
        if (live) setPending(false);
      });
    return () => { live = false; };
  }, [signedIn, uid, getBearer]);

  const points = sparkline(days);
  const last = days.length ? days[days.length - 1].totalPkn : 0;

  return (
    <div className="nav-preview nav-preview-dash" role="region" aria-label="Dashboard">
      <div>
        <strong>Assets</strong>
        {pending ? <p>Loading your collection…</p> : null}
        {!pending && !days.length ? <p>{signedIn ? 'Scan cards to start the graph.' : 'Sign in to see your collection.'}</p> : null}
        {points ? (
          <>
            <p className="nav-preview-total">{formatPknNumber(last)} PKN</p>
            <svg viewBox="0 0 260 88" width="260" height="88" aria-hidden="true">
              <polyline points={points} fill="none" stroke="#ffd33d" strokeWidth="2.5" />
            </svg>
          </>
        ) : null}
      </div>
      <Link className="nav-scan" to={DASHBOARD_SCAN} aria-label="Scan cards">
        <svg viewBox="0 0 72 100" width="72" height="100" aria-hidden="true">
          <rect x="1" y="1" width="70" height="98" rx="7" fill="#17131f" stroke="#6f5414" strokeWidth="2" />
          <rect x="7" y="7" width="58" height="86" rx="4" fill="none" stroke="#ffd33d" strokeWidth="2" />
          <path d="M11 20V11h9M52 11h9v9M11 80v9h9M52 89h9v-9" fill="none" stroke="#ffd33d" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="36" cy="50" r="20" fill="#211b2b" stroke="#ffd33d" strokeWidth="2" />
          <path d="M17 50h38" fill="none" stroke="#ffd33d" strokeWidth="3" />
          <circle cx="36" cy="50" r="7" fill="#17131f" stroke="#ffd33d" strokeWidth="3" />
          <circle cx="36" cy="50" r="2.5" fill="#ffd33d" />
        </svg>
        <strong>Scan cards</strong>
      </Link>
    </div>
  );
}
