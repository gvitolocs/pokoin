import assert from "node:assert/strict";
import test from "node:test";
import { cardFromAutocomplete } from "./api.js";
import { langScanUrl } from "./lang-scans.js";
import { mergePrintingFields } from "./print-bucket.js";

// Suggest printings carry the same langScans string as tiles and the desk
// (pokoin-rust suggest.rs overlay_lang_scans), so a French popup row paints the
// French scan the desk shows (Scolipede 056/086 Black Bolt).
const scolipede = { id: "684588", card_id: "684588", name: "Scolipede", set: "Black Bolt", number: "056/086", langScans: "de,es,fr,it,pt:sv/sv10.5b/056" };

test("popup rows keep langScans and paint the scan of the picked language", () => {
  const card = cardFromAutocomplete(scolipede);
  assert.equal(card.langScans, "de,es,fr,it,pt:sv/sv10.5b/056");
  assert.equal(langScanUrl(card.langScans, "fr"), "https://cdn.pokoin.com/tcgdex/fr/sv/sv10.5b/056.webp");
  assert.equal(langScanUrl(card.langScans, "de"), "https://cdn.pokoin.com/tcgdex/de/sv/sv10.5b/056.webp");
  for (const lang of ["en", "jp", "ko", "zh", "zht"]) assert.equal(langScanUrl(card.langScans, lang), "", lang);
  assert.equal(cardFromAutocomplete({ ...scolipede, langScans: undefined, lang_scans: "fr:sv/sv10.5b/056" }).langScans, "fr:sv/sv10.5b/056");
  assert.equal(cardFromAutocomplete({ id: "263748", name: "Scolipede" }).langScans, "");
});

test("a later hydration without langScans keeps the cached scans", () => {
  const merged = mergePrintingFields(scolipede, { id: "684588", name: "Scolipede", langScans: "" });
  assert.equal(merged.langScans, "de,es,fr,it,pt:sv/sv10.5b/056");
});
