/**
 * Decoder for the opt-in compact API encoding, `c1`.
 *
 * Big read responses (`/api/marketplace-expansion-page`,
 * `/api/marketplace-card-versions`, `/api/marketplace-search-page`,
 * `/api/marketplace-home-page`, `/api/marketplace-home/*`,
 * `/api/marketplace-artist-cards`, `/api/marketplace-expansions`) can be asked
 * for in a columnar form that is ~5-9x smaller on the wire. `decodeC1`
 * rebuilds **exactly** the default JSON those routes serve, so a caller can
 * swap the request and leave everything downstream alone.
 *
 * Opt in with `Accept: application/vnd.pokoin.c1+json` or `?format=c1`:
 *
 *     const response = await fetch(url, { headers: { Accept: C1_MEDIA_TYPE } });
 *     const payload = await response.json();
 *     const cards = (isC1(payload) ? decodeC1(payload) : payload).cards;
 *
 * Nothing in the SPA calls this yet — wiring pages up belongs to whoever owns
 * `market/` performance. The format is specified in
 * `docs/rust-migration/COMPACT_ENCODING.md`; the encoder is
 * `pokoin-rust/crates/api-common/src/compact/encode.rs` and the Rust decoder it
 * is mirrored from is `.../compact/decode.rs`.
 *
 * Decoded values are **structurally shared** wherever the encoder interned them
 * (a palette entry, a constant column, an aliased column): two rows can hold
 * the same object. That is what makes the decode cheap. Treat the result as
 * read-only; clone before mutating.
 */

/** The `c1` version this decoder understands. */
export const C1_FORMAT_VERSION = 1;

/** The media type that opts a request into `c1`. */
export const C1_MEDIA_TYPE = 'application/vnd.pokoin.c1+json';

/**
 * Snapshot of the append-only code tables served by `GET /api/dictionary`.
 *
 * Codes are `index + 1` and are never renumbered, so this snapshot keeps
 * decoding every code it knows forever. A payload encoded against a newer
 * dictionary can carry a code this snapshot has not seen; the decode then
 * throws and the caller should refetch `/api/dictionary` and pass the fresh
 * document as the second argument.
 *
 * Kept in step with the Rust tables by `compact.test.js`, which compares it to
 * `compact-dictionary.json` (generated from `api-common`'s `compact::dict`).
 */
export const C1_DICTIONARY = Object.freeze({
  version: '1',
  format: 'c1',
  codeBase: 1,
  appendOnly: true,
  tables: Object.freeze({
    games: Object.freeze([
      'pokemon', 'magic', 'yugioh', 'flesh_and_blood', 'digimon', 'dragon_ball_super',
      'vanguard', 'one_piece', 'lorcana', 'star_wars', 'union_arena', 'riftbound',
      'gundam', 'sorcery', 'palworld', 'cyberpunk', 'weiss_schwarz', 'final_fantasy',
      'force_of_will', 'world_of_warcraft', 'battle_spirits_saga', 'star_wars_destiny',
      'dragon_born', 'my_little_pony', 'the_spoils',
    ]),
    languages: Object.freeze([
      'EN', 'IT', 'FR', 'DE', 'ES', 'JP', 'PT', 'NL', 'PL', 'RU', 'KO', 'ZH', 'ZHT',
      'ID', 'TH', 'VI',
    ]),
    conditions: Object.freeze(['M', 'NM', 'SP', 'MP', 'PL', 'Poor']),
    printings: Object.freeze(['standard', 'reverse', 'holo', 'first_edition_holo']),
    nationalities: Object.freeze([
      'western', 'japanese', 'korean', 'chinese', 'indonesian', 'thai', 'idth',
      'unknown', 'product',
    ]),
    artLayouts: Object.freeze(['window', 'bleed', 'landscape', 'item', 'halfart']),
    rarityKinds: Object.freeze(['rainbow', 'gold', 'ghost']),
    itemKinds: Object.freeze(['single', 'product']),
    productTypes: Object.freeze([
      'card', 'jumbo', 'sealed_product', 'booster_box', 'booster_pack',
      'booster_bundle', 'collection_box', 'elite_trainer_box', 'deck', 'tin',
      'accessory', 'bundle',
    ]),
    rarities: Object.freeze([
      'Card', 'Common', 'Uncommon', 'Rare', 'Holo Rare', 'Ultra Rare', 'Secret Rare',
      'Gold Secret Rare', 'Illustration Rare', 'Special Illustration Rare',
      'Shiny Rare', 'Amazing Rare', 'Full-Art', 'Promo', 'Holo Promo', 'Non-Holo',
      'Non-Holo Promo', 'Reverse Holo', 'Cosmos Holo', 'Cracked Ice Holo',
      'Master Ball Reverse Holo', 'Poké Ball Reverse Holo', 'Shadowless', 'No Rarity',
      'No Rarity Holo', 'Jumbo Oversized', 'Fixed',
    ]),
  }),
  flags: Object.freeze({
    firstEdition: 1,
    signed: 2,
    altered: 4,
    reverse: 8,
    graded: 16,
    sealed: 32,
    nftAvailable: 64,
    shippingAvailable: 128,
    reserveAvailable: 256,
  }),
  urlPrefixes: Object.freeze([
    'https://cdn.pokoin.com/',
    'https://cdn.pokoin.com/card-images/',
    'https://cdn.pokoin.com/card-images/previews/',
    'https://cdn.pokoin.com/expansions/symbols/',
    'https://cdn.pokoin.com/expansions/logos/',
    '/card-images/',
    '/card-images/previews/',
    '/marketplace/en/cards/',
    '/marketplace/',
  ]),
});

/** A `c1` payload that could not be decoded. */
export class C1Error extends Error {
  constructor(message) {
    super(`c1 decode failed: ${message}`);
    this.name = 'C1Error';
  }
}

function fail(message) {
  throw new C1Error(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** True when a parsed response body is a `c1` document rather than plain JSON. */
export function isC1(payload) {
  return isPlainObject(payload) && payload.c1 === C1_FORMAT_VERSION;
}

/**
 * Rebuild the default JSON body from a `c1` document.
 *
 * @param {object} payload parsed `application/vnd.pokoin.c1+json` body
 * @param {object} [dictionary] a `GET /api/dictionary` document; defaults to
 *   the bundled snapshot
 * @returns {unknown} the body the same route serves as plain JSON
 */
export function decodeC1(payload, dictionary = C1_DICTIONARY) {
  if (!isPlainObject(payload)) {
    fail('document is not an object');
  }
  if (payload.c1 !== C1_FORMAT_VERSION) {
    fail(`unsupported c1 version ${JSON.stringify(payload.c1)}`);
  }
  if (!isPlainObject(dictionary) || !isPlainObject(dictionary.tables)) {
    fail('dictionary is not a /api/dictionary document');
  }
  const raw = payload.t === undefined ? [] : payload.t;
  if (!Array.isArray(raw)) {
    fail('t is not an array');
  }
  const tables = raw.map((table) => decodeTable(table, dictionary));
  if (!('b' in payload)) {
    fail('missing body');
  }
  return rebuild(payload.b, tables);
}

function rebuild(value, tables) {
  if (Array.isArray(value)) {
    return value.map((item) => rebuild(item, tables));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const keys = Object.keys(value);
  if (keys.length === 1) {
    if (keys[0] === '$c1') {
      const index = value.$c1;
      if (!Number.isInteger(index) || index < 0 || index >= tables.length) {
        fail(`table ${JSON.stringify(index)} is out of range`);
      }
      return tables[index];
    }
    // An escaped object: its own keys are literal data (one of them looks like
    // a marker), but its values can still hold placeholders.
    if (keys[0] === '$c1x' && isPlainObject(value.$c1x)) {
      const inner = value.$c1x;
      const out = {};
      for (const key of Object.keys(inner)) {
        out[key] = rebuild(inner[key], tables);
      }
      return out;
    }
  }
  const out = {};
  for (const key of keys) {
    out[key] = rebuild(value[key], tables);
  }
  return out;
}

function decodeTable(table, dictionary) {
  if (!isPlainObject(table)) {
    fail('table is not an object');
  }
  const rows = table.n;
  if (!Number.isInteger(rows) || rows < 0) {
    fail('table has no row count');
  }
  if (!Array.isArray(table.c)) {
    fail('table has no columns');
  }
  const columns = [];
  for (const column of table.c) {
    columns.push(decodeColumn(column, rows, columns, dictionary));
  }

  // No `k`: the table stood in for a flat array of scalars.
  if (table.k === undefined) {
    if (columns.length !== 1) {
      fail('a vector table needs exactly one column');
    }
    const [column] = columns;
    const out = new Array(rows);
    for (let row = 0; row < rows; row += 1) {
      const slot = column.slots === null ? row : column.slots[row];
      if (slot < 0) {
        fail('a vector table cannot have absent cells');
      }
      out[row] = column.values[slot];
    }
    return out;
  }

  if (!Array.isArray(table.k)) {
    fail('k is not an array');
  }
  if (table.k.length !== columns.length) {
    fail('key count does not match column count');
  }
  const out = new Array(rows);
  for (let row = 0; row < rows; row += 1) {
    const object = {};
    for (let index = 0; index < columns.length; index += 1) {
      const column = columns[index];
      const slot = column.slots === null ? row : column.slots[row];
      if (slot >= 0) {
        // Insertion order is the column order, which the encoder only produces
        // when it is each row's own key order.
        object[table.k[index]] = column.values[slot];
      }
    }
    out[row] = object;
  }
  return out;
}

function decodeColumn(column, rows, earlier, dictionary) {
  if (!isPlainObject(column)) {
    fail('column is not an object');
  }
  const codec = column.c;
  if (!Number.isInteger(codec)) {
    fail('column has no codec');
  }

  let slots = null;
  let present = rows;
  if (column.m !== undefined) {
    if (!Array.isArray(column.m) || column.m.length !== rows) {
      fail('presence mask length does not match the row count');
    }
    slots = new Array(rows);
    present = 0;
    for (let row = 0; row < rows; row += 1) {
      slots[row] = column.m[row] ? present++ : -1;
    }
  }

  let residuals;
  if (codec === 4) {
    const target = column.r;
    if (!Number.isInteger(target) || target < 0 || target >= earlier.length) {
      fail('ref column points forward or out of range');
    }
    // Residuals and presence both come from the referenced column.
    ({ slots, residuals } = earlier[target]);
  } else {
    residuals = residualsFor(codec, column, present, dictionary);
  }

  let values = residuals;
  if (column.ns) {
    values = values.map((value) => {
      if (!Number.isInteger(value)) {
        fail('ns column holds a non-integer');
      }
      return String(value);
    });
  }
  const prefix = affix(column, 'prei', 'pre', dictionary);
  const suffix = affix(column, 'sufi', 'suf', dictionary);
  if (prefix || suffix) {
    values = values.map((value) => {
      if (typeof value !== 'string') {
        fail('affix column holds a non-string');
      }
      return `${prefix}${value}${suffix}`;
    });
  }

  return { slots, residuals, values };
}

function residualsFor(codec, column, present, dictionary) {
  if (codec === 0) {
    if (!('v' in column)) {
      fail('const column has no value');
    }
    return new Array(present).fill(column.v);
  }
  if (codec === 1) {
    if (!Array.isArray(column.v)) {
      fail('raw column has no values');
    }
    if (column.v.length !== present) {
      fail('raw column length does not match the presence count');
    }
    return column.v;
  }
  if (codec === 2) {
    if (!Array.isArray(column.p)) {
      fail('palette column has no palette');
    }
    if (!Array.isArray(column.x)) {
      fail('palette column has no indices');
    }
    if (column.x.length !== present) {
      fail('palette index count does not match the presence count');
    }
    const entries = paletteEntries(column, dictionary);
    const values = new Array(present);
    for (let index = 0; index < present; index += 1) {
      const slot = column.x[index];
      if (!Number.isInteger(slot) || slot < 0 || slot >= entries.length) {
        fail('palette index is out of range');
      }
      values[index] = entries[slot];
    }
    return values;
  }
  if (codec === 3) {
    if (!Number.isInteger(column.z)) {
      fail('delta column has no first value');
    }
    if (!Array.isArray(column.d)) {
      fail('delta column has no deltas');
    }
    if (column.d.length + 1 !== present) {
      fail('delta count does not match the presence count');
    }
    const values = new Array(present);
    let current = column.z;
    values[0] = current;
    for (let index = 0; index < column.d.length; index += 1) {
      const delta = column.d[index];
      if (!Number.isInteger(delta)) {
        fail('delta is not an integer');
      }
      current += delta;
      values[index + 1] = current;
    }
    return values;
  }
  return fail(`unknown codec ${JSON.stringify(codec)}`);
}

function paletteEntries(column, dictionary) {
  const name = column.t;
  if (name === undefined) {
    return column.p;
  }
  const table = dictionary.tables[name];
  return column.p.map((entry) => {
    // With a table, an integer entry is a dictionary code and a string entry
    // is a literal the table does not carry.
    if (!Number.isInteger(entry)) {
      return entry;
    }
    const value = Array.isArray(table) ? table[entry - 1] : undefined;
    if (typeof value !== 'string') {
      fail(`dictionary ${name} has no code ${entry}; refetch /api/dictionary`);
    }
    return value;
  });
}

function affix(column, codeKey, literalKey, dictionary) {
  let out = '';
  if (column[codeKey] !== undefined) {
    const code = column[codeKey];
    const prefixes = dictionary.urlPrefixes;
    const prefix = Number.isInteger(code) && Array.isArray(prefixes)
      ? prefixes[code - 1]
      : undefined;
    if (typeof prefix !== 'string') {
      fail(`url prefix ${JSON.stringify(code)} is unknown; refetch /api/dictionary`);
    }
    out += prefix;
  }
  if (column[literalKey] !== undefined) {
    if (typeof column[literalKey] !== 'string') {
      fail('affix literal is not a string');
    }
    out += column[literalKey];
  }
  return out;
}
