// HTML string helpers for the Pokoin News renderer: escaping and safe URLs.
// No dependencies; every dynamic value must pass through esc().

export function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Render ` name="value"` or an empty string when the value is null/false.
export function attr(name, value) {
  if (value === null || value === undefined || value === false || value === '') return '';
  return ` ${name}="${esc(value)}"`;
}

// Only http(s), absolute-path (but not protocol-relative) URLs are allowed.
export function safeUrl(url) {
  if (typeof url !== 'string') return '#';
  const value = url.trim();
  if (!value) return '#';
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('/') && !value.startsWith('//')) return value;
  return '#';
}
