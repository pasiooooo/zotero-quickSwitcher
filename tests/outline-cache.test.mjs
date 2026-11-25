import test from "node:test";
import assert from "node:assert/strict";
import { OutlineService, parseOutlineCache } from "../src/outline.mjs";

const titleRow = title => ({ title, parents: [], outlineKey: "0", parentKey: null, depth: 0, pageIndex: 1, location: { dest: "methods" } });
function fixture(text = null) {
  const globals = { Zotero: globalThis.Zotero, IOUtils: globalThis.IOUtils };
  let observer, modified = 1, extracted = 0, metadata = "Paper", stored = text, writes = 0;
  const attachment = { id: 15, parentID: 1, libraryID: 1, isPDFAttachment: () => true, getFilePathAsync: async () => "/paper.pdf" };
  const parent = { id: 1, libraryID: 1 };
  globalThis.Zotero = { DataDirectory: { dir: "/isolated/data" }, Notifier: { registerObserver: value => { observer = value; return 1; }, unregisterObserver() {} },
    Items: { getAsync: async id => id === 15 ? attachment : parent }, Reader: { _readers: [] },
    Libraries: { getAll: () => [{ libraryType: "user", libraryID: 1 }] }, DB: { queryAsync: async () => [{ itemID: 15, topItemID: 1 }] } };
  globalThis.IOUtils = { stat: async () => ({ size: 100, lastModified: modified }) };
  const win = { closed: false, setTimeout, clearTimeout }, io = { read: async () => stored, write: async text => { writes++; stored = text; } }, errors = [];
  const service = new OutlineService({ metadata: async () => ({ title: metadata }), io, onError: error => errors.push(String(error)) });
  service.loader = { win, read: async () => { extracted++; return [titleRow("Methods")]; }, destroy() {} };
  return { service, win, io, errors, observer: () => observer, setModified: value => { modified = value; }, setMetadata: value => { metadata = value; },
    setStored: value => { stored = value; }, stats: () => ({ extracted, stored, writes }),
    restore: () => { for (const [key, value] of Object.entries(globals)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } };
}

test("persistent outlines reuse clean titles and exact destinations after a new service starts", async () => {
  const f = fixture(); let second;
  try {
    await f.service.init(); const first = await f.service.load(15, f.win); await f.service.flush();
    assert.equal(f.stats().extracted, 1); assert.equal(f.stats().writes, 1);
    const saved = JSON.parse(f.stats().stored); assert.deepEqual(saved.entries[0][1].rows, [titleRow("Methods")]);
    assert.ok(!f.stats().stored.includes("documentTitle") && !f.stats().stored.includes("win") && !f.stats().stored.includes("Paper"));
    second = await new OutlineService({ metadata: async () => ({ title: "Current metadata" }), io: f.io }).init();
    const reopened = await second.load(15, f.win);
    assert.deepEqual(reopened.rows[0].location, first.rows[0].location); assert.equal(reopened.rows[0].documentTitle, "Current metadata");
    assert.equal(f.stats().extracted, 1); assert.equal(second.dirty, undefined);
  } finally { await second?.destroy(); await f.service.destroy(); f.restore(); }
});

test("metadata and reading notifications keep raw PDF data while file changes invalidate only affected PDFs", async () => {
  const f = fixture();
  try {
    await f.service.init(); await f.service.load(15, f.win);
    f.observer().notify("modify", "item", [1]); f.setMetadata("Renamed paper");
    const updated = await f.service.load(15, f.win); assert.equal(updated.rows[0].documentTitle, "Renamed paper"); assert.equal(f.stats().extracted, 1);
    f.observer().notify("modify", "item", [15]); await f.service.load(15, f.win); assert.equal(f.stats().extracted, 1);
    const epoch = f.service.epoch; f.observer().notify("modify", "item", [999]); assert.equal(f.service.epoch, epoch);
    f.setModified(2); await f.service.load(15, f.win); assert.equal(f.stats().extracted, 2);
    f.observer().notify("modify", "file", [15]); assert.equal(f.service.records.has(15), false);
    await f.service.load(15, f.win); assert.equal(f.stats().extracted, 3);
    f.observer().notify("trash", "item", [1]); assert.equal(f.service.records.has(15), false);
  } finally { await f.service.destroy(); f.restore(); }
});

test("warm reopening checks file identity without decoding unchanged PDFs or reindexing each typed query", async () => {
  const f = fixture();
  try {
    await f.service.init(); const owner = {};
    await f.service.search("", { type: "all" }, { owner, win: f.win }); await f.service.work;
    assert.equal(f.stats().extracted, 1); f.service.release(owner);
    const warm = await f.service.search("Methods", { type: "all" }, { owner, win: f.win }); await f.service.work;
    assert.equal(warm.rows.length, 1); assert.equal(warm.pending, false); assert.equal(f.stats().extracted, 1);
    await f.service.search("Meth", { type: "all" }, { owner, win: f.win }); assert.equal(f.service.work, null);
    f.service.release(owner); f.setModified(3);
    await f.service.search("Methods", { type: "all" }, { owner, win: f.win }); await f.service.work;
    assert.equal(f.stats().extracted, 2); f.service.release(owner);
  } finally { await f.service.destroy(); f.restore(); }
});

test("filtered global outlines decode only metadata-matching PDFs and keep all their real ancestors", async () => {
  const f = fixture();
  try {
    await f.service.init(); f.service.candidateIDs = [15, 16]; f.service.candidateItems = new Map([[15, 1], [16, 2]]);
    const owner = {}, first = await f.service.search("Methods", { type: "all" }, { owner, win: f.win, itemIDs: new Set([1]) });
    assert.equal(first.documents, 1); await f.service.work;
    const warm = await f.service.search("Methods", { type: "all" }, { owner, win: f.win, itemIDs: new Set([1]) });
    assert.equal(warm.total, 1); assert.equal(f.stats().extracted, 1);
    const empty = await f.service.search("Methods", { type: "all" }, { owner, win: f.win, itemIDs: new Set() }); assert.equal(empty.documents, 0); assert.equal(empty.rows.length, 0);
    f.service.release(owner);
  } finally { await f.service.destroy(); f.restore(); }
});

test("narrowing an active global query skips queued PDFs outside the new metadata filter", async () => {
  const f = fixture();
  try {
    await f.service.init(); f.service.candidateIDs = [15, 16, 17]; f.service.candidateItems = new Map([[15, 1], [16, 2], [17, 3]]);
    const loaded = [], owner = {}; let release;
    f.service.load = async id => { loaded.push(id); if (id === 15) await new Promise(resolve => { release = resolve; }); return { itemID: id - 14, rows: [] }; };
    await f.service.search("", { type: "all" }, { owner, win: f.win });
    await f.service.search("", { type: "all" }, { owner, win: f.win, itemIDs: new Set([2]) });
    release(); await f.service.work;
    assert.deepEqual(loaded, [15, 16]); assert.equal(f.service.cache.has(17), false); f.service.release(owner);
  } finally { await f.service.destroy(); f.restore(); }
});

test("bad cache versions, changed data directories and invalid titles fall back without blocking the service", async () => {
  const f = fixture();
  const good = { schemaVersion: 1, dataDirectory: "/isolated/data", entries: [[15, { itemID: 1, fingerprint: "/paper.pdf:100:1", rows: [titleRow("Methods")] }]] };
  try {
    assert.equal(parseOutlineCache(JSON.stringify(good), "/isolated/data").size, 1);
    for (const alter of [value => { value.schemaVersion = 99; }, value => { value.dataDirectory = "/other/data"; }, value => { value.entries[0][1].rows[0].title += "\x00"; }, value => { value.entries[0][1].rows[0].depth = 8; }]) {
      const bad = structuredClone(good); alter(bad); assert.throws(() => parseOutlineCache(JSON.stringify(bad), "/isolated/data"));
    }
    f.setStored("{broken"); await f.service.init(); assert.equal(f.errors.length, 1);
    assert.equal((await f.service.load(15, f.win)).rows[0].title, "Methods"); assert.equal(f.stats().extracted, 1);
  } finally { await f.service.destroy(); f.restore(); }
});
