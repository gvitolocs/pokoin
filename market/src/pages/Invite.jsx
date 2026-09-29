import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { fetchReferral, formatPknNumber } from '../api.js';
import { useAuth } from '../auth.jsx';
import { authFrom } from '../punchouts.js';
import { Alert, DeskPanel, SessionWait } from '../components/Desk.jsx';
import {
  INVITE_STATUS_LABEL,
  REFERRAL_CLAIM_WINDOW_DAYS,
  REFERRAL_REWARD_PKN,
  inviteLink,
} from '../referral.js';
import '../referral.css';

const STEPS = [
  { title: 'Share your link', text: 'Send pokoin.com/join/you to a friend who collects.' },
  { title: 'They join', text: `They create a Pokoin account within ${REFERRAL_CLAIM_WINDOW_DAYS} days of opening it.` },
  { title: 'First deal', text: 'They complete their first purchase or first sale.' },
  { title: `+${REFERRAL_REWARD_PKN} PKN each`, text: 'Pokoin pays you both, straight into your site balance.' },
];

function shortDate(iso) {
  const parsed = new Date(iso || '');
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function ShareLink({ link }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch (_) {
      setCopied(false);
    }
  };
  const share = async () => {
    try {
      await navigator.share({ title: 'Join me on Pokoin', text: `Join Pokoin with my link — we both get ${REFERRAL_REWARD_PKN} PKN.`, url: link });
    } catch (_) {
      // Share sheet dismissed.
    }
  };
  return (
    <div className="referral-link">
      <input readOnly value={link} aria-label="Your invite link" onFocus={(event) => event.target.select()} />
      <button type="button" className="btn" onClick={copy}>{copied ? 'Copied' : 'Copy link'}</button>
      {typeof navigator !== 'undefined' && navigator.share ? (
        <button type="button" className="btn ghost" onClick={share}>Share</button>
      ) : null}
    </div>
  );
}

export default function Invite() {
  const location = useLocation();
  const { ready, signedIn, getBearer } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    document.title = 'Invite & Earn · Pokoin';
  }, []);

  useEffect(() => {
    if (!signedIn) return undefined;
    let cancelled = false;
    getBearer()
      .then((token) => fetchReferral(token))
      .then((payload) => { if (!cancelled) setData(payload); })
      .catch((err) => { if (!cancelled) setError(err?.message || 'Invite & Earn is unreachable right now.'); });
    return () => { cancelled = true; };
  }, [signedIn, getBearer]);

  if (!ready) return <SessionWait />;
  if (!signedIn) return <Navigate to={authFrom(location.pathname || '/invite')} replace />;

  const link = inviteLink(data?.code);
  const stats = data?.stats || { invited: 0, pending: 0, activated: 0, earnedPkn: 0 };

  return (
    <div className="page referral-page">
      <section className="referral-hero">
        <div className="referral-hero-copy">
          <p className="referral-kicker">Invite &amp; Earn</p>
          <h1>Bring a collector. You both get {REFERRAL_REWARD_PKN} PKN.</h1>
          <p className="referral-lede">
            When someone joins with your link and completes a first purchase or a first sale,
            Pokoin pays {REFERRAL_REWARD_PKN} PKN to each of you.
          </p>
          {error ? <Alert>{error}</Alert> : null}
          {!data && !error ? <div className="referral-link is-loading"><div className="skeleton-line" /></div> : null}
          {data && link ? <ShareLink link={link} /> : null}
          {data && !link ? (
            <Alert>
              Your invite link is your Pokoin username. <Link to="/profile">Pick a username on your profile</Link> to get one.
            </Alert>
          ) : null}
        </div>
        <dl className="referral-stats">
          <div><dt>Invited</dt><dd>{stats.invited}</dd></div>
          <div><dt>Activated</dt><dd>{stats.activated}</dd></div>
          <div><dt>Earned</dt><dd>{formatPknNumber(stats.earnedPkn)} <small>PKN</small></dd></div>
        </dl>
      </section>

      {data?.referredBy ? (
        <p className="referral-banner">
          You joined with @{data.referredBy.username}&rsquo;s link.{' '}
          {data.referredBy.status === 'rewarded'
            ? `You both received ${REFERRAL_REWARD_PKN} PKN.`
            : `Make your first purchase or sale and you both get ${REFERRAL_REWARD_PKN} PKN.`}
        </p>
      ) : null}

      <ol className="referral-steps">
        {STEPS.map((step, index) => (
          <li key={step.title}>
            <span className="referral-step-n">{index + 1}</span>
            <strong>{step.title}</strong>
            <span>{step.text}</span>
          </li>
        ))}
      </ol>

      <DeskPanel flush title={`Your invites${stats.invited ? ` · ${stats.invited}` : ''}`} className="referral-list-panel">
        {data?.invited?.length ? (
          <ul className="referral-list">
            {data.invited.map((row) => (
              <li key={`${row.username}-${row.claimedAt}`} className={`is-${row.status}`}>
                <span className="referral-list-who">
                  <strong>@{row.username || 'collector'}</strong>
                  <span>
                    Joined {shortDate(row.claimedAt)}
                    {row.rewardedAt ? ` · first ${row.kind === 'sale' ? 'sale' : 'purchase'} ${shortDate(row.rewardedAt)}` : ''}
                  </span>
                </span>
                <span className="referral-list-status">{INVITE_STATUS_LABEL[row.status] || row.status}</span>
                <strong className="referral-list-earned">{row.earnedPkn ? `+${formatPknNumber(row.earnedPkn)} PKN` : '—'}</strong>
              </li>
            ))}
          </ul>
        ) : (
          <p className="page-lede referral-empty">No invites yet. Share your link — invites show up here as soon as someone joins.</p>
        )}
      </DeskPanel>

      <section className="referral-ambassador-cta">
        <div>
          <strong>Want to do more for the community?</strong>
          <span>Become a Pokoin Ambassador: complete missions, level up, unlock perks.</span>
        </div>
        <Link className="btn ghost" to="/ambassadorprogram">Ambassador program</Link>
      </section>

      <p className="referral-fine">
        Rules: the invited account must be new (created within {REFERRAL_CLAIM_WINDOW_DAYS} days) and must not have bought or sold before.
        Orders between you and the person you invited do not count. Rewards are paid once per invited collector,
        from the Pokoin treasury, and appear in your balance and ledger.
      </p>
    </div>
  );
}
