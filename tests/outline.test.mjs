import test from "node:test";
import assert from "node:assert/strict";
import { readPDFOutline } from "../addon/content/pdf-outline-data.js";
import { OutlineService, outlineMatches, availableReader } from "../src/outline.mjs";
import { initialPDFPage } from "../src/pdf-preview.mjs";

test("PDF outline preserves exact destinations, hierarchy, duplicate headings and non-Latin text", async () => {
  const dest = [{ num: 20, gen: 0 }, { name: "XYZ" }, 20, 640, null];
  const pdf = { numPages: 5, getDestination: async () => [0, { name: "Fit" }], getPageIndex: async () => 2,
    getOutline: async () => [{ title: "Introduction", dest: "intro", items: [
      { title: "Résumé · 方法", dest, items: [] }, { title: "Résumé · 方法", dest: [3, { name: "Fit" }], items: [] },
    ] }, { title: "External", unsafeUrl: "https://example.invalid", items: [] }, { title: "Invalid", dest: [7, { name: "Fit" }], items: [] }] };
  const rows = await readPDFOutline(pdf);
  assert.equal(rows.length, 5); assert.deepEqual(rows[1].parents, ["Introduction"]);
  assert.equal(rows[3].location, undefined); assert.equal(rows[4].location, undefined);
  assert.equal(rows[1].parentKey, "0"); assert.equal(rows[1].depth, 1);
  assert.deepEqual(rows[1].location, { dest }); assert.equal(rows[1].pageIndex, 2);
  assert.notEqual(rows[1].outlineKey, rows[2].outlineKey);
  assert.equal(outlineMatches(rows[1], 'resume 方法'), true);
  assert.equal(outlineMatches(rows[1], 'Intro* "方法"'), true);
  assert.equal(outlineMatches(rows[1], '方法 results'), false);
});

test("native generated outline positions are reused when bookmarks are absent", async () => {
  const location = { position: { pageIndex: 1, rects: [[10, 600, 10, 600]] } };
  const rows = await readPDFOutline({ numPages: 3, getOutline: async () => null,
    getOutline2: async () => [{ title: "Methods", location, items: [] }] });
  assert.equal(rows.length, 1); assert.deepEqual(rows[0].location, location);
  assert.equal(await initialPDFPage({ kind: "outline", attachmentID: 15, pageIndex: 1 }, 15), 1);
  assert.deepEqual(await readPDFOutline({ numPages: 1, getOutline: async () => [] }), []);
});

function serviceFixture() {
  let observer;
  const attachment = { id: 15, parentID: 1, isPDFAttachment: () => true, getDisplayTitle: () => "PDF" };
  const reader = { itemID: 15 }, win = { closed: false, Zotero_Tabs: { selectedID: "pdf-tab" }, setTimeout, clearTimeout };
  globalThis.Zotero = {
    Prefs: { get: () => "en-US" }, locale: "en-US",
    Notifier: { registerObserver: value => { observer = value; return 1; }, unregisterObserver() {} },
    Reader: { getByTabID: id => id === "pdf-tab" ? reader : undefined, _readers: [] },
    Items: { get: id => id === 15 ? attachment : { getDisplayTitle: () => "Paper" } },
  };
  return { service: new OutlineService({ metadata: async () => ({}) }), win, reader, observer: () => observer };
}

test("outline scope follows actual PDF tabs/reader windows and stays global in library/non-PDF contexts", () => {
  const { service, win, reader } = serviceFixture();
  assert.deepEqual(service.context(win), { type: "pdf", attachmentID: 15, title: "Paper", reader });
  assert.equal(service.context({ reader }).type, "pdf");
  assert.equal(service.context({ Zotero_Tabs: { selectedID: "zotero-pane" } }).type, "all");
  assert.equal(service.context({}).type, "all"); service.destroy();
});

test("dead reader proxies are skipped and suspended tabs reuse and activate their native ID", async () => {
  const { service } = serviceFixture(); let opened, selected;
  const dead = { itemID: 15, _window: { closed: true }, get _isTabClosed() { throw new Error("can't access dead object"); } };
  assert.equal(availableReader(dead), false);
  Zotero.Reader._readers = [dead];
  Zotero.Items.getAsync = async () => ({ isPDFAttachment: () => true, getFilePathAsync: async () => "fixture.pdf" });
  Zotero.getMainWindow = () => ({ Zotero_Tabs: { getTabIDByItemID: () => "suspended-tab" } });
  Zotero.Reader.open = async (...args) => { opened = args; return { tabID: "suspended-tab", _window: { Zotero_Tabs: { select: id => { selected = id; } } }, focus() {} }; };
  await service.open({ attachmentID: 15, location: { dest: "methods" } });
  assert.deepEqual(opened, [15, { dest: "methods" }, { allowDuplicate: true, tabID: "suspended-tab" }]);
  assert.equal(selected, "suspended-tab");
  service.destroy();
});

test("cancelling current-PDF extraction releases the launcher while the reader's own work remains intact", async () => {
  const { service, win } = serviceFixture(), owner = {}; let release;
  service.load = () => new Promise(resolve => { release = resolve; });
  const pending = service.search("methods", { type: "pdf", attachmentID: 15 }, { owner, win });
  await Promise.resolve(); service.cancel(owner);
  await assert.rejects(pending, /cancelled/);
  assert.equal(service.currentLoads.size, 0);
  release({ rows: [] }); service.destroy();
});

test("global outline indexing yields partial results, batches progress and finishes the active PDF on close", async () => {
  const { service, win } = serviceFixture();
  service.candidateIDs = [15, 16]; let updates = 0;
  service.load = async id => ({ itemID: id, rows: [{ attachmentID: id, title: "Methods", parents: [], outlineKey: "0", documentTitle: "Paper", pageIndex: 1 }] });
  const owner = {};
  const initial = await service.search("Methods", { type: "all" }, { owner, win, onUpdate: () => updates++ });
  assert.equal(initial.pending, true); assert.equal(initial.total, 0);
  await service.work;
  const warm = await service.search("Methods", { type: "all" }, { owner, win });
  assert.equal(warm.total, 2); assert.equal(warm.pending, false); assert.equal(updates, 1);
  service.release(owner); service.cache.delete(16);
  let release;
  service.load = id => id === 15 ? Promise.resolve(service.cache.get(id)) : new Promise(resolve => { release = resolve; });
  await service.search("", { type: "all" }, { owner, win });
  await new Promise(setImmediate);
  service.release(owner); release({ rows: [{ title: "late", parents: [] }] }); await service.work;
  assert.equal(service.cache.has(16), true); await service.destroy();
});
