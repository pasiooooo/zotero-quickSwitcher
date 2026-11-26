import test from "node:test";
import assert from "node:assert/strict";
import { parseLauncherInput, replaceLauncherFilter } from "../src/launcher-query.mjs";
import { ALL_FIELDS } from "../src/core.mjs";
import { Launcher } from "../src/launcher.mjs";
import { groupAuthors } from "../src/authors.mjs";
import { buildOutlineTree } from "../src/outline-tree.mjs";
import { Prefs } from "../src/prefs.mjs";
import { InputScopes } from "../src/input-scopes.mjs";

test("input prefixes keep recent, global, tabs, fulltext, author and directory queries distinct", () => {
  assert.equal(parseLauncherInput("").kind, "recent");
  assert.deepEqual(parseLauncherInput('岩石 "stress transfer"'), { mode: "items", kind: "global", text: '岩石 "stress transfer"' });
  assert.deepEqual(parseLauncherInput(" full tail"), { mode: "items", kind: "fulltext", text: "full tail" });
  assert.equal(parseLauncherInput("/").mode, "directories");
  assert.equal(parseLauncherInput("/项目 A").activeFilter.value, "项目 A");
  assert.equal(parseLauncherInput("@").mode, "authors");
  assert.equal(parseLauncherInput("@晓禾 林").activeFilter.value, "晓禾 林");
  assert.deepEqual(parseLauncherInput("@author", "tabs"), { mode: "tabs", kind: "tabs", text: "@author" });
  assert.deepEqual(parseLauncherInput(">岩石"), { mode: "items", kind: "scoped", text: "岩石", current: true });
  assert.equal(parseLauncherInput("'岩石").activeFilter.type, "outline");
});

test("filters work anywhere, preserve phrases, and distinguish OR from ordinary words", () => {
  const value = 'fault /项目* @Lin OR -@"Second Author" /方法? "literal @ /" OR ';
  const parsed = parseLauncherInput(value);
  assert.equal(parsed.mode, "items"); assert.equal(parsed.text, 'fault "literal @ /" OR');
  assert.deepEqual(parsed.filters.map(({ type, value, negated, join }) => ({ type, value, negated, join })), [
    { type: "directory", value: "项目*", negated: false, join: "and" },
    { type: "author", value: "Lin", negated: false, join: "and" },
    { type: "author", value: "Second Author", negated: true, join: "or" },
    { type: "directory", value: "方法?", negated: false, join: "and" },
  ]);
  const escaped = parseLauncherInput(String.raw`literal\@name literal\/name`);
  assert.equal(escaped.filters, undefined);
});

test("selection replaces only the active caret fragment and keeps all other filters", () => {
  const value = 'fault /old OR -/next @Lin ';
  const cursor = value.indexOf("/next") + 5;
  const parsed = parseLauncherInput(value, "items", cursor);
  assert.equal(parsed.activeFilter.value, "next"); assert.ok(parsed.activeFilter.negated);
  const replaced = replaceLauncherFilter(value, parsed.activeFilter, "我的文库 › 项目 B");
  assert.equal(replaced.value, 'fault /old OR -/"我的文库 › 项目 B" @Lin ');
  assert.equal(replaced.value.slice(replaced.caret), "@Lin ");
  assert.equal(parseLauncherInput(replaced.value, "items", replaced.caret).mode, "items");
  assert.equal(parseLauncherInput('@"Lin" fault').mode, "items");
  assert.equal(parseLauncherInput('@Lin* fault').mode, "items");
});

function popup() {
  const view = Object.create(Launcher.prototype);
  Object.assign(view, { inputMode: "items", mode: "items", ready: true, isOpen: true, rows: [], selected: 0, context: { libraryID: 7 }, nativeConditions: null, filterBindings: new Map(),
    sources: { hidden: true }, advanced: { hidden: true },
    input: { _value: "", get value() { return this._value; }, set value(value) { this._value = value; this.selectionStart = this.selectionEnd = value.length; }, focus() {}, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; } },
    app: { prefs: { get: key => ({ defaultScope: "collection", recursive: true, openMode: "reader" })[key] }, makeSpec: (_, spec) => spec, plainContext: () => ({ libraryID: 9, collectionKey: "CURRENT9", collectionName: "当前目录" }) },
    schedule() { this.mode = this.query().mode; }, hide() { this.isOpen = false; }, message(text) { this.lastMessage = text; } });
  return view;
}

test("ordinary typing remains global and a leading space searches every field and source", () => {
  const view = popup(); view.input.value = "fault";
  assert.deepEqual(view.spec().scope, { type: "library", libraryID: 7 });
  view.input.value = " fault";
  assert.deepEqual(view.spec().fields, ALL_FIELDS.fields);
  assert.deepEqual(view.spec().sources, { notes: true, annotations: true, fulltext: true });
  assert.equal(view.spec().text, "fault");
  view.input.value = ' fault @Roe'; assert.equal(view.query().mode, "authors"); assert.deepEqual(view.spec().fields, ALL_FIELDS.fields);
  view.inputMode = "outline"; view.outlineContext = { type: "all" }; assert.equal(view.spec().fields, undefined); assert.equal(view.spec().text, "fault");
});

test("a batch applies prefix changes before adopting them in the live query and retains the caret", () => {
  const previous = globalThis.Zotero, values = new Map(), view = popup();
  globalThis.Zotero = { isMac: false, Prefs: { get: key => values.get(key), set: (key, value) => values.set(key, value) } };
  view.app.prefs = new Prefs(name => {
    if (name.endsWith("Prefix")) view.updatePrefixes();
    view.query();
  });
  try {
    view.input.value = '@(Alice) /(Core)'; view.input.setSelectionRange(5, 5);
    view.inputScopes = new InputScopes(view.input.value); view.inputScopes.add(0); view.inputScopes.add(9);
    view.query();
    view.app.prefs.apply([["fontSize", 16], ["authorPrefix", "~"], ["yearPrefix", "^"]]);
    assert.equal(view.input.value, '~(Alice) /(Core)');
    assert.equal(view.input.selectionEnd, 5); assert.equal(view.query().activeFilter.type, "author");
    assert.equal(view.inputScopes.records.length, 2);
    view.updatePrefixes(); assert.equal(view.input.selectionEnd, 5);
    assert.equal(view.app.prefs.exportConfig().settings.lastQueryScopes, undefined);
  } finally { globalThis.Zotero = previous; }
});

test("an advanced shortcut keeps an existing outline or tab query intact before migration", () => {
  for (const mode of ["outline", "tabs"]) {
    const view = popup(); view.inputMode = mode; view.input.value = '(Methods OR "@literal")';
    let before;
    view.toggleAdvanced = () => { before = { mode: view.inputMode, value: view.input.value }; };
    view.show("items", true);
    assert.deepEqual(before, { mode, value: '(Methods OR "@literal")' });
  }
});

test("consecutive advanced metadata clicks retain one another and native edits made during preparation", async () => {
  const view = popup(); view.openRevision = 1; view.advancedSpec = { text: "", scope: { type: "library", libraryID: 7 } };
  const conditions = [{ condition: "title", operator: "contains", value: "fault" }];
  const search = () => ({ toJSON: () => ({ conditions }) });
  view.widget = { search: search(), updateSearch() { view.nativeConditions = conditions; } };
  let release, prepares = 0;
  view.app.search = {
    async prepare(spec) { if (++prepares === 1) await new Promise(resolve => { release = resolve; }); return { ...spec, resolvedFilters: spec.filters }; },
    buildSearch(spec) { conditions.splice(0, conditions.length, ...spec.nativeConditions, { condition: spec.filters[0].type, value: spec.filters[0].value }); return search(); },
  };
  const first = view.addAdvancedFilter("author", "A", {}), second = view.addAdvancedFilter("year", "2024", {});
  await new Promise(resolve => setImmediate(resolve));
  conditions.push({ condition: "publisher", value: "Native edit" });
  release(); await Promise.all([first, second]);
  assert.deepEqual(conditions.map(condition => condition.condition), ["title", "publisher", "author", "year"]);
  view.app.search.prepare = async spec => { view.openRevision++; return { ...spec, resolvedFilters: spec.filters }; };
  await view.addAdvancedFilter("venue", "stale", {});
  assert.equal(conditions.length, 4);
});

test("Enter binds multiple directory fragments without closing or discarding the query", async () => {
  const view = popup(), row = { kind: "collection", libraryID: 7, key: "ABCD1234", title: "项目 A 的核心文献", path: "文库 › 项目 A 的核心文献" };
  view.mode = "directories"; view.rows = [row]; view.selected = 0; view.input.value = "fault /项目 A";
  await view.activate();
  assert.equal(view.isOpen, true); assert.equal(view.input.value, 'fault /"项目 A 的核心文献" ');
  assert.equal(view.input.selectionStart, view.input.value.length);
  view.input.value += "transfer /方法"; view.mode = "directories";
  view.rows = [{ ...row, key: "METHODS1", title: "方法", path: "文库 › 方法" }]; await view.activate();
  assert.deepEqual(view.spec().filters.map(filter => filter.ref.key), ["ABCD1234", "METHODS1"]);
  assert.deepEqual(view.spec().scope, { type: "library", libraryID: 7 });
  assert.equal(view.spec().text, "fault transfer"); assert.equal(view.spec().fields, undefined);
  view.clearDirectory();
  assert.equal(view.spec().text, "fault transfer"); assert.deepEqual(view.spec().scope, { type: "library", libraryID: 7 });
});

test("current-directory prefix reads the actual sidebar and selected group directories change library scope", () => {
  const view = popup(); view.input.value = ">fault";
  assert.deepEqual(view.spec().scope, { type: "collection", libraryID: 9, collectionKey: "CURRENT9", recursive: true });
  view.filterBindings.set("directory:Group", { kind: "collection", libraryID: 12, key: "GROUPKEY" });
  view.input.value = '/"Group" fault'; assert.equal(view.spec().scope.libraryID, 12);
  view.filterBindings.set("directory:Local", { kind: "collection", libraryID: 7, key: "LOCALKEY" });
  view.input.value = '/"Group" OR /"Local" fault'; assert.deepEqual(view.spec().scope, { type: "all" });
  view.input.value = '>/"Group" fault'; assert.equal(view.spec().scope.libraryID, 9);
  view.clearDirectory(); assert.ok(view.input.value.startsWith('/"Group"'));
});

test("same displayed paths keep each chosen directory reference, including folder/search and libraries", async () => {
  const view = popup(), base = { kind: "collection", libraryID: 7, key: "DIRECT01", title: "Same", path: "Library › Same" };
  for (const row of [base, { ...base, kind: "search", key: "SEARCH01" }, { ...base, libraryID: 12 }]) {
    view.input.value += "/Same"; view.mode = "directories"; view.rows = [row]; view.selected = 0; await view.activate();
  }
  const filters = view.spec().filters;
  assert.equal(new Set(filters.map(filter => filter.value)).size, 3);
  assert.deepEqual(filters.map(filter => filter.value), ["Same", "Same · 2", "Same · 3"]);
  assert.deepEqual(filters.map(filter => [filter.ref.kind, filter.ref.libraryID, filter.ref.key]), [["collection", 7, "DIRECT01"], ["search", 7, "SEARCH01"], ["collection", 12, "DIRECT01"]]);
  assert.deepEqual(view.spec().scope, { type: "all" });
});

test("selecting an author binds its complete canonical name independently of directory scope", async () => {
  const view = popup(); view.input.value = "fault @Wei Li"; view.mode = "authors";
  view.rows = [{ kind: "author", key: "liwei", title: "Wei Li", authors: "Wei Li" }]; view.selected = 0;
  await view.activate();
  assert.equal(view.spec().filters[0].ref.key, "liwei");
  assert.deepEqual(view.spec().scope, { type: "library", libraryID: 7 });
  assert.equal(view.spec().text, "fault");
});

test("history persistence failures never prevent Escape or lifecycle cleanup from closing", () => {
  const view = popup(); let logged = 0;
  view.app.prefs.set = () => { throw new Error("history unavailable"); };
  view.app.logError = () => logged++; view.root = { hidden: false }; view.win = { clearTimeout() {} }; view.revision = 1;
  Launcher.prototype.hide.call(view);
  assert.equal(logged, 1); assert.equal(view.isOpen, false); assert.equal(view.root.hidden, true); assert.equal(view.ready, false);
});

test("opening advanced conditions migrates every query fragment to the native editor without applying it twice", async () => {
  const view = popup(); view.input.value = 'fault /"Project" @Lin'; view.mode = "authors";
  view.filterBindings.set("directory:Project", { kind: "collection", libraryID: 7, key: "DIRECT01" });
  const conditions = [{ condition: "title", operator: "contains", value: "fault" }, { condition: "collection", operator: "is", value: "DIRECT01" }, { condition: "creator", operator: "is", value: "Lin" }];
  view.app.search = { prepare: async spec => spec, buildSearch: spec => { view.migratedSpec = spec; return { libraryID: 7, toJSON: () => ({ conditions }) }; }, libraries: () => [{ libraryID: 7, name: "Library" }] };
  const node = () => ({ setAttribute() {}, append() {}, addEventListener() {}, querySelector() { return null; } });
  view.doc = { createXULElement: node, createElementNS: node }; view.advanced.replaceChildren = () => {}; view.advanced.append = () => {};
  view.advancedButton = node(); view.directoryChoice = () => {}; view.revision = 0;
  await view.toggleAdvanced(true);
  assert.equal(view.query().mode, "items"); assert.equal(view.spec().text, "");
  assert.equal(view.migratedSpec.text, "fault"); assert.equal(view.migratedSpec.filters[0].ref.key, "DIRECT01");
  assert.equal(view.migratedSpec.filters[1].value, "Lin"); assert.equal(view.spec().filters, undefined);
  assert.deepEqual(view.spec().nativeConditions, conditions); assert.equal(view.input.readOnly, true);
  assert.equal(view.advanced.hidden, false); assert.equal(view.directoryChoice, null);
});

test("all-library advanced searches use an array-based library chooser and preserve cancellation", async t => {
  const previous = globalThis.Services;
  t.after(() => { globalThis.Services = previous; });
  for (const accepted of [false, true]) {
    const view = popup(), libraries = [{ libraryID: 7, name: "Library" }, { libraryID: 9, name: "Group" }], choices = [];
    view.input.value = 'fault /"Project" ';
    const original = view.input.value, get = view.app.prefs.get;
    view.app.prefs.get = key => key === "defaultScope" ? "all" : get(key);
    globalThis.Services = { prompt: { select: (_win, _title, _text, labels, selected) => {
      assert.ok(Array.isArray(labels), "nsIPromptService.select requires an array as its fourth argument");
      choices.push(labels); selected.value = 1; return accepted;
    } } };
    view.app.search = { libraries: () => libraries, prepare: async spec => spec,
      buildSearch: spec => { view.migratedSpec = spec; return { libraryID: spec.scope.libraryID, toJSON: () => ({ conditions: [] }) }; } };
    const node = () => ({ setAttribute() {}, append() {}, addEventListener() {}, querySelector() { return null; } });
    view.doc = { createXULElement: node, createElementNS: node }; view.advanced.replaceChildren = () => {}; view.advanced.append = () => {};
    view.advancedButton = node(); view.revision = 0;
    await view.toggleAdvanced(true);
    assert.deepEqual(choices, [["Library", "Group"]]);
    assert.equal(view.lastMessage, undefined);
    if (accepted) assert.deepEqual(view.migratedSpec.scope, { type: "library", libraryID: 9 });
    else { assert.equal(view.input.value, original); assert.equal(view.widget, undefined); assert.equal(view.spec().scope.type, "all"); }
  }
});

test("directory organization callbacks preserve cancellation and composition cannot activate", async () => {
  const view = popup(); view.mode = "directories"; view.rows = [{ kind: "collection" }]; view.selected = 0;
  let calls = 0; view.directoryChoice = async () => { calls++; return false; };
  await view.activate(); assert.equal(view.isOpen, true); assert.equal(calls, 1);
  view.composing = true; await view.activate(); assert.equal(calls, 1);
  view.composing = false; view.directoryChoice = async () => true; await view.activate(); assert.equal(view.isOpen, false);
});

test("Tab leaves the current block without entering tabs, and Escape always exits", () => {
  const view = popup(); view.input.value = "@(fault)"; view.input.setSelectionRange(5, 5);
  view.inputScopes = new InputScopes(view.input.value);
  const event = (key, target, extra = {}) => ({ key, target, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {}, ...extra });
  const tab = event("Tab", view.input); view.keydown(tab);
  assert.equal(tab.prevented, true); assert.equal(view.inputMode, "items"); assert.equal(view.input.value, "@(fault) "); assert.equal(view.input.selectionEnd, 9);
  view.directoryChoice = () => {}; view.setMode("items"); assert.equal(view.directoryChoice, null);
  const button = { getAttribute: () => null, getClientRects: () => [1], focus() {} };
  view.root = { querySelectorAll: () => [button] }; view.doc = { activeElement: {} };
  const controlTab = event("Tab", button); view.keydown(controlTab); assert.equal(controlTab.prevented, false);
  const composing = event("Escape", view.input, { isComposing: true }); view.keydown(composing); assert.equal(view.isOpen, true);
  const escape = event("Escape", view.input); view.keydown(escape); assert.equal(view.isOpen, false);
});

class UINode {
  constructor(doc, namespaceURI, text = "") { this.ownerDocument = doc; this.namespaceURI = namespaceURI; this.text = text; this.children = []; this.listeners = {}; this.attributes = {}; this.dataset = {}; this.isConnected = true; this.classList = { add() {}, remove() {}, toggle() {} }; }
  get firstChild() { return this.children[0]; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(""); }
  set textContent(text) { this.text = text; this.children = []; }
  setAttribute(key, value) { this.attributes[key] = value; }
  getAttribute(key) { return this.attributes[key]; }
  removeAttribute(key) { delete this.attributes[key]; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.text = ""; this.children = children; }
  addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
  getBoundingClientRect() { return { top: 0, bottom: 32, height: 32 }; }
  scrollIntoView() { this.scrolled = true; }
}
function uiPopup() {
  const view = popup(), doc = { createElementNS: namespace => new UINode(doc, namespace), createTextNode: text => new UINode(doc, "text", text) };
  view.doc = doc;
  view.input.setAttribute = () => {}; view.input.removeAttribute = () => {};
  for (const key of ["filterSummary", "copyButton", "scopeChip", "modeIcon", "list", "preview", "previewButton", "sourceButton", "advancedButton", "showAll", "save", "hint", "status"]) view[key] = new UINode(doc, "html");
  Object.assign(view.list, { clientHeight: 640, scrollTop: 0 });
  view.expressionAdvanced = view.advancedButton;
  view.preview.hidden = true; view.currentSpec = { text: "" }; view.scopePathRevision = 0; return view;
}
function descendants(node) { return [node, ...node.children.flatMap(descendants)]; }

function collectionPopup(t, { fail } = {}) {
  const previous = globalThis.Zotero;
  globalThis.Zotero = { isMac: false }; t.after(() => { globalThis.Zotero = previous; });
  const view = uiPopup(), writes = [], savedPrefs = new Map();
  view.input.value = 'fault @(Ada) /(Project A) '; view.inputScopes = new InputScopes(view.input.value);
  view.inputScopes.add(view.input.value.indexOf("@")); view.inputScopes.add(view.input.value.indexOf("/"));
  view.filterBindings.set("directory:Project A", { kind: "collection", libraryID: 7, key: "PROJECTA" });
  view.rows = [1, 2].map(itemID => ({ kind: "item", itemID })); view.selected = 1;
  view.rowNodes = view.rows.map(() => new UINode(view.doc, "html")); view.list.append(...view.rowNodes);
  view.picked = new Map(view.rows.map(row => [`item:${row.itemID}`, row])); view.selectionRevision = 3; view.selectionAnchor = 0;
  view.openRevision = view.revision = 1; view.inputShell = { dataset: {} };
  view.root = new UINode(view.doc, "html"); view.root.hidden = false;
  view.body = new UINode(view.doc, "html"); view.dialog = new UINode(view.doc, "html");
  view.win = { clearTimeout() {} }; view.updatePreview = async () => {}; view.resizeToContent = () => {};
  view.app.prefs.set = (key, value) => savedPrefs.set(key, value); view.app.logError = () => {};
  view.app.directoryStart = async () => ({ kind: "collection", libraryID: 7, key: "COREAlpha" });
  const directory = (collectionID, parent, libraryID = 7, kind = "collection") => ({ kind, collectionID, libraryID, key: `CORE${parent}`,
    title: "Core", path: `Library › Project ${parent} › Core`, pathSegments: ["Library", `Project ${parent}`, "Core"], pathKeys: ["u", parent, `CORE${parent}`] });
  view.app.directoryRows = async () => [directory(10, "Alpha"), directory(20, "Beta"), directory(30, "Beta", 7, "search"), directory(40, "Beta", 8)];
  view.app.selectDirectory = () => { assert.fail("Choosing a membership target must not navigate Zotero"); };
  view.app.createCollection = async (rows, _win, current) => {
    if (!current()) return false;
    const target = await view.chooseCollection(7);
    if (!target || !current()) return false;
    if (fail) throw fail;
    writes.push({ rows, target }); return { count: rows.length, name: target.name || "Core" };
  };
  view.notify = (text, error = false) => { view.lastNotification = { text, error }; };
  return { view, writes, savedPrefs };
}

test("collection membership reuses the directory tree and full-path search before restoring the item selection", async t => {
  const { view, writes } = collectionPopup(t), value = view.input.value, picked = view.picked, bindings = view.filterBindings;
  view.feedback = { hidden: false }; view.tooltip = { hidden: false }; view.feedbackTimer = 17;
  const timers = []; view.win.clearTimeout = timer => timers.push(timer);
  const pending = view.createCollection(); await Promise.resolve();
  assert.equal(view.switchMode, "directories"); assert.equal(view.canSelectMany(), false); assert.equal(view.isOpen, true);
  assert.equal(view.feedback.hidden, true); assert.equal(view.tooltip.hidden, true); assert.ok(timers.includes(17));
  view.input.value = "Project Beta Core"; await view.run();
  assert.deepEqual(view.rows.map(row => row.collectionID), [20]);
  assert.ok(descendants(view.list).some(node => node.className?.includes("qs-directory-result")));
  await view.activate(); assert.equal(await pending, true);
  assert.deepEqual(writes, [{ rows: [...picked.values()], target: { collectionID: 20 } }]);
  assert.equal(view.input.value, value); assert.equal(view.picked, picked); assert.equal(view.filterBindings, bindings);
  assert.equal(view.switchMode, undefined); assert.equal(view.mode, "items"); assert.equal(view.isOpen, true);
  assert.equal(view.lastNotification.error, false);
});

test("Escape from the collection picker restores scoped input, caret and advanced conditions without writing", async t => {
  const { view, writes } = collectionPopup(t), value = view.input.value, records = structuredClone(view.inputScopes.records), picked = view.picked;
  view.input.setSelectionRange(1, 3); view.input.readOnly = true;
  const conditions = [{ condition: "title", operator: "contains", value: "fault" }];
  view.advancedSpec = { scope: { type: "library", libraryID: 7 } }; view.nativeConditions = conditions; view.advanced.hidden = false;
  view.watchAdvancedHeight = () => {};
  const pending = view.createCollection(); await Promise.resolve();
  view.input.value = "some folder";
  view.keydown({ key: "Escape", target: view.input, preventDefault() {}, stopPropagation() {} });
  assert.equal(await pending, false); assert.deepEqual(writes, []);
  assert.equal(view.isOpen, true); assert.equal(view.input.value, value); assert.deepEqual(view.inputScopes.records, records);
  assert.deepEqual([view.input.selectionStart, view.input.selectionEnd], [1, 3]); assert.equal(view.picked, picked);
  assert.equal(view.input.readOnly, true); assert.equal(view.advanced.hidden, false); assert.equal(view.nativeConditions, conditions);
});

test("Ctrl/Cmd+Enter creates a collection from the picker input and refuses an empty name", async t => {
  const { view, writes } = collectionPopup(t), value = view.input.value;
  const pending = view.createCollection(); await Promise.resolve();
  const enter = (extra = {}) => ({ key: "Enter", target: view.input, preventDefault() {}, ...extra });
  view.input.value = "   "; view.keydown(enter({ ctrlKey: true }));
  assert.ok(view.collectionPicker); assert.deepEqual(writes, []); assert.match(view.lastNotification.text, /请输入目录名称/u);
  globalThis.Zotero.isMac = true; view.input.value = "  Research folder  "; view.keydown(enter({ metaKey: true }));
  assert.equal(await pending, true); assert.deepEqual(writes[0].target, { name: "Research folder" }); assert.equal(view.input.value, value);
});

test("a failed collection addition returns to the item query with its original selection available to retry", async t => {
  const { view, writes } = collectionPopup(t, { fail: new Error("Write failed") }), value = view.input.value, picked = view.picked;
  const pending = view.createCollection(); await Promise.resolve(); await view.run(); await view.activate();
  assert.equal(await pending, false); assert.deepEqual(writes, []);
  assert.equal(view.input.value, value); assert.equal(view.picked, picked); assert.equal(view.isOpen, true);
  assert.deepEqual(view.lastNotification, { text: "Write failed", error: true }); assert.equal(view.creatingCollection, false);
});

test("closing the collection picker cancels its operation and saves the item query instead of the target search", async t => {
  const { view, writes, savedPrefs } = collectionPopup(t), value = view.input.value;
  const pending = view.createCollection(); await Promise.resolve(); view.input.value = "target search";
  Launcher.prototype.hide.call(view);
  assert.equal(await pending, false); assert.deepEqual(writes, []); assert.equal(view.isOpen, false);
  assert.equal(savedPrefs.get("lastQuery"), value); assert.equal(view.collectionPicker, null);
});

test("year, author and path hovers stay silent while toolbar descriptions remain available", () => {
  const view = uiPopup(), row = { kind: "item", title: "Fault transfer", year: "2024", authors: "Ada",
    creatorDetails: [{ name: "Ada", start: 0, end: 3 }],
    evidence: [{ field: "date", ranges: [{ start: 0, end: 4 }] }, { field: "creator", ranges: [{ start: 0, end: 3 }] }] };
  view.rows = [row]; view.select = () => {}; view.resizeToContent = () => {}; view.renderRows(0);
  const title = descendants(view.list).find(node => node.className === "qs-result-title");
  assert.equal(title.getAttribute("title"), undefined, "The year must not inherit the item title tooltip");
  assert.equal(descendants(title).find(node => node.className === "qs-title-text").getAttribute("title"), row.title);
  assert.equal(descendants(view.list).find(node => node.className === "qs-result-authors").getAttribute("title"), undefined);
  const paths = new UINode(view.doc, "html");
  view.renderLocations(paths, row, { status: "ready", locations: [
    { libraryID: 7, collectionID: 1, pathSegments: ["Library", "Core"], pathKeys: ["u", "core"], path: "Library › Core" },
  ] });
  const unfiled = new UINode(view.doc, "html");
  view.renderLocations(unfiled, row, { status: "ready", locations: [], libraryID: 7, libraryName: "Library" });
  view.tooltip = new UINode(view.doc, "html"); view.tooltip.style = {};
  view.tooltip.getBoundingClientRect = () => ({ width: 120, height: 20 }); view.win = { innerWidth: 1200, innerHeight: 800 };
  const controls = [...descendants(view.list), ...descendants(paths), ...descendants(unfiled)]
    .filter(node => ["author", "year", "directory"].includes(node.getAttribute("data-qs-filter")));
  assert.equal(controls.length, 5);
  for (const control of controls) {
    assert.equal(control.getAttribute("title"), undefined); assert.ok(control.getAttribute("aria-label"));
    for (const target of [control, control.firstChild]) {
      target.closest = () => control; view.tooltip.hidden = false;
      view.showTooltip(target); assert.equal(view.tooltip.hidden, true);
    }
  }
  const toolbar = new UINode(view.doc, "html"); toolbar.setAttribute("aria-label", "Copy references"); toolbar.closest = () => toolbar;
  toolbar.getBoundingClientRect = () => ({ left: 120, width: 40, top: 40, bottom: 60 });
  view.showTooltip(toolbar); assert.equal(view.tooltip.hidden, false); assert.equal(view.tooltip.textContent, "Copy references");
});

test("multi-selection supports ranges and all matching IDs beyond the rendered page", () => {
  const view = uiPopup(); view.rows = [{ kind: "item", itemID: 1 }, { kind: "item", itemID: 2 }, { kind: "item", itemID: 3 }];
  view.itemIDs = [1, 2, 3, 4, 5]; view.picked = new Map(); view.rowNodes = view.rows.map(() => new UINode(view.doc, "html"));
  view.toggleSelection(0); view.selectRange(2); assert.deepEqual(view.chosenRows().map(row => row.itemID), [1, 2, 3]);
  view.selectAllResults(); assert.deepEqual(view.chosenRows().map(row => row.itemID), [1, 2, 3, 4, 5]);
  view.clearSelection(); assert.equal(view.picked.size, 0); assert.deepEqual(view.chosenRows().map(row => row.itemID), [3]);
});

test("switcher select-all includes unloaded directory and outline matches", () => {
  for (const mode of ["directories", "outline"]) {
    const view = uiPopup(); view.mode = view.switchMode = mode; view.picked = new Map(); view.rowNodes = [];
    const all = mode === "directories" ? [1, 2, 3, 4].map(number => ({ kind: "collection", key: String(number), libraryID: 7 }))
      : [1, 2, 3, 4].map(number => ({ kind: "outline", attachmentID: 9, outlineKey: String(number) }));
    view.rows = all.slice(0, 2);
    if (mode === "outline") view.outlineProgress = { rows: all }; else view.pickerRows = all;
    view.selectAllResults(); assert.deepEqual(view.chosenRows(), all);
  }
});

test("the combined selection button changes partial selection to all IDs, then clears", () => {
  const view = uiPopup(); view.rows = [1, 2].map(itemID => ({ kind: "item", itemID }));
  view.itemIDs = [1, 2, 3, 4]; view.selected = 1; view.rowNodes = [];
  view.picked = new Map([["item:1", view.rows[0]]]); view.selectAllButton = new UINode(view.doc, "html");
  assert.equal(view.allResultsSelected(), false);
  view.toggleAllResults();
  assert.deepEqual([...view.picked.keys()], ["item:1", "item:2", "item:3", "item:4"]);
  assert.equal(view.picked.get("item:1"), view.rows[0]);
  assert.deepEqual(view.picked.get("item:4"), { kind: "item", itemID: 4 });
  assert.equal(view.allResultsSelected(), true); assert.equal(view.selectAllButton.getAttribute("aria-pressed"), "true");
  view.picked.delete("item:4"); view.picked.set("item:99", { kind: "item", itemID: 99 });
  assert.equal(view.allResultsSelected(), false);
  view.toggleAllResults(); assert.equal(view.picked.has("item:4"), true); assert.equal(view.picked.has("item:99"), false);
  view.toggleAllResults();
  assert.equal(view.picked.size, 0); assert.equal(view.allResultsSelected(), false);
  assert.equal(view.selectionAnchor, 1); assert.equal(view.selectAllButton.getAttribute("aria-pressed"), "false");
  assert.deepEqual(view.chosenRows(), [view.rows[1]]);
});

test("combined switcher selection uses complete outline and tab identities, ignoring duplicate rows", () => {
  const firstReader = {}, secondReader = {};
  const cases = {
    outline: [
      { kind: "outline", attachmentID: 9, outlineKey: "chapter" },
      { kind: "outline", attachmentID: 10, outlineKey: "chapter" },
      { kind: "outline", attachmentID: 9, outlineKey: "section" },
    ],
    tabs: [
      { kind: "tab", itemID: 9, tabID: "tab-a" },
      { kind: "tab", itemID: 9, tabID: "tab-b" },
      { kind: "reader", itemID: 9, reader: firstReader },
      { kind: "reader", itemID: 9, reader: secondReader },
    ],
  };
  for (const [mode, unique] of Object.entries(cases)) {
    const view = uiPopup(); view.mode = view.switchMode = mode; view.rowNodes = []; view.picked = new Map();
    view.rows = unique.slice(0, 1); const all = [...unique, { ...unique[0] }];
    if (mode === "outline") view.outlineProgress = { rows: all }; else view.pickerRows = all;
    view.toggleAllResults();
    assert.equal(view.picked.size, unique.length); assert.equal(view.allResultsSelected(), true);
    assert.ok(unique.every(row => view.chosenRows().some(chosen => mode === "outline"
      ? chosen.attachmentID === row.attachmentID && chosen.outlineKey === row.outlineKey
      : row.reader ? chosen.reader === row.reader : chosen.tabID === row.tabID)));
    view.picked.delete([...view.picked.keys()][0]); assert.equal(view.allResultsSelected(), false);
    view.toggleAllResults(); assert.equal(view.allResultsSelected(), true);
    view.toggleAllResults(); assert.equal(view.picked.size, 0); assert.equal(view.allResultsSelected(), false);
  }
});

test("the combined selection button stays disabled and unpressed for empty results", () => {
  const view = uiPopup(); view.rows = []; view.itemIDs = []; view.rowNodes = []; view.picked = new Map();
  view.selectAllButton = new UINode(view.doc, "html");
  view.toggleAllResults();
  assert.equal(view.picked.size, 0); assert.equal(view.allResultsSelected(), false);
  assert.equal(view.selectAllButton.disabled, true); assert.equal(view.selectAllButton.getAttribute("aria-pressed"), "false");
});

test("empty picker caches use the visible rows for both select-all and deselect-all", () => {
  for (const mode of ["directories", "outline", "tabs"]) {
    const view = uiPopup(); view.mode = view.switchMode = mode; view.rowNodes = []; view.picked = new Map(); view.pickerRows = [];
    view.rows = mode === "directories" ? [{ kind: "collection", libraryID: 7, key: "CORE" }]
      : mode === "outline" ? [{ kind: "outline", attachmentID: 9, outlineKey: "chapter" }]
        : [{ kind: "tab", itemID: 9, tabID: "tab-a" }];
    if (mode === "outline") view.outlineProgress = { rows: [] };
    view.toggleAllResults(); assert.deepEqual(view.chosenRows(), view.rows); assert.equal(view.allResultsSelected(), true, mode);
    view.toggleAllResults(); assert.equal(view.picked.size, 0, mode); assert.equal(view.allResultsSelected(), false, mode);
  }
});

test("result years and selection checkboxes share the title tail in that order", () => {
  const view = uiPopup(); view.rows = [{ kind: "item", title: "A title", year: "2020" }]; view.rowNodes = []; view.picked = new Map();
  view.resizeToContent = () => {}; view.select = index => { view.selected = index; };
  view.renderRows(0);
  const row = view.rowNodes[0], nodes = descendants(row);
  for (const node of nodes) node.querySelector = selector => {
    let current = node;
    for (const part of selector.replace(/^:scope > /, "").split(" > ")) {
      current = current?.children.find(child => child.className?.split(" ").includes(part.slice(1)));
    }
    return current;
  };
  const tail = nodes.find(node => node.className === "qs-result-tail");
  const year = nodes.find(node => node.className?.split(" ").includes("qs-result-year"));
  assert.ok(tail); assert.ok(year); assert.deepEqual(tail.children, [year]);
  view.updateSelection(); view.updateSelection();
  assert.equal(tail.children[0], year); assert.equal(tail.children[1].className, "qs-result-check");
  assert.equal(tail.children.length, 2); assert.equal(nodes.filter(node => node.className?.split(" ").includes("qs-result-year")).length, 1);
  let filter; view.useFilter = (type, value) => { filter = { type, value }; };
  year.listeners.click[0]({ stopPropagation() {} }); assert.equal(filter.type, "year"); assert.equal(filter.value.key, "2020");
});

test("a partly located batch keeps omitted items for retry instead of closing", async () => {
  const view = uiPopup(); view.rows = [1, 2, 3].map(itemID => ({ kind: "item", itemID })); view.rowNodes = []; view.selected = 0;
  view.picked = new Map(view.rows.map(row => ["item:" + row.itemID, row]));
  view.app.locateItems = async rows => ({ count: 1, failed: rows.slice(1) });
  await view.activate({ locate: true });
  assert.equal(view.isOpen, true); assert.deepEqual(view.chosenRows().map(row => row.itemID), [2, 3]);
  view.app.locateItems = async rows => ({ count: rows.length, failed: [] });
  await view.activate({ locate: true }); assert.equal(view.isOpen, false);
});

test("late CSL defaults cannot overwrite a reopened session or a manual style", async () => {
  const view = uiPopup(); view.doc.createXULElement = name => new UINode(view.doc, name);
  view.styleMenu = new UINode(view.doc, "menulist"); view.openRevision = 1; view.sourceApp = { name: "powerpnt.exe" };
  let release;
  view.app.clipboard = { styles: async () => [{ styleID: "ppt", title: "Slides" }, { styleID: "word", title: "Paper" }],
    styleForApp: app => app.name === "powerpnt.exe" ? new Promise(resolve => { release = resolve; }) : Promise.resolve("word") };
  const old = view.refreshStyles(); await Promise.resolve();
  view.openRevision++; view.sourceApp = { name: "winword.exe" }; await view.refreshStyles();
  assert.equal(view.styleMenu.value, "word"); release("ppt"); await old; assert.equal(view.styleMenu.value, "word");
  view.sourceApp = { name: "powerpnt.exe" }; const pending = view.refreshStyles(); await Promise.resolve();
  view.manualStyleID = "word"; view.styleMenu.value = "word"; release("ppt"); await pending; assert.equal(view.styleMenu.value, "word");
});

test("copying resolves the active app default rather than treating an old menu value as an override", async () => {
  const view = uiPopup(); view.rows = [{ itemID: 1 }]; view.selected = 0; view.styleMenu = { value: "old" }; view.sourceApp = { name: "winword.exe" };
  let options;
  view.app.clipboard = { copy: async (_kind, _rows, value) => { options = value; return { count: 1, failed: [] }; } };
  await view.copySelection("citation"); assert.equal(options.styleID, undefined); assert.equal(options.app, view.sourceApp);
  view.manualStyleID = "selected"; await view.copySelection("citation"); assert.equal(options.styleID, "selected");
});

test("a missing default CSL leaves installed styles available for explicit recovery", async () => {
  const view = uiPopup(); view.doc.createXULElement = name => new UINode(view.doc, name);
  view.styleMenu = new UINode(view.doc, "menulist"); view.openRevision = 1;
  view.app.clipboard = { styles: async () => [{ styleID: "available", title: "Installed" }], styleForApp: async () => { throw new Error("Missing configured CSL"); } };
  await view.refreshStyles(); assert.equal(view.styleMenu.firstChild.children[0].getAttribute("value"), "available");
  assert.equal(view.styleMenu.value, ""); assert.equal(view.lastMessage, "Missing configured CSL");
  view.manualStyleID = "available"; await view.refreshStyles(); assert.equal(view.styleMenu.value, "available");
});

test("a batch continues after an item fails and retains only that item for retry", async () => {
  const view = uiPopup(); view.rows = [1, 2, 3].map(itemID => ({ kind: "item", itemID })); view.rowNodes = []; view.selected = 0;
  view.picked = new Map(view.rows.map(row => ["item:" + row.itemID, row])); let calls = [];
  view.app.openPDFWindow = async row => { calls.push(row.itemID); if (row.itemID === 2) throw new Error("Missing PDF"); return true; };
  await view.activate({ shifted: true }); assert.deepEqual(calls, [1, 2, 3]); assert.equal(view.isOpen, true);
  assert.deepEqual(view.chosenRows().map(row => row.itemID), [2]);
  view.app.openPDFWindow = async row => { calls.push(row.itemID); return true; };
  await view.activate({ shifted: true }); assert.equal(calls.at(-1), 2); assert.equal(view.isOpen, false);
});

test("a pending batch stops when its query or selection changes and leaves the new query open", async () => {
  for (const change of ["query", "selection"]) {
    const view = uiPopup(); view.openRevision = 1;
    view.rows = [1, 2].map(itemID => ({ kind: "item", itemID })); view.selected = 0; view.picked = new Map(view.rows.map(row => ["item:" + row.itemID, row]));
    let release; const calls = [];
    view.app.openPDFWindow = row => { calls.push(row.itemID); return new Promise(resolve => { release = resolve; }); };
    const pending = view.activate({ shifted: true });
    if (change === "query") view.input.value = "a different query";
    else view.toggleSelection(1);
    release(true); await pending;
    assert.deepEqual(calls, [1]); assert.equal(view.isOpen, true); assert.equal(view.actionRunning, false);
    if (change === "selection") assert.deepEqual(view.chosenRows().map(row => row.itemID), [1]);
  }
});

test("late copy failure cannot replace a new query or a user's changed selection", async () => {
  for (const change of ["query", "selection"]) {
    const view = uiPopup(); view.openRevision = 1;
    view.rows = [1, 2].map(itemID => ({ kind: "item", itemID })); view.selected = 0; view.picked = new Map(view.rows.map(row => ["item:" + row.itemID, row]));
    let release; view.app.clipboard = { copy: () => new Promise(resolve => { release = resolve; }) };
    const pending = view.copySelection("pdf");
    if (change === "query") {
      view.input.value = "new"; view.rows = [{ kind: "item", itemID: 9 }]; view.picked = new Map([["item:9", view.rows[0]]]);
    } else view.toggleSelection(1);
    release({ count: 1, failed: [{ kind: "item", itemID: 2 }] }); assert.equal(await pending, true);
    assert.deepEqual(view.chosenRows().map(row => row.itemID), [change === "query" ? 9 : 1]); assert.equal(view.isOpen, true);
  }
});

test("pending actions distinguish separate readers and equally sized replacement selections", () => {
  const view = uiPopup(); view.openRevision = 1; view.switchMode = view.mode = "tabs";
  view.rows = [{ kind: "reader", reader: {}, itemID: 1 }, { kind: "reader", reader: {}, itemID: 1 }]; view.selected = 0;
  const readerCurrent = view.actionCurrent(); view.select(1, false); assert.equal(readerCurrent(), false);
  view.switchMode = null; view.mode = "items"; view.rows = [1, 2, 3].map(itemID => ({ kind: "item", itemID }));
  view.toggleSelection(0); view.toggleSelection(1); const batchCurrent = view.actionCurrent();
  view.toggleSelection(0); view.toggleSelection(2); assert.equal(view.picked.size, 2); assert.equal(batchCurrent(), false);
});

test("a refreshed result set resets the previous range-selection anchor", async () => {
  const view = uiPopup(), previous = globalThis.Zotero;
  globalThis.Zotero = { Libraries: { get: () => ({ name: "Library" }) } };
  view.input.value = "first"; view.revision = 1;
  view.app.search = { prepare: async spec => spec, search: async () => ({ results: [1, 2, 3].map(itemID => ({ kind: "item", itemID })), total: 3 }) };
  view.app.prefs.get = key => key === "limit" ? 20 : key === "defaultScope" ? "library" : undefined;
  view.renderRows = () => {}; view.renderFilterSummary = () => {};
  view.rowNodes = []; view.save = {}; view.status = {};
  try {
    await view.run(); view.toggleSelection(2); assert.equal(view.selectionAnchor, 2);
    view.input.value = "next"; view.revision++; await view.run();
    assert.equal(view.selectionAnchor, null); assert.equal(view.selected, 0);
    view.selectRange(1); assert.deepEqual(view.chosenRows().map(row => row.itemID), [1, 2]);
  } finally { globalThis.Zotero = previous; }
});

test("an explicit launch application remains the CSL source after the worker sees another app", () => {
  const view = uiPopup(), captured = { name: "winword.exe" };
  view.app.hotkey = { sourceApp: { name: "powerpnt.exe" } };
  view.doc.getElementById = () => ({ href: "" }); view.doc.querySelectorAll = () => [];
  view.dialog = { style: { setProperty() {} } }; view.win = { innerWidth: 1400, innerHeight: 900 };
  view.sources.querySelectorAll = () => []; view.input.select = () => {};
  view.setMode = () => {}; view.refreshStyles = () => {};
  view.show("items", false, captured); assert.equal(view.sourceApp, captured);
  view.show("items"); assert.equal(view.sourceApp.name, "powerpnt.exe");
});

test("copy shortcuts preserve a selected query while citation and bibliography copy chosen items", () => {
  const view = uiPopup(); view.input.value = "fault"; view.input.setSelectionRange(0, 5); view.picked = new Map();
  const copied = []; view.copySelection = kind => copied.push(kind);
  const event = (key, extra = {}) => ({ key, target: view.input, ctrlKey: true, preventDefault() { this.prevented = true; }, stopPropagation() {}, ...extra });
  const queryCopy = event("c"); view.keydown(queryCopy); assert.equal(queryCopy.prevented, undefined); assert.deepEqual(copied, []);
  view.input.setSelectionRange(5, 5); view.keydown(event("c")); view.keydown(event("A", { shiftKey: true })); view.keydown(event("C", { shiftKey: true }));
  assert.deepEqual(copied, ["pdf", "citation", "bibliography"]);
  const oldBibliography = event("B", { shiftKey: true }); view.keydown(oldBibliography);
  assert.equal(oldBibliography.prevented, undefined); assert.equal(copied.length, 3, "the old bibliography chord is no longer registered");
  const composition = event("c", { isComposing: true }); view.keydown(composition); assert.equal(copied.length, 3);
});

test("Ctrl/Cmd+A selects query text before result selection, including protected field scopes", () => {
  const previous = globalThis.Zotero;
  try {
    for (const isMac of [false, true]) {
      globalThis.Zotero = { isMac };
      const view = uiPopup(); view.input.value = "@(Alice) fault"; view.rows = [{ kind: "item", itemID: 1 }];
      view.selectAllResults = () => { throw new Error("Query focus must not select results"); };
      view.keydown({ key: "a", target: view.input, ctrlKey: !isMac, metaKey: isMac, preventDefault() {} });
      assert.equal(view.input.selectionStart, 0); assert.equal(view.input.selectionEnd, view.input.value.length);
      view.inputScopes = new InputScopes(view.input.value); view.inputScopes.add(0);
      assert.equal(view.inputScopes.guard("deleteContentBackward", 0, view.input.value.length).value, "");
    }
  } finally { globalThis.Zotero = previous; }
});

test("clipboard drafts accept Enter and Space, while other keys discard the entire suggestion", () => {
  for (const key of ["Enter", " ", "x", "ArrowDown", "Control", "Backspace"]) {
    const view = uiPopup(); view.input.value = "fault"; view.clipboardDraft = true;
    view.inputShell = { dataset: { clipboardDraft: "true" } }; view.inputScopes = new InputScopes(view.input.value);
    view.enterActions = () => null;
    let activated = false; view.activate = () => { activated = true; };
    const event = { key, target: view.input, preventDefault() { this.prevented = true; }, stopPropagation() {} };
    view.keydown(event);
    assert.equal(view.clipboardDraft, false); assert.equal(view.inputShell.dataset.clipboardDraft, undefined);
    assert.equal(view.input.value, ["Enter", " "].includes(key) ? "fault" : "");
    assert.equal(activated, key === "Enter");
    if (key === " ") assert.equal(view.input.selectionEnd, 5);
    if (key === "ArrowDown") assert.equal(event.prevented, true);
  }
});

test("macOS Command copy chords use the native citation and bibliography keys", () => {
  const view = uiPopup(), previous = globalThis.Zotero, copied = [];
  globalThis.Zotero = { isMac: true }; view.picked = new Map(); view.copySelection = kind => copied.push(kind);
  try {
    for (const [key, shiftKey] of [["c", false], ["A", true], ["C", true]]) {
      const event = { key, shiftKey, metaKey: true, ctrlKey: false, target: view.input, preventDefault() { this.prevented = true; } };
      view.keydown(event); assert.equal(event.prevented, true);
    }
    assert.deepEqual(copied, ["pdf", "citation", "bibliography"]);
  } finally { globalThis.Zotero = previous; }
});

test("an unfinished preview does not block the next query or determine its page size", async () => {
  const view = uiPopup(), previousZotero = globalThis.Zotero; let release, previews = 0;
  globalThis.Zotero = { Libraries: { get: () => ({ name: "Library" }) } };
  view.input.value = "@First"; view.preview.hidden = false; view.rowNodes = []; view.revision = 0;
  view.app.prefs.get = key => key === "limit" ? 5 : key === "defaultScope" ? "library" : undefined;
  view.app.search = { authorRows: async pattern => Array.from({ length: 25 }, (_, index) => ({ kind: "author", key: pattern + index, title: pattern + index, records: [{ libraryID: 7 }] })) };
  view.renderRows = () => view.select(0, false); view.renderFilterSummary = () => {};
  view.updatePreview = () => { previews++; return new Promise(resolve => { release = resolve; }); };
  try {
    await view.run(); assert.equal(view.running, false); assert.equal(previews, 1); assert.equal(view.rows.length, 20);
    view.input.value = "@Next"; view.revision++; await view.run(); assert.match(view.rows[0].title, /^Next/u); assert.equal(previews, 2);
    view.list.clientHeight = 256; view.input.value = "@Third"; view.revision++; await view.run(); assert.equal(view.rows.length, 8); assert.equal(view.pickerVisible, 8);
  } finally { release?.(); globalThis.Zotero = previousZotero; }
});

function outlinePopup(rows, { grouped = false, allRows = rows } = {}) {
  const view = uiPopup(); view.inputMode = view.mode = "outline";
  view.outlineContext = { type: grouped ? "all" : "pdf" };
  view.outlineTree = buildOutlineTree(rows, { groupDocuments: grouped, allRows });
  view.rows = rows; view.selected = 0; view.revision = 1;
  return view;
}
const outlineRows = () => [
  { kind: "outline", attachmentID: 1, itemID: 10, outlineKey: "0", parentKey: null, title: "Introduction", parents: [], depth: 0, documentTitle: "Paper", location: { pageIndex: 0 }, pageIndex: 0 },
  { kind: "outline", attachmentID: 1, itemID: 10, outlineKey: "0.0", parentKey: "0", title: "Methods", parents: ["Introduction"], depth: 1, documentTitle: "Paper", location: { pageIndex: 1 }, pageIndex: 1 },
];

test("outline UI nests all real children without adding expansion controls", () => {
  const view = outlinePopup(outlineRows()); view.renderOutlineRows(1);
  assert.equal(view.rows.length, 2); assert.equal(view.outlineButton, undefined); assert.equal(view.toggleOutline, undefined);
  assert.equal(view.rowNodes[0].getAttribute("aria-level"), "1"); assert.equal(view.rowNodes[1].getAttribute("aria-level"), "2");
  assert.equal(view.rowNodes[0].getAttribute("aria-expanded"), "true");
  assert.ok(descendants(view.rowNodes[0]).includes(view.rowNodes[1]));
});

test("document groups keep hierarchy and targetless structural rows do not navigate", async () => {
  const view = outlinePopup(outlineRows(), { grouped: true }); view.renderOutlineRows(1);
  assert.equal(view.rows[0].isDocument, true); assert.equal(view.rows[0].outlineKey, "document");
  assert.equal(view.rows.length, 3); assert.equal(view.rowNodes[2].getAttribute("aria-level"), "3");
  view.select(0, false); await view.activate(); assert.equal(view.rows.length, 3); assert.equal(view.isOpen, true);
  const selected = view.rows[0]; view.rows = outlineRows(); view.selected = 0; view.renderRows(2, selected);
  assert.equal(view.rows[view.selected].isDocument, true);
});

test("filtered headings retain real ancestors and arrow keys keep ordinary editing", () => {
  const rows = [...outlineRows(), { ...outlineRows()[1], outlineKey: "0.0.0", parentKey: "0.0", title: "Details", parents: ["Introduction", "Methods"], depth: 2 }];
  const view = outlinePopup([rows[2]], { allRows: rows }); view.input.value = "Details"; view.renderOutlineRows(1);
  assert.equal(view.rows.length, 3); assert.equal(view.rows[view.selected].title, "Details");
  assert.equal(view.rowNodes[2].getAttribute("aria-level"), "3");
  view.outlineProgress = { total: 1, pending: false }; view.updateOutlineStatus(); assert.equal(view.lastMessage, "当前 PDF 大纲 · 1 个匹配");
  const event = { key: "ArrowRight", target: view.input, preventDefault() { this.prevented = true; }, stopPropagation() {} };
  view.keydown(event); assert.equal(event.prevented, undefined);
  const alt = { ...event, altKey: true }; view.keydown(alt); assert.equal(alt.prevented, undefined); assert.equal(view.rows.length, 3);
});

test("outline switch filtering hides inherited descendants and skips context rows in navigation and ranges", async () => {
  const rows = [
    ...outlineRows(),
    { ...outlineRows()[1], outlineKey: "0.0.0", parentKey: "0.0", title: "Details", depth: 2, parents: ["Introduction", "Methods"] },
    { ...outlineRows()[1], outlineKey: "1", parentKey: null, title: "Other", depth: 0, parents: [] },
    { ...outlineRows()[1], outlineKey: "1.0", parentKey: "1", title: "Methods again", depth: 1, parents: ["Other"] },
  ];
  const view = outlinePopup(rows); view.switchMode = "outline"; view.input.value = "Methods";
  view.app.outline = { search: async () => ({ rows, allRows: rows, total: rows.length, pending: false }) };
  await view.run();
  assert.deepEqual(view.rows.map(row => row.title), ["Introduction", "Methods", "Other", "Methods again"]);
  assert.deepEqual(view.rows.map(row => !!row.contextOnly), [true, false, true, false]);
  assert.equal(view.rowNodes[0].getAttribute("aria-disabled"), "true");
  assert.equal(view.rows[view.selected].title, "Methods");
  view.list.clientHeight = 32;
  const key = (key, extra = {}) => view.keydown({ key, target: view.input, preventDefault() {}, ...extra });
  key("ArrowDown", { shiftKey: true }); assert.equal(view.rows[view.selected].title, "Methods again");
  assert.deepEqual(view.chosenRows().map(row => row.title), ["Methods", "Methods again"]);
  key("ArrowUp"); assert.equal(view.rows[view.selected].title, "Methods");
  key("PageDown"); assert.equal(view.rows[view.selected].title, "Methods again");
  key("PageUp"); assert.equal(view.rows[view.selected].title, "Methods");
  view.select(0); view.toggleSelection(0); assert.equal(view.selected, 1); assert.equal(view.picked.has("outline:1:0"), false);
});

test("outline switch auto-reveal loads the current heading and scrolls only its title in segments", async () => {
  const { view, rows } = pagingPopup({ count: 12 }); view.switchMode = "outline";
  view.outlineContext.reader = { _internalReader: { _state: { primary: true, primaryViewStats: { pageIndex: 2, outlinePath: [10] } } } };
  await view.run();
  assert.equal(view.rows[view.selected].outlineKey, "10"); assert.ok(view.outlineVisible >= 11);
  const title = new UINode(view.doc, "html"); title.scrollIntoView = () => { throw new Error("Native scrolling must not precede segmented scrolling"); };
  Object.assign(view.list, { clientHeight: 200, clientTop: 0, scrollHeight: 2000, scrollTop: 0 });
  title.getBoundingClientRect = () => ({ top: 800 - view.list.scrollTop, bottom: 832 - view.list.scrollTop });
  view.rowNodes[view.selected].querySelector = () => title;
  view.select(view.selected); assert.equal(view.list.scrollTop, 800);
  view.select(view.selected); assert.equal(view.list.scrollTop, 800);
  view.select(3, false); view.revision++; await view.run(); assert.equal(view.selected, 3);
  view.input.value = "Heading 12"; view.revision++; await view.run(); assert.equal(view.rows[view.selected].title, rows[11].title);
  view.input.value = ""; view.revision++; await view.run(); assert.equal(view.rows[view.selected].outlineKey, "10");
});

test("outline metadata selections stay in the current PDF and render portable and local expressions", () => {
  const view = uiPopup(); view.inputMode = view.mode = "outline"; view.input.value = "Methods";
  view.outlineContext = { type: "pdf", attachmentID: 15, title: "Current paper" };
  const previous = globalThis.Zotero; globalThis.Zotero = { Items: { get: () => ({ libraryID: 7 }) } };
  try {
    view.useFilter("year", { kind: "year", key: "2024", title: "2024", field: "year" });
    assert.equal(view.inputMode, "outline"); assert.equal(view.spec().outlineScope.attachmentID, 15); assert.equal(view.spec().text, "Methods");
    assert.equal(view.spec().filters[0].value, "2024");
    view.useFilter("author", { kind: "author", key: "roe", title: "A. Roe" });
    assert.equal(view.spec().filters.length, 2); view.renderFilterSummary();
    assert.ok(view.expression.text.includes("ZOTERO_OUTLINE_TEXT=(Methods)")); assert.ok(view.expression.text.includes("AU=")); assert.ok(view.expression.text.includes("PY=(2024)"));
    const scopeChip = descendants(view.filterSummary).find(node => node.text?.startsWith("PDF ·"));
    assert.equal(scopeChip.text, 'PDF · Current paper'); assert.ok(descendants(view.filterSummary).some(node => node.attributes?.title?.includes("Current paper")));
    assert.ok(!view.expression.copyText.includes("ZOTERO") && !view.expression.copyText.includes("Methods"));
    view.removeFilter(view.query().filters[1]); assert.equal(view.inputMode, "outline"); assert.equal(view.spec().filters.length, 1);
  } finally { globalThis.Zotero = previous; }
});

test("outline progress keeps unchanged DOM and selection and does not reload the preview", async () => {
  const view = uiPopup(), rows = outlineRows();
  view.inputMode = view.mode = "outline"; view.outlineContext = { type: "all" }; view.input.value = "Methods"; view.revision = 1;
  view.app.outline = { search: async () => ({ rows: [rows[1]], allRows: rows, total: 1, completed: 1, documents: 1, pending: false }) };
  let previews = 0; view.updatePreview = async () => { previews++; };
  await view.run(); const root = view.rowNodes[0], displayedRows = view.rows, selected = view.selected, before = previews;
  view.revision++; await view.run();
  assert.equal(view.rowNodes[0], root); assert.equal(view.rows, displayedRows); assert.equal(view.selected, selected); assert.equal(previews, before);
});

function pagingPopup({ grouped = false, count = 24 } = {}) {
  const view = uiPopup(), rows = Array.from({ length: count }, (_, index) => ({ kind: "outline", itemID: index < 12 ? 10 : 20,
    attachmentID: index < 12 ? 1 : 2, outlineKey: String(index < 12 ? index : index - 12), parentKey: null, depth: 0, parents: [], title: `Heading ${index + 1}`,
    pageIndex: index % 3, location: { pageIndex: index % 3 }, documentTitle: index < 12 ? "A" : "B" }));
  view.inputMode = view.mode = "outline"; view.outlineContext = { type: grouped ? "all" : "pdf", attachmentID: 1 }; view.revision = 1;
  view.list.clientHeight = 160; view.app.prefs.get = name => name === "defaultScope" ? "all" : undefined;
  let calls = 0;
  view.app.outline = { search: async () => { calls++; return { rows, allRows: rows, total: rows.length, pending: false }; } };
  view.app.makeSpec = (_, spec) => spec; view.spec = () => ({ text: view.input.value, rawText: view.input.value, scope: { type: "all" } });
  view.searchCalls = () => calls; return { view, rows };
}

test("opening a long outline fills the viewport and growing it preserves selection without another search", async () => {
  const { view } = pagingPopup({ count: 40 }); view.switchMode = "outline";
  view.outlineContext.reader = { _internalReader: { _state: { primaryViewStats: { outlinePath: [3] } } } };
  view.list.clientHeight = 700;
  Object.defineProperty(view.list, "scrollHeight", { get: () => Math.max(view.list.clientHeight,
    view.rowNodes.reduce((height, node, index) => height + (index % 3 ? 32 : 60), 0)) });
  await view.run();
  const first = view.outlineVisible;
  assert.ok(first < 40 && view.list.scrollHeight >= view.list.clientHeight);
  assert.equal(view.rows[view.selected].outlineKey, "3"); assert.equal(view.searchCalls(), 1);
  assert.equal(view.lastMessage, `当前 PDF 大纲 · ${first}/40 个匹配`);
  view.select(7, false); view.list.scrollTop = 64;
  const selected = view.rows[view.selected]; view.toggleSelection();
  view.list.clientHeight = 1000; view.fillViewport();
  assert.ok(view.outlineVisible > first && view.list.scrollHeight > view.list.clientHeight);
  assert.equal(view.rows[view.selected].outlineKey, selected.outlineKey); assert.equal(view.list.scrollTop, 64);
  assert.deepEqual(view.chosenRows().map(row => row.outlineKey), [selected.outlineKey]); assert.equal(view.searchCalls(), 1);
});

test("outline viewport filling stops for complete, already full, hidden and composing lists", async () => {
  for (const options of [{ count: 3, height: 700 }, { count: 40, height: 100 }, { count: 40, height: 0 }, { count: 40, height: 700, composing: true }]) {
    const { view } = pagingPopup({ count: options.count });
    await view.run(); view.list.clientHeight = options.height; view.composing = !!options.composing;
    Object.defineProperty(view.list, "scrollHeight", { get: () => Math.max(view.list.clientHeight, view.rowNodes.length * 32) });
    view.fillViewport();
    assert.equal(view.rows.length, Math.min(5, options.count)); assert.equal(view.searchCalls(), 1);
  }
});

test("outline pagination reaches every cached match without another search and preserves the selected item and scroll", async () => {
  const { view } = pagingPopup(); await view.run();
  assert.equal(view.rows.length, 5); assert.equal(view.lastMessage, "当前 PDF 大纲 · 5/24 个匹配");
  view.selected = 4; view.list.scrollTop = 92; const selected = view.rows[4], signature = view.resultSignature;
  let previews = 0; view.preview.hidden = false; view.updatePreview = () => { previews++; };
  assert.equal(view.moreOutline(), true); assert.equal(view.rows.length, 10); assert.equal(view.rows[view.selected].outlineKey, selected.outlineKey);
  assert.equal(view.list.scrollTop, 92); assert.equal(previews, 0); assert.equal(view.resultSignature, signature);
  while (view.moreOutline()) {}
  assert.equal(view.rows.length, 24); assert.equal(view.moreOutline(), false); assert.equal(view.searchCalls(), 1);
  assert.equal(view.lastMessage, "当前 PDF 大纲 · 24 个匹配");
});

test("ArrowDown and PageDown load the next outline batch and PageUp retains previously loaded headings", async () => {
  const { view } = pagingPopup(); await view.run(); view.selected = 4; view.list.clientHeight = 160;
  const event = key => ({ key, target: view.input, preventDefault() { this.prevented = true; } });
  const down = event("ArrowDown"); view.keydown(down); assert.equal(down.prevented, true); assert.equal(view.rows.length, 10); assert.equal(view.rows[view.selected].title, "Heading 6");
  view.selected = 9; view.keydown(event("PageDown")); assert.equal(view.rows.length, 15); assert.equal(view.rows[view.selected].title, "Heading 15");
  view.keydown(event("PageUp")); assert.equal(view.rows.length, 15); assert.equal(view.rows[view.selected].title, "Heading 10");
  view.composing = true; view.selected = 14; view.keydown(event("ArrowDown")); assert.equal(view.rows.length, 15); assert.equal(view.moreOutline(), false);
});

test("expanded global batches survive progress refresh and new query resets paging without losing document identities", async () => {
  const { view } = pagingPopup({ grouped: true }); await view.run();
  assert.equal(view.rows.filter(row => !row.isDocument).length, 5);
  view.moreOutline(); view.moreOutline();
  assert.equal(view.rows.filter(row => !row.isDocument).length, 15); assert.equal(view.rows.filter(row => row.isDocument).length, 2);
  const target = view.rows.findIndex(row => row.attachmentID === 2 && row.outlineKey === "1"); view.selected = target; view.list.scrollTop = 144;
  const node = view.rowNodes[target]; view.revision++; await view.run();
  assert.equal(view.rowNodes[view.selected], node); assert.equal(view.rows[view.selected].attachmentID, 2); assert.equal(view.list.scrollTop, 144);
  view.input.value = "new query"; view.revision++; await view.run();
  assert.equal(view.outlineVisible, 5); assert.equal(view.rows.filter(row => !row.isDocument).length, 5); assert.equal(view.list.scrollTop, 0);
});

test("pagination retains real ancestors without counting document groups as additional matches", async () => {
  const { view, rows } = pagingPopup({ count: 12 });
  const parent = { ...rows[0], title: "Structure", outlineKey: "10", location: undefined };
  const matches = rows.map((row, index) => ({ ...row, outlineKey: `10.${index}`, parentKey: "10", parents: ["Structure"], depth: 1 }));
  view.app.outline.search = async () => ({ rows: matches, allRows: [parent, ...matches], total: 12, pending: false });
  await view.run(); assert.equal(view.rows.length, 6); assert.equal(view.outlineVisible, 5);
  view.moreOutline(); assert.equal(view.rows.length, 11); assert.equal(view.rowNodes[1].getAttribute("aria-level"), "2");
  assert.equal(view.rows[0].title, "Structure"); assert.equal(view.lastMessage, "当前 PDF 大纲 · 10/12 个匹配");
});

test("a superseded metadata filter cannot start the old outline index", async () => {
  const { view } = pagingPopup(); let release;
  view.spec = () => ({ text: "Methods", rawText: "Methods @Roe ", scope: { type: "all" }, filters: [{ type: "author", value: "Roe" }] });
  view.app.search = { search: () => new Promise(resolve => { release = resolve; }), prepare: async spec => spec };
  view.run = () => {}; // The original run finishes stale; its queued successor is irrelevant here.
  const pending = Launcher.prototype.run.call(view); view.revision++; release({ itemIDs: [10] }); await pending;
  assert.equal(view.isOpen, true);
  assert.equal(view.searchCalls(), 0); assert.equal(view.outlineProgress, undefined);
});

test("a superseded ordinary query cannot publish its prepared spec while a scope candidate is active", async () => {
  const view = uiPopup(); view.input.value = "fault"; view.revision = 1;
  view.app.search = { prepare: async spec => { view.input.value = "'()"; view.input.setSelectionRange(2, 2); view.revision++; return spec; } };
  await view.run(); assert.notEqual(view.currentSpec?.rawText, "fault"); assert.equal(view.rows?.length || 0, 0);
  assert.equal(view.query().activeFilter.type, "outline");
});

test("item collection trees show every direct location and clicks append bound directory filters", () => {
  const view = uiPopup(), container = new UINode(view.doc, "html");
  view.input.value = 'fault @"Ada" ';
  const locations = ["Project A", "Methods", "Review"].map((name, index) => ({ libraryID: 7, collectionID: index + 1, path: `Library › ${name}`, pathSegments: ["Library", name], pathKeys: ["library", String(index)] }));
  view.renderLocations(container, { itemID: 7 }, { status: "ready", locations });
  const nodes = descendants(container), buttons = nodes.filter(node => node.className?.includes("qs-path"));
  assert.equal(buttons.length, 4); assert.ok(!nodes.some(node => node.className === "qs-more-paths"));
  assert.equal(nodes.filter(node => node.text === "Library").length, 1);
  view.activate = () => { assert.fail("Plain path clicks must stay in search"); };
  buttons[0].listeners.click[0]({ stopPropagation() {} });
  buttons[3].listeners.click[0]({ stopPropagation() {} });
  assert.equal(view.input.value, 'fault @"Ada" /"Library" /"Review" ');
  assert.equal(view.isOpen, true);
  assert.deepEqual(view.spec().filters.slice(-2).map(filter => filter.ref), [
    { kind: "library", libraryID: 7, key: "library", title: "Library", path: "Library" },
    { kind: "collection", libraryID: 7, key: "2", title: "Review", path: "Library › Review" },
  ]);
});

test("Ctrl/Cmd path clicks locate the chosen direct membership including a parent with children", () => {
  const view = uiPopup(), container = new UINode(view.doc, "html"), row = { itemID: 7 };
  const locations = [
    { libraryID: 7, collectionID: 1, pathSegments: ["Library", "Project"], pathKeys: ["u", "project"], path: "Library › Project" },
    { libraryID: 7, collectionID: 2, pathSegments: ["Library", "Project", "Core"], pathKeys: ["u", "project", "core"], path: "Library › Project › Core" },
  ];
  view.renderLocations(container, row, { status: "ready", locations });
  const project = descendants(container).find(node => node.attributes["data-qs-location-key"] === "project");
  assert.ok(project.attributes["aria-label"].includes("Library › Project"));
  let activation; view.activate = options => { activation = options; };
  project.listeners.click[0]({ ctrlKey: true, stopPropagation() {} });
  assert.equal(activation.location, locations[0]); assert.equal(activation.directory, undefined); assert.equal(activation.locate, true);
  const core = descendants(container).find(node => node.attributes["data-qs-location-key"] === "core");
  core.listeners.click[0]({ metaKey: true, stopPropagation() {} });
  assert.equal(activation.location, locations[1]); assert.equal(activation.row, row);
  assert.equal(view.input.value, "");
});

test("path filters use configured prefixes, distinguish same-name branches and suppress repeated clicks", () => {
  const view = uiPopup(), container = new UINode(view.doc, "html"), get = view.app.prefs.get;
  view.app.prefs.get = name => name === "directoryPrefix" ? "#" : name === "tagPrefix" ? "~" : get(name);
  view.input.value = '>fault @"Ada" OR -:"2020" ';
  const locations = ["A", "B"].map((parent, index) => ({ libraryID: 7, collectionID: index + 1,
    pathSegments: ["Library", parent, "Core"], pathKeys: ["u", parent, String(index)], path: `Library › ${parent} › Core` }));
  view.renderLocations(container, { itemID: 7 }, { status: "ready", locations });
  view.activate = () => { assert.fail("Filtering must not navigate"); };
  const buttons = descendants(container).filter(node => node.attributes["data-qs-location-kind"] === "collection" && node.textContent === "Core");
  for (const button of [buttons[0], buttons[1], buttons[0]]) button.listeners.click[0]({ stopPropagation() {} });
  assert.equal(view.input.value, '>fault @"Ada" OR -:"2020" #"Core" #"Core · 2" ');
  assert.deepEqual(view.spec().filters.slice(-2).map(filter => filter.ref.key), ["0", "1"]);
  assert.equal(view.spec().scope.collectionKey, "CURRENT9");
});

test("path clicks report filter errors and ignore clicks while composing", () => {
  const view = uiPopup(), container = new UINode(view.doc, "html");
  view.renderLocations(container, { itemID: 7 }, { status: "ready", locations: [
    { libraryID: 7, collectionID: 1, pathSegments: ["Library", "Core"], pathKeys: ["u", "core"], path: "Library › Core" },
  ] });
  const button = descendants(container).find(node => node.attributes["data-qs-location-key"] === "core");
  view.input.value = "x".repeat(2040);
  button.listeners.click[0]({ stopPropagation() {} });
  assert.match(view.lastMessage, /检索式过长/u);
  const draft = view.input.value; view.composing = true;
  view.activate = () => { assert.fail("Composition must not trigger navigation"); };
  button.listeners.click[0]({ ctrlKey: true, stopPropagation() {} });
  assert.equal(view.input.value, draft);
});

test("ancestor navigation retains the query on cancellation or failure and closes only on success", async () => {
  const view = popup(), row = { itemID: 7, win: {} }, directory = { kind: "collection", libraryID: 7, key: "PARENT01" };
  view.input.value = "fault /Project";
  let received;
  view.app.openItem = () => { throw new Error("Ancestor must not locate the item"); };
  view.app.selectDirectory = async options => { received = options; return false; };
  await view.activate({ directory, row });
  assert.deepEqual(received, { ...directory, itemID: row.itemID, win: row.win });
  assert.equal(view.isOpen, true); assert.equal(view.input.value, "fault /Project");
  view.app.selectDirectory = async () => { throw new Error("Directory unavailable"); };
  await view.activate({ directory, row });
  assert.equal(view.isOpen, true); assert.equal(view.lastMessage, "Directory unavailable");
  view.composing = true; received = null;
  view.app.selectDirectory = async options => { received = options; return true; };
  await view.activate({ directory, row }); assert.equal(received, null);
  view.composing = false; await view.activate({ directory, row }); assert.equal(view.isOpen, false);
});

test("an unfiled item's library button adds a library filter without inventing a collection", () => {
  const view = uiPopup(), container = new UINode(view.doc, "html"), row = { itemID: 7 };
  view.renderLocations(container, row, { status: "ready", locations: [], libraryID: 7, libraryName: "Library" });
  const button = descendants(container).find(node => node.className?.includes("qs-path"));
  view.activate = () => { assert.fail("Plain library click must filter"); };
  button.listeners.click[0]({ stopPropagation() {} });
  assert.equal(view.input.value, '/"Library" ');
  assert.equal(view.spec().filters[0].ref.kind, "library"); assert.equal(view.spec().filters[0].ref.libraryID, 7);
  assert.match(container.textContent, /未归入文件夹/);
});

test("library path clicks preserve unbound filters and distinguish libraries with the same display name", () => {
  const view = uiPopup(), container = new UINode(view.doc, "html"); view.input.value = 'fault /"Manual" ';
  view.activate = () => { assert.fail("Plain library clicks must filter"); };
  for (const libraryID of [7, 8, 7]) {
    view.renderLocations(container, { itemID: libraryID }, { status: "ready", locations: [], libraryID, libraryName: "Library" });
    descendants(container).find(node => node.className?.includes("qs-path")).listeners.click[0]({ stopPropagation() {} });
  }
  assert.equal(view.input.value, 'fault /"Manual" /"Library" /"Library · 2" ');
  assert.deepEqual(view.spec().filters.slice(-2).map(filter => filter.ref.libraryID), [7, 8]);
  view.renderLocations(container, { itemID: 7 }, { status: "ready", locations: [
    { libraryID: 7, collectionID: 1, path: "Library › Core", pathSegments: ["Library", "Core"], pathKeys: ["u", "core"] },
  ] });
  const before = view.input.value;
  descendants(container).find(node => node.attributes["data-qs-location-kind"] === "library").listeners.click[0]({ stopPropagation() {} });
  assert.equal(view.input.value, before, "A library's identity does not depend on whether its item is unfiled");
});

test("row repaints beneath a stationary pointer preserve the keyboard selection while pointer movement selects", () => {
  for (const mode of ["items", "tabs", "directories", "authors", "years", "venues", "types", "tags"]) {
    const view = uiPopup(); view.mode = mode; view.inputMode = mode; view.resizeToContent = () => {};
    const kind = mode === "directories" ? "collection" : mode === "authors" ? "author" : mode === "years" ? "year" : mode === "venues" ? "venue" : mode === "types" ? "type" : mode === "tags" ? "tag" : mode === "tabs" ? "tab" : "item";
    view.rows = ["First", "Second"].map((title, index) => ({ kind, title, key: kind === "type" ? "journalArticle" : String(index), libraryID: 7, path: `Library › ${title}`, pathSegments: ["Library", title], pathKeys: ["u", String(index)], count: 1 }));
    view.selected = 1; view.select = index => { view.selected = index; };
    view.renderRows(0);
    const node = view.rowNodes[0]; assert.equal(node.listeners.pointerover, undefined, mode);
    node.listeners.pointermove[0]({ movementX: 0, movementY: 0 }); assert.equal(view.selected, 1, mode);
    node.listeners.pointermove[0]({ movementX: 1, movementY: 0 }); assert.equal(view.selected, 0, mode);
  }
});

test("click filters append with configured prefixes and preserve scope, Boolean filters and stable author identity", () => {
  const view = popup(), prefs = view.app.prefs.get;
  view.app.prefs.get = key => ({ authorPrefix: "~", yearPrefix: "^" })[key] || prefs(key);
  view.input.value = '>fault /Core OR -~"Other" ';
  view.filterBindings.set("directory:Core", { kind: "collection", libraryID: 9, key: "CORE0001" });
  const author = { kind: "author", key: "name-complete", title: 'Lab; Group "A" @ Center' };
  view.useFilter("author", author);
  assert.equal(view.input.value, '>fault /Core OR -~"Other" ~"Lab; Group \\"A\\" @ Center" ');
  assert.equal(view.spec().scope.collectionKey, "CURRENT9"); assert.equal(view.spec().text, "fault");
  assert.equal(view.spec().filters.at(-1).ref.key, "name-complete");
  view.useFilter("year", { kind: "year", key: "2020", field: "year", title: "2020" });
  assert.equal(view.spec().filters.at(-1).ref.field, "year"); assert.ok(view.input.value.endsWith('^"2020" '));
  const value = view.input.value; view.useFilter("author", author); view.useFilter("year", { kind: "year", key: "2020", field: "year", title: "2020" });
  assert.equal(view.input.value, value); assert.equal(view.isOpen, true);
  view.composing = true; view.useFilter("year", { kind: "year", key: "2021", title: "2021" }); assert.equal(view.input.value, value);
});

test("quick filters leave tabs for item search with literal keywords and reject long changes atomically", () => {
  const view = popup(); view.inputMode = view.mode = "tabs"; view.input.value = "fault @literal /value";
  view.useFilter("year", { kind: "year", key: "2020", field: "year", title: "2020" });
  assert.equal(view.inputMode, "items"); assert.equal(view.spec().filters.length, 1);
  assert.equal(view.spec().text, '"fault" "@literal" "/value"');
  const original = "a".repeat(2040); view.inputMode = "tabs"; view.input.value = original;
  assert.throws(() => view.useFilter("author", { key: "too-long", title: "Long author name" }), /检索式过长/);
  assert.equal(view.input.value, original); assert.equal(view.inputMode, "tabs"); assert.equal(view.filterBindings.has("author:Long author name"), false);
});

test("every creator role has a clickable button while original separators and highlight offsets stay intact", () => {
  const view = uiPopup(), container = new UINode(view.doc, "html");
  const records = [{ firstName: "A.", lastName: "Researcher", isAuthor: true }, { firstName: "", lastName: 'Lab; Group "A"', fieldMode: 1, isAuthor: true }, { firstName: "E.", lastName: "Editor", isAuthor: false }];
  let offset = 0;
  const creators = records.map(record => { const name = [record.firstName, record.lastName].filter(Boolean).join(" "), start = offset; offset += name.length + 2; return { ...record, name, start, end: start + name.length }; });
  const row = { authors: creators.map(creator => creator.name).join("; "), creatorDetails: creators };
  view.renderAuthors(container, row, [{ start: creators[1].start + 5, end: creators[1].start + 10 }]);
  assert.equal(container.textContent, row.authors);
  const buttons = descendants(container).filter(node => node.attributes["data-qs-filter"] === "author");
  assert.equal(buttons.length, 3); assert.equal(buttons[1].textContent, creators[1].name);
  assert.equal(descendants(buttons[1]).find(node => Object.hasOwn(node.attributes, "data-qs-mark")).textContent, "Group");
  let used; view.useFilter = (...args) => { used = args; };
  buttons[1].listeners.click[0]({ stopPropagation() {} }); assert.equal(used[0], "author"); assert.equal(used[1].title, creators[1].name); assert.equal(used[1].key, groupAuthors([creators[1]])[0].key);
  buttons[2].listeners.click[0]({ stopPropagation() {} }); assert.equal(used[1].title, creators[2].name);
  const year = view.yearNode({ year: "2020" }); year.listeners.click[0]({ stopPropagation() {} });
  assert.equal(used[0], "year"); assert.equal(used[1].field, "year");
  assert.equal(view.yearNode({ year: "n.d." }).listeners.click, undefined);
  assert.equal(view.yearNode({ year: "0000" }).listeners.click, undefined);
});

test("publication and publisher buttons display their fields, preserve marks and bind different source keys", () => {
  const view = uiPopup(), row = { itemID: 7, publicationTitle: 'Nature; Research "A"', publisher: 'Nature; Research "A"', evidence: [
    { field: "publicationTitle", sourceItemID: 7, ranges: [{ start: 0, end: 6 }] },
    { field: "publisher", sourceItemID: 8, ranges: [{ start: 0, end: 6 }] },
  ] };
  const sources = view.sourceNodes(row), nodes = descendants(sources), buttons = nodes.filter(node => node.attributes["data-qs-filter"] === "venue");
  assert.equal(buttons.length, 2); assert.ok(buttons[0].textContent.includes(row.publicationTitle)); assert.ok(buttons[1].textContent.includes(row.publisher));
  assert.equal(nodes.filter(node => Object.hasOwn(node.attributes, "data-qs-mark")).length, 1);
  let used; view.useFilter = (...args) => { used = args; };
  buttons[0].listeners.click[0]({ stopPropagation() {} }); assert.equal(used[0], "venue"); assert.equal(used[1].field, "publicationTitle"); const first = used[1].key;
  buttons[1].listeners.click[0]({ stopPropagation() {} }); assert.equal(used[1].field, "publisher"); assert.notEqual(first, used[1].key);
  assert.equal(view.sourceNodes({}), null); assert.equal(descendants(view.sourceNodes({ publisher: "Institute" })).filter(node => node.attributes["data-qs-filter"] === "venue").length, 1);
});

test("source clicks keep distinct same-name SO and PUBL conditions and use the configured venue prefix", () => {
  const view = uiPopup(), prefs = view.app.prefs.get; view.app.prefs.get = key => key === "venuePrefix" ? "!" : prefs(key);
  view.input.value = 'fault /Core ';
  view.useFilter("venue", { kind: "venue", key: "publicationTitle:nature", field: "publicationTitle", title: "Nature" });
  view.useFilter("venue", { kind: "venue", key: "publisher:nature", field: "publisher", title: "Nature" });
  view.updateMode();
  assert.ok(view.input.value.includes('!"Nature"')); assert.ok(view.input.value.includes('!"Nature · 2"'));
  assert.ok(view.filterSummary.textContent.includes("SO=(Nature)")); assert.ok(view.filterSummary.textContent.includes("PUBL=(Nature)"));
  const before = view.input.value; view.useFilter("venue", { kind: "venue", key: "publisher:nature", field: "publisher", title: "Nature" }); assert.equal(view.input.value, before);
  assert.equal(view.spec().text, "fault"); assert.equal(view.spec().filters[0].type, "directory");
});

test("Enter on an inline author or year button stays with native button activation", () => {
  const view = popup(); let activated = false; view.activate = () => { activated = true; };
  const button = { closest: selector => selector === "button" || selector === ".qs-result-main" ? button : null };
  let prevented = false;
  view.keydown({ key: "Enter", target: button, preventDefault() { prevented = true; } });
  assert.equal(activated, false); assert.equal(prevented, false);
});

test("panel adaptation includes metadata and preview within window-relative maxima and updates saved ratios", () => {
  const view = popup(), values = new Map(), prefs = { width: 60, height: 80, fontSize: 14 };
  view.app.prefs.get = key => prefs[key]; view.dialog = { style: { setProperty: (name, value) => values.set(name, value) } };
  let canvases = 0;
  view.doc = { createElementNS() { canvases++; return { getContext: () => ({ measureText: text => ({ width: text.length * 7 }) }) }; } };
  view.win = { innerWidth: 1800, innerHeight: 1000, getComputedStyle: () => ({ fontFamily: "sans-serif" }) }; view.root = {}; view.preview = { hidden: true };
  view.rows = [{ title: "Short", authors: "A. Researcher", year: "2020" }]; view.selected = 0;
  view.resizeToContent(); assert.equal(values.get("--qs-content-width"), "520px");
  view.preview.hidden = false; view.resizeToContent(); assert.equal(values.get("--qs-content-width"), "840px");
  view.preview.hidden = true; view.input.value = '@("Long Author") !("Publication name with enough text to expand the query") ';
  view.resizeToContent(); assert.equal(values.get("--qs-content-width"), Math.min(1080, view.input.value.length * 7 + 70) + "px");
  view.input.value = ""; view.preview.hidden = false;
  view.rows[0].authors = "Full author ".repeat(40); view.resizeToContent(); assert.equal(values.get("--qs-content-width"), "1080px");
  prefs.width = 40; prefs.height = 50; view.resizeToContent(); assert.equal(values.get("--qs-content-width"), "720px"); assert.equal(values.get("--qs-width"), "720px"); assert.equal(values.get("--qs-height"), "500px");
  view.win.innerWidth = 560; view.resizeToContent(); assert.equal(values.get("--qs-content-width"), "224px"); assert.equal(canvases, 1);
});

test("commands and expanded advanced search use configured width while global windows stay freely sized", () => {
  const view = popup(), values = new Map(), prefs = { width: 62, height: 80 };
  view.app.prefs.get = key => prefs[key]; view.dialog = { style: { setProperty: (name, value) => values.set(name, value) } };
  view.doc = { createElementNS: () => { throw new Error("Fixed modes should not measure text"); } };
  view.win = { innerWidth: 1600, innerHeight: 1000 }; view.root = { classList: { contains: () => false } };
  view.switchMode = "commands"; view.resizeToContent();
  assert.equal(values.get("--qs-content-width"), "992px"); assert.equal(values.get("--qs-height"), "800px");
  view.switchMode = null; view.advanced.hidden = false; prefs.width = 70; view.resizeToContent();
  assert.equal(values.get("--qs-content-width"), "1120px");
  values.clear(); view.root.classList.contains = () => true; view.win.innerWidth = 850; view.resizeToContent();
  assert.equal(values.size, 0, "No proportional resizing inside a manually sized global window");
});

test("outline opening width stays fixed across paging, filtering, selection and preview updates", () => {
  const view = popup(), values = new Map(), prefs = { width: 80, height: 80, fontSize: 14 };
  view.app.prefs.get = key => prefs[key]; view.dialog = { style: { setProperty: (name, value) => values.set(name, value) } };
  let measures = 0;
  view.doc = { createElementNS: () => ({ getContext: () => ({ measureText: text => { measures++; return { width: text.length * 7 }; } }) }) };
  view.win = { innerWidth: 1800, getComputedStyle: () => ({ fontFamily: "sans-serif" }) }; view.root = {}; view.preview = { hidden: true };
  view.inputMode = view.mode = "outline"; view.ready = false; view.rows = []; view.resizeToContent();
  assert.equal(view.outlineSize, undefined); view.ready = true;
  view.rows = [{ title: "Short heading", authors: "A. Researcher", year: "2024" }]; view.selected = 0; view.resizeToContent();
  assert.equal(values.get("--qs-content-width"), "520px"); const afterOpening = measures;
  view.rows.push({ title: "A much longer title ".repeat(30), authors: "Full author ".repeat(40) }); view.selected = 1;
  view.input.value = "Longer query ".repeat(30); view.resizeToContent();
  assert.equal(values.get("--qs-content-width"), "520px"); assert.equal(measures, afterOpening);
  view.preview.hidden = false; view.resizeToContent(); assert.equal(values.get("--qs-content-width"), "840px");
  view.selected = 0; view.resizeToContent(); assert.equal(values.get("--qs-content-width"), "840px");
  view.preview.hidden = true; view.resizeToContent(); assert.equal(values.get("--qs-content-width"), "520px");
});

test("locked outline sizing follows viewport and maximum changes, and resets after leaving the mode or closing", () => {
  const view = popup(), values = new Map(), prefs = { width: 70, height: 80, fontSize: 14 };
  view.app.prefs.get = key => prefs[key]; view.dialog = { style: { setProperty: (name, value) => values.set(name, value) } };
  view.doc = { createElementNS: () => ({ getContext: () => ({ measureText: text => ({ width: text.length * 7 }) }) }) };
  view.win = { innerWidth: 1800, getComputedStyle: () => ({ fontFamily: "sans-serif" }), clearTimeout() {} }; view.root = {}; view.preview = { hidden: true };
  view.inputMode = view.mode = "outline"; view.rows = [{ title: "Long heading ".repeat(9) }]; view.selected = 0; view.resizeToContent();
  const opened = values.get("--qs-content-width"); assert.notEqual(opened, "520px");
  view.win.innerWidth = 560; view.resizeToContent(); assert.equal(values.get("--qs-content-width"), "392px");
  view.win.innerWidth = 1800; view.resizeToContent(); assert.equal(values.get("--qs-content-width"), opened);
  prefs.width = 30; view.resizeToContent(); assert.equal(values.get("--qs-content-width"), "540px");
  prefs.width = 70; view.resizeToContent(); assert.equal(values.get("--qs-content-width"), opened);
  view.inputMode = view.mode = "items"; view.input.value = ""; view.rows = [{ title: "Short" }]; view.resizeToContent();
  assert.equal(view.outlineSize, null); assert.equal(values.get("--qs-content-width"), "520px");
  view.inputMode = view.mode = "outline"; view.resizeToContent(); assert.equal(values.get("--qs-content-width"), "520px");
  view.app.prefs.set = () => {}; Launcher.prototype.hide.call(view); assert.equal(view.outlineSize, null);
});

test("an empty ready outline keeps its opening width when indexing later supplies matches", () => {
  const view = popup(), values = new Map();
  view.app.prefs.get = key => ({ width: 80, height: 80, fontSize: 14 })[key];
  view.dialog = { style: { setProperty: (name, value) => values.set(name, value) } };
  view.doc = { createElementNS: () => ({ getContext: () => ({ measureText: text => ({ width: text.length * 7 }) }) }) };
  view.win = { innerWidth: 1800, getComputedStyle: () => ({ fontFamily: "sans-serif" }) }; view.root = {}; view.preview = { hidden: true };
  view.inputMode = view.mode = "outline"; view.ready = true; view.rows = []; view.resizeToContent();
  assert.deepEqual(view.outlineSize, { base: 520, preview: 320 });
  view.rows = [{ title: "A much longer heading ".repeat(30) }]; view.selected = 0; view.resizeToContent();
  assert.equal(values.get("--qs-content-width"), "520px");
  view.preview.hidden = false; view.resizeToContent(); assert.equal(values.get("--qs-content-width"), "840px");
});

test("field candidates keep the opening width when paging changes the selected preview", () => {
  const view = popup(), values = new Map(), prefs = { width: 80, height: 80, fontSize: 14 };
  view.app.prefs.get = key => prefs[key];
  view.dialog = { style: { setProperty: (name, value) => values.set(name, value) } };
  view.doc = { createElementNS: () => ({ getContext: () => ({ measureText: text => ({ width: text.length * 7 }) }) }) };
  view.win = { innerWidth: 1800, innerHeight: 1000, getComputedStyle: () => ({ fontFamily: "sans-serif" }) };
  view.root = {}; view.preview = { hidden: false }; view.ready = true;
  for (const mode of ["authors", "years", "venues", "types", "directories"]) {
    view.mode = mode; view.rows = [{ title: "Short" }]; view.selected = 0;
    view.resizeToContent(); assert.equal(values.get("--qs-content-width"), "840px");
    view.rows.push({ title: "A much longer candidate ".repeat(30) }); view.selected = 1;
    view.resizeToContent(); assert.equal(values.get("--qs-content-width"), "840px");
    prefs.width = 30; view.resizeToContent(); assert.equal(values.get("--qs-content-width"), "540px");
    prefs.width = 80;
  }
  view.mode = "items"; view.rows = [{ title: "Short" }]; view.selected = 0;
  view.resizeToContent(); assert.equal(view.pickerSize, null);
});

test("WoS summary preserves actual OR branches, includes the draft, and retains directory editing through Alt", () => {
  const view = uiPopup(); view.input.value = 'fault /"Core" OR -@"Wei Li" /"Next" @Draft';
  const ref = { kind: "collection", libraryID: 7, key: "CORE0001", path: "Old library › Core" };
  view.filterBindings.set("directory:Core", ref);
  view.currentSpec = { rawText: view.input.value, resolvedFilters: [{ type: "directory", value: "Core", negated: false, ref, matches: [{ path: "Library › Renamed parent › Core" }] }] };
  view.updateMode();
  assert.equal(view.filterSummary.hidden, false);
  assert.match(view.filterSummary.textContent, /TS=\(fault\)/u);
  assert.ok(view.filterSummary.textContent.includes("Core")); assert.ok(!view.filterSummary.textContent.includes("ZOTERO_DIR"));
  assert.match(view.filterSummary.textContent, /AU=\(Draft\)/u);
  assert.ok(view.filterSummary.textContent.includes("OR"));
  const edit = descendants(view.filterSummary).find(node => node.attributes["aria-label"] === "编辑目录条件：Core");
  assert.ok(edit.attributes.title.startsWith("Library › Renamed parent › Core"));
  const original = view.input.value; edit.listeners.click[0]({ altKey: true });
  assert.equal(view.input.value, original); assert.equal(view.query().activeFilter.value, "Core"); assert.ok(view.input.value.endsWith("@Draft"));
});

test("clicking the displayed expression copies only WoS clauses without changing the input or clipboard for local-only queries", async () => {
  const view = uiPopup(); view.input.value = "fault :2020 /Project "; let copied;
  globalThis.Zotero = { Utilities: { Internal: { copyTextToClipboard: text => { copied = text; } } } };
  try {
    view.updateMode(); const before = view.input.value;
    const copy = descendants(view.filterSummary).find(node => node.attributes["aria-label"] === "复制 WoS 检索式");
    copy.listeners.click[0]({}); await new Promise(setImmediate);
    assert.ok(copied.includes("TS=(fault)")); assert.ok(copied.includes("PY=(2020)")); assert.ok(!copied.includes("ZOTERO_"));
    assert.equal(view.input.value, before);
    const previous = copied; view.input.value = "%book "; view.updateMode();
    assert.equal(await view.copyExpression(), false); assert.equal(copied, previous);
  } finally { delete globalThis.Zotero; }
});

test("clearing a configured current-directory marker removes only that scope and retains the other filters", () => {
  const view = popup(), get = view.app.prefs.get; view.app.prefs.get = name => name === "currentPrefix" ? ">" : get(name);
  view.input.value = "> fault @literal_author "; view.clearDirectory();
  assert.equal(view.input.value, "fault @literal_author "); assert.equal(view.spec().filters[0].value, "literal_author");
});

test("metadata refreshes retain the selected tab by native ID while new input selects the first result", async () => {
  const view = uiPopup(); view.inputMode = "tabs"; view.input.value = "fault";
  const owner = {}, a = { kind: "tab", tabID: "a", win: owner }, b = { kind: "tab", tabID: "b", win: owner };
  let rows = [a, b]; view.app.tabRows = async () => rows;
  view.renderRows = () => {}; view.updatePreview = async () => {}; view.selected = 0;
  await view.run(); view.selected = 1;
  rows = [{ ...b }, { ...a }]; await view.run();
  assert.equal(view.rows[view.selected].tabID, "b");
  rows = [{ ...a }, { ...b }]; view.input.value = "other"; await view.run();
  assert.equal(view.rows[view.selected].tabID, "a");
});

test("removing an OR member preserves other filters, ordinary words and the pending draft", () => {
  for (const [value, removed, expected] of [
    ['fault /"A" OR /"B" OR /"C" /"D" @Wei Li', "B", ["A", "C", "D", "Wei"]],
    ['fault /"A" OR /"B" ', "A", ["B"]],
    ['fault /"A" OR /"B" ', "B", ["A"]],
  ]) {
    const view = popup(); view.input.value = value;
    const filter = parseLauncherInput(value, "items", -1).filters.find(entry => entry.value === removed);
    view.removeFilter(filter);
    const parsed = parseLauncherInput(view.input.value, "items", -1);
    assert.deepEqual(parsed.filters.map(entry => entry.value), expected); assert.ok(!parsed.text.includes("OR"));
    assert.equal(view.isOpen, true);
    if (value.endsWith("@Wei Li")) { assert.ok(view.input.value.endsWith("@Wei Li")); assert.equal(view.query().activeFilter.value, "Wei Li"); assert.equal(parsed.filters[1].join, "or"); }
  }
  const view = popup(); view.input.value = ' fault /"A" /"A" '; view.filterBindings.set("directory:A", { kind: "collection", key: "A" });
  view.removeFilter(parseLauncherInput(view.input.value, "items", -1).filters[0]);
  assert.equal(view.filterBindings.has("directory:A"), true); assert.ok(view.input.value.startsWith(" "));
});

test("removing an automatic condition does not protect an identical manual condition", () => {
  const view = popup(); view.input.value = "@(Alice) @(Alice) "; view.inputScopes = new InputScopes(view.input.value); view.inputScopes.add(0);
  view.removeFilter(parseLauncherInput(view.input.value, "items", -1).filters[0]);
  assert.equal(view.query().filters.length, 1); assert.equal(view.inputScopes.records.length, 0);
  view.input.value = "@(Alice OR Bob) "; view.inputScopes.reset(view.input.value); view.inputScopes.add(0);
  view.removeFilter(parseLauncherInput(view.input.value, "items", -1).filters[0]);
  assert.equal(view.query().filters[0].value, "Bob"); assert.equal(view.inputScopes.records.length, 1);
});

test("the current-directory prefix uses the main sidebar context for specs and summary", () => {
  const view = uiPopup(); view.input.value = ">fault";
  view.app.directoryContext = () => ({ libraryID: 12, libraryName: "主文库", collectionKey: "MAIN0001", collectionName: "主目录" });
  assert.deepEqual(view.spec().scope, { type: "collection", libraryID: 12, collectionKey: "MAIN0001", recursive: true });
  view.updateMode(); assert.equal(view.scopeChip.title, "主文库 › 主目录"); assert.ok(view.filterSummary.textContent.includes("主目录"));
});

test("saved-search current scope resolves its organized full path and ignores stale tooltip reads", async () => {
  const view = uiPopup(); view.input.value = ">fault";
  view.app.directoryContext = () => ({ libraryID: 7, libraryName: "Library", searchKey: "SEARCH01", searchName: "Saved" });
  const releases = []; view.app.directoryRows = () => new Promise(resolve => releases.push(resolve));
  view.updateMode(); view.updateMode();
  releases[1]([{ kind: "search", libraryID: 7, key: "SEARCH01", path: "Library › New parent › Saved" }]); await new Promise(setImmediate);
  releases[0]([{ kind: "search", libraryID: 7, key: "SEARCH01", path: "Library › Old parent › Saved" }]); await new Promise(setImmediate);
  assert.equal(view.scopeChip.title, "Library › New parent › Saved");
});

test("author suggestions remove duplicate displayed names and highlight actual names for pinyin matches", () => {
  const view = uiPopup(); view.input.value = "@linxiaohe"; view.mode = "authors";
  view.rows = groupAuthors([
    { firstName: "", lastName: "林晓禾", fieldMode: 1, libraryID: 7, count: 1 },
    { firstName: "Xiaohe", lastName: "Lin", fieldMode: 0, libraryID: 7, count: 1 },
  ]);
  view.renderRows(0);
  assert.equal(view.list.textContent, "林晓禾Xiaohe Lin");
  const mark = descendants(view.list).find(node => Object.hasOwn(node.attributes, "data-qs-mark"));
  assert.equal(mark.textContent, "林晓禾");
});

test("Show All waits for the registered main window and preserves cancelled, failed or stale queries", async () => {
  const view = popup(), owner = {}, main = { closed: false, focus() { this.focused = true; } }; view.win = owner; view.revision = 1; view.input.value = "fault";
  view.app.ensureMainWindow = async win => { assert.equal(win, owner); return main; };
  view.app.nativeFor = win => { assert.equal(win, main); return { applyQuery: async spec => { assert.equal(spec.text, "fault"); return true; } }; };
  assert.equal(await view.applyAll(), true); assert.equal(main.focused, true); assert.equal(view.isOpen, false);
  view.isOpen = true; view.app.nativeFor = () => ({ applyQuery: async () => false });
  assert.equal(await view.applyAll(), false); assert.equal(view.isOpen, true); assert.equal(view.input.value, "fault");
  view.app.ensureMainWindow = async () => { throw new Error("main unavailable"); };
  assert.equal(await view.applyAll(), false); assert.equal(view.lastMessage, "main unavailable"); assert.equal(view.isOpen, true);
  let release, applied = 0; view.app.ensureMainWindow = () => new Promise(resolve => { release = resolve; });
  view.app.nativeFor = () => ({ applyQuery: async () => { applied++; } });
  const pending = view.applyAll(); view.input.value = "new query"; view.revision++; release(main);
  assert.equal(await pending, false); assert.equal(applied, 0); assert.equal(view.input.value, "new query"); assert.equal(view.isOpen, true);
});

test("Show All survives data refreshes while a main window opens but rejects a reopened launcher", async () => {
  const view = popup(), main = { closed: false, focus() {} }; view.input.value = "fault"; view.openRevision = 1;
  let release, applied = 0;
  view.app.ensureMainWindow = () => new Promise(resolve => { release = resolve; });
  view.app.nativeFor = () => ({ applyQuery: async () => { applied++; return true; } });
  const pending = view.applyAll(); view.revision += 3; view.ready = false; release(main);
  assert.equal(await pending, true); assert.equal(applied, 1); assert.equal(view.isOpen, false);
  view.ready = true; view.isOpen = true;
  const old = view.applyAll(); view.openRevision++; release(main);
  assert.equal(await old, false); assert.equal(applied, 1); assert.equal(view.isOpen, true);
});

test("reader rows activate their existing reader instance without reopening an attachment", async () => {
  const view = popup(), reader = { kind: "reader", reader: {} }; view.mode = "items"; view.rows = [reader]; view.selected = 0;
  view.app.openTab = async row => { assert.equal(row, reader); return true; };
  view.app.openItem = () => { throw new Error("attachment must not reopen"); };
  await view.activate(); assert.equal(view.isOpen, false);
});

test("editing a bound short directory label shows both live same-name branches and selects its original ref", async () => {
  const view = uiPopup(); view.revision = 1;
  const a = { kind: "collection", libraryID: 7, key: "A", title: "Renamed Core", path: "Library › A › Renamed Core", pathSegments: ["Library", "A", "Renamed Core"] };
  const b = { ...a, key: "B", path: "Library › B › Renamed Core", pathSegments: ["Library", "B", "Renamed Core"] };
  view.input.value = 'fault /"Old title · 2" tail ';
  view.filterBindings.set("directory:Old title · 2", { ...b, title: "Old title", path: "Old path" });
  view.app.directoryRows = async (_, text) => { assert.equal(text, ""); return [a, b]; };
  view.editFilter(parseLauncherInput(view.input.value, "items", -1).filters[0]);
  await view.run();
  assert.deepEqual(new Set(view.rows.map(row => row.key)), new Set(["A", "B"]));
  assert.equal(view.rows[view.selected].key, "B"); assert.equal(view.spec().filters[0].ref.key, "B");
  assert.equal(view.input.value, 'fault /"Old title · 2" tail ');
  view.select(view.rows.findIndex(row => row.key === "A"), false); await view.activate();
  assert.equal(view.input.value, 'fault /"Renamed Core" tail '); assert.equal(view.spec().filters[0].ref.key, "A");
});

test("a replacement reuses its label while other same-name conditions retain independent refs and OR", async () => {
  const view = uiPopup(), row = { kind: "collection", libraryID: 7, key: "C", title: "Core", path: "Library › C › Core" };
  view.input.value = 'fault /"Core" OR /"Core · 2" @"Wei Li" tail ';
  view.filterBindings.set("directory:Core", { ...row, key: "A" });
  view.filterBindings.set("directory:Core · 2", { ...row, key: "B" });
  view.filterBindings.set("author:Wei Li", { kind: "author", key: "author-one" });
  view.editFilter(parseLauncherInput(view.input.value, "items", -1).filters[1]);
  view.rows = [row]; view.selected = 0; await view.activate();
  assert.equal(view.input.value, 'fault /"Core" OR /"Core · 2" @"Wei Li" tail ');
  assert.deepEqual(view.spec().filters.map(filter => filter.ref.key), ["A", "C", "author-one"]);
  assert.equal(view.spec().filters[1].join, "or"); assert.equal(view.spec().text, "fault tail");
  view.input.value = 'fault /"Core" tail '; view.query();
  view.editFilter(parseLauncherInput(view.input.value, "items", -1).filters[0]);
  view.rows = [row]; await view.activate();
  assert.equal(view.input.value, 'fault /"Core" tail '); assert.equal(view.spec().filters[0].ref.key, "C");
  assert.deepEqual([...view.filterBindings.keys()], ["directory:Core"]);
});

test("manual fragment deletion clears retired bindings before retyping without losing remaining refs", () => {
  const view = popup(); view.input.value = '/"Core" /"Keep" ';
  const kept = { kind: "collection", libraryID: 7, key: "KEEP" };
  view.filterBindings.set("directory:Core", { kind: "collection", libraryID: 7, key: "OLD" });
  view.filterBindings.set("directory:Keep", kept);
  view.input.value = '/"Keep" '; view.query();
  assert.equal(view.filterBindings.has("directory:Core"), false);
  view.input.value += "/Core";
  assert.equal(view.spec().filters[0].ref, kept); assert.equal(view.spec().filters[1].ref, undefined);
});

test("bound author editing offers normal matching alternatives while preserving separate identities", async () => {
  const view = uiPopup(); view.revision = 1; view.input.value = 'fault @"William Li" tail ';
  const [a, b] = groupAuthors([
    { firstName: "William", lastName: "Li", fieldMode: 0, libraryID: 7, count: 2 },
    { firstName: "William", lastName: "Li Jr", fieldMode: 0, libraryID: 7, count: 1 },
  ]);
  const originalRecords = JSON.stringify([a.records, b.records]);
  view.filterBindings.set("author:William Li", { kind: "author", key: a.key });
  view.app.search = { authorRows: async text => { assert.equal(text, ""); return [b, a]; } };
  view.editFilter(parseLauncherInput(view.input.value, "items", -1).filters[0]); await view.run();
  assert.deepEqual(new Set(view.rows.map(row => row.key)), new Set([a.key, b.key]));
  assert.equal(view.rows[view.selected].key, a.key); assert.equal(view.spec().filters[0].ref.key, a.key);
  view.select(view.rows.findIndex(row => row.key === b.key), false); await view.activate();
  assert.equal(view.spec().filters[0].ref.key, b.key); assert.equal(view.spec().text, "fault tail");
  assert.equal(JSON.stringify([a.records, b.records]), originalRecords);
});

test("guide candidates page in on demand, keep the selection and stop at the end", () => {
  const all = Array.from({ length: 45 }, (_, index) => ({ kind: "author", key: `a${index}`, title: `Author ${index}` }));
  const rendered = [], view = Object.create(Launcher.prototype);
  Object.assign(view, { isOpen: true, ready: true, composing: false, mode: "authors", pickerRows: all, rows: all.slice(0, 20), selected: 19, revision: 1, countLabel: "authors",
    list: { clientHeight: 640, scrollTop: 300 }, rowNodes: [], doc: { activeElement: null },
    renderRows(revision, previous) { rendered.push([this.rows.length, previous.key]); }, select(index) { this.selected = index; }, message(text) { this.status = text; } });
  assert.equal(view.more(), true);
  assert.deepEqual([view.rows.length, view.selected, view.list.scrollTop, view.status], [40, 19, 300, "authors · 45 / 40"]);
  assert.equal(view.more(), true); assert.equal(view.rows.length, 45); assert.equal(view.status, "authors · 45");
  assert.equal(view.more(), false); assert.deepEqual(rendered, [[40, "a19"], [45, "a19"]]);
  view.mode = "items"; view.rows = all.slice(0, 20); assert.equal(view.more(), false);
});

test("item pages append one batch with its evidence and preserve the existing selection and scroll", async () => {
  const previous = globalThis.Zotero;
  globalThis.Zotero = { Items: { getAsync: async itemID => ({ id: itemID }) } };
  const view = Object.create(Launcher.prototype), appended = [], ids = [1, 2, 3, 4, 5];
  Object.assign(view, { isOpen: true, ready: true, mode: "items", revision: 1, openRevision: 1, rows: [{ itemID: 1 }, { itemID: 2 }], selected: 1,
    pagedItemIDs: ids, currentSpec: { text: "fault" }, list: { clientHeight: 64, scrollTop: 100 }, countLabel: "items",
    app: { prefs: { get: () => 2 }, search: { metadataCache: new Map(ids.map(id => [id, { title: "fault" }])),
      result: async item => ({ itemID: item.id }), metadataEvidence: () => [{ field: "title" }] } },
    renderRows: (revision, row, from) => appended.push([revision, row.itemID, from]), select(index) { this.selected = index; }, message() {} });
  try {
    assert.equal(await view.moreItems(), true); assert.deepEqual(view.rows.map(row => row.itemID), [1, 2, 3, 4]);
    assert.deepEqual(appended, [[1, 2, 2]]); assert.equal(view.selected, 1); assert.equal(view.list.scrollTop, 100);
    assert.deepEqual(view.rows[2].evidence, [{ field: "title" }]);
    assert.equal(await view.moreItems(), true); assert.equal(view.rows.length, 5); assert.equal(await view.moreItems(), false);
  } finally { globalThis.Zotero = previous; }
});

test("late item batches cannot append into a changed query", async () => {
  const previous = globalThis.Zotero; let release;
  globalThis.Zotero = { Items: { getAsync: async itemID => ({ id: itemID }) } };
  const view = Object.create(Launcher.prototype);
  Object.assign(view, { isOpen: true, ready: true, revision: 1, openRevision: 1, rows: [{ itemID: 1 }], selected: 0,
    pagedItemIDs: [1, 2], recentItemIDs: [1, 2], currentSpec: { text: "" },
    app: { prefs: { get: () => 20 }, search: { result: async item => { await new Promise(resolve => { release = resolve; }); return { itemID: item.id }; } } } });
  try {
    const pending = view.moreItems(); await Promise.resolve(); await Promise.resolve();
    view.revision++; view.rows = [{ itemID: 9 }]; release();
    assert.equal(await pending, false); assert.deepEqual(view.rows, [{ itemID: 9 }]); assert.equal(view.itemPaging, null);
  } finally { globalThis.Zotero = previous; }
});

test("result wheels request more candidates halfway through the available scroll range", () => {
  const view = uiPopup(); view.mode = "authors"; view.rows = [{ key: "one" }]; view.pickerRows = [{ key: "one" }, { key: "two" }];
  Object.assign(view.list, { scrollHeight: 400, clientHeight: 100, scrollTop: 0 });
  let next = 0; view.more = () => { next++; }; view.queueFill = () => view.fillViewport();
  const wheel = extra => ({ deltaY: 2, deltaMode: 1, preventDefault() { this.prevented = true; }, stopPropagation() {}, ...extra });
  const lines = wheel(); view.scrollResults(lines); assert.equal(view.list.scrollTop, 32); assert.equal(lines.prevented, true);
  assert.equal(next, 0); view.scrollResults(wheel({ deltaY: 118, deltaMode: 0 })); assert.equal(view.list.scrollTop, 150); assert.equal(next, 1);
  const zoom = wheel({ ctrlKey: true }); view.scrollResults(zoom); assert.equal(zoom.prevented, undefined);
  view.list.scrollHeight = view.list.clientHeight; view.list.scrollTop = 0;
  view.scrollResults(wheel()); assert.equal(next, 2);
});

test("a member path in a field candidate preview locates that item instead of selecting another filter", async () => {
  const view = popup(), item = { itemID: 42, title: "Preview member" }, location = { collectionID: 9 };
  view.mode = "authors";
  view.app.openItem = async (row, { current, ...options }) => { assert.equal(row, item); assert.deepEqual(options, { locate: true, location }); assert.equal(current(), true); return true; };
  view.useFilter = () => { throw new Error("must not replace the author condition"); };
  await view.activate({ row: item, locate: true, location });
  assert.equal(view.isOpen, false);
});
