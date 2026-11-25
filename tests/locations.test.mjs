import test from "node:test";
import assert from "node:assert/strict";
import { LocationService } from "../src/locations.mjs";

function fixture() {
  let observer;
  const collections = new Map([
    [1, { id: 1, libraryID: 1, key: "AAAA1111", name: "项目 A", parentID: null }],
    [2, { id: 2, libraryID: 1, key: "BBBB1111", name: "项目 B", parentID: null }],
    [3, { id: 3, libraryID: 1, key: "CCCC1111", name: "核心文献", parentID: 1 }],
    [4, { id: 4, libraryID: 1, key: "DDDD1111", name: "核心文献", parentID: 2 }],
  ]);
  const items = new Map();
  const parent = { id: 10, libraryID: 1, getCollections: () => [3, 4, 4] };
  items.set(10, parent); items.set(11, { id: 11, libraryID: 1, parentID: 10 });
  items.set(12, { id: 12, libraryID: 1, parentID: 11 });
  items.set(13, { id: 13, libraryID: 1, getCollections: () => [] });
  globalThis.Zotero = {
    Notifier: { registerObserver: value => { observer = value; return 1; }, unregisterObserver() {} },
    Libraries: { get: id => ({ name: "我的文库", libraryType: "user", libraryID: id }) },
    Collections: { getAsync: async id => collections.get(id) },
    Items: { getAsync: async id => Array.isArray(id) ? id.map(n => items.get(n)) : items.get(id), loadDataTypes: async () => {} },
  };
  return { collections, items, parent, notify: () => observer.notify() };
}
test("actual direct memberships, same-name branches and descendant entries share full paths", async () => {
  const f = fixture(), service = new LocationService();
  const result = await service.get(12);
  assert.equal(result.itemID, 10);
  assert.deepEqual(result.locations.map(p => p.path), ["我的文库 › 项目 A › 核心文献", "我的文库 › 项目 B › 核心文献"]);
  assert.deepEqual(result.locations.map(p => p.pathKeys), [["u", "AAAA1111", "CCCC1111"], ["u", "BBBB1111", "DDDD1111"]]);
  assert.equal((await service.get(13)).status, "ready");
  assert.equal((await service.get(13)).locations.length, 0);
  f.parent.getCollections = () => [4]; f.collections.get(2).name = "改名项目 B"; f.notify();
  assert.equal((await service.get(11)).locations[0].path, "我的文库 › 改名项目 B › 核心文献");
  // A saved search's display placement has no role in actual item memberships.
  assert.equal((await service.get(10)).locations.length, 1);
  service.destroy();
});
test("a missing parent is unavailable, never incorrectly reported as unfiled", async () => {
  const f = fixture(), service = new LocationService();
  f.collections.delete(2);
  assert.equal((await service.get(10)).status, "error");
  f.collections.set(2, { id: 2, libraryID: 1, key: "BBBB1111", name: "同步恢复 B" }); f.notify();
  assert.equal((await service.get(10)).status, "ready");
  service.destroy();
});
