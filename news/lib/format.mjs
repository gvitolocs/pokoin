// Shared formatting for the Pokoin News renderer. All dates render in UTC.

const DATE_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});

const TIME_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parse(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function pad(value, size = 2) {
  return String(value).padStart(size, '0');
}

// "Oct 4, 2026, 09:14 UTC"
export function formatDateTime(iso) {
  const date = parse(iso);
  if (!date) return '';
  return `${DATE_FMT.format(date)}, ${TIME_FMT.format(date)} UTC`;
}

// "Oct 4, 2026"
export function formatDate(iso) {
  const date = parse(iso);
  if (!date) return '';
  return DATE_FMT.format(date);
}

// "09:14"
export function formatTime(iso) {
  const date = parse(iso);
  if (!date) return '';
  return TIME_FMT.format(date);
}

// "Sun, 04 Oct 2026 09:14:00 GMT" for RSS.
export function rfc822(iso) {
  const date = parse(iso);
  if (!date) return '';
  return (
    `${WEEKDAYS[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ` +
    `${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:` +
    `${pad(date.getUTCSeconds())} GMT`
  );
}

// House rule: digits only, no thousands separators ("2642 PKN").
export function formatPkn(value) {
  return `${Math.round(Number(value))} PKN`;
}

const SECTION_LABELS = Object.freeze({
  sets: 'Sets',
  cards: 'Cards',
  market: 'Market',
  competitive: 'Competitive',
  collectors: 'Collectors',
  'fact-check': 'Fact Check',
  analysis: 'Analysis',
  industry: 'Industry',
});

export function sectionLabel(id) {
  if (SECTION_LABELS[id]) return SECTION_LABELS[id];
  const text = String(id || '').replace(/-/g, ' ').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

export const SECTION_NAV = Object.freeze([
  { id: 'latest', label: 'Latest', href: '/news' },
  { id: 'sets', label: 'Sets', href: '/news/sets' },
  { id: 'cards', label: 'Cards', href: '/news/cards' },
  { id: 'market', label: 'Market', href: '/news/market' },
  { id: 'competitive', label: 'Competitive', href: '/news/competitive' },
  { id: 'collectors', label: 'Collectors', href: '/news/collectors' },
  { id: 'fact-check', label: 'Fact Check', href: '/news/fact-check' },
  { id: 'analysis', label: 'Analysis', href: '/news/analysis' },
]);
