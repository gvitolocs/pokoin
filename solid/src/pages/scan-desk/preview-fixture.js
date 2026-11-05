/**
 * Localhost / dev layout preview of the Scan desk (`/dashboard/scan?scanPreview`),
 * like MyPokoin's (`allowMypokoinPreview`): an open "List for sale" batch with
 * fixture rows, the seller's pricing groups and strategies from the MyPokoin
 * fixture, and no backend. Production hosts never take this path.
 */
import { DEFAULTS } from '@market/scan-model.js';
import { previewGroups, previewStrategies } from '../mypokoin-preview-fixture.js';

export const SCAN_PREVIEW_BANNER = 'Layout preview — fixture data. Nothing is saved, scanned or listed.';

/** What a server call answers in the preview: nothing, it is never sent. */
export const SCAN_PREVIEW_ERROR = 'Layout preview — this action needs a real session.';

export function allowScanPreview(params) {
  if (!params || params.scanPreview === undefined) return false;
  if (import.meta.env?.DEV) return true;
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname;
  return host === 'localhost' || host === '127.0.0.1';
}

// Catalog printings the MyPokoin fixture already uses (public leftover scans).
const ROWS = [
  ['222410', 'Pikachu', 'Base Set', '58/102', 'https://cdn.pokoin.com/111205_pikachu-58-102-base-set.jpg?v=bsu2', 420],
  ['222302', 'Charizard', 'Base Set', '4/102', 'https://cdn.pokoin.com/111151_charizard-holo-rare-4-102-base-set.jpg?v=bsu2', 1800],
  ['222314', 'Mewtwo', 'Base Set', '10/102', 'https://cdn.pokoin.com/111157_mewtwo-rare-holo-10-102-base-set.jpg?v=bsu2', null],
  ['502874', 'Snorlax', 'Pokémon Card 151', '181/165', 'https://cdn.pokoin.com/251437_snorlax-181-165-pokemon-card-151.jpg', 620],
  ['502862', 'Psyduck', 'Pokémon Card 151', '175/165', 'https://cdn.pokoin.com/251431_psyduck-175-165-pokemon-card-151.jpg', null],
  ['484062', 'Slowpoke', 'Scarlet & Violet', '204/198', 'https://cdn.pokoin.com/242031_slowpoke-204-198-scarlet-violet.jpg', 170],
];

/**
 * The desk's state: a connected phone, an open batch whose defaults name the
 * first fixture group (so unpriced rows read "on load"), six matched rows
 * (two unpriced), each row's one-printing version set, and the Pricing
 * select's `fetchPricingStrategies` answer.
 */
export function previewScanDesk(now = Date.now()) {
  const groups = previewGroups().groups;
  const location = 'box1';
  const items = ROWS.map(([cardId, cardName, setName, collectorNumber, imageUrl, pricePkn], index) => ({
    id: `preview-scan-${index + 1}`,
    seq: 1,
    position: index + 1,
    status: 'active',
    recognitionState: 'matched',
    reviewed: true,
    cardId,
    cardName,
    setName,
    collectorNumber,
    imageUrl,
    game: 'pokemon',
    condition: 'NM',
    language: 'EN',
    foilState: 'standard',
    firstEdition: false,
    signed: false,
    altered: false,
    quantity: 1,
    location: `${location}·1·${index + 1}`,
    pricePkn,
    priceSuggested: false,
    hasImage: false,
    receivedAt: new Date(now - (ROWS.length - index) * 9000).toISOString(),
  }));
  return {
    session: {
      id: 'preview-session',
      status: 'connected',
      phase: 'connected',
      phoneLabel: 'iPhone',
      // Seen "in the future", so the fixture phone never reads as lost.
      phoneLastSeenAt: new Date(now + 365 * 864e5).toISOString(),
    },
    batch: {
      id: 'preview-batch',
      status: 'open',
      defaults: {
        ...DEFAULTS,
        location,
        stackSize: 10,
        startPosition: ROWS.length + 1,
        pricingGroupId: groups[0].id,
        pricingStrategyId: '',
      },
    },
    items,
    versionSets: Object.fromEntries(items.map((item) => [item.cardId, {
      version: '',
      printings: [{
        id: item.cardId,
        name: item.cardName,
        set_name: item.setName,
        card_number: item.collectorNumber,
        nationality: 'western',
        image_url: item.imageUrl,
      }],
    }])),
    pricing: { strategies: previewStrategies(), groups },
  };
}
