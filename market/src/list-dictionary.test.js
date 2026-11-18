import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { LIST_DICTIONARY_ENABLED, LIST_DICTIONARY_ID, listSnapshotPath, listSnapshotUrls, primeListDictionary, readSnapshotUrls } from "./api.js";

test("primeListDictionary adds one compression-dictionary link per page", () => {
  const appended = [];
  const doc = {
    head: { appendChild: (node) => appended.push(node) },
    createElement: () => ({ relList: { supports: (rel) => rel === "compression-dictionary" } }),
  };
  assert.equal(primeListDictionary(doc, false), false, "the kill switch adds nothing");
  assert.equal(appended.length, 0);
  assert.equal(primeListDictionary(doc), true, "on by default");
  assert.equal(appended[0].rel, "compression-dictionary");
  assert.match(appended[0].href, /\/api\/c1-dictionary$/);
  assert.equal(primeListDictionary(doc, true), false);
  assert.equal(appended.length, 1);
});

test("LIST_DICTIONARY_ID is the shipped dictionary filename and its sha256 prefix", () => {
  const dir = new URL("../../pokoin-rust/apps/api/assets/", import.meta.url);
  const names = readdirSync(dir).filter((name) => name.startsWith("c1-shared-") && name.endsWith(".dict"));
  assert.deepEqual(names.map((name) => name.slice("c1-shared-".length, -".dict".length)), [LIST_DICTIONARY_ID]);
  const hex = createHash("sha256").update(readFileSync(new URL(names[0], dir))).digest("hex").slice(0, 16);
  assert.equal(hex, LIST_DICTIONARY_ID);
});

test("the flag is on, and browsers without compression-dictionary keep the plain c1v2 list URL", () => {
  assert.equal(LIST_DICTIONARY_ENABLED, true);
  const plain = "/api/marketplace-list?kind=set&key=sv1&format=c1v2";
  assert.equal(listSnapshotPath("set", "SV1"), plain);
  assert.equal(listSnapshotPath("set", "SV1", ""), plain);
  assert.deepEqual(listSnapshotUrls("set", "sv1"), [plain]);
  assert.deepEqual(listSnapshotUrls("artist", "Ken Sugimori"), [listSnapshotPath("artist", "Ken Sugimori")]);
  assert.deepEqual(listSnapshotUrls("name", "Pikachu"), [listSnapshotPath("name", "Pikachu")]);
  assert.deepEqual(listSnapshotUrls("seller", "Alice"), ["/api/marketplace-list?kind=seller&key=alice&format=c1v2"]);
  assert.deepEqual(listSnapshotUrls("set", "sv1", { enabled: false, supported: true }), [plain]);
});

test("flag on appends dict for set, artist and name only, and retries the plain URL once", async () => {
  const on = { enabled: true, supported: true };
  const plain = listSnapshotPath("set", "sv1");
  const urls = listSnapshotUrls("set", "sv1", on);
  assert.deepEqual(urls, [`${plain}&dict=${LIST_DICTIONARY_ID}`, plain]);
  assert.match(listSnapshotUrls("artist", "a", on)[0], /kind=artist&key=a&format=c1v2&dict=/);
  assert.match(listSnapshotUrls("name", "pika", on)[0], /kind=name&key=pika&format=c1v2&dict=/);
  assert.deepEqual(listSnapshotUrls("seller", "alice", on), [listSnapshotPath("seller", "alice")]);
  assert.equal(listSnapshotPath("seller", "alice", LIST_DICTIONARY_ID), listSnapshotPath("seller", "alice"));
  assert.deepEqual(listSnapshotUrls("set", "sv1", { enabled: true, supported: false }), [plain]);

  const seen = [];
  const value = await readSnapshotUrls(urls, async (url) => {
    seen.push(url);
    if (url.includes("&dict=")) throw new TypeError("dictionary mismatch");
    return { ok: true };
  });
  assert.deepEqual(seen, urls);
  assert.deepEqual(value, { ok: true });

  const aborted = [];
  await assert.rejects(readSnapshotUrls(urls, async (url) => {
    aborted.push(url);
    throw Object.assign(new Error("Aborted"), { name: "AbortError" });
  }));
  assert.deepEqual(aborted, [urls[0]]);
});
