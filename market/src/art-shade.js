/** Persisted leftover illustration caption shade (`#rrggbb`). */

const HEX = /^#[0-9a-fA-F]{6}$/;

export function albumShade(card) {
  const hex = String(card?.artShade || card?.art_shade || '').trim();
  return HEX.test(hex) ? hex.toLowerCase() : '';
}

export function albumShadeStyle(card) {
  const shade = albumShade(card);
  return shade ? { '--album-shade': shade } : undefined;
}
