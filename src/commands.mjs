// SPDX-License-Identifier: AGPL-3.0-or-later
import { switchMatches, normalize } from "./core.mjs";
import { t } from "./i18n.mjs";

export function parseCommandInput(value, caret = value.length) {
  if (!value.startsWith("@")) return { text: value.replace(/^\\@/u, "@"), source: "", choosingSource: false };
  let start = value[1] === "(" ? 2 : 1, end = -1;
  for (let i = start; i < value.length; i++) {
    if (value[i] === "\\") { i++; continue; }
    if (value[1] === "(" ? value[i] === ")" : /\s/u.test(value[i])) { end = i; break; }
  }
  if (end < 0) end = value.length;
  const closed = value[1] === "(" && value[end] === ")", finish = end + (closed ? 1 : 0);
  return { text: value.slice(finish).trimStart(), source: value.slice(start, end).replace(/\\([\\()])/gu, "$1").trim(), choosingSource: caret >= start && caret <= end, finish, start, end };
}

const ZOTERO_ICON = "chrome://quickswitcher/content/zotero-command.svg";
// Gecko and plugins can reject with undefined, while Zotero.logError and the launcher both read error.message.
const asError = error => error && typeof error === "object" && "message" in error ? error : new Error(error == null ? t("当前上下文不可用") : String(error));
const hidden = node => node.hidden || node.getAttribute?.("hidden") === "true" || node.collapsed || node.getAttribute?.("collapsed") === "true";
const disabled = node => node.disabled || node.getAttribute?.("disabled") === "true";
const unmet = (dependency, context) => dependency === "items" && !context.items?.length || dependency === "collection" && !context.collectionTreeRows?.length
  || dependency === "reader" && !context.reader || dependency === "field" && !context.fieldName || context.available === false;
export function commandState(node, owner, dependency = "", context = {}, ignoredPopup) {
  const command = node.getAttribute("command"), target = command && owner.document.getElementById(command);
  let unavailable = disabled(node) || hidden(node) || !!target && (disabled(target) || hidden(target));
  for (let parent = node; parent; parent = parent.parentElement) {
    if (parent !== ignoredPopup) unavailable ||= hidden(parent) || disabled(parent);
    const types = [...(parent.classList || [])].filter(name => name.startsWith("menu-type-")).map(name => name.slice(10));
    if (types.length && !types.includes(context.tabType)) unavailable = true;
    if (types.includes("reader") && ["pdf", "epub", "snapshot"].some(type => parent.classList.contains(type)) && !parent.classList.contains(context.tabSubType)) unavailable = true;
  }
  unavailable ||= unmet(dependency, context);
  return { enabled: !unavailable, dependency, reason: unavailable ? t(({ items: "需选择适用条目", collection: "需选择适用目录", reader: "需当前阅读器", field: "需选中信息字段" })[dependency] || "当前上下文不可用") : "" };
}

export class CommandService {
  constructor(app) { this.app = app; this.sessions = new Map(); }
  dispose(win) {
    const session = this.sessions.get(win); if (!session) return;
    for (const popup of session.popups) {
      for (const child of [...popup.querySelectorAll("menupopup"), popup]) for (const type of ["popuphiding", "popuphidden"]) child.dispatchEvent(new win.Event(type));
      popup.remove();
    }
    for (const popup of session.nativePopups) popup.dispatchEvent(new win.Event("popuphidden"));
    this.sessions.delete(win);
  }
  // Resolves with available commands only; unavailable ones are never collected.
  async index(win, options) {
    try { return await this.collect(win, options); } catch (error) { throw asError(error); }
  }
  async collect(win, { focus } = {}) {
    this.dispose(win);
    const doc = win.document, app = this.app, tabs = win.Zotero_Tabs, report = error => app.logError(asError(error));
    const read = (get, fallback) => { try { return get() ?? fallback; } catch (error) { report(error); return fallback; } };
    // A detached reader window has neither Zotero_Tabs nor ZoteroPane, and the main window may still be loading them.
    const reader = win.reader || tabs && read(() => Zotero.Reader.getByTabID?.(tabs.selectedID));
    const main = app.mainWindowFor(win), pane = main?.ZoteroPane;
    const items = read(() => pane?.getSelectedItems?.(), []), collectionTreeRows = read(() => pane?.getCollectionTreeRows?.(), []);
    const tab = tabs?._tabs?.find(tab => tab.id === tabs.selectedID);
    const context = { items: reader ? [reader.itemID && read(() => Zotero.Items.get(reader.itemID))].filter(Boolean) : items, collectionTreeRows, reader,
      tabType: reader ? "reader" : tab?.type || "library", tabSubType: reader?._type, tabID: reader?.tabID || tab?.id || "zotero-pane" };
    const infoRow = focus?.closest?.("[fieldname],[data-fieldname]");
    if (infoRow) { context.fieldName = infoRow.getAttribute("fieldname") || infoRow.dataset.fieldname; context.targetElem = new WeakRef(infoRow); context.editable = infoRow.closest("item-box")?.editable; }
    const session = { popups: [], nativePopups: [], rows: [], context, focus }; this.sessions.set(win, session);
    const current = () => !app.stopped && !win.closed && this.sessions.get(win) === session;
    // Edit controllers must reflect the original focus rather than the palette's text box.
    const previousFocus = doc.activeElement, editPopup = doc.getElementById("menu_EditPopup");
    const launcher = app.windows.get(win)?.launcher, allowed = launcher?.allowOutsideFocus;
    let editStates = new Map();
    try {
      if (launcher) launcher.allowOutsideFocus = true;
      focus?.isConnected && focus.focus();
      editPopup?.dispatchEvent(new win.Event("popupshowing", { cancelable: true }));
      editStates = new Map([...editPopup?.querySelectorAll("menuitem[command]") || []].map(node => [node.getAttribute("command"), commandState(node, win, "", context)]));
    } catch (error) { report(error); }
    finally { if (launcher) launcher.allowOutsideFocus = allowed; previousFocus?.isConnected && previousFocus.focus(); }
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    // AddonManager is asynchronous: one read per index supplies every row's source name and icon.
    const addons = new Map((await AddonManager.getAllAddons().catch(error => { report(error); return []; })).map(addon => [addon.id, { name: addon.name, iconURL: addon.iconURL || "" }]));
    if (!current()) return [];
    const manager = Zotero.MenuManager?._menuManager, options = manager?.options || [], pluginFor = new Map(), menuFor = new Map();
    const remember = menus => { for (const menu of menus) { menuFor.set(menu._key, menu); if (menu.menus) remember(menu.menus); } };
    for (const option of options) { pluginFor.set(manager._getOptionMainKey(option), option.pluginID); remember(option.menus); }
    const visited = new Set(), rows = session.rows, nodes = new Set(), labels = new Set(), shortcuts = new Map();
    for (const key of doc.querySelectorAll("key[command]")) if (!shortcuts.has(key.getAttribute("command"))) shortcuts.set(key.getAttribute("command"), key.getAttribute("key") || "");
    const add = (node, path = [], source = "zotero", dependency = "", sourceTitle = "Zotero", rowContext = context, ignoredPopup, label) => {
      if (nodes.has(node) || !["menuitem", "command", "key"].includes(node.localName) || node.hasAttribute("data-qs-key")) return;
      // Recent collection shortcuts repeat targets already in the complete native tree and expose no target identity.
      if (source === "zotero" && node.parentElement?.id === "zotero-add-to-collection-popup" && !node.id
        && !node.hasAttribute("value") && !node.hasAttribute("command") && !node.hasAttribute("oncommand")
        && node.getAttribute("image") === "chrome://zotero/skin/16/universal/folder.svg") return;
      const title = label || node.getAttribute("label") || node.label || node.getAttribute("aria-label"); if (!title?.trim()) return;
      if (!node.hasAttribute("oncommand") && !node.hasAttribute("command") && node.localName === "command" && !node.id) return;
      for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) {
        const mainKey = [...ancestor.classList || []].find(name => pluginFor.has(name));
        if (mainKey) {
          // Registered plugin menus get fresh owned nodes below; reused native nodes retain idle cleanup listeners.
          if (!ignoredPopup) return;
          source = pluginFor.get(mainKey); sourceTitle = addons.get(source)?.name || source; break;
        }
      }
      nodes.add(node);
      const commandID = node.localName === "command" ? node.id : node.getAttribute("command");
      const menuKey = [...node.classList].find(name => /^zotero-custom-menu-(?!item$|group-)/u.test(name));
      const key = source + ":" + (commandID || menuKey || node.id || path.join("/") + ":" + title);
      if (visited.has(key)) return;
      const inferred = dependency || (node.closest(".menu-type-reader") ? "reader" : /(?:copyCitation|copyBibliography|copyAnnotation|newChild|showFile|export_files)/iu.test(commandID || node.id || "") ? "items" : "");
      const state = editStates.has(commandID) ? { ...editStates.get(commandID), dependency: inferred } : commandState(node, win, inferred, rowContext, ignoredPopup);
      if (!state.enabled) return;
      visited.add(key);
      // Different nodes with one source, full label and handler are the same command.
      const full = [...path, title].join(" › "), handler = commandID || node.getAttribute("oncommand") || node.closest("menupopup[oncommand]")?.getAttribute("oncommand");
      if (handler) { const same = [source, full, handler].join("\n"); if (labels.has(same)) return; labels.add(same); }
      const menu = menuKey && menuFor.get(menuKey);
      const action = menu?.onCommand && (() => {
        const event = new win.Event("command", { bubbles: true, cancelable: true });
        Object.defineProperties(event, { target: { value: node }, currentTarget: { value: node } });
        return menu.onCommand(event, { ...rowContext, menuElem: node, setEnabled: enabled => { node.disabled = !enabled; }, setVisible: visible => { node.hidden = !visible; },
          setL10nArgs: args => { node.dataset.l10nArgs = args; }, setIcon: (icon, darkIcon) => {
            node.style.setProperty("--custom-menu-icon-light", `url(${icon})`); node.style.setProperty("--custom-menu-icon-dark", `url(${darkIcon || icon})`);
          } });
      });
      rows.push({ kind: "command", key, title, parent: path.at(-1) || "", source, sourceTitle, path: full, node, win, context: rowContext, ignoredPopup, ...(action ? { action } : {}),
        ...state, shortcut: shortcuts.get(commandID) || "" });
    };
    const scan = async (popup, path = [], source, dependency, sourceTitle, init = true, rowContext = context, ignoredPopup) => {
      if (!current()) return;
      if (init && popup !== editPopup) popup.dispatchEvent(new win.Event("popupshowing", { bubbles: false, cancelable: true }));
      if (!ignoredPopup && !session.nativePopups.includes(popup)) session.nativePopups.push(popup);
      // Nested popups translate their own children when scanned, so each element is translated once.
      const localized = [...popup.children].filter(node => node.hasAttribute("data-l10n-id"));
      // A message missing from this window (a plugin FTL only the main window loaded) rejects the whole call; labels that resolved still apply.
      if (localized.length) try { await doc.l10n?.translateElements?.(localized); } catch {}
      for (const node of [...popup.children]) {
        if (!current()) return;
        if (node.localName === "menu") {
          const sub = [...node.children].find(child => child.localName === "menupopup");
          // Nothing inside an unavailable submenu can run, so its popup is never built.
          if (sub && commandState(node, win, dependency, rowContext, ignoredPopup).enabled) await scan(sub, [...path, node.getAttribute("label") || ""].filter(Boolean), source, dependency, sourceTitle, true, rowContext, ignoredPopup);
        } else add(node, path, source, dependency, sourceTitle, rowContext, ignoredPopup);
      }
    };
    for (const menu of doc.querySelectorAll("menubar > menu")) {
      const popup = menu.querySelector(":scope > menupopup"); if (!popup || hidden(menu) || disabled(menu)) continue;
      try { await scan(popup, [menu.getAttribute("label") || ""].filter(Boolean), "zotero", "", "Zotero"); }
      catch (error) { report(error); }
    }
    const library = { ...context, items, available: context.tabType === "library" };
    if (win.ZoteroPane) for (const [id, method, dependency] of [["zotero-itemmenu", "buildItemContextMenu", "items"], ["zotero-collectionmenu", "buildCollectionContextMenu", "collection"]]) {
      if (unmet(dependency, library)) continue;
      try { await win.ZoteroPane[method](); const popup = doc.getElementById(id); if (popup) await scan(popup, [t(dependency === "items" ? "条目" : "目录")], "zotero", dependency, "Zotero", false, library); }
      catch (error) { report(error); }
    }
    for (const option of options) {
      if (!current()) return [];
      const dependency = option.target === "itemPane/info/row" ? "field" : option.target.includes("collection") ? "collection" : /item|Note|Attachment|locate/iu.test(option.target) ? "items" : option.target.startsWith("reader/") ? "reader" : "";
      const rowContext = { ...context, ...(option.target.startsWith("main/library/") ? { items, available: !!win.ZoteroPane && context.tabType === "library" }
        : option.target.startsWith("main/") ? { available: !!win.ZoteroPane } : option.target.startsWith("reader/") ? { available: !!reader } : {}) };
      if (unmet(dependency, rowContext)) continue;
      const popup = doc.createXULElement("menupopup"); popup.hidden = true; popup.dataset.qsCommandPopup = "true"; doc.documentElement.append(popup); session.popups.push(popup);
      try {
        manager.updateMenuPopup(popup, option.menus, option.target, { event: new win.Event("popupshowing"), getContext: () => rowContext, tabType: context.tabType, tabSubType: context.tabSubType, skipGrouping: true });
        await scan(popup, [], option.pluginID, dependency, addons.get(option.pluginID)?.name || option.pluginID, false, rowContext, popup);
      } catch (error) { report(error); }
    }
    for (const node of doc.querySelectorAll("commandset command, key[oncommand]")) {
      if (node.id?.startsWith("qs-") || node.hasAttribute("data-qs-key") || visited.has("zotero:" + node.id)) continue;
      const name = node.getAttribute("label") || node.getAttribute("aria-label") || node.id?.replace(/^(?:cmd_|key_)(?:zotero_)?/u, "").replace(/[_-]/gu, " ").replace(/([a-z])([A-Z])/gu, "$1 $2");
      if (!name) continue;
      add(node, ["Zotero"], "zotero", "", "Zotero", context, undefined, name);
    }
    if (tab) try {
      const index = tabs._tabs.indexOf(tab), contentType = tabs.parseTabType(tab.type).tabContentType;
      const tabAction = (key, label, action, enabled = true) => enabled && rows.push({ kind: "command", key: "zotero:tab:" + key, title: Zotero.getString(label), parent: t("标签页"),
        source: "zotero", sourceTitle: "Zotero", path: t("标签页"), win, action, enabled, dependency: "tab", reason: "" });
      if (tab.id !== "zotero-pane") {
        tabAction("library", "general.showInLibrary", () => pane.selectItem(context.items[0].parentID || context.items[0].id), !!context.items[0] && !!pane);
        tabAction("start", "tabs.moveToStart", () => tabs.move(tab.id, 1), index !== 1);
        tabAction("end", "tabs.moveToEnd", () => tabs.move(tab.id, tabs._tabs.length), index !== tabs._tabs.length - 1);
        for (const [key, label] of [["moveToNewWindow", "tabs.moveToWindow"], ["duplicate", "tabs.duplicate"]]) {
          if (tabs._hasHook(contentType, key)) tabAction(key, label, () => tabs._getHook(contentType, key)(tab, index));
        }
        if (!rows.some(row => row.node?.id === "menu_close_tab" || row.key === "zotero:menu_close_tab")) tabAction("close", "general.close", () => tabs.close(tab.id));
      }
      if (!(tabs._tabs.length === 2 && tab.id !== "zotero-pane")) tabAction("closeOthers", "tabs.closeOther", () => tabs.close(tabs._tabs.slice(1).filter(other => other.id !== tab.id).map(other => other.id)), tabs._tabs.length > 1);
      if (tabs._hasHook(contentType, "undoClose")) tabAction("undoClose", "tabs.undoClose", () => tabs.undoClose(), !!tabs._history.length);
    } catch (error) { report(error); }
    const nativeSources = new Set(rows.map(row => row.source)), names = [...addons].map(([id, addon]) => [id, addon.name, normalize(addon.name)]), owners = new Map();
    // The first add-on named by a menu label, resolved once per menu rather than once per row.
    const owner = menu => {
      if (!owners.has(menu)) { const label = normalize(menu.getAttribute("label") || ""); owners.set(menu, names.findIndex(([, , name]) => name && label.includes(name))); }
      return owners.get(menu);
    };
    // Older plugins attach menu DOM directly; their surrounding menu label is the source when identifiable.
    for (const row of rows) if (row.source === "zotero" && row.node) {
      let first = -1; for (let node = row.node.parentElement; node; node = node.parentElement) if (node.localName === "menu" && owner(node) >= 0 && (first < 0 || owner(node) < first)) first = owner(node);
      const addon = names[first];
      if (addon && !nativeSources.has(addon[0])) { row.source = addon[0]; row.sourceTitle = addon[1]; }
    }
    if (!current()) return [];
    for (const [key, title, action, dependency] of [["search", "文献检索", () => app.launcherFor(win).show(), ""], ["advanced", "高级搜索", () => app.launcherFor(win).show("items", true), ""],
      ["tabs", "标签页切换", () => app.launcherFor(win).showSwitch("tabs"), ""], ["outline", "大纲切换", () => app.launcherFor(win).showSwitch("outline"), "reader"],
      ["directories", "目录切换", () => app.launcherFor(win).showSwitch("directories"), ""], ["settings", "设置", () => app.openPreferences(), ""]]) if (dependency !== "reader" || reader) {
      rows.push({ kind: "command", key: "qs:" + key, title: t(title), parent: "", source: app.data.id, sourceTitle: "Quick Switcher for Zotero", win, action, dependency, enabled: true, reason: "", path: "Quick Switcher for Zotero" });
    }
    // A bare number, or a label repeated within one source, names nothing alone; its parent menu supplies the context.
    const repeats = new Map(), labelOf = row => row.source + "\n" + row.title;
    for (const row of rows) repeats.set(labelOf(row), (repeats.get(labelOf(row)) || 0) + 1);
    for (const row of rows) {
      if (!/\p{L}/u.test(row.title) || repeats.get(labelOf(row)) > 1) row.title = (row.parent || row.sourceTitle) + " › " + row.title;
      row.iconURL = row.source === "zotero" ? ZOTERO_ICON : addons.get(row.source)?.iconURL || "";
    }
    return rows.sort((a, b) => a.sourceTitle.localeCompare(b.sourceTitle) || a.title.localeCompare(b.title, undefined, { numeric: true }));
  }
  async rows(win, query) {
    const session = this.sessions.get(win); if (!session) return [];
    if (query.choosingSource) {
      const sources = new Map();
      for (const row of session.rows) {
        if (sources.has(row.source)) sources.get(row.source).count++;
        else sources.set(row.source, { kind: "command-source", key: row.source, title: row.sourceTitle, source: row.source, iconURL: row.iconURL, count: 1 });
      }
      return [...sources.values()].filter(source => switchMatches(source.title, query.source));
    }
    return session.rows.filter(row => (query.sourceID ? row.source === query.sourceID : !query.source || switchMatches(row.sourceTitle, query.source) || row.source === query.source) && switchMatches(row.title + " " + row.path, query.text));
  }
  async execute(row) {
    try { return await this.run(row); } catch (error) { throw asError(error); }
  }
  async run(row) {
    if (row.action) {
      if (!row.enabled || this.app.stopped || row.node && (!row.node.isConnected || !commandState(row.node, row.win, row.dependency, row.context, row.ignoredPopup).enabled)) throw new Error(t("当前上下文不可用"));
      await row.action(); return true;
    }
    if (row.win.closed || this.app.stopped || !row.node.isConnected) throw new Error(t("命令已不可用，请重新打开面板"));
    if (!commandState(row.node, row.win, row.dependency, row.context, row.ignoredPopup).enabled) throw new Error(t("当前上下文不可用"));
    row.win.focus();
    if (typeof row.node.doCommand === "function") row.node.doCommand();
    else row.node.dispatchEvent(new row.win.Event("command", { bubbles: true, cancelable: true }));
    return true;
  }
  destroy() { for (const win of [...this.sessions.keys()]) this.dispose(win); }
}
