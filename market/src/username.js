/** Pokoin usernames: the handle people send PKN and messages to.
 * Same rule as the API (`api/_username.js normalizeRequestedUsername`). */

export const USERNAME_RE = /^[a-z0-9]{3,32}$/;

/** What the user typed → what the server will store: lowercase letters and
 * digits only, `@` prefix and spaces dropped. */
export function normalizeUsernameInput(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 32);
}

/** '' when valid, else the message to show under the field. */
export function usernameProblem(value, current = '') {
  const clean = normalizeUsernameInput(value);
  if (!clean) return 'Pick a username.';
  if (clean.length < 3) return 'Use at least 3 letters or numbers.';
  if (!USERNAME_RE.test(clean)) return 'Use only letters and numbers.';
  if (clean === String(current || '').toLowerCase()) return 'That is already your username.';
  return '';
}
