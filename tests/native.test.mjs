import test from "node:test";
import assert from "node:assert/strict";
import { NativeAdapter, patch } from "../src/native.mjs";
import { DEFAULT_PREFIXES } from "../src/launcher-query.mjs";

test("synced prefix changes preserve active advanced conditions while migrating the visible input", async () => {
  const adapter = new NativeAdapter({ document: {}, ZoteroPane: {} }, { prefs: { get: name => ({ authorPrefix: "~", directoryPrefix: "$" })[name] } });
  const conditions = [{ condition: "publisher", operator: "is", value: "Institute" }]; let received;
  Object.assign(adapter, { active: true, prefixSymbols: { ...DEFAULT_PREFIXES }, currentSpec: { nativeConditions: conditions }, searchbox: { value: 'fault @Roe /Core ' },
    spec: text => ({ text }), applyQuery: async spec => { received = spec; } });
  await adapter.updatePrefixes(); assert.equal(adapter.searchbox.value, 'fault ~Roe $Core '); assert.equal(received.nativeConditions, conditions);
});

test("native fields highlight their matching creator without scanning every saved spelling per cell", () => {
  const previous = globalThis.Zotero;
  globalThis.Zotero = { CreatorTypes: { getID: role => ({ author: 1, editor: 2 })[role] } };
  try {
    const adapter = new NativeAdapter({ document: {}, ZoteroPane: {} }, {});
    const conditions = Array.from({ length: 1500 }, (_, index) => ({ condition: "creator", operator: "is", value: `Person ${index}` }));
    adapter.currentSpec = { text: 'fault "long phrase"', fields: ["title"], nativeConditions: conditions };
    const item = { getCreators: () => [{ creatorTypeID: 2, firstName: "Person", lastName: "1234" }] };
    assert.deepEqual(adapter.cellTerms("firstCreator", item), ["Person", "1234"]);
    const cached = adapter.highlight; assert.deepEqual(adapter.cellTerms("title", item), ["fault", "long phrase"]); assert.equal(adapter.highlight, cached);
    adapter.currentSpec = { text: "", fields: [], nativeConditions: [{ condition: "author", operator: "contains", value: "Person" }] };
    assert.deepEqual(adapter.cellTerms("firstCreator", item), []);
    item.getCreators = () => [{ creatorTypeID: 1, firstName: "Person", lastName: "1234" }];
    assert.deepEqual(adapter.cellTerms("firstCreator", item), ["Person", "1234"]);
  } finally { globalThis.Zotero = previous; }
});

test("selected-item evidence stays lazy and resolving it does not invalidate the whole tree", async () => {
  let calls = 0, invalidations = 0;
  const adapter = new NativeAdapter({ document: {}, ZoteroPane: {} }, { logError() {}, search: { evidenceForItem: async () => { calls++; return []; } } });
  adapter.view = { tree: { invalidate: () => invalidations++ } }; adapter.currentSpec = { text: "fault" };
  assert.equal(calls, 0); await adapter.itemEvidence({ id: 1 }); await adapter.itemEvidence({ id: 1 });
  assert.equal(calls, 1); assert.equal(invalidations, 0);
});

test("instance hooks restore inherited methods and respect hooks subsequently installed by others", () => {
  const original = () => 1, host = Object.create({ method: original }), cleanups = [];
  patch(host, "method", fn => () => fn() + 1, cleanups);
  assert.equal(host.method(), 2); cleanups.pop()();
  assert.equal(host.method, original); assert.equal(Object.hasOwn(host, "method"), false);
  patch(host, "method", fn => () => fn() + 1, cleanups);
  const other = () => 3; host.method = other; cleanups.pop()();
  assert.equal(host.method, other);
});
test("queued native requests skip stale queries and stopped windows cannot apply them", async () => {
  const row = { ref: { libraryID: 1 }, getSearchObject: async () => null };
  const pane = { getSelectedItems: () => [], collectionsView: { getSelectedRows: () => [{ id: "L1" }] } };
  const app = { logError: () => {}, plainContext: () => ({ libraryID: 1 }), search: { prepare: async spec => spec, buildSearch: spec => ({ text: spec.text }) } };
  const adapter = new NativeAdapter({ document: {}, ZoteroPane: pane }, app), calls = [];
  adapter.view = { collectionTreeRows: [row] }; adapter.context = { libraryID: 1 };
  adapter.scope = {}; adapter.searchbox = { value: "" }; adapter.refreshDisplay = () => {};
  adapter.baseFilter = async (type, search) => calls.push(search.text);
  let release; adapter.work = new Promise(resolve => { release = resolve; });
  const first = adapter.applyQuery({ text: "fault", scope: { type: "library", libraryID: 1 } });
  const latest = adapter.applyQuery({ text: "stress", scope: { type: "library", libraryID: 1 } });
  release();
  assert.deepEqual(await Promise.all([first, latest]), [false, true]);
  assert.deepEqual(calls, ["stress"]);
  adapter.closed = true;
  assert.equal(await adapter.applyQuery({ text: "closed" }), false);
  assert.deepEqual(calls, ["stress"]);
  adapter.releaseRows();
});

test("metadata invalidation refreshes evidence without cancelling an in-progress native query", async () => {
  const spec = { text: "fault", scope: { type: "library", libraryID: 1 } }, row = { ref: { libraryID: 1 }, getSearchObject: async () => null };
  const pane = { getSelectedItems: () => [], collectionsView: { getSelectedRows: () => [{ id: "L1" }] } };
  let prepareRelease, filterRelease;
  const app = { logError() {}, plainContext: () => ({ libraryID: 1 }), search: { prepare: () => new Promise(resolve => { prepareRelease = resolve; }), buildSearch: spec => spec } };
  const adapter = new NativeAdapter({ document: {}, ZoteroPane: pane }, app);
  Object.assign(adapter, { view: { collectionTreeRows: [row] }, context: { libraryID: 1 }, scope: {}, searchbox: { value: "" }, refreshDisplay() {}, updateDetails() {},
    baseFilter: () => new Promise(resolve => { filterRelease = resolve; }) });
  const pending = adapter.applyQuery(spec);
  await new Promise(resolve => setImmediate(resolve)); assert.ok(prepareRelease);
  const firstVersion = adapter.version; adapter.invalidate(); assert.ok(adapter.version > firstVersion); prepareRelease(spec);
  await new Promise(resolve => setImmediate(resolve)); assert.ok(filterRelease);
  adapter.invalidate(); filterRelease();
  assert.equal(await pending, true); assert.equal(adapter.currentSpec.text, "fault"); assert.equal(adapter.searchbox.value, "fault");
  adapter.releaseRows();
});

test("RSS and in-progress native selection callbacks stay outside the enhanced search queue", () => {
  const adapter = new NativeAdapter({ document: {}, ZoteroPane: {} }, {});
  adapter.view = { collectionTreeRows: [{ isFeedsOrFeed: () => true }] };
  assert.ok(adapter.nativeOnly());
  adapter.view.collectionTreeRows = [{ isFeedsOrFeed: () => false }];
  assert.ok(!adapter.nativeOnly());
  adapter.collectionChanging = 2;
  assert.ok(adapter.nativeOnly());
  adapter.collectionChanging--;
  assert.ok(adapter.nativeOnly());
  adapter.collectionChanging--;
  assert.ok(!adapter.nativeOnly());
});

test("editing native query text retains the stable reference of an unchanged filter fragment", () => {
  const ref = { kind: "collection", libraryID: 1, key: "DIRECT01" };
  const app = { makeSpec: (_, spec) => spec, prefs: { get: () => true }, plainContext: () => ({ libraryID: 1, collectionKey: "CURRENT1" }) };
  const adapter = new NativeAdapter({ document: {}, ZoteroPane: {} }, app);
  adapter.scope = { value: "library" }; adapter.context = { libraryID: 1 };
  adapter.currentSpec = { filters: [{ type: "directory", value: "Old name", ref }] };
  assert.deepEqual(adapter.spec('/"Old name" changed word').filters[0].ref, ref);
  assert.equal(adapter.spec('/"Different name" changed word').filters[0].ref, undefined);
  assert.equal(adapter.spec('>changed word').scope.collectionKey, "CURRENT1");
});

test("native outline edits preserve the current-PDF scope handed off by the launcher", () => {
  const outlineSource = { type: "pdf", attachmentID: 21, title: "Current PDF" }, ref = { kind: "outline", key: "1", attachmentID: 21, libraryID: 1 };
  const adapter = new NativeAdapter({ document: {}, ZoteroPane: {} }, { makeSpec: (_, spec) => spec, prefs: { get: () => undefined } });
  Object.assign(adapter, { scope: { value: "library" }, context: { libraryID: 1 }, currentSpec: { outlineSource, filters: [{ type: "outline", value: "Methods", ref }] } });
  const next = adapter.spec("fault '(Methods) ");
  assert.deepEqual(next.outlineSource, outlineSource); assert.deepEqual(next.filters[0].ref, ref);
  assert.equal(adapter.spec("fault").outlineSource, undefined);
  adapter.currentSpec = null; assert.deepEqual(adapter.spec("'(Methods) ").outlineSource, { type: "all" });
});

test("returning from all-library results clears every other selected library", async () => {
  const rowIDs = ["L1", "L2"], selected = new Set(rowIDs); let nativeSelectCalls = 0, changed = 0;
  const tree = {
    getSelectedRows: () => [...selected].map(id => ({ id })),
    expandLibrary: async () => {}, getRowIndexByID: id => rowIDs.indexOf(id),
    selectByID: async id => { nativeSelectCalls++; if (selected.has(id)) return true; selected.clear(); selected.add(id); return true; },
    _onSelectionChange: async () => { changed++; },
    selection: { selectEventsSuppressed: false, clearSelection: () => selected.clear(), toggleSelect: index => selected.add(rowIDs[index]) },
  };
  const adapter = new NativeAdapter({ document: {}, ZoteroPane: { collectionsView: tree } }, {});
  assert.equal(await adapter.selectRows(["L1"]), true);
  assert.deepEqual([...selected], ["L1"]); assert.equal(nativeSelectCalls, 0); assert.equal(changed, 1);
  assert.equal(tree.selection.selectEventsSuppressed, false);
  assert.equal(await adapter.selectRows(["L1", "L2"]), true);
  assert.equal(await adapter.selectRows(["L2"]), true);
  assert.deepEqual([...selected], ["L2"]); assert.equal(changed, 3); assert.equal(tree.selection.selectEventsSuppressed, false);
  assert.equal(await adapter.selectRows(["L1"]), true); assert.equal(nativeSelectCalls, 1);
});
