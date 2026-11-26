import test from "node:test";
import assert from "node:assert/strict";
import { Prefs, DEFAULTS, ACTIONS, CONFIG_GROUPS, validatePreference } from "../src/prefs.mjs";

function storage() {
  const values = new Map();
  globalThis.Zotero = { isMac: false, Prefs: { get: name => values.get(name), set: (name, value) => values.set(name, value) } };
  return values;
}

test("recent clipboard settings default to enabled and three seconds with validated portable configuration", () => {
  storage(); const prefs = new Prefs();
  try {
    assert.equal(prefs.get("clipboardSearch"), true); assert.equal(prefs.get("clipboardSeconds"), 3);
    prefs.set("clipboardSearch", false); prefs.set("clipboardSeconds", 5);
    assert.equal(prefs.exportConfig().settings.clipboardSearch, false); assert.equal(prefs.exportConfig().settings.clipboardSeconds, 5);
    assert.deepEqual(CONFIG_GROUPS.clipboardSearch, ["clipboardSearch"]); assert.deepEqual(CONFIG_GROUPS.clipboardSeconds, ["clipboardSeconds"]);
    for (const value of [0, -1, 1.5, 61, "3"]) assert.throws(() => prefs.set("clipboardSeconds", value));
    assert.throws(() => prefs.set("clipboardSearch", "true"));
  } finally { delete globalThis.Zotero; }
});

test("unsupported shortcut names are rejected before settings or an import are written", () => {
  const values = storage(), prefs = new Prefs();
  try {
    assert.throws(() => prefs.set("launcherShortcut", "Ctrl+UnknownKey"), /不支持/);
    assert.equal(values.size, 0);
    assert.throws(() => prefs.importConfig({ schemaVersion: 1, settings: { fontSize: 16, advancedShortcut: "Ctrl+F25" } }), /不支持/);
    assert.equal(values.size, 0);
    prefs.set("launcherShortcut", "Ctrl+PageDown");
    assert.equal(prefs.get("launcherShortcut"), "Ctrl+PageDown");
  } finally { delete globalThis.Zotero; }
});

test("invalid stored settings use valid defaults without overwriting their original data", () => {
  const values = storage(), prefs = new Prefs();
  const invalid = { launcherShortcut: "Ctrl+UnknownKey", theme: "unsupported", fontSize: 900, fields: '["not-a-field"]', sources: '{"fulltext":true}', recentItems: '["not-an-id"]', lastQueryBindings: '[["directory:broken",null]]' };
  try {
    for (const [name, value] of Object.entries(invalid)) values.set("quickswitcher." + name, value);
    for (const [name, value] of Object.entries(invalid)) {
      assert.deepEqual(prefs.get(name), DEFAULTS[name]);
      assert.equal(values.get("quickswitcher." + name), value);
      assert.ok(prefs.errors.has(name));
    }
    prefs.set("launcherShortcut", "Accel+Shift+P");
    assert.equal(prefs.get("launcherShortcut"), "Accel+Shift+P");
    assert.equal(prefs.errors.has("launcherShortcut"), false);
    values.set("quickswitcher.defaultScope", "collection");
    assert.equal(prefs.get("defaultScope"), "library");
    assert.equal(prefs.exportConfig().settings.lastQueryBindings, undefined);
  } finally { delete globalThis.Zotero; }
});

test("all shortcut updates validate together before writing and reset handles swapped bindings", () => {
  const values = storage(), changes = [], prefs = new Prefs(name => changes.push([name, prefs.get("launcherShortcut"), prefs.get("advancedShortcut")]));
  try {
    assert.throws(() => prefs.importConfig({ schemaVersion: 1, settings: { fontSize: 16, launcherShortcut: "Accel+Shift+P", advancedShortcut: "Ctrl+Shift+P" } }), /重复/);
    assert.equal(values.size, 0); assert.equal(changes.length, 0);
    assert.throws(() => prefs.set("launcherShortcut", "Alt+;"), /重复/);
    prefs.importConfig({ schemaVersion: 1, settings: { launcherShortcut: "Accel+Shift+F", advancedShortcut: "Accel+Shift+P" } });
    assert.equal(prefs.get("launcherShortcut"), "Accel+Shift+F");
    assert.deepEqual(changes[0], ["launcherShortcut", "Accel+Shift+F", "Accel+Shift+P"]);
    prefs.reset();
    assert.equal(prefs.get("launcherShortcut"), DEFAULTS.launcherShortcut);
    assert.equal(prefs.get("advancedShortcut"), DEFAULTS.advancedShortcut);
    assert.throws(() => prefs.importConfig({ schemaVersion: 1, settings: { constructor: 1 } }), /未知设置/);
  } finally { delete globalThis.Zotero; }
});

test("mode keys and prefixes update atomically in both directions, and invalid combinations leave all settings intact", () => {
  const values = storage(), prefs = new Prefs();
  try {
    prefs.set("tagPrefix", "~"); prefs.set("directoryPrefix", "#"); assert.equal(prefs.get("directoryShortcut"), "Alt+#");
    prefs.set("outlineShortcut", "Ctrl+`"); assert.equal(prefs.get("outlinePrefix"), "`");
    prefs.set("outlinePrefix", "$"); assert.equal(prefs.get("outlineShortcut"), "Control+$");
    prefs.set("outlinePrefix", "`"); assert.equal(prefs.get("outlineShortcut"), "Control+`");
    prefs.set("directoryShortcut", "Alt+Shift+3"); assert.equal(prefs.get("directoryPrefix"), "#");
    prefs.set("tabsShortcut", "Alt+T"); assert.equal(prefs.get("tabsPrefix"), "t");
    prefs.importConfig({ schemaVersion: 1, settings: { directoryPrefix: "&", commandShortcut: "Ctrl+P" } });
    assert.equal(prefs.get("directoryPrefix"), "&"); assert.equal(prefs.get("directoryShortcut"), "Alt+&");
    prefs.importConfig({ schemaVersion: 1, settings: { directoryPrefix: "^", launcherShortcut: "Alt+L", advancedShortcut: "Alt+G", tabsShortcut: "Alt+;" } });
    assert.equal(prefs.get("directoryPrefix"), "^"); assert.equal(prefs.get("directoryShortcut"), "Alt+^");
    const before = [...values];
    assert.throws(() => prefs.set("outlinePrefix", "^"), /重复/);
    assert.throws(() => prefs.set("directoryShortcut", "Alt+F10"));
    assert.throws(() => prefs.set("tabsPrefix", "+"));
    assert.deepEqual([...values], before);
    prefs.reset(); assert.equal(prefs.get("commandShortcut"), "Alt+P"); assert.equal(prefs.get("directoryPrefix"), "/");
  } finally { delete globalThis.Zotero; }
});

test("panel limits are ratios, legacy pixel configs migrate once, and Enter actions cannot re-enter exported settings", () => {
  const values = storage(), prefs = new Prefs();
  try {
    assert.equal(prefs.get("width"), 62); assert.equal(prefs.get("height"), 80);
    prefs.set("width", 70); prefs.set("height", 75);
    for (const width of [29, 101, 900, 60.5]) assert.throws(() => prefs.set("width", width));
    for (const height of [39, 101, 800]) assert.throws(() => prefs.set("height", height));
    prefs.importConfig({ schemaVersion: 1, settings: { width: 960, height: 800, openMode: "locate" } });
    assert.equal(prefs.get("width"), 62); assert.equal(prefs.get("height"), 80);
    assert.equal(prefs.exportConfig().settings.openMode, undefined);
    assert.equal(values.has("quickswitcher.openMode"), false);
  } finally { delete globalThis.Zotero; }
});

test("Enter actions accept blanks and repeats per mode, reject foreign actions, and stay in sync order", () => {
  storage(); const prefs = new Prefs();
  try {
    assert.deepEqual(prefs.get("actions"), DEFAULTS.actions);
    prefs.set("actions", { directories: { alt: "open", ctrl: "", shift: "open", enter: "open" }, outline: DEFAULTS.actions.outline, tabs: DEFAULTS.actions.tabs, items: { enter: "", shift: "", ctrl: "", alt: "" } });
    assert.equal(JSON.stringify(Object.keys(prefs.get("actions"))), JSON.stringify(Object.keys(ACTIONS)));
    assert.deepEqual(prefs.get("actions").directories, { enter: "open", shift: "open", ctrl: "", alt: "open" });
    assert.deepEqual(Object.values(prefs.get("actions").items), ["", "", "", ""]);
    const saved = prefs.get("actions");
    for (const bad of [{ ...saved, outline: { ...saved.outline, enter: "read" } }, { ...saved, tabs: { enter: "switch" } }, { items: saved.items }, { ...saved, extra: saved.items }, null]) {
      assert.throws(() => prefs.set("actions", bad)); assert.deepEqual(prefs.get("actions"), saved);
    }
    assert.deepEqual(prefs.exportConfig().settings.actions, saved);
  } finally { delete globalThis.Zotero; }
});

test("the global shortcut can be disabled, rejects unusable keys and stays on this device", () => {
  storage(); const prefs = new Prefs();
  try {
    assert.equal(prefs.get("globalShortcut"), "Alt+Shift+O");
    prefs.set("globalShortcut", ""); assert.equal(prefs.get("globalShortcut"), "");
    prefs.set("globalShortcut", "Ctrl+Shift+F9");
    assert.throws(() => prefs.set("globalShortcut", "Ctrl+Alt+VolumeUp")); assert.equal(prefs.get("globalShortcut"), "Ctrl+Shift+F9");
    assert.equal(Object.values(CONFIG_GROUPS).flat().includes("globalShortcut"), false);
    assert.equal(Object.values(CONFIG_GROUPS).flat().includes("actions"), true);
    assert.equal(prefs.exportConfig().settings.globalShortcut, undefined);
    prefs.importConfig({ schemaVersion: 1, settings: { globalShortcut: "Ctrl+Alt+F12" } });
    assert.equal(prefs.get("globalShortcut"), "Ctrl+Shift+F9");
  } finally { delete globalThis.Zotero; }
});

test("citation style and application rules validate before saving and travel with synced settings", () => {
  const rules = validatePreference("citationRules", [{ app: " POWERPNT.EXE ", styleID: "https://www.zotero.org/styles/apa", locale: "en-US" }]);
  assert.equal(rules[0].app, "POWERPNT.EXE"); assert.ok(CONFIG_GROUPS.citationRules); assert.ok(CONFIG_GROUPS.citationStyle);
  assert.throws(() => validatePreference("citationRules", [...rules, { ...rules[0], app: "powerpnt.exe" }]), /重复/u);
  assert.throws(() => validatePreference("citationRules", [{ app: "C:\\Program Files\\Word.exe", styleID: "apa" }]), /无效/u);
  assert.throws(() => validatePreference("citationRules", [{ app: "word.exe", styleID: "apa", secret: "invalid" }]), /无效/u);
  assert.throws(() => validatePreference("citationLocale", "bad locale"), /无效/u);
  assert.equal(validatePreference("citationLocale", "zh-CN"), "zh-CN");
  const actions = structuredClone(DEFAULTS.actions); actions.items.alt = "citation";
  assert.equal(validatePreference("actions", actions).items.alt, "citation");
});
