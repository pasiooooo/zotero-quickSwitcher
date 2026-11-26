import test from "node:test";
import assert from "node:assert/strict";
import { CommandService, commandState, parseCommandInput } from "../src/commands.mjs";

test("command sources have caret-defined scope and escaped source names retain following literal search text", () => {
  assert.equal(parseCommandInput("@()", 2).choosingSource, true);
  assert.equal(parseCommandInput("@()", 3).choosingSource, false);
  const value = String.raw`@(Tools \(PDF\)) rotate @page`;
  const parsed = parseCommandInput(value);
  assert.equal(parsed.source, "Tools (PDF)"); assert.equal(parsed.text, "rotate @page");
  assert.equal(parseCommandInput(value, 5).choosingSource, true);
  assert.equal(parseCommandInput("@Zotero copy").source, "Zotero");
  assert.equal(parseCommandInput("@Zotero copy").text, "copy");
  assert.deepEqual(parseCommandInput(String.raw`\@literal`), { source: "", text: "@literal", choosingSource: false });
});

function node(attributes = {}, parentElement = null, classes = []) {
  const classList = new Set(classes); classList.contains = name => classList.has(name);
  return { attributes, parentElement, classList, isConnected: true,
    getAttribute(name) { return this.attributes[name] ?? null; } };
}
const context = () => ({ items: [{ id: 1 }], collectionTreeRows: [{ id: "C1" }], reader: {}, tabType: "reader", tabSubType: "pdf" });

test("hidden and disabled native or plugin commands cannot execute even when their target object exists", () => {
  const command = node(), win = { document: { getElementById: () => command } }, entry = node({ command: "cmd_action" });
  assert.equal(commandState(entry, win, "items", context()).enabled, true);
  entry.attributes.hidden = "true"; assert.equal(commandState(entry, win, "items", context()).enabled, false);
  delete entry.attributes.hidden; command.attributes.disabled = "true"; assert.equal(commandState(entry, win, "items", context()).enabled, false);
  delete command.attributes.disabled;
  const popup = node({ hidden: "true" }); entry.parentElement = popup;
  assert.equal(commandState(entry, win, "items", context(), popup).enabled, true);
  const submenu = node({ disabled: "true" }, popup); entry.parentElement = submenu;
  assert.equal(commandState(entry, win, "items", context(), popup).enabled, false);
});

test("native tab types and selection dependencies keep unavailable operations distinct from generic commands", () => {
  const win = { document: { getElementById: () => null } }, entry = node({}, null, ["menu-type-reader", "pdf"]);
  assert.equal(commandState(entry, win, "reader", context()).enabled, true);
  assert.equal(commandState(entry, win, "reader", { ...context(), tabSubType: "epub" }).enabled, false);
  assert.equal(commandState(entry, win, "reader", { ...context(), reader: null }).enabled, false);
  const normal = node();
  for (const [dependency, field] of [["items", "items"], ["collection", "collectionTreeRows"]]) {
    assert.equal(commandState(normal, win, dependency, { ...context(), [field]: [] }).enabled, false);
  }
  assert.equal(commandState(normal, win, "field", context()).enabled, false);
  assert.equal(commandState(normal, win, "field", { ...context(), fieldName: "title" }).enabled, true);
});

test("source picker lists each source once with its icon and a selected source ID distinguishes identical plugin names", async () => {
  const win = {}, service = new CommandService({}), rows = [
    { key: "a", source: "a", sourceTitle: "Tools", title: "Read PDF", path: "Read", enabled: true, iconURL: "chrome://a/icon.svg" },
    { key: "a2", source: "a", sourceTitle: "Tools", title: "Copy", path: "Edit", enabled: true, iconURL: "chrome://a/icon.svg" },
    { key: "b", source: "b", sourceTitle: "Tools", title: "Read PDF", path: "Read", enabled: true },
  ];
  service.sessions.set(win, { rows });
  const sources = await service.rows(win, parseCommandInput("@()", 2));
  assert.deepEqual(sources.map(({ kind, key, count, iconURL }) => ({ kind, key, count, iconURL })), [
    { kind: "command-source", key: "a", count: 2, iconURL: "chrome://a/icon.svg" }, { kind: "command-source", key: "b", count: 1, iconURL: undefined }]);
  assert.deepEqual((await service.rows(win, { source: "Tools", sourceID: "b", text: "pdf" })).map(row => row.key), ["b"]);
  assert.equal((await service.rows(win, { text: "copy" })).length, 1);
});

test("execution awaits actions, rejects stale nodes, and disposal releases nested menu hooks exactly once", async () => {
  const service = new CommandService({}), entry = node(), win = { closed: false, document: { getElementById: () => null, createEvent: type => ({ type, initCommandEvent(type) { this.type = type; } }) }, focus() {}, Event };
  let count = 0; entry.doCommand = () => { count++; };
  const row = { node: entry, win, context: context(), dependency: "items", enabled: true };
  await service.execute(row); assert.equal(count, 1);
  entry.attributes.hidden = "true"; await assert.rejects(service.execute(row)); assert.equal(count, 1);
  delete entry.attributes.hidden; entry.isConnected = false; await assert.rejects(service.execute(row));
  entry.isConnected = true;
  await service.execute({ ...row, ignoredPopup: node({ hidden: "true" }), action: () => { count++; } }); assert.equal(count, 2);
  await service.execute({ enabled: true, action: async () => { await Promise.resolve(); count++; } }); assert.equal(count, 3);
  const events = [], child = { dispatchEvent: event => events.push("child:" + event.type) };
  const popup = { querySelectorAll: () => [child], dispatchEvent: event => events.push(event.type), remove: () => events.push("remove") };
  service.sessions.set(win, { popups: [popup], nativePopups: [] }); service.dispose(win); service.dispose(win);
  assert.deepEqual(events, ["child:popuphiding", "child:popuphidden", "popuphiding", "popuphidden", "remove"]);
});

const matches = (target, selector) => selector.split(",").some(part => {
  const found = part.trim().match(/^([\w-]*)(?:\.([\w-]+))?(?:\[([\w-]+)\])?$/u);
  return !!found && (!found[1] || target.localName === found[1]) && (!found[2] || target.classList.has(found[2])) && (!found[3] || target.hasAttribute(found[3]));
});
const descendants = target => target.children.flatMap(child => [child, ...descendants(child)]);
function element(localName, attributes = {}, children = [], classes = []) {
  const classList = new Set(classes); classList.contains = name => classList.has(name);
  const self = { localName, attributes, children, classList, parentElement: null, isConnected: true, id: attributes.id || "", dataset: {}, events: [],
    getAttribute(name) { return this.attributes[name] ?? null; }, hasAttribute(name) { return name in this.attributes; },
    dispatchEvent(event) { this.events.push(event.type); return true; }, remove() {}, focus() {},
    closest(selector) { for (let target = this; target; target = target.parentElement) if (matches(target, selector)) return target; return null; },
    querySelectorAll(selector) { return descendants(this).filter(target => matches(target, selector)); },
    querySelector(selector) { return selector.startsWith(":scope > ") ? this.children.find(child => matches(child, selector.slice(9))) || null : this.querySelectorAll(selector)[0] || null; } };
  for (const child of children) child.parentElement = self;
  return self;
}
const item = (label, attributes = {}, classes) => element("menuitem", { label, ...attributes }, [], classes);
const menu = (label, children, attributes = {}, popup = {}) => element("menu", { label, ...attributes }, [element("menupopup", popup, children)]);
function windowFor({ menus = [], keys = [], commands = [], ...extra } = {}) {
  const root = element("window", {}, [element("menubar", {}, menus), element("keyset", {}, keys), element("commandset", {}, commands)]), queries = {}, created = [];
  root.append = child => { child.parentElement = root; root.children.push(child); };
  const document = { documentElement: root, activeElement: null, getElementById: id => descendants(root).find(target => target.id === id) || null,
    createXULElement: name => { const node = element(name); created.push(node); return node; },
    querySelectorAll(selector) {
      queries[selector] = (queries[selector] || 0) + 1;
      return selector === "menubar > menu" ? menus : selector === "key[command]" ? keys.filter(key => key.hasAttribute("command"))
        : selector === "commandset command, key[oncommand]" ? [...commands, ...keys.filter(key => key.hasAttribute("oncommand"))] : [];
    } };
  return { document, closed: false, Event, focus() {}, queries, created, ...extra };
}
// logError has Zotero's own body, which throws when a catch hands it undefined.
function host(t, { addons = [], manager, main = null } = {}) {
  const logged = [];
  globalThis.Zotero = { Reader: { getByTabID: () => undefined }, Items: { get: id => ({ id }) }, getString: name => name, ...(manager ? { MenuManager: { _menuManager: manager } } : {}) };
  globalThis.ChromeUtils = { importESModule: () => ({ AddonManager: { getAllAddons: async () => addons } }) };
  t.after(() => { delete globalThis.Zotero; delete globalThis.ChromeUtils; });
  const app = { stopped: false, windows: new Map(), data: { id: "qs@local" }, mainWindowFor: win => win?.ZoteroPane ? win : main, logError(err) { logged.push(err.message ? err.message : err.toString()); } };
  return { app, logged, service: new CommandService(app) };
}
const tabs = () => ({ selectedID: "zotero-pane", _tabs: [{ id: "zotero-pane", type: "library" }, { id: "reader-1", type: "reader" }], _history: [],
  parseTabType: type => ({ tabContentType: type }), _hasHook: () => true, _getHook: () => () => {} });
const pane = () => ({ getSelectedItems: () => [], getCollectionTreeRows: () => [], buildItemContextMenu() { throw new Error("built without a selection"); }, buildCollectionContextMenu() { throw new Error("built without a collection"); } });

test("indexing returns only commands that can run now and reads shortcuts from one lookup", async t => {
  const off = menu("Disabled submenu", [item("Inside disabled")], { disabled: "true" });
  const win = windowFor({ ZoteroPane: pane(), Zotero_Tabs: tabs(), commands: [element("command", { id: "cmd_open", oncommand: "open()" }), element("command", { id: "cmd_off", oncommand: "off()", disabled: "true" })],
    keys: [element("key", { command: "cmd_open", key: "O" }), element("key", { command: "cmd_open", key: "Z" }), element("key", { command: "cmd_off", key: "X" })],
    menus: [menu("File", [item("Open", { command: "cmd_open" }), item("Disabled", { disabled: "true", id: "a" }), item("Hidden", { hidden: "true", id: "b" }), item("Collapsed", { collapsed: "true", id: "c" }),
      item("Disabled command", { command: "cmd_off" }), item("EPUB only", { id: "d" }, ["menu-type-reader", "epub"]), off]), menu("Hidden menu", [item("Inside hidden")], { hidden: "true" })] });
  const { service, logged } = host(t), rows = await service.index(win);
  assert.deepEqual(rows.filter(row => row.node).map(row => [row.title, row.shortcut, row.enabled, row.reason]), [["Open", "O", true, ""]]);
  assert.equal(win.queries["key[command]"], 1);
  assert.deepEqual(off.children[0].events, [], "an unavailable submenu is never built");
  assert.ok(rows.every(row => row.enabled), "every returned row is available");
  assert.deepEqual(rows.filter(row => row.key.startsWith("zotero:tab:")).map(row => row.key), ["zotero:tab:closeOthers"]);
  assert.ok(!rows.some(row => row.key === "qs:outline"), "the outline switcher needs a reader");
  assert.equal(new Set(rows.map(row => row.key)).size, rows.length);
  assert.deepEqual(logged, [], "context menus are not built for an empty selection");
  assert.deepEqual(await service.rows(win, { text: "disabled" }), []);
});

test("numeric and repeated labels carry their parent menu, and identical commands collapse to one", async t => {
  const sizes = id => menu(id, [item("11", { type: "checkbox" }), item("12", { type: "checkbox" }), item("Reset", { id: id + "-reset", oncommand: "reset()" })], {}, { oncommand: id + "(event)" });
  const win = windowFor({ menus: [menu("View", [sizes("Note Font Size"), sizes("Note Tab Font Size"), item("Layout", { id: "layout" })]), menu("View", [sizes("Note Font Size")])] });
  const { service } = host(t), titles = (await service.index(win)).filter(row => row.node).map(row => row.title);
  assert.deepEqual(titles, ["Layout", "Note Font Size › 11", "Note Font Size › 12", "Note Font Size › Reset", "Note Tab Font Size › 11", "Note Tab Font Size › 12", "Note Tab Font Size › Reset"]);
  assert.ok(!(await service.index(win)).some(row => !/\p{L}/u.test(row.title)), "no command is a bare number");
  assert.equal((await service.rows(win, { text: "tab font 12" })).length, 1);
});

test("unavailable menu duplicates leave the available menu entry or commandset fallback selectable", async t => {
  const { service } = host(t);
  for (const fallback of [false, true]) {
    const disabled = item("Unavailable variant", { command: "cmd_run", disabled: "true" });
    const available = item("Available variant", { command: "cmd_run" });
    const command = element("command", { id: "cmd_run", label: "Run command", oncommand: "run()" });
    const win = windowFor({ menus: [menu("File", fallback ? [disabled] : [disabled, available])], commands: [command] });
    const rows = (await service.index(win)).filter(row => row.key === "zotero:cmd_run");
    assert.equal(rows.length, 1, "exactly one available representation is retained");
    assert.equal(rows[0].node, fallback ? command : available);
    assert.equal(rows[0].enabled, true);
  }
});

test("native recent collection shortcuts defer to the complete target tree without dropping new collection or other targets", async t => {
  const recent = item("Project B › Core", { image: "chrome://zotero/skin/16/universal/folder.svg" }), target = item("Core", { value: "C2" }), other = item("Core", { value: "C3" });
  const create = item("New Collection…", {}, ["zotero-menuitem-new-collection"]);
  const extension = item("Plugin action", { image: "chrome://zotero/skin/16/universal/folder.svg", oncommand: "plugin()" });
  const popup = element("menupopup", { id: "zotero-add-to-collection-popup" }, [create, recent, extension, menu("Project B", [target]), menu("Project A", [other])]);
  const itemPopup = element("menupopup", { id: "zotero-itemmenu" }, [element("menu", { label: "Add to Collection" }, [popup])]);
  const win = windowFor({ ZoteroPane: { ...pane(), getSelectedItems: () => [{ id: 1 }], buildItemContextMenu() {} } });
  win.document.documentElement.append(itemPopup);
  const { service } = host(t), rows = (await service.index(win)).filter(row => row.node);
  assert.deepEqual(new Set(rows.map(row => row.node)), new Set([create, target, other, extension]));
  assert.ok(!rows.some(row => row.node === recent), "recent shortcuts do not produce a second command for an existing target");
  assert.equal(new Set(rows.map(row => [row.source, row.title, row.path].join("\n"))).size, rows.length);
  assert.ok(rows.every(row => row.enabled));
});

test("a detached reader window without ZoteroPane or Zotero_Tabs indexes its menus and never fails with a non-Error", async t => {
  const broken = menu("Go", [item("First Page", { id: "first" })]); broken.children[0].dispatchEvent = () => { throw undefined; };
  const win = windowFor({ reader: { itemID: 5, _type: "pdf" }, menus: [menu("File", [item("Close", { command: "cmd_close" })]), broken, menu("View", [item("Hand Tool", { id: "hand" }, ["menu-type-reader", "pdf"])])],
    commands: [element("command", { id: "cmd_close", oncommand: "reader.close()" })] });
  win.document.l10n = { translateElements: () => Promise.reject() };
  win.document.getElementById("cmd_close").parentElement.children.push(element("menupopup", { id: "menu_EditPopup" }, [item("Undo", { command: "cmd_undo", "data-l10n-id": "undo" })]));
  const { service, logged } = host(t), rows = await service.index(win, { focus: null });
  assert.deepEqual(rows.filter(row => row.node).map(row => row.title).sort(), ["Close", "Hand Tool"]);
  assert.ok(rows.some(row => row.key === "qs:outline"), "reader commands are available");
  assert.ok(!rows.some(row => row.key.startsWith("zotero:tab:")));
  assert.equal(logged.length, 1, "the failing menu is reported as an Error and the others are kept");
  const partial = windowFor({ ZoteroPane: {}, Zotero_Tabs: {}, menus: [menu("File", [item("Open", { id: "open" })])] });
  assert.deepEqual((await service.index(partial)).filter(row => row.node).map(row => row.title), ["Open"]);
  globalThis.ChromeUtils.importESModule = () => ({ AddonManager: { getAllAddons: () => Promise.reject() } });
  assert.ok((await service.index(win)).length > 0, "a failed add-on lookup leaves native commands usable");
  globalThis.ChromeUtils.importESModule = () => { throw undefined; };
  await assert.rejects(service.index(win), error => error instanceof Error && !!error.message);
  for (const action of [() => Promise.reject(), () => { throw "plain text"; }]) await assert.rejects(service.execute({ enabled: true, action }), error => error instanceof Error && !!error.message);
});

test("rows carry the icon of their source: add-on icon for plugin commands and the Zotero icon for native ones", async t => {
  const manager = { options: [{ pluginID: "notes@example", target: "main/menubar/tools", menus: [{ _key: "zotero-custom-menu-notes" }] }, { pluginID: "notes@example", target: "reader/menubar/file", menus: [{ _key: "zotero-custom-menu-reader" }] }],
    _getOptionMainKey: option => "main-" + option.target,
    updateMenuPopup(popup, menus) { for (const data of menus) { const added = item("Export notes", {}, ["zotero-custom-menu-item", data._key]); added.parentElement = popup; popup.children.push(added); } } };
  const win = windowFor({ ZoteroPane: pane(), menus: [menu("Tools", [item("Add-ons", { id: "addons" }), menu("Zotero PDF Translate", [item("Translate", { id: "translate" })])])] });
  const { service } = host(t, { manager, addons: [{ id: "notes@example", name: "Notes", iconURL: "chrome://notes/icon.svg" }, { id: "pdf@example", name: "PDF Translate", iconURL: "chrome://pdf/icon.png" }, { id: "qs@local", name: "Zotero Quick Switcher", iconURL: null }] });
  const rows = await service.index(win), icon = title => rows.find(row => row.title === title).iconURL;
  assert.equal(icon("Add-ons"), "chrome://quickswitcher/content/zotero-command.svg");
  assert.equal(icon("Export notes"), "chrome://notes/icon.svg");
  assert.equal(icon("Translate"), "chrome://pdf/icon.png");
  assert.equal(rows.find(row => row.key === "qs:settings").iconURL, "");
  assert.equal(win.created.length, 1, "a reader-only plugin menu is not built outside a reader");
  const sources = await service.rows(win, parseCommandInput("@()", 2));
  assert.deepEqual(sources.map(row => [row.kind, row.title, row.iconURL, row.count]), [["command-source", "Notes", "chrome://notes/icon.svg", 1], ["command-source", "PDF Translate", "chrome://pdf/icon.png", 1],
    ["command-source", "Zotero", "chrome://quickswitcher/content/zotero-command.svg", 1], ["command-source", "Zotero Quick Switcher", "", 5]]);
});
