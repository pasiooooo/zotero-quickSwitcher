import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Launcher } from "../src/launcher.mjs";
import { topItem } from "../src/core.mjs";

// Run the actual Application methods without starting Zotero or initializing its services.
const source = readFileSync(new URL("../src/index.mjs", import.meta.url), "utf8");
const methods = [
  source.match(/  async selectDirectory\([\s\S]*?(?=\n  openOrganizationPicker\()/u)[0],
  source.match(/  async locateItems\([\s\S]*?(?=\n  stop\()/u)[0],
].join("\n");
const Application = new Function("topItem", "Zotero", "t", "loadedItems", `return class { ${methods} }`);

function gate() {
  let release, arrived;
  return { wait: new Promise(resolve => { release = resolve; }), hit: new Promise(resolve => { arrived = resolve; }), release: () => release(), arrive: () => arrived() };
}

function fixture(stage) {
  const pending = gate(), events = [], items = new Map([1, 2].map(id => [id, { id, libraryID: 1, getCollections: () => [10] }]));
  let itemLoads = 0, windows = 0, selected = [], selectedCollection = 10;
  const pause = async name => { if (name === stage) { pending.arrive(); await pending.wait; } };
  const host = { Items: { getAsync: async id => {
    itemLoads++;
    if (stage === "bulk-load" || itemLoads === 3) await pause(stage === "bulk-load" ? "bulk-load" : "parent-load");
    return items.get(id);
  } }, Promise: { delay: async () => {} } };
  const app = new (Application(topItem, host, value => value, async () => []))();
  const pane = {
    collectionsView: { get selectedTreeRow() { return { id: `C${selectedCollection}`, ref: { id: selectedCollection, libraryID: 1 }, isCollection: () => true }; },
      selectByID: async id => { selectedCollection = Number(id.slice(1)); events.push(["collection", id]); } },
    itemsView: {
      selectItem: async id => { selected = [id]; events.push(["item", id]); await pause("item-selection"); },
      selectItems: async ids => { selected = ids; events.push(["items", ids]); await pause("batch-selection"); },
      focus: () => events.push(["focus"]),
    },
    getSelectedItems: () => selected,
  };
  const win = { ZoteroPane: pane, Zotero_Tabs: { select: id => events.push(["tab", id]) }, focus: () => events.push(["window-focus"]) };
  app.ensureMainWindow = async () => { await pause(++windows === 1 ? "main-window" : "batch-window"); return win; };
  app.locations = { get: async () => { await pause("locations"); return { status: "ready", locations: [{ collectionID: 10 }] }; } };
  app.revealLocations = async (_win, ids, current) => { if (current()) events.push(["reveal", ids]); };
  const view = Object.create(Launcher.prototype);
  Object.assign(view, { isOpen: true, openRevision: 1, ready: true, mode: "items", input: { value: "old" },
    spec: () => ({ text: view.input.value }), selectionRevision: 0, rows: [], selected: 0, app,
    picked: new Map([1, 2].map(itemID => [itemID, { kind: "item", itemID }])), message() {}, hide: () => events.push(["hide"]) });
  return { host, app, win, view, events, pending };
}

test("changing a query cancels pending batch location before its next native mutation", async t => {
  const saved = globalThis.Zotero;
  t.after(() => { globalThis.Zotero = saved; });
  for (const stage of ["bulk-load", "parent-load", "main-window", "locations", "item-selection", "batch-window", "batch-selection"]) {
    await t.test(stage, async () => {
      const { host, view, events, pending } = fixture(stage);
      globalThis.Zotero = host;
      const action = view.activateBatch({ locate: true });
      await pending.hit;
      const started = structuredClone(events);
      view.input.value = "new"; view.selectionRevision++;
      pending.release(); await action;
      assert.deepEqual(events, started, "no next selection, focus, reveal or panel close after cancellation");
      assert.equal(view.isOpen, true); assert.equal(view.actionRunning, false);
    });
  }
});

test("native batch location callers can omit the guard and still select and reveal all valid items", async t => {
  const saved = globalThis.Zotero;
  t.after(() => { globalThis.Zotero = saved; });
  const { host, app, events } = fixture(); globalThis.Zotero = host;
  const result = await app.locateItems([{ itemID: 1 }, { itemID: 2 }]);
  assert.deepEqual(result, { count: 2, failed: [] });
  assert.ok(events.some(([name, ids]) => name === "items" && ids.join(",") === "1,2"));
  assert.deepEqual(events.at(-1), ["reveal", [1, 2]]);
});

test("an explicit membership selects that path and reveals the item even when another path sorts first", async t => {
  const saved = globalThis.Zotero; t.after(() => { globalThis.Zotero = saved; });
  const { host, app, events } = fixture(); globalThis.Zotero = host;
  const item = await host.Items.getAsync(1); item.getCollections = () => [10, 20];
  assert.equal(await app.openItem({ itemID: 1 }, { locate: true, location: { collectionID: 20 } }), true);
  assert.ok(events.some(([name, id]) => name === "collection" && id === "C20"));
  assert.ok(events.some(([name, id]) => name === "item" && id === 1));
  assert.deepEqual(events.at(-1), ["reveal", 1]);
});

test("current-directory single and batch locate keep their captured scope while navigating to the item's child collection", async t => {
  const saved = globalThis.Zotero; t.after(() => { globalThis.Zotero = saved; });
  for (const batch of [false, true]) {
    await t.test(batch ? "batch" : "single", async () => {
      const { host, app, win, view, events } = fixture(); globalThis.Zotero = host;
      await win.ZoteroPane.collectionsView.selectByID("C9"); events.length = 0;
      app.directoryContext = () => ({ libraryID: 1, collectionKey: String(win.ZoteroPane.collectionsView.selectedTreeRow.ref.id) });
      app.makeSpec = (_win, spec) => spec;
      app.prefs = { get: name => ({ recursive: true, defaultScope: "library", currentPrefix: ">" })[name] };
      Object.assign(view, { win, inputMode: "items", context: { libraryID: 1 }, filterBindings: new Map(), spec: Launcher.prototype.spec,
        rows: [{ kind: "item", itemID: 1 }] });
      view.input.value = ">fault"; view.input.selectionEnd = view.input.value.length;
      if (!batch) view.picked.clear();
      assert.equal(view.spec().scope.collectionKey, "9");
      await view.activate({ locate: true });
      assert.equal(view.spec().scope.collectionKey, "10", "live query still follows the sidebar after navigation");
      assert.ok(events.some(([name]) => name === "item"));
      assert.ok(events.some(([name]) => name === "reveal"));
      assert.deepEqual(events.at(-1), ["hide"]);
    });
  }
});

test("cancelled reveal never paints after waiting for focus, locations or a previous reveal", async t => {
  for (const stage of ["focus", "locations", "previous"]) {
    await t.test(stage, async () => {
      const pending = gate(), painted = [], host = { Promise: { delay: async () => {
        if (stage === "focus") { pending.arrive(); await pending.wait; }
      } } };
      const app = new (Application(topItem, host, value => value, async () => []))(), entry = {};
      const win = { closed: false, ZoteroPane: { collectionsView: { selectedTreeRow: { id: "C10" },
        setHighlightedRows: async ids => painted.push(ids) }, getSelectedItems: () => [1] } };
      app.windows = new Map([[win, entry]]);
      app.locations = { get: async () => {
        if (stage === "locations") { pending.arrive(); await pending.wait; }
        return { status: "ready", locations: [{ collectionID: 10 }] };
      } };
      if (stage === "previous") entry.reveal = { cancel: async () => { pending.arrive(); await pending.wait; } };
      let current = true;
      const action = app.revealLocations(win, 1, () => current);
      await pending.hit; current = false; pending.release(); await action;
      assert.deepEqual(painted, []);
    });
  }
});
