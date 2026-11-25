import test from "node:test";
import assert from "node:assert/strict";
import { encodeSavedSpec, decodeSavedSpec, validateSavedSpec, mergeSavedQueryRecords, savedQueryConditions, SavedQueryAdapter } from "../src/saved-queries.mjs";
import { LayoutStore, parseLayout } from "../src/layout.mjs";
import { A, B, memoryStore, placement } from "./fixtures/layout.mjs";

const spec = () => ({ text: "fault", rawText: "fault ;(Paper) /(Core)", fields: ["title", "citationKey"], sources: { notes: false, annotations: false, fulltext: false }, scope: { type: "library" },
  filters: [{ type: "tabs", value: "Paper" }, { type: "directory", value: "Core" }], queryTree: { op: "AND", children: [{ text: "fault" }, { filterIndex: 0 }, { filterIndex: 1 }] } });

test("extended native saved queries use stable item keys instead of local attachment IDs", t => {
  const before = globalThis.Zotero; t.after(() => { globalThis.Zotero = before; });
  globalThis.Zotero = { Libraries: { userLibraryID: 1, get: () => ({ libraryType: "user" }) }, Items: { getLibraryAndKeyFromID: () => ({ libraryID: 1, key: "PDFKEY22" }), getIDFromLibraryAndKey: (library, key) => library === 1 && key === "PDFKEY22" ? 900 : null } };
  const query = { ...spec(), scope: { type: "collection", collectionKey: "CORE2222", libraryID: 1 }, filters: [{ type: "tabs", value: "Paper", ref: { kind: "tab", key: "11", attachmentID: 11, libraryID: 1 } }], queryTree: { filterIndex: 0 }, outlineSource: { type: "pdf", attachmentID: 11 } };
  const encoded = encodeSavedSpec(query), decoded = decodeSavedSpec(encoded, 1);
  assert.equal(encoded.scope.libraryID, undefined); assert.equal(encoded.filters[0].ref.attachmentID, undefined);
  assert.equal(encoded.filters[0].ref.attachmentKey, "PDFKEY22"); assert.equal(encoded.filters[0].ref.key, "PDFKEY22");
  assert.equal(decoded.filters[0].ref.attachmentID, 900); assert.equal(decoded.outlineSource.attachmentID, 900);
  assert.equal(decoded.scope.collectionKey, "CORE2222");
});

test("query records sync independently from search placements, preserve legacy files and newer resets", async () => {
  const a = await memoryStore(A), b = await memoryStore(B);
  await a.store.saveQuery("u", "AAAA2222", spec());
  await a.store.place("u", "AAAA2222", placement("BBBB2222"));
  const parsed = parseLayout(JSON.stringify(a.store.snapshot()));
  await b.store.merge(parsed.records, () => true, parsed.queries);
  assert.deepEqual(a.store.queries, b.store.queries);
  await b.store.place("u", "AAAA2222", placement("CCCC2222"));
  await a.store.merge(b.store.records);
  assert.deepEqual(a.store.getQuery("u", "AAAA2222"), spec());
  const restored = await new LayoutStore({ prefs: a.prefs, io: a.io }).init();
  assert.deepEqual(restored.queries, a.store.queries);
  await a.store.saveQuery("u", "AAAA2222", null);
  await b.store.merge({}, () => true, a.store.queries);
  assert.equal(b.store.getQuery("u", "AAAA2222"), null);
  assert.ok(b.store.get("u", "AAAA2222"));
});

test("invalid remote query rules and oversized logical trees cannot replace a valid layout", () => {
  assert.throws(() => validateSavedSpec({ ...spec(), nativeConditions: [{ condition: "arbitrary" }] }));
  assert.throws(() => validateSavedSpec({ ...spec(), queryTree: { filterIndex: 99 } }));
  assert.throws(() => validateSavedSpec({ ...spec(), fields: ["arbitrarySQL"] }));
  assert.throws(() => validateSavedSpec({ ...spec(), scope: { type: "library", libraryID: 100 } }));
  assert.throws(() => validateSavedSpec({ ...spec(), filters: [{ type: "tabs", value: "x", ref: { kind: "tab", key: "x", attachmentID: 100 } }] }));
  assert.throws(() => mergeSavedQueryRecords({ "u:AAAA2222": { libraryKey: "u", searchKey: "AAAA2222", version: { clock: 1, deviceID: A }, spec: { ...spec(), filters: [{ type: "directory", value: "x", ref: { kind: "collection", key: "x", libraryKey: "other-account" } }] } } }));
  assert.throws(() => parseLayout(JSON.stringify({ schemaVersion: 1, deviceID: A, clock: 0, records: {}, queries: { "u:AAAA2222": { libraryKey: "u", searchKey: "AAAA2222", spec: spec(), version: { clock: 1, deviceID: A } } } })));
});

test("failed query writes retain the prior durable record and logical clock", async () => {
  const a = await memoryStore(A); await a.store.saveQuery("u", "AAAA2222", spec());
  const before = a.store.snapshot(); a.fail(true);
  await assert.rejects(a.store.saveQuery("u", "AAAA2222", null), /disk/);
  assert.deepEqual(a.store.snapshot(), before);
});

test("native saved search, clones, concurrent callers and temp tables reevaluate open tabs without saving item IDs", async t => {
  const before = globalThis.Zotero; t.after(() => { globalThis.Zotero = before; });
  let open = [1, 2], preparedCalls = 0;
  class Search {
    constructor() { this.libraryID = 1; this.conditions = savedQueryConditions; }
    toJSON() { return { conditions: this.conditions }; }
    hasPostSearchFilter() { return false; }
    clone() { const value = new Search(); value.conditions = this.conditions; return value; }
    async search() { return this.ids || []; }
    static async idsToTempTable(ids) { return { ids }; }
  }
  globalThis.Zotero = { Search, Libraries: { userLibraryID: 1, get: () => ({ libraryType: "user" }) }, Notifier: { registerObserver: () => 1, unregisterObserver() {} } };
  const stored = spec();
  const app = { layout: { getQuery: () => stored }, search: { async prepare(value) { preparedCalls++; await Promise.resolve(); return value; }, buildSearch() { const value = new Search(); value.ids = [...open]; return value; } } };
  const adapter = new SavedQueryAdapter(app).init(); t.after(() => adapter.destroy());
  const search = new Search(); search.key = "AAAA2222";
  assert.equal(search.hasPostSearchFilter(), true);
  assert.deepEqual(await Promise.all([search.search(), search.search()]), [[1, 2], [1, 2]]); assert.equal(preparedCalls, 1);
  open = [3]; assert.deepEqual(await search.clone().search(), [3]); assert.deepEqual(await search.search(true), { ids: [3] });
  adapter.destroy(); assert.deepEqual(await search.search(), []); assert.equal(search.hasPostSearchFilter(), false);
});

test("a rule replaced during preparation is reevaluated for every caller and never receives the previous compiled query", async t => {
  const before = globalThis.Zotero; let adapter;
  t.after(() => { adapter?.destroy(); globalThis.Zotero = before; });
  let rule = { ...spec(), text: "before" }, release, entered;
  const started = new Promise(resolve => { entered = resolve; }), blocked = new Promise(resolve => { release = resolve; });
  class Search {
    constructor() { this.libraryID = 1; this.conditions = savedQueryConditions; }
    toJSON() { return { conditions: this.conditions }; }
    hasPostSearchFilter() { return false; }
    clone() { return new Search(); }
    async search() { return this.ids || []; }
    static async idsToTempTable(ids) { return { ids }; }
  }
  globalThis.Zotero = { Search, Libraries: { userLibraryID: 1, get: () => ({ libraryType: "user" }) }, Notifier: { registerObserver: () => 1, unregisterObserver() {} } };
  const app = { layout: { getQuery: () => rule }, search: {
    async prepare(value) { if (value.text === "before") { entered(); await blocked; } return value; },
    buildSearch(value) { const query = new Search(); query.ids = value.text === "after" ? [2] : [1]; return query; },
  } };
  adapter = new SavedQueryAdapter(app).init();
  const query = new Search(); query.key = "AAAA2222";
  const first = query.search(); await started;
  rule = { ...spec(), text: "after" }; const second = query.search(); release();
  assert.deepEqual(await Promise.all([first, second]), [[2], [2]]);
  assert.equal(adapter.compiled.get("1:AAAA2222").stored, rule);
  assert.equal(adapter.compiled.get("1:AAAA2222").spec.text, "after");
});

test("a reset or plugin stop during native query execution cannot return stale IDs or temp-table rows", async t => {
  const before = globalThis.Zotero; t.after(() => { globalThis.Zotero = before; });
  for (const change of ["reset", "stop"]) {
    let rule = spec(), entered, release;
    const started = new Promise(resolve => { entered = resolve; }), blocked = new Promise(resolve => { release = resolve; });
    class Search {
      constructor() { this.libraryID = 1; this.conditions = savedQueryConditions; }
      toJSON() { return { conditions: this.conditions }; }
      hasPostSearchFilter() { return false; }
      clone() { return new Search(); }
      async search(asTempTable) { if (!this.ids) return asTempTable ? Search.idsToTempTable([]) : []; entered(); await blocked; return this.ids; }
      static async idsToTempTable(ids) { return { ids }; }
    }
    globalThis.Zotero = { Search, Libraries: { userLibraryID: 1, get: () => ({ libraryType: "user" }) }, Notifier: { registerObserver: () => 1, unregisterObserver() {} } };
    const app = { stopped: false, layout: { getQuery: () => rule }, search: { async prepare(value) { return value; }, buildSearch() { const query = new Search(); query.ids = [7]; return query; } } };
    const adapter = new SavedQueryAdapter(app).init();
    try {
      const query = new Search(); query.key = "AAAA2222";
      const result = query.search(true); await started;
      if (change === "reset") rule = null; else app.stopped = true;
      release(); assert.deepEqual(await result, { ids: [] }, change);
    } finally { adapter.destroy(); }
  }
});
