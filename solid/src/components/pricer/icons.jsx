import { Match, Switch } from 'solid-js';

/**
 * The pricer's icons: inline stroke SVGs that take the text colour. Always
 * decorative (`aria-hidden`); the label next to them says what they mean.
 */
function Icon(props) {
  return (
    <svg
      class={['pricer-icon', props.class]}
      viewBox="0 0 24 24"
      width={props.size || 20}
      height={props.size || 20}
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {props.children}
    </svg>
  );
}

/** A price tag: the pricer itself. */
export function TagIcon(props) {
  return (
    <Icon {...props}>
      <path d="M3.5 12.5 11 5h7.5v7.5L11 20z" />
      <circle cx="15" cy="8.5" r="1.2" />
    </Icon>
  );
}

/** Match the market: "=" in a circle. */
export function MatchIcon(props) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.5 10h7M8.5 14h7" />
    </Icon>
  );
}

/** Undercut: an arrow down. */
export function UndercutIcon(props) {
  return (
    <Icon {...props}>
      <path d="M12 4.5v15M6 13.5l6 6 6-6" />
    </Icon>
  );
}

/** Sit above the market: an arrow up. */
export function PremiumIcon(props) {
  return (
    <Icon {...props}>
      <path d="M12 19.5v-15M6 10.5l6-6 6 6" />
    </Icon>
  );
}

/** Sold median (last 30 days): a calendar. */
export function CalendarIcon(props) {
  return (
    <Icon {...props}>
      <rect x="4" y="5.5" width="16" height="14" rx="2" />
      <path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" />
    </Icon>
  );
}

/** A pricing group: stacked cards. */
export function GroupIcon(props) {
  return (
    <Icon {...props}>
      <rect x="7" y="7" width="12" height="13" rx="2" />
      <path d="M5 16.5V6a2 2 0 0 1 2-2h8.5" />
    </Icon>
  );
}

export function PlusIcon(props) {
  return (
    <Icon {...props}>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

/** "Batch default": a box (the batch's own choice). */
export function BatchIcon(props) {
  return (
    <Icon {...props}>
      <path d="M4 8.5 12 4l8 4.5v7L12 20l-8-4.5z" />
      <path d="M4 8.5 12 13l8-4.5M12 13v7" />
    </Icon>
  );
}

/** "No pricing": a slashed circle. */
export function NoneIcon(props) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M6 18 18 6" />
    </Icon>
  );
}

export function CloseIcon(props) {
  return (
    <Icon {...props}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Icon>
  );
}

export function BackIcon(props) {
  return (
    <Icon {...props}>
      <path d="M14.5 6 8.5 12l6 6" />
    </Icon>
  );
}

/** The action icon of a strategy tile (`strategyTile(...).icon`). */
export function ActionIcon(props) {
  return (
    <Switch fallback={<MatchIcon size={props.size} />}>
      <Match when={props.action === 'undercut'}><UndercutIcon size={props.size} /></Match>
      <Match when={props.action === 'premium'}><PremiumIcon size={props.size} /></Match>
    </Switch>
  );
}
