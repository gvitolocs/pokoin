import { useEffect, useState } from 'react';

const CELEBRATED_KEY = 'pokoin.founder.celebrated';
const CONFETTI_COLORS = ['#ffd33d', '#c9b8ff', '#f5b7ff', '#7dd3fc', '#4ade80', '#ffffff'];
const PIECES = Array.from({ length: 36 }, (_, i) => ({
  left: (i * 37) % 100,
  delay: (i % 12) * 0.09,
  duration: 2.2 + ((i * 7) % 10) / 10,
  color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
  tilt: (i * 53) % 360,
  wide: i % 3 === 0,
}));

function firstVisit() {
  try {
    if (window.localStorage.getItem(CELEBRATED_KEY)) return false;
    window.localStorage.setItem(CELEBRATED_KEY, String(Date.now()));
  } catch (_) {
    // Storage blocked: celebrate anyway.
  }
  return true;
}

function longDate(iso) {
  const parsed = new Date(iso || '');
  return Number.isNaN(parsed.getTime())
    ? ''
    : parsed.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** The Founder Ambassador medal: No. 001, gold ring, violet core. */
export function FounderMedal({ size = 168 }) {
  return (
    <svg className="founder-medal-svg" viewBox="0 0 200 232" width={size} height={size * 1.16} aria-hidden="true">
      <defs>
        <linearGradient id="founder-gold" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff3b0" />
          <stop offset="0.45" stopColor="#ffd33d" />
          <stop offset="1" stopColor="#c98a00" />
        </linearGradient>
        <radialGradient id="founder-core" cx="0.5" cy="0.38" r="0.7">
          <stop offset="0" stopColor="#6d4bd8" />
          <stop offset="1" stopColor="#1d1240" />
        </radialGradient>
      </defs>
      <path d="M62 150 44 226l32-14 22 20 12-78z" fill="#8b6cf0" />
      <path d="M138 150l18 76-32-14-22 20-12-78z" fill="#6d4bd8" />
      <circle cx="100" cy="96" r="88" fill="url(#founder-gold)" />
      <circle cx="100" cy="96" r="76" fill="none" stroke="#fff6c8" strokeOpacity="0.55" strokeWidth="2" strokeDasharray="3 5" />
      <circle cx="100" cy="96" r="68" fill="url(#founder-core)" />
      <path d="m100 40 6.5 13.2 14.5 2.1-10.5 10.2 2.5 14.5-13-6.8-13 6.8 2.5-14.5-10.5-10.2 14.5-2.1z" fill="#ffd33d" />
      <text x="100" y="118" textAnchor="middle" fontSize="38" fontWeight="900" fill="#fff" fontFamily="Satoshi, system-ui, sans-serif" letterSpacing="1">001</text>
      <text x="100" y="142" textAnchor="middle" fontSize="12" fontWeight="800" fill="#ffd33d" fontFamily="Satoshi, system-ui, sans-serif" letterSpacing="3">FOUNDER</text>
    </svg>
  );
}

/**
 * Personal welcome for Pokoin's Founder Ambassador on /associate.
 * Confetti plays on the first visit on this browser, and again on a medal tap.
 */
export default function FounderWelcome({ name = '', since = '' }) {
  const [burst, setBurst] = useState(0);
  const first = String(name || '').trim() || 'Ambassador';

  useEffect(() => {
    if (firstVisit()) setBurst(1);
  }, []);

  return (
    <section className="founder-hero" aria-labelledby="founder-title">
      {burst ? (
        <div className="founder-confetti" key={burst} aria-hidden="true">
          {PIECES.map((piece, index) => (
            <span
              key={index}
              style={{
                left: `${piece.left}%`,
                background: piece.color,
                animationDelay: `${piece.delay}s`,
                animationDuration: `${piece.duration}s`,
                '--tilt': `${piece.tilt}deg`,
                width: piece.wide ? '10px' : '6px',
              }}
            />
          ))}
        </div>
      ) : null}
      <div className="founder-copy">
        <p className="founder-kicker">Founder Ambassador · No. 001</p>
        <h1 id="founder-title">Congratulations, {first}!</h1>
        <p className="founder-lede">
          You are the <strong>first Ambassador in Pokoin&rsquo;s history</strong>. You believed in this
          before the program had a page, a badge or a single mission, and you helped shape it.
          The Founder title is given once, and it is yours.
        </p>
        <ul className="founder-facts">
          <li><span>Title</span><strong>Founder Ambassador</strong></li>
          {since ? <li><span>Ambassador since</span><strong>{longDate(since)}</strong></li> : null}
          <li><span>Number</span><strong>#001 of the program</strong></li>
        </ul>
        <p className="founder-sign">Grazie di cuore — the Pokoin team</p>
      </div>
      <button
        type="button"
        className="founder-medal"
        onClick={() => setBurst((n) => n + 1)}
        aria-label="Celebrate again"
        title="Celebrate again"
      >
        <FounderMedal />
      </button>
    </section>
  );
}
