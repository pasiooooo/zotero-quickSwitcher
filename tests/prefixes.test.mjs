import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PREFIXES, PRIOR_PREFIXES, LEGACY_PREFIXES, parseLauncherInput, parseSwitchInput, replaceLauncherFilter, migrateLauncherPrefixes } from "../src/launcher-query.mjs";
import { Prefs, DEFAULTS, CONFIG_GROUPS, migrateInputGroup, linkModePrefixes } from "../src/prefs.mjs";

test("fixed local guides form fields while URLs and standalone punctuation stay literal", () => {
  const query = parseLauncherInput('fault :2020 !Nature %journalArticle @Roe /Core \'(Methods) ;(Reader) ');
  assert.deepEqual(query.filters.map(filter => filter.type), ["year", "venue", "type", "author", "directory", "outline", "tabs"]);
  assert.equal(query.scopedOutline, true); assert.equal(query.scopedTabs, true);
  const plain = parseLauncherInput('https://doi.org/10.1234/a:b DOI:10.1234/c 95% pressure! "literal : ! % / ;"');
  assert.equal(plain.filters, undefined);
  assert.equal(parseLauncherInput("D'Angelo rock").text, "D'Angelo rock");
  assert.equal(parseLauncherInput("/>literal").activeFilter?.type, "directory");
});

test("independent switchers retain every typed symbol as plain text", () => {
  const text = String.raw`@Name /Core '(Methods) ;tabs OR NOT "quote" \escaped`;
  for (const mode of ["tabs", "outline", "directories"]) assert.deepEqual(parseSwitchInput(text, mode), { mode, kind: "switch", text });
  assert.equal(DEFAULT_PREFIXES.directory, "/"); assert.equal(DEFAULT_PREFIXES.tabs, ";"); assert.equal(DEFAULT_PREFIXES.outline, "'");
});

test("nonfixed configured guides and quoted replacements retain complete condition ranges", () => {
  const prefixes = { ...DEFAULT_PREFIXES, author: "~", year: "^", venue: "&", type: "=" };
  const raw = "rock ~Roe /Core ^2020 &Nature =book ";
  const query = parseLauncherInput(raw, "items", -1, prefixes);
  assert.deepEqual(query.filters.map(filter => filter.type), ["author", "directory", "year", "venue", "type"]);
  assert.ok(replaceLauncherFilter(raw, query.filters[3], "Nature Communications", prefixes).value.includes('&"Nature Communications" '));
  assert.equal(migrateLauncherPrefixes("rock @Roe /Core :2020 ", DEFAULT_PREFIXES, prefixes), "rock ~Roe /Core ^2020 ");
});

test("old input groups link their mode guides to upgraded shortcuts without losing other choices", () => {
  const legacy = Object.fromEntries(Object.entries(LEGACY_PREFIXES).map(([type, value]) => [type + "Prefix", value]));
  const prefixes = linkModePrefixes(migrateInputGroup("prefixes", { ...legacy, authorPrefix: "~" }), DEFAULTS, true);
  assert.equal(prefixes.currentPrefix, ">"); assert.equal(prefixes.directoryPrefix, "/"); assert.equal(prefixes.outlinePrefix, "'"); assert.equal(prefixes.tabsPrefix, ";"); assert.equal(prefixes.authorPrefix, "~");
  assert.equal(new Set(Object.values(prefixes)).size, CONFIG_GROUPS.prefixes.length);
  const shortcuts = migrateInputGroup("shortcuts", { launcherShortcut: "Accel+Shift+P", tabsShortcut: "native", advancedShortcut: DEFAULTS.advancedShortcut, outlineShortcut: "Alt+'" });
  assert.equal(shortcuts.launcherShortcut, "Alt+O"); assert.equal(shortcuts.advancedShortcut, "Alt+F"); assert.equal(shortcuts.tabsShortcut, "Alt+;"); assert.equal(shortcuts.directoryShortcut, "Alt+/");
  const custom = migrateInputGroup("shortcuts", { launcherShortcut: "Ctrl+K", tabsShortcut: "Alt+T", advancedShortcut: "Ctrl+Shift+F", outlineShortcut: "Alt+O" });
  assert.equal(custom.launcherShortcut, "Ctrl+K"); assert.equal(custom.tabsShortcut, "Alt+T");
});

test("local migration updates query markers and keeps private history and device data", () => {
  const values = new Map(Object.entries(PRIOR_PREFIXES).map(([type, value]) => ["quickswitcher." + type + "Prefix", value]));
  const bindings = [["directory:Core", { kind: "collection", libraryID: 1, key: "CORE0001" }]];
  values.set("quickswitcher.inputSchemaVersion", 2); values.set("quickswitcher.lastQuery", '@(Roe) #(Core) ');
  values.set("quickswitcher.lastQueryBindings", JSON.stringify(bindings)); values.set("quickswitcher.launcherShortcut", "Accel+Shift+P"); values.set("quickswitcher.tabsShortcut", "native");
  globalThis.Zotero = { isMac: false, Prefs: { get: key => values.get(key), set: (key, value) => values.set(key, value) } };
  try {
    const prefs = new Prefs(), migrated = prefs.migrateInputSettings(); assert.ok(migrated);
    assert.equal(prefs.get("lastQuery"), '@(Roe) /(Core) '); assert.deepEqual(prefs.get("lastQueryBindings"), bindings);
    assert.equal(prefs.get("inputSchemaVersion"), 5); assert.equal(prefs.migrateInputSettings(), false);
    assert.equal(prefs.get("launcherShortcut"), "Alt+O"); assert.equal(prefs.get("tabsShortcut"), "Alt+;");
    assert.equal(prefs.exportConfig().settings.lastQuery, undefined);
  } finally { delete globalThis.Zotero; }
});

test("imports link old symbols, reject bad groups atomically, and reserve the unused command chord", () => {
  const values = new Map(); globalThis.Zotero = { isMac: false, Prefs: { get: key => values.get(key), set: (key, value) => values.set(key, value) } };
  try {
    const prefs = new Prefs(); prefs.set("directoryPrefix", "#"); assert.equal(prefs.get("directoryShortcut"), "Alt+#");
    assert.throws(() => prefs.set("authorPrefix", "#"), /重复/); assert.equal(prefs.get("authorPrefix"), "@");
    prefs.importConfig({ schemaVersion: 1, settings: { ...Object.fromEntries(Object.entries(PRIOR_PREFIXES).map(([type, value]) => [type + "Prefix", value])), fontSize: 16 } });
    assert.equal(prefs.get("directoryPrefix"), "#"); assert.equal(prefs.get("tabsPrefix"), ";"); assert.equal(prefs.get("fontSize"), 16);
    assert.throws(() => prefs.set("launcherShortcut", "Alt+Shift+P"), /预留/);
    assert.throws(() => prefs.importConfig({ schemaVersion: 1, settings: { fontSize: 20, typePrefix: "**" } }), /引导符/);
    assert.equal(prefs.get("fontSize"), 16);
  } finally { delete globalThis.Zotero; }
});

test("new reserved symbols move a colliding custom guide rather than losing a whole preference group", () => {
  const values = Object.fromEntries(Object.entries(PRIOR_PREFIXES).map(([type, value]) => [type + "Prefix", value])); values.authorPrefix = "/";
  const migrated = linkModePrefixes(migrateInputGroup("prefixes", values), DEFAULTS, true);
  assert.equal(migrated.directoryPrefix, "/"); assert.notEqual(migrated.authorPrefix, "/"); assert.equal(new Set(Object.values(migrated)).size, 9);
  assert.throws(() => migrateInputGroup("prefixes", { ...values, yearPrefix: "/" }), /重复/);
  const incomplete = { ...values }; delete incomplete.venuePrefix; assert.throws(() => migrateInputGroup("prefixes", incomplete), /无效/);
});
