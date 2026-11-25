import test from "node:test";
import assert from "node:assert/strict";
import { DirectoryCounts } from "../src/directory-counts.mjs";

function fixture() {
  let observer, queries = 0, searches = 0;
  const rows = [
    { itemID: 1, collectionID: 10 }, { itemID: 1, collectionID: 11 },
    { itemID: 2, collectionID: 11 }, { itemID: 3, parentItemID: 1, collectionID: 10 },
    { itemID: 4, parentItemID: 3, collectionID: 12 }, { itemID: 5, collectionID: 12 },
    { itemID: 6, parentItemID: 2, collectionID: 11 }, { itemID: 7, collectionID: 13 },
    { itemID: 8, parentItemID: 99, collectionID: 10 }, { itemID: 9 },
  ];
  globalThis.Zotero = {
    Prefs: { get: () => "en-US" }, locale: "en-US",
    Libraries: { get: id => id === 1 ? { libraryType: "user" } : { libraryType: "feed" } },
    Notifier: { registerObserver: value => { observer = value; return 17; }, unregisterObserver: id => assert.equal(id, 17) },
    Collections: { getByLibrary: () => [{ id: 10 }, { id: 11, parentID: 10 }, { id: 12, parentID: 10 }, { id: 13, parentID: 11 }, { id: 14, parentID: 13, deleted: true }] },
    DB: { queryAsync: async () => { queries++; return rows; } },
    Searches: { getAsync: async () => ({ search: async () => { searches++; return [1, 3, 4, 5, 5, 8, 99, 2]; } }) },
  };
  return { service: new DirectoryCounts(), rows, notify: () => observer.notify("modify", "collection-item", [1]), queries: () => queries, searches: () => searches };
}

test("directory counts deduplicate direct/recursive memberships and normalize attachment/note/annotation parents", async () => {
  const f = fixture();
  const values = await Promise.all([
    f.service.count({ kind: "library", libraryID: 1 }),
    f.service.count({ kind: "collection", libraryID: 1, collectionID: 10 }),
    f.service.count({ kind: "collection", libraryID: 1, collectionID: 10 }, { recursive: false }),
    f.service.count({ kind: "collection", libraryID: 1, collectionID: 11 }),
  ]);
  assert.deepEqual(values, [5, 4, 1, 3]);
  assert.equal(f.queries(), 1);
  assert.equal(await f.service.count({ kind: "feed", libraryID: 2 }), 5);
  f.service.destroy();
});

test("saved searches count actual top-level results and refresh after member notifications", async () => {
  const f = fixture(), row = { kind: "search", libraryID: 1, searchID: 77 };
  assert.equal(await f.service.count(row), 3);
  assert.equal(await f.service.count(row), 3);
  assert.equal(f.searches(), 1);
  f.rows.push({ itemID: 15, collectionID: 10 }); f.notify();
  assert.equal(await f.service.count({ kind: "collection", libraryID: 1, collectionID: 10 }), 5);
  assert.equal(await f.service.count(row), 3); assert.equal(f.searches(), 2);
  f.service.destroy();
});

test("a membership change during loading discards the obsolete count", async () => {
  const f = fixture(); let release, calls = 0;
  Zotero.DB.queryAsync = async () => ++calls === 1 ? new Promise(resolve => { release = resolve; }) : [{ itemID: 25, collectionID: 10 }];
  const pending = f.service.count({ kind: "collection", libraryID: 1, collectionID: 10 });
  f.notify(); release([{ itemID: 1, collectionID: 10 }, { itemID: 2, collectionID: 10 }]);
  assert.equal(await pending, 1); assert.equal(calls, 2); f.service.destroy();
});
