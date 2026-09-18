// Minimal QR Code encoder (ISO/IEC 18004): byte mode, ECC M or H,
// versions 1–10, automatic mask. Enough for the Scan Connect pairing URL
// (~70 bytes). Local on purpose: the URL carries a pairing secret and must
// not be sent to a third-party QR image service.
//
 // ECC H (~30% recovery) is used when the Scan desk overlays the Pokoin logo.

const ECC = {
  // format-info level bits (ISO/IEC 18004 Table 12) << 3 | mask
  M: {
    format: 0b00,
    // ECC codewords per block, versions 1–10 (Nayuki / ISO Annex)
    ecPerBlock: [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
    blocks: [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
  },
  H: {
    format: 0b10,
    ecPerBlock: [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28],
    blocks: [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8],
  },
};

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < result.length; j += 1) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i] ^= gfMul(coef, factor);
    });
  }
  return result;
}

function rawDataModules(ver) {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(ver, level) {
  const cfg = ECC[level];
  return Math.floor(rawDataModules(ver) / 8) - cfg.ecPerBlock[ver] * cfg.blocks[ver];
}

function alignmentPositions(ver, size) {
  if (ver === 1) return [];
  const numAlign = Math.floor(ver / 7) + 2;
  const step = Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

function utf8Bytes(text) {
  return Array.from(new TextEncoder().encode(String(text)));
}

/**
 * @param {string} text
 * @param {{ ecc?: 'M' | 'H' }} [opts]
 */
export function encodeQr(text, opts = {}) {
  const level = opts.ecc === 'M' ? 'M' : 'H';
  const cfg = ECC[level];
  const bytes = utf8Bytes(text);
  let ver = 1;
  for (; ver <= 10; ver += 1) {
    const countBits = ver <= 9 ? 8 : 16;
    if (4 + countBits + bytes.length * 8 <= dataCodewords(ver, level) * 8) break;
  }
  if (ver > 10) throw new Error('QR payload too long');
  const size = ver * 4 + 17;
  const capacityBits = dataCodewords(ver, level) * 8;

  const bits = [];
  const push = (value, len) => {
    for (let i = len - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, capacityBits - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) push(pad, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j];
    data.push(byte);
  }

  const numBlocks = cfg.blocks[ver];
  const eccLen = cfg.ecPerBlock[ver];
  const rawCodewords = Math.floor(rawDataModules(ver) / 8);
  const numShort = numBlocks - (rawCodewords % numBlocks);
  const shortLen = Math.floor(rawCodewords / numBlocks);
  const divisor = rsDivisor(eccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i += 1) {
    const datLen = shortLen - eccLen + (i < numShort ? 0 : 1);
    const dat = data.slice(k, k + datLen);
    k += datLen;
    const ecc = rsRemainder(dat, divisor);
    if (i < numShort) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const codewords = [];
  for (let i = 0; i < blocks[0].length; i += 1) {
    blocks.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= numShort) codewords.push(block[i]);
    });
  }

  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));
  const setFunc = (x, y, dark) => {
    modules[y][x] = dark;
    isFunction[y][x] = true;
  };

  for (let i = 0; i < size; i += 1) {
    setFunc(6, i, i % 2 === 0);
    setFunc(i, 6, i % 2 === 0);
  }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        setFunc(x, y, dist !== 2 && dist !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  const align = alignmentPositions(ver, size);
  const last = align.length - 1;
  align.forEach((ay, i) => {
    align.forEach((ax, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) setFunc(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    });
  });

  const drawFormat = (mask) => {
    const formatData = (cfg.format << 3) | mask;
    let rem = formatData;
    for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const fbits = ((formatData << 10) | rem) ^ 0x5412;
    const bit = (i) => ((fbits >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i += 1) setFunc(8, i, bit(i));
    setFunc(8, 7, bit(6));
    setFunc(8, 8, bit(7));
    setFunc(7, 8, bit(8));
    for (let i = 9; i < 15; i += 1) setFunc(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i += 1) setFunc(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i += 1) setFunc(8, size - 15 + i, bit(i));
    setFunc(8, size - 8, true);
  };
  drawFormat(0);
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const vbits = (ver << 12) | rem;
    for (let i = 0; i < 18; i += 1) {
      const dark = ((vbits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunc(a, b, dark);
      setFunc(b, a, dark);
    }
  }

  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y][x] && bitIndex < codewords.length * 8) {
          modules[y][x] = ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) !== 0;
          bitIndex += 1;
        }
      }
    }
  }

  const maskFn = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];
  const applyMask = (mask) => {
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (!isFunction[y][x] && maskFn[mask](x, y)) modules[y][x] = !modules[y][x];
      }
    }
  };

  let best = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask += 1) {
    applyMask(mask);
    drawFormat(mask);
    const score = penalty(modules, size);
    if (score < bestScore) {
      best = mask;
      bestScore = score;
    }
    applyMask(mask);
  }
  applyMask(best);
  drawFormat(best);
  return { version: ver, size, mask: best, ecc: level, modules };
}

function penalty(m, size) {
  let score = 0;
  const lineScore = (get) => {
    let s = 0;
    let run = 1;
    for (let i = 1; i <= size; i += 1) {
      if (i < size && get(i) === get(i - 1)) {
        run += 1;
      } else {
        if (run >= 5) s += 3 + (run - 5);
        run = 1;
      }
    }
    const pattern = [true, false, true, true, true, false, true];
    for (let i = 0; i + 7 <= size; i += 1) {
      if (pattern.every((v, k) => get(i + k) === v)) {
        const lightBefore = [1, 2, 3, 4].every((d) => i - d < 0 || !get(i - d));
        const lightAfter = [0, 1, 2, 3].every((d) => i + 7 + d >= size || !get(i + 7 + d));
        if (lightBefore || lightAfter) s += 40;
      }
    }
    return s;
  };
  for (let y = 0; y < size; y += 1) score += lineScore((x) => m[y][x]);
  for (let x = 0; x < size; x += 1) score += lineScore((y) => m[y][x]);
  let dark = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (m[y][x]) dark += 1;
      if (x + 1 < size && y + 1 < size && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) {
        score += 3;
      }
    }
  }
  const total = size * size;
  score += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
  return score;
}

/** SVG path data, one unit per module, with a 4-module quiet zone. */
export function qrPath(qr) {
  const parts = [];
  for (let y = 0; y < qr.size; y += 1) {
    for (let x = 0; x < qr.size; x += 1) {
      if (qr.modules[y][x]) parts.push(`M${x + 4} ${y + 4}h1v1h-1z`);
    }
  }
  return parts.join('');
}

/** Center logo geometry in the quiet-zone SVG viewBox (modules + 8). */
export function qrLogoLayout(qr, {
  logoRatio = 0.20,
  padRatio = 0.28,
} = {}) {
  const view = qr.size + 8;
  const modules = qr.size;
  const cx = view / 2;
  const cy = view / 2;
  const logo = modules * logoRatio;
  const pad = modules * padRatio;
  return {
    view,
    cx,
    cy,
    logo,
    pad,
    // Fraction of module area covered by the white pad (≈ π(r/s)²).
    coverFraction: Math.PI * ((pad / 2) / modules) ** 2,
  };
}
