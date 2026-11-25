import test from "node:test";
import assert from "node:assert/strict";
import { SearchTreeAdapter, layoutSlot, subtreeEnd } from "../src/tree.mjs";

test("search gap anchors keep ordinary folder order and missing anchors fall back to root end", () => {
  const keys = ["AAAA2222", "BBBB2222"];
  assert.equal(layoutSlot({ anchorCollectionKey: keys[0], anchorSide: "after" }, keys), 1);
  assert.equal(layoutSlot({ anchorCollectionKey: keys[1], anchorSide: "before" }, keys), 1);
  assert.equal(layoutSlot({ anchorCollectionKey: "CCCC2222", anchorSide: "before" }, keys), 2);
  const rows = [{ level: 0 }, { level: 1 }, { level: 2 }, { level: 3 }, { level: 1 }];
  assert.equal(subtreeEnd(rows, 1), 4); assert.equal(subtreeEnd(rows, 0), 5);
});

test("tree refresh restores selection events after native reload, including RSS selections", async () => {
  const selection = { selectEventsSuppressed: false }, calls = [];
  const view = {
    selection, getSelectedRows: () => [{ id: "L2" }],
    reload: async () => { selection.selectEventsSuppressed = true; },
    selectByID: async id => { calls.push(id); },
    _onSelectionChange: async () => { assert.equal(selection.selectEventsSuppressed, false); calls.push("selected"); },
  };
  const adapter = new SearchTreeAdapter({ ZoteroPane: { collectionsView: view } }, {}); adapter.prepare = async () => {};
  await adapter.refresh();
  assert.deepEqual(calls, ["L2", "selected"]);
  assert.equal(selection.selectEventsSuppressed, false);
  adapter.native = { collectionChanging: 1 };
  calls.length = 0;
  await adapter.refresh();
  assert.deepEqual(calls, ["L2"]);
  assert.equal(selection.selectEventsSuppressed, false);
  view.reload = async () => { selection.selectEventsSuppressed = true; throw new Error("reload failed"); };
  await assert.rejects(adapter.refresh(), /reload failed/);
  assert.equal(selection.selectEventsSuppressed, false);
});
