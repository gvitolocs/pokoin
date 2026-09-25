/** Profile display name. The @handle stays a separate username. */

export function normalizeDisplayName(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}

/** '' when the name can be saved. */
export function displayNameProblem(value) {
  const clean = normalizeDisplayName(value);
  if (!clean) return 'Enter a name.';
  if (clean.length < 2) return 'Use at least 2 characters.';
  if (clean.includes('@') || /[<>]/.test(clean)) return 'Use your name, not an email.';
  if (!/[0-9A-Za-z\u00C0-\u024F]/.test(clean)) return 'Name needs a letter or number.';
  return '';
}
