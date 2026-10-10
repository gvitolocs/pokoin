/**
 * Stable keys for the typeahead groups: the group name, with `#n` only when
 * the same name shows up again. Keying by name, not by the group's first
 * printing, keeps a group and its rows mounted when a keystroke re-ranks the
 * printings inside it, so identical results do not repaint.
 */
export function withGroupKeys(groups = []) {
  const seen = new Map();
  return (groups || []).map((group) => {
    const name = String(group?.name || '');
    const n = (seen.get(name) || 0) + 1;
    seen.set(name, n);
    return { ...group, key: n === 1 ? name : `${name}#${n}` };
  });
}
