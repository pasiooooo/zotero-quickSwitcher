import test from "node:test";
import assert from "node:assert/strict";
import { LayoutStore, parseLayout } from "../src/layout.mjs";
import { A, B, memoryStore, placement } from "./fixtures/layout.mjs";

test("atomic layout writes, durable pending state, Lamport merge and newer resets", async () => {
  const a = await memoryStore(A), b = await memoryStore(B);
  await a.store.place("u", "AAAA2222", placement("BBBB2222"));
  await b.store.merge(a.store.records);
  await b.store.place("u", "AAAA2222", placement("CCCC2222"));
  await a.store.merge(b.store.records);
  assert.deepEqual(a.store.records, b.store.records);
  const reopened = await new LayoutStore({ prefs: a.prefs, io: a.io }).init();
  assert.equal(reopened.dirty, true); assert.equal(reopened.clock, 2);
  await a.store.place("u", "AAAA2222", null);
  await b.store.merge(a.store.records);
  assert.equal(b.store.get("u", "AAAA2222"), null);
  const before = structuredClone(a.store.records); a.fail(true);
  await assert.rejects(a.store.place("u", "AAAA2222", placement("DDDD2222")));
  assert.deepEqual(a.store.records, before);
});
test("unknown schema, oversized and invalid records are rejected before merging", () => {
  assert.throws(() => parseLayout(JSON.stringify({ schemaVersion: 2, deviceID: A, clock: 0, records: {} })));
  assert.throws(() => parseLayout(" ".repeat(2 * 1024 * 1024 + 1)));
  assert.throws(() => parseLayout(JSON.stringify({ schemaVersion: 1, deviceID: A, clock: 0, records: { __protoBad: {} } })));
});

test("native atomic layout saves retry file conflicts once per logical edit and preserve state on failure", async t => {
  const before = { Zotero: globalThis.Zotero, PathUtils: globalThis.PathUtils, IOUtils: globalThis.IOUtils };
  t.after(() => Object.assign(globalThis, before));
  const f = await memoryStore(A), writes = [], waits = [], blocked = new Error("NS_ERROR_FILE_ACCESS_DENIED");
  let mode = "transient", changed = 0;
  globalThis.Zotero = { Profile: { dir: "isolated" }, Promise: { async delay(ms) { waits.push(ms); } } };
  globalThis.PathUtils = { join: (...parts) => parts.join("/") };
  globalThis.IOUtils = { exists: async () => false, async writeUTF8(file, text, options) {
    writes.push({ file, text, options });
    if (mode === "permanent" || (mode === "transient" && writes.length < 3)) throw blocked;
    if (mode === "disk") throw new Error("disk full");
  } };
  const store = await new LayoutStore({ prefs: f.prefs, onChange() { changed++; } }).init();
  await store.place("u", "AAAA2222", placement("BBBB2222"));
  assert.equal(writes.length, 3); assert.deepEqual(waits, [30, 60]); assert.equal(store.clock, 1); assert.equal(changed, 1);
  assert.ok(writes.every(write => write.text === writes[0].text && write.options.tmpPath === write.file + ".tmp"));
  const saved = store.snapshot(); mode = "permanent"; writes.length = 0;
  await assert.rejects(store.place("u", "AAAA2222", placement("CCCC2222")), error => error === blocked);
  assert.equal(writes.length, 8); assert.deepEqual(store.snapshot(), saved); assert.equal(changed, 1);
  mode = "disk"; writes.length = 0;
  await assert.rejects(store.place("u", "AAAA2222", null), /disk full/u);
  assert.equal(writes.length, 1); assert.deepEqual(store.snapshot(), saved);
});
