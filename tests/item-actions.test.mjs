import test from "node:test";
import assert from "node:assert/strict";
import { itemWebURL } from "../src/item-actions.mjs";
import { Launcher } from "../src/launcher.mjs";
import { migrateInputGroup } from "../src/prefs.mjs";

test("DOI wins over URL, invalid DOI falls back to a web URL and missing links remain explicit", t => {
  const saved = globalThis.Zotero; t.after(() => { globalThis.Zotero = saved; });
  globalThis.Zotero = { Utilities: { cleanDOI: value => /^10\.\d+\//u.test(value) ? value : null } };
  const item = (doi, url) => ({ getField: field => field === "DOI" ? doi : url });
  assert.equal(itemWebURL(item("10.1234/a(b)", "https://publisher.example/paper")), "https://doi.org/10.1234/a(b)");
  assert.equal(itemWebURL(item("invalid", "https://publisher.example/paper")), "https://publisher.example/paper");
  assert.throws(() => itemWebURL(item("", "")), /DOI/);
  assert.throws(() => itemWebURL(item("", "javascript:alert(1)")), /URL/);
});

test("old default search/advanced keys migrate to Alt O/F while other custom combinations survive", () => {
  const migrated = migrateInputGroup("shortcuts", { launcherShortcut: "Alt+Shift+O", advancedShortcut: "Alt+Shift+F", tabsShortcut: "Alt+;", outlineShortcut: "Alt+'", directoryShortcut: "Alt+/" });
  assert.equal(migrated.launcherShortcut, "Alt+O"); assert.equal(migrated.advancedShortcut, "Alt+F");
  const custom = migrateInputGroup("shortcuts", { ...migrated, launcherShortcut: "Ctrl+Shift+L", advancedShortcut: "Alt+Shift+K" });
  assert.equal(custom.launcherShortcut, "Ctrl+Shift+L"); assert.equal(custom.advancedShortcut, "Alt+Shift+K");
});

test("item search exposes Enter, Ctrl Enter, Shift Enter and Alt Enter without altering tab activation", async () => {
  const calls = [], view = Object.create(Launcher.prototype);
  Object.assign(view, { isOpen: true, ready: true, input: { value: "" }, spec: () => ({}), mode: "items", rows: [{ itemID: 1 }], selected: 0, app: { prefs: { get: () => "reader" }, async openItem(_, options) { calls.push(options.locate ? "collection" : "pdf"); }, async openPDFWindow() { calls.push("window"); }, async openItemURL() { calls.push("doi"); }, async openTab() { calls.push("tab"); } }, hide() {}, message() {} });
  await view.activate(); await view.activate({ locate: true }); await view.activate({ shifted: true }); await view.activate({ web: true });
  view.switchMode = "tabs"; view.mode = "tabs"; await view.activate(); await view.activate({ web: true });
  assert.deepEqual(calls, ["pdf", "collection", "window", "doi", "tab", "doi"]);
});
