const COMP_CDN = '/card-images/competitive';

export const FLAG = (cc) => {
  const code = String(cc || '').trim().toLowerCase();
  return code ? `${COMP_CDN}/flags/${code}.svg` : '';
};

export const SPRITE = (name) => {
  const id = String(name || '').trim();
  return id ? `${COMP_CDN}/sprites/${id}.png` : '';
};

export const FORMAT = (id) => {
  const key = String(id || '').trim();
  return key ? `${COMP_CDN}/formats/${key}.png` : '';
};

export function scanUrl(set, num) {
  const code = String(set || '').toUpperCase();
  const n = String(num || '').replace(/^0+/, '') || '0';
  if (!code) {
    return '';
  }
  return `${COMP_CDN}/scans/${code}_${n.padStart(3, '0')}_R_EN.png`;
}
