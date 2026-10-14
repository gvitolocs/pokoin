import { For, Show } from 'solid-js';
import { MISSIONS, TIERS, nextStepLine, tierIndex } from '@market/ambassador-program.js';

const CHECK = 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z';

function Glyph(props) {
  return (
    <svg viewBox="0 0 24 24" width={props.size ?? 22} height={props.size ?? 22} aria-hidden="true">
      <path fill="currentColor" d={props.d} />
    </svg>
  );
}

/** Collector → Ambassador → Senior → City, trainer-badge style. */
export function TierLadder(props) {
  const current = () => tierIndex(props.tier || 'collector');
  return (
    <ol class="amb-ladder" aria-label="Ambassador tiers">
      <For each={TIERS}>
        {(row, index) => (
          <li
            class={['amb-ladder-step', index() < current() ? 'is-done' : index() === current() ? 'is-current' : 'is-locked']}
            aria-current={index() === current() ? 'step' : undefined}
          >
            <span class="amb-medal" aria-hidden="true">
              <Show when={index() < current()} fallback={index() + 1}><Glyph d={CHECK} size={18} /></Show>
            </span>
            <strong>{row.key === 'city' && props.city && index() === current() ? `${row.title} · ${props.city}` : row.title}</strong>
            <span>{row.rule}</span>
          </li>
        )}
      </For>
    </ol>
  );
}

/** The six missions; `completed` lights up the ones already verified. */
export function MissionGrid(props) {
  const done = () => new Set(props.completed || []);
  const target = () => props.referralTarget || 3;
  const activated = () => props.activatedReferrals || 0;
  return (
    <ul class="amb-missions">
      <For each={MISSIONS}>
        {(mission) => (
          <li class={['amb-mission', { 'is-done': done().has(mission.key) }]}>
            <span class="amb-mission-icon"><Glyph d={done().has(mission.key) ? CHECK : mission.icon} /></span>
            <span class="amb-mission-text">
              <strong>{mission.title}</strong>
              <span>{mission.text}</span>
              <Show when={props.completed && mission.key === 'referrals' && !done().has(mission.key)}>
                <span class="amb-mission-meter">
                  <span class="amb-meter"><span style={{ width: `${Math.min(100, (activated() / target()) * 100)}%` }} /></span>
                  {Math.min(activated(), target())}/{target()}
                </span>
              </Show>
            </span>
          </li>
        )}
      </For>
    </ul>
  );
}

/** Signed-in trainer card: tier, mission meter, next unlock. */
export function TrainerCard(props) {
  const completed = () => props.progress?.completed || [];
  const pct = () => Math.round((completed().length / MISSIONS.length) * 100);
  return (
    <section class={['amb-trainer', `is-${props.progress?.tier || 'collector'}`, { 'is-founder': Boolean(props.progress?.founder) }]}>
      <div class="amb-trainer-head">
        <Show when={props.progress?.founder}><span class="amb-trainer-badge is-founder">Founder Ambassador</span></Show>
        <span class="amb-trainer-badge">{TIERS[tierIndex(props.progress?.tier)].title}</span>
        <Show when={props.username}><strong class="amb-trainer-name">@{props.username}</strong></Show>
      </div>
      <div class="amb-xp">
        <span class="amb-xp-label">Missions {completed().length}/{MISSIONS.length}</span>
        <span class="amb-meter is-xp"><span style={{ width: `${pct()}%` }} /></span>
        <span class="amb-xp-next">{nextStepLine(props.progress)}</span>
      </div>
      <TierLadder tier={props.progress?.tier} city={props.progress?.city} />
    </section>
  );
}
