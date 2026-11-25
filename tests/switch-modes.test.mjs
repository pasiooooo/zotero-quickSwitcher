import test from "node:test";
import assert from "node:assert/strict";
import { parseSwitchInput, parseLauncherInput, DEFAULT_PREFIXES } from "../src/launcher-query.mjs";
import { switchMatches } from "../src/core.mjs";
import { inputScopeBlocks, InputScopes } from "../src/input-scopes.mjs";
import { matchesShortcut, shortcutFromEvent } from "../src/keys.mjs";
import { DEFAULTS } from "../src/prefs.mjs";
import { Launcher } from "../src/launcher.mjs";
import { buildWosExpression, localExpressionText } from "../src/wos-query.mjs";

test("switcher text is literal across guides, booleans, quotes and unmatched parentheses", () => {
  for (const mode of ["tabs", "outline", "directories"]) {
    for (const text of ["'", "@(A", "/Methods", "A OR B", '"exact"', String.raw`\path`]) {
      const query = parseSwitchInput(text, mode); assert.equal(query.text, text); assert.equal(query.filters, undefined); assert.equal(query.complete, undefined);
    }
  }
  assert.equal(switchMatches("Résumé @name /Methods", "resume @name"), true);
  assert.equal(switchMatches("A only", "A OR B"), false);
  assert.equal(switchMatches("A (B)", "(B)"), true);
  assert.equal(switchMatches("A prefixname", "prefix*"), false);
});

test("fixed local condition guides remain composable within the search mode", () => {
  const raw = "fault /(Core OR Methods) '(Results) ;(Reading) @({{PERSON_hgcj367b}}) ";
  const inside = parseLauncherInput(raw, "items", raw.indexOf("Results") + 2), outside = parseLauncherInput(raw, "items", raw.length);
  assert.equal(inside.mode, "outline"); assert.equal(outside.mode, "items"); assert.equal(outside.scopedTabs, true); assert.equal(outside.scopedOutline, true);
  assert.deepEqual(outside.filters.map(filter => filter.type), ["directory", "directory", "outline", "tabs", "author"]);
  assert.equal(DEFAULT_PREFIXES.directory, "/"); assert.equal(DEFAULT_PREFIXES.tabs, ";");
});

test("scope blocks preserve nested logical containment without changing source character positions", () => {
  const value = "(@(Alice OR (Bob AND Carol)) AND /(Core)) ";
  const query = parseLauncherInput(value, "items", -1), input = new InputScopes(value);
  input.add(value.indexOf("@")); input.add(value.indexOf("/"));
  const blocks = inputScopeBlocks(value, input.records, query);
  assert.ok(blocks.some(block => block.type === "author" && block.automatic));
  assert.ok(blocks.some(block => block.type === "directory" && block.automatic));
  assert.ok(blocks.some(block => block.type === "logic" && block.open === 0));
  assert.ok(blocks.every(block => block.start >= 0 && block.end <= value.length && block.end > block.start));
  const author = blocks.find(block => block.type === "author");
  assert.ok(blocks.some(block => block.type === "logic" && block.start > author.start && block.end < author.end));
  assert.equal(input.guard("deleteContentBackward", author.open + 1, author.open + 1).caret, author.open);
});

test("bare field guides produce bounded blocks while grouped inherited fields keep one outer marker", () => {
  const value = "plain @(Native) :1900 !journal %journalArticle", query = parseLauncherInput(value, "items", value.length);
  const fields = inputScopeBlocks(value, [], query).filter(block => block.type !== "logic");
  assert.deepEqual(fields.map(block => [block.type, value.slice(block.start, block.end)]), [
    ["author", "@(Native)"], ["year", ":1900"], ["venue", "!journal"], ["type", "%journalArticle"],
  ]);
  assert.deepEqual(fields.slice(1).map(block => block.markerEnd), fields.slice(1).map(block => block.start + 1));
  const nested = "(@(Alice OR (Bob AND Carol)) AND :1900)";
  assert.equal(inputScopeBlocks(nested, [], parseLauncherInput(nested, "items", nested.length)).filter(block => block.type === "author" && block.markerEnd !== undefined).length, 0, "inherited group leaves do not add bare marker blocks");
  const literal = String.raw`"@quoted :1900 !journal %book" \@literal \:2000 \!publisher \%book`;
  assert.deepEqual(inputScopeBlocks(literal, [], parseLauncherInput(literal, "items", literal.length)), []);
});

test("Tab exits the innermost query block, then its parent, and never invokes tabs", () => {
  const value = "@(Alice OR (Bob)) ", input = { value, selectionStart: 13, selectionEnd: 13, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; } };
  const view = Object.create(Launcher.prototype); Object.assign(view, { input, inputMode: "items", filterBindings: new Map(), inputScopes: new InputScopes(value), app: { prefs: { get: () => undefined } }, schedule() { this.mode = this.query().mode; } });
  view.inputScopes.add(0);
  const fire = () => { const event = { key: "Tab", target: input, preventDefault() { this.prevented = true; } }; view.keydown(event); return event; };
  assert.equal(fire().prevented, true); assert.equal(input.selectionEnd, value.indexOf(")") + 1);
  assert.equal(fire().prevented, true); assert.equal(input.selectionEnd, value.lastIndexOf(")") + 1);
  assert.equal(view.inputMode, "items"); assert.equal(view.mode, "items");
});

test("default chords separate the three switchers and leave command palette unclaimed", () => {
  assert.equal(DEFAULTS.launcherShortcut, "Alt+O"); assert.equal(DEFAULTS.advancedShortcut, "Alt+F"); assert.equal(DEFAULTS.tabsShortcut, "Alt+;"); assert.equal(DEFAULTS.outlineShortcut, "Alt+'"); assert.equal(DEFAULTS.directoryShortcut, "Alt+/");
  assert.ok(!Object.entries(DEFAULTS).filter(([name]) => name.endsWith("Shortcut")).some(([, value]) => value === "Alt+Shift+P"));
  const event = { key: "÷", code: "Slash", altKey: true, getModifierState: () => true };
  assert.equal(matchesShortcut(event, DEFAULTS.directoryShortcut, true), true); assert.equal(shortcutFromEvent(event, true), "Alt+/");
});

test("Enter and Shift+Enter dispatch only the current switcher's action and keep failed switches open", async () => {
  const previous = globalThis.Zotero; globalThis.Zotero = { isMac: false };
  try {
    for (const mode of ["tabs", "outline", "directories"]) {
      const calls = [], row = { itemID: 1, attachmentID: 11, location: { pageIndex: 2 }, kind: "collection", key: "CORE0001" };
      const view = Object.create(Launcher.prototype); Object.assign(view, { switchMode: mode, mode, isOpen: true, ready: true, input: { value: "" }, spec: () => ({}), rows: [row], selected: 0, outlineContext: { type: "pdf", attachmentID: 11 }, win: {},
        app: { openTab: async () => { calls.push("tab"); return true; }, openPDFWindow: async () => { calls.push("window"); return true; }, outline: { open: async (_, options) => { calls.push(options.split ? "split" : "outline"); return true; } },
          selectDirectory: async selected => { calls.push(selected.key); return true; }, parentDirectory: async () => ({ key: "PARENT01" }) }, hide() { this.isOpen = false; }, message() {} });
      await view.activate({ shifted: true }); assert.equal(view.isOpen, false);
      assert.deepEqual(calls, [mode === "tabs" ? "window" : mode === "outline" ? "split" : "PARENT01"]);
      view.isOpen = true; calls.length = 0; await view.activate(); assert.deepEqual(calls, [mode === "tabs" ? "tab" : mode === "outline" ? "outline" : "CORE0001"]);
      if (mode === "directories") { view.isOpen = true; view.app.selectDirectory = async () => false; await view.activate(); assert.equal(view.isOpen, true); }
    }
  } finally { globalThis.Zotero = previous; }
});

test("local display stays concise while whole copy contains only valid WoS fields", () => {
  const query = parseLauncherInput('fault /(Core) /(Methods) :(2024) !("Nature Geoscience") ', "items", -1);
  const expression = buildWosExpression(query);
  const display = localExpressionText(expression.tree);
  assert.ok(display.includes("Core AND Methods")); assert.ok(!display.includes("ZOTERO_DIR"));
  assert.ok(display.includes("TS=(fault)")); assert.ok(expression.copyText.includes("PY=(2024)")); assert.ok(!expression.copyText.includes("Core"));
  for (const text of [':(2024)', 'ze*', '@(*Name)']) assert.equal(buildWosExpression(parseLauncherInput(text, "items", -1)).copyText, "");
  assert.ok(buildWosExpression(parseLauncherInput('stress :2024', "items", -1)).copyText.includes("PY=(2024)"));
});
