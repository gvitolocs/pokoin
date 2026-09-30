import { MISSIONS, TIERS, nextStepLine, tierIndex } from '../ambassador-program.js';

const CHECK = 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z';

function Glyph({ d, size = 22 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path fill="currentColor" d={d} />
    </svg>
  );
}

/** Collector → Ambassador → Senior → City, trainer-badge style. */
export function TierLadder({ tier = 'collector', city = '' }) {
  const current = tierIndex(tier);
  return (
    <ol className="amb-ladder" aria-label="Ambassador tiers">
      {TIERS.map((row, index) => {
        const state = index < current ? 'is-done' : index === current ? 'is-current' : 'is-locked';
        return (
          <li key={row.key} className={`amb-ladder-step ${state}`} aria-current={index === current ? 'step' : undefined}>
            <span className="amb-medal" aria-hidden="true">{index < current ? <Glyph d={CHECK} size={18} /> : index + 1}</span>
            <strong>{row.key === 'city' && city && index === current ? `${row.title} · ${city}` : row.title}</strong>
            <span>{row.rule}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** The six missions; `completed` lights up the ones already verified. */
export function MissionGrid({ completed = null, activatedReferrals = 0, referralTarget = 3 }) {
  const done = new Set(completed || []);
  return (
    <ul className="amb-missions">
      {MISSIONS.map((mission) => {
        const isDone = done.has(mission.key);
        return (
          <li key={mission.key} className={`amb-mission${isDone ? ' is-done' : ''}`}>
            <span className="amb-mission-icon"><Glyph d={isDone ? CHECK : mission.icon} /></span>
            <span className="amb-mission-text">
              <strong>{mission.title}</strong>
              <span>{mission.text}</span>
              {completed && mission.key === 'referrals' && !isDone ? (
                <span className="amb-mission-meter">
                  <span className="amb-meter"><span style={{ width: `${Math.min(100, (activatedReferrals / referralTarget) * 100)}%` }} /></span>
                  {Math.min(activatedReferrals, referralTarget)}/{referralTarget}
                </span>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Signed-in trainer card: tier, mission meter, next unlock. */
export function TrainerCard({ progress, username = '' }) {
  const completed = progress?.completed || [];
  const pct = Math.round((completed.length / MISSIONS.length) * 100);
  return (
    <section className={`amb-trainer is-${progress?.tier || 'collector'}${progress?.founder ? ' is-founder' : ''}`}>
      <div className="amb-trainer-head">
        {progress?.founder ? <span className="amb-trainer-badge is-founder">Founder Ambassador</span> : null}
        <span className="amb-trainer-badge">{TIERS[tierIndex(progress?.tier)].title}</span>
        {username ? <strong className="amb-trainer-name">@{username}</strong> : null}
      </div>
      <div className="amb-xp">
        <span className="amb-xp-label">Missions {completed.length}/{MISSIONS.length}</span>
        <span className="amb-meter is-xp"><span style={{ width: `${pct}%` }} /></span>
        <span className="amb-xp-next">{nextStepLine(progress)}</span>
      </div>
      <TierLadder tier={progress?.tier} city={progress?.city} />
    </section>
  );
}
