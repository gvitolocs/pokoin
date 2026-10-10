import assert from "node:assert/strict";
import test from "node:test";
import { primeListDictionary } from "./api.js";

test("primeListDictionary adds one compression-dictionary link per page", () => {
  const appended = [];
  const doc = {
    head: { appendChild: (node) => appended.push(node) },
    createElement: () => ({ relList: { supports: (rel) => rel === "compression-dictionary" } }),
  };
  assert.equal(primeListDictionary(doc), false, "off by default");
  assert.equal(appended.length, 0);
  assert.equal(primeListDictionary(doc, true), true);
  assert.equal(appended[0].rel, "compression-dictionary");
  assert.match(appended[0].href, /\/api\/c1-dictionary$/);
  assert.equal(primeListDictionary(doc, true), false);
  assert.equal(appended.length, 1);
});
