import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { topItem } from "../src/core.mjs";

// Exercise the actual method without starting the Application or a Zotero profile.
const source = readFileSync(new URL("../src/index.mjs", import.meta.url), "utf8");
const method = source.match(/  async createCollection\([\s\S]*?(?=\n  async directoryRows\()/u)[0];
const Application = new Function("topItem", "Zotero", "Services", "t", `return class { ${method} }`);

function fixture(t, { accepted = true, name = "  Research  ", editable = true, allowed = true, failAdd, afterSave, afterAdd, failReload = false,
  existing = [], collectionID, choiceAccepted = true, afterChoice, afterCollectionLoad } = {}) {
  const saved = globalThis.Zotero;
  t.after(() => { globalThis.Zotero = saved; });
  const events = [], collections = new Map(), members = new Map();
  const items = new Map([
    { id: 1, libraryID: 7 }, { id: 2, libraryID: 7 },
    { id: 3, libraryID: 7, parentID: 1 }, { id: 4, libraryID: 8 },
  ].map(item => [item.id, { ...item, reload: async (types, force) => {
    events.push(["reload", item.id, types, force]);
    if (failReload) throw new Error("reload failed");
  } }]));
  const host = {
    Items: { getAsync: async id => items.get(id), loadDataTypes: async (loaded, types) => events.push(["load", loaded.map(item => item.id), types]) },
    Libraries: { get: id => ({ libraryID: id, editable, isChildObjectAllowed: type => allowed && type === "collection" }) },
    Collections: { getByLibrary: id => [...collections.values()].filter(collection => collection.libraryID === id), getAsync: async id => collections.get(id) },
    Collection: class {
      async save() {
        assert.equal(host.DB.inTransaction, true); events.push(["save", this.libraryID, this.name]);
        this.id = 10; collections.set(this.id, { libraryID: this.libraryID, name: this.name }); afterSave?.();
        this.childItems = [];
        return this.id;
      }
      async loadDataType(type) {
        assert.equal(type, "childItems"); events.push(["load-collection", this.id]);
        this.childItems = [...(members.get(this.id) || [])]; afterCollectionLoad?.(this);
      }
      async reload(types, force) {
        events.push(["reload-collection", this.id, types, force]);
        this.childItems = [...(members.get(this.id) || [])];
      }
      async addItems(ids, options) {
        assert.ok(this.childItems, "Native addItems requires loaded childItems");
        assert.equal(host.DB.inTransaction, true); events.push(["add", ids, options]);
        members.set(this.id, [...new Set([...(members.get(this.id) || []), ...ids])]);
        this.childItems = [...members.get(this.id)]; afterAdd?.();
        if (failAdd) throw failAdd;
      }
      saveTx() { throw new Error("nested saveTx must not be used"); }
    },
    DB: { inTransaction: false, async executeTransaction(callback) {
      events.push(["begin"]); this.inTransaction = true;
      const savedCollections = new Map(collections), savedMembers = new Map([...members].map(([id, ids]) => [id, [...ids]]));
      try { const result = await callback(); events.push(["commit"]); return result; }
      catch (error) {
        collections.clear(); members.clear();
        for (const [id, collection] of savedCollections) collections.set(id, collection);
        for (const [id, ids] of savedMembers) members.set(id, ids);
        events.push(["rollback"]); throw error;
      }
      finally { this.inTransaction = false; }
    } },
  };
  for (const entry of existing) {
    collections.set(entry.id, { libraryID: 7, ...entry, addItems: host.Collection.prototype.addItems,
      loadDataType: host.Collection.prototype.loadDataType, reload: host.Collection.prototype.reload });
    members.set(entry.id, [...(entry.members || [])]);
  }
  const services = { prompt: {
    select: () => { assert.fail("Collection selection must use the launcher directory picker"); },
    prompt: () => { assert.fail("New collection names must come from the launcher input"); },
  } };
  globalThis.Zotero = host;
  const app = new (Application(topItem, host, services, value => value))();
  app.launcherFor = () => ({ chooseCollection: async libraryID => {
    events.push(["choose", libraryID]); afterChoice?.(collections);
    return accepted && choiceAccepted ? collectionID === undefined ? { name } : { collectionID } : null;
  } });
  return { app, events, items, collections, members };
}

test("collection creation deduplicates top-level items and commits creation and memberships together", async t => {
  const { app, events, collections, members } = fixture(t);
  const rows = [3, 1, 2, 3].map(itemID => ({ itemID })), original = structuredClone(rows);
  const result = await app.createCollection(rows, {});
  assert.deepEqual(result, { count: 2, name: "Research", collectionID: 10 });
  assert.deepEqual(rows, original);
  assert.deepEqual(collections.get(10), { libraryID: 7, name: "Research" });
  assert.deepEqual(members.get(10), [1, 2]);
  assert.deepEqual(events, [
    ["choose", 7], ["load", [1, 2], ["collections"]], ["begin"],
    ["save", 7, "Research"], ["add", [1, 2], { skipSelect: true }], ["commit"],
  ]);
});

test("cancelled or blank collection names never create an empty collection", async t => {
  for (const options of [{ accepted: false }, { name: "   " }]) {
    await t.test(options.accepted === false ? "cancel" : "blank", async t => {
      const { app, events, collections, members } = fixture(t, options);
      if (options.accepted === false) assert.equal(await app.createCollection([{ itemID: 1 }], {}), false);
      else await assert.rejects(app.createCollection([{ itemID: 1 }], {}), /请输入目录名称/u);
      assert.deepEqual(events, [["choose", 7]]); assert.equal(collections.size, 0); assert.equal(members.size, 0);
    });
  }
});

test("cross-library, read-only and unsupported Feed selections stop before prompting or writing", async t => {
  for (const [name, options, ids, expected] of [
    ["cross-library", {}, [1, 4], /同一文库/u],
    ["read-only group", { editable: false }, [1, 2], /不允许创建或加入目录/u],
    ["feed disallows collection", { allowed: false }, [1, 2], /不允许创建或加入目录/u],
  ]) {
    await t.test(name, async t => {
      const { app, events, collections } = fixture(t, options);
      await assert.rejects(app.createCollection(ids.map(itemID => ({ itemID })), {}), expected);
      assert.deepEqual(events, []); assert.equal(collections.size, 0);
    });
  }
});

test("membership failure rolls back the new collection and reloads every touched item's collections", async t => {
  const error = new Error("membership write failed");
  const { app, events, collections, members } = fixture(t, { failAdd: error, failReload: true });
  await assert.rejects(app.createCollection([{ itemID: 3 }, { itemID: 2 }], {}), value => value === error);
  assert.equal(collections.size, 0); assert.equal(members.size, 0);
  assert.ok(events.some(([name]) => name === "rollback"));
  assert.deepEqual(events.filter(([name]) => name === "reload"), [["reload", 1, ["collections"], true], ["reload", 2, ["collections"], true]]);
  assert.equal(events.some(([name]) => name === "commit"), false);
});

test("query cancellation during creation rolls back instead of committing a partial directory", async t => {
  for (const stage of ["save", "add"]) {
    await t.test(stage, async t => {
      let current = true;
      const { app, events, collections, members } = fixture(t, { [stage === "save" ? "afterSave" : "afterAdd"]: () => { current = false; } });
      const rows = [{ itemID: 1 }, { itemID: 2 }], original = structuredClone(rows);
      assert.equal(await app.createCollection(rows, {}, () => current), false);
      assert.deepEqual(rows, original); assert.equal(collections.size, 0); assert.equal(members.size, 0);
      assert.ok(events.some(([name]) => name === "rollback"));
      assert.equal(events.some(([name]) => name === "commit"), false);
      assert.equal(events.filter(([name]) => name === "reload").length, 2);
      if (stage === "save") assert.equal(events.some(([name]) => name === "add"), false);
    });
  }
});

test("the picker receives the selected library and adds to the exact chosen collection ID", async t => {
  const { app, events, collections, members } = fixture(t, { collectionID: 30, existing: [
    { id: 30, name: "Core", path: "Library › B › Core", members: [1, 99] },
    { id: 20, name: "Core", path: "Library › A › Core" },
    { id: 40, libraryID: 8, name: "Other", path: "Group › Other" },
    { id: 50, name: "Deleted", path: "Library › Deleted", deleted: true },
  ] });
  const rows = [3, 1, 2, 3].map(itemID => ({ itemID })), original = structuredClone(rows);
  assert.deepEqual(await app.createCollection(rows, {}), { count: 2, name: "Core", collectionID: 30 });
  assert.deepEqual(events[0], ["choose", 7]);
  assert.equal(events.some(([name]) => ["prompt", "save"].includes(name)), false);
  assert.equal(collections.size, 4); assert.deepEqual(members.get(30), [1, 99, 2]);
  assert.deepEqual(rows, original); assert.deepEqual(events.at(-1), ["commit"]);
});

test("the new collection choice still creates a named collection while keeping existing paths", async t => {
  const { app, events, collections, members } = fixture(t, { existing: [{ id: 20, name: "Old", path: "Library › Old", members: [99] }] });
  assert.deepEqual(await app.createCollection([{ itemID: 1 }], {}), { count: 1, name: "Research", collectionID: 10 });
  assert.deepEqual(events[0], ["choose", 7]); assert.equal(events.some(([name]) => name === "prompt"), false);
  assert.equal(collections.size, 2); assert.deepEqual(members.get(20), [99]); assert.deepEqual(members.get(10), [1]);
});

test("cancelling the path chooser does not create a directory or change memberships", async t => {
  const { app, events, collections, members } = fixture(t, { choiceAccepted: false, existing: [{ id: 20, name: "Old", path: "Library › Old", members: [99] }] });
  assert.equal(await app.createCollection([{ itemID: 1 }], {}), false);
  assert.equal(events.length, 1); assert.equal(events[0][0], "choose");
  assert.equal(collections.size, 1); assert.deepEqual(members.get(20), [99]);
});

test("a selected path that disappears or changes library is rejected before writing", async t => {
  for (const [name, change, expected] of [
    ["deleted", collections => { collections.get(20).deleted = true; }, /已删除/u],
    ["missing", collections => { collections.delete(20); }, /已删除/u],
    ["other library", collections => { collections.get(20).libraryID = 8; }, /同一文库/u],
  ]) {
    await t.test(name, async t => {
      const { app, events, members } = fixture(t, { collectionID: 20, afterChoice: change, existing: [{ id: 20, name: "Old", path: "Library › Old", members: [99] }] });
      await assert.rejects(app.createCollection([{ itemID: 1 }], {}), expected);
      assert.deepEqual(members.get(20), [99]); assert.equal(events.some(([name]) => name === "begin"), false);
    });
  }
});

test("failed or cancelled additions preserve existing memberships and reload touched items", async t => {
  for (const stage of ["failure", "cancel"]) {
    await t.test(stage, async t => {
      let current = true; const error = new Error("membership write failed");
      const { app, events, collections, members } = fixture(t, { collectionID: 20,
        failAdd: stage === "failure" ? error : undefined, afterAdd: stage === "cancel" ? () => { current = false; } : undefined,
        existing: [{ id: 20, name: "Old", path: "Library › Old", members: [99] }],
      });
      const action = app.createCollection([{ itemID: 1 }, { itemID: 2 }], {}, () => current);
      if (stage === "failure") await assert.rejects(action, value => value === error); else assert.equal(await action, false);
      assert.equal(collections.size, 1); assert.deepEqual(members.get(20), [99]);
      assert.deepEqual(collections.get(20).childItems, [99], "The collection cache must also reflect the rollback");
      assert.ok(events.some(([name]) => name === "rollback"));
      assert.equal(events.some(([name]) => ["save", "commit"].includes(name)), false);
      assert.equal(events.filter(([name]) => name === "reload").length, 2);
    });
  }
});

test("query changes during existing member loading cancel before any transaction or membership write", async t => {
  let current = true;
  const { app, events, members } = fixture(t, { collectionID: 20, afterCollectionLoad: () => { current = false; },
    existing: [{ id: 20, name: "Old", path: "Library › Old", members: [99] }],
  });
  assert.equal(await app.createCollection([{ itemID: 1 }], {}, () => current), false);
  assert.deepEqual(members.get(20), [99]); assert.equal(events.some(([name]) => name === "begin"), false);
});
