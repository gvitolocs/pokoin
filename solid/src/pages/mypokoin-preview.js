/** Preview data is downloaded only for explicitly requested local previews. */
export const MYPOKOIN_PREVIEW_BANNER = 'Layout preview — fixture data, not your live collection.';
export function allowMypokoinPreview(params) {
  if (!params || params.mypokoinPreview === undefined) return false;
  if (import.meta.env?.DEV) return true;
  return typeof window !== 'undefined' && ['localhost', '127.0.0.1'].includes(window.location.hostname);
}
let fixture;
export async function loadMypokoinPreview() {
  if (typeof window === 'undefined' || !allowMypokoinPreview(Object.fromEntries(new URLSearchParams(window.location.search)))) return;
  fixture ||= await import('./mypokoin-preview-fixture.js');
}
export const previewListings = (...args) => fixture.previewListings(...args);
export const previewPricer = (...args) => fixture.previewPricer(...args);
export const previewComps = (...args) => fixture.previewComps(...args);
export const previewGroups = (...args) => fixture.previewGroups(...args);
export const previewStrategies = (...args) => fixture.previewStrategies(...args);
export const previewCollection = (...args) => fixture.previewCollection(...args);
export const previewSales = (...args) => fixture.previewSales(...args);
export const previewBought = (...args) => fixture.previewBought(...args);
export const previewZero = (...args) => fixture.previewZero(...args);
export const previewZeroPicked = (...args) => fixture.previewZeroPicked(...args);
