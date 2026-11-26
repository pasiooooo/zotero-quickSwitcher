// SPDX-License-Identifier: AGPL-3.0-or-later
import { Prefs, renderPreferences, DEFAULTS } from "./prefs.mjs";
import { SearchService } from "./search.mjs";
import { LocationService } from "./locations.mjs";
import { DirectoryCounts } from "./directory-counts.mjs";
import { OutlineService } from "./outline.mjs";
import { Launcher } from "./launcher.mjs";
import { NativeAdapter, patch } from "./native.mjs";
import { SearchTreeAdapter } from "./tree.mjs";
import { LayoutStore } from "./layout.mjs";
import { SavedQueryAdapter, savedQueryConditions, encodeSavedSpec } from "./saved-queries.mjs";
import { ConfigStore } from "./config.mjs";
import { WebDAVSync } from "./webdav.mjs";
import { installWindowKeys } from "./window-keys.mjs";
import { tokenize, normalize, libraryKey, loadedItems, topItem, switchMatches } from "./core.mjs";
import { initialPDFPage, localPDF } from "./pdf-preview.mjs";
import { itemWebURL } from "./item-actions.mjs";
import { CommandService } from "./commands.mjs";
import { ClipboardService } from "./clipboard.mjs";
import { GlobalHotkey, globalWindowBounds, windowLoad, keepGlobalWindowOnTop } from "./global-hotkey.mjs";
import { installStyle } from "./dom.mjs";
import { filterMatches } from "./filter-match.mjs";
import { t, localize, refreshTranslations } from "./i18n.mjs";

class Application {
  constructor(data) {
    this.data = data; this.windows = new Map(); this.stopped = false;
    this.tabVisits = new WeakMap(); this.readerVisits = new WeakMap(); this.recentReads = new Map(); this.visitSequence = 0;
    this.pendingWindows = new Map();
    this.prefs = new Prefs(name => this.preferenceChanged(name), entries => this.config?.changed(entries).catch(error => {
      this.logError(error); this.sync?.say("pending", "配置保存失败，等待重试"); this.sync?.schedule();
    }));
    this.search = new SearchService(this.prefs, { onInvalidate: () => this.invalidate(), directories: () => this.directoryRows(null), tabs: () => this.tabRows(null),
      outlines: spec => this.outline.search("", spec.outlineSource || { type: "all" }, { owner: this.search, win: this.mainWindowFor(null) || [...this.windows.keys()].find(win => !win.closed), onUpdate: () => {
        this.search.filterGeneration++; this.invalidate();
        for (const entry of this.windows.values()) if (entry.native?.active && entry.native.currentSpec?.filters?.some(filter => filter.type === "outline")) entry.native.applyQuery(entry.native.currentSpec).catch(error => this.logError(error));
      } }) });
    this.locations = new LocationService({ onInvalidate: () => this.invalidate() });
    this.directoryCounts = new DirectoryCounts({ onInvalidate: () => this.invalidate() });
    this.outline = new OutlineService({ metadata: item => this.search.result(item, this.makeSpec(null), []), onInvalidate: () => this.invalidate(), onError: error => this.logError(error) });
    this.layout = new LayoutStore({ prefs: this.prefs, onChange: () => this.layoutChanged() });
    this.commands = new CommandService(this);
    this.clipboard = new ClipboardService(this.prefs);
    this.hotkey = new GlobalHotkey(); this.hotkeyError = "";
  }
  async init() {
    await this.layout.init();
    this.savedQueries = new SavedQueryAdapter(this).init();
    await this.outline.init();
    this.config = await new ConfigStore({ prefs: this.prefs, deviceID: this.layout.deviceID,
      onChange: () => this.sync?.schedule(), onApplied: () => this.refreshPreferences() }).init();
    this.paneID = await Zotero.PreferencePanes.register({ pluginID: this.data.id, id: "quickswitcher-preferences",
      label: "Zotero Quick Switcher", image: "chrome://quickswitcher/content/icon.svg", src: "chrome://quickswitcher/content/preferences.xhtml",
      scripts: ["chrome://quickswitcher/content/preferences.js"], defaultXUL: true });
    this.sync = new WebDAVSync({ prefs: this.prefs, layout: this.layout, config: this.config, onStatus: () => this.updateSyncStatus() });
    await this.sync.start();
    this.windowListener = {
      onOpenWindow: xulWindow => this.watchWindow(xulWindow.docShell.domWindow),
      onCloseWindow: xulWindow => this.unregisterWindow(xulWindow.docShell.domWindow).catch(error => this.logError(error)),
      onWindowTitleChange() {},
    };
    Services.wm.addListener(this.windowListener);
    for (const win of Zotero.getMainWindows()) await this.registerWindow(win);
    for (const win of Services.wm.getEnumerator("zotero:reader")) await this.registerWindow(win);
    this.restartHotkey();
    this.clipboard.start();
    return this;
  }
  logError(error) { Zotero.logError(error instanceof Error || error?.message ? error : new Error(String(error ?? "Quick Switcher operation failed"))); }
  restartHotkey() {
    const shortcut = this.prefs.get("globalShortcut");
    const revision = this.hotkeyRevision = (this.hotkeyRevision || 0) + 1;
    let failed = false;
    const status = error => {
      if (this.stopped || this.hotkeyRevision !== revision || this.prefs.get("globalShortcut") !== shortcut || !error && failed) return;
      if (error) failed = true;
      if (error) this.logError(error);
      const message = !error ? "" : [1409, -9878].includes(error.code) ? t("全局快捷键 {shortcut} 已被其他程序占用", { shortcut }) : t("全局快捷键注册失败：{message}", { message: error.message });
      this.hotkeyError = message;
      for (const win of Services.wm.getEnumerator(null)) for (const node of win.document.querySelectorAll(".qs-hotkey-state")) node.textContent = message;
    };
    // Also track the last external app for citation rules when the system-wide chord is disabled.
    const started = Zotero.isWin || Zotero.isMac ? this.hotkey.start(shortcut, (screen, sourceApp) => this.globalSearch(screen, sourceApp).catch(error => this.logError(error)), status) : this.hotkey.stop();
    return started.then(() => status(), status);
  }
  async globalSearch(screen, sourceApp = this.hotkey.sourceApp) {
    if (this.stopped) return;
    if (!this.globalWindow || this.globalWindow.closed) {
      const chrome = Ci.nsIWebBrowserChrome;
      const owner = Cc["@mozilla.org/appshell/appShellService;1"].getService(Ci.nsIAppShellService).createTopLevelWindow(null,
        Services.io.newURI("chrome://quickswitcher/content/global.xhtml"), chrome.CHROME_OPENAS_CHROME | chrome.CHROME_WINDOW_RESIZE | chrome.CHROME_SUPPRESS_ANIMATION, 1, 1);
      const win = this.globalWindow = owner.docShell.domWindow;
      win.docShell.treeOwner.QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIBaseWindow).visibility = false;
      const wait = this.globalWindowWait = windowLoad(win);
      const closed = () => {
        wait.cancel();
        if (this.globalWindow === win) this.globalWindow = null;
        if (this.globalWindowWait === wait) { this.globalWindowWait = null; this.globalWindowPromise = null; }
      };
      win.addEventListener("DOMWindowClose", closed, { once: true });
      win.addEventListener("unload", () => { if (win.closed) closed(); }, { once: true });
      this.globalWindowPromise = wait.promise.finally(() => { if (this.globalWindowWait === wait) { this.globalWindowWait = null; this.globalWindowPromise = null; } });
    }
    const win = this.globalWindowPromise ? await this.globalWindowPromise : this.globalWindow;
    if (this.stopped || !win || win.closed) return;
    await this.registerWindow(win);
    if (this.stopped || win.closed) return;
    const launcher = this.launcherFor(win);
    if (!launcher || launcher.composing) return;
    const entry = this.windows.get(win);
    entry.topmostCleanup?.();
    if (!entry.topmostRegistered) { entry.topmostRegistered = true; entry.cleanups.push(() => entry.topmostCleanup?.()); }
    if (!screen) {
      const scale = win.devicePixelRatio || 1, current = win.screen;
      screen = { left: current.availLeft * scale, top: current.availTop * scale, width: current.availWidth * scale, height: current.availHeight * scale };
    }
    const bounds = globalWindowBounds(screen, this.prefs.get("width"), this.prefs.get("height"));
    const native = win.docShell.treeOwner.QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIBaseWindow);
    native.setPositionAndSize(bounds.left, bounds.top, bounds.width, bounds.height, true);
    launcher.root.classList.add("qs-global");
    launcher.onHide = () => { entry.topmostCleanup?.(); native.visibility = false; };
    launcher.show("items", false, sourceApp);
    native.visibility = true;
    if (!Zotero.isWin) Zotero.Utilities.Internal.activate(win);
    try { entry.topmostCleanup = keepGlobalWindowOnTop(win, { onError: error => this.logError(error) }); }
    catch (error) { this.logError(error); entry.topmostCleanup = null; }
    launcher.input.focus();
  }
  mainWindowFor(win) { return win?.ZoteroPane && !win.closed ? win : Zotero.getMainWindow(); }
  plainContext(win) {
    const pane = this.mainWindowFor(win)?.ZoteroPane, row = pane?.collectionsView?.selectedTreeRow;
    let readerLibraryID;
    const reader = this.outline.context(win).reader;
    if (reader?.itemID) { try { readerLibraryID = Zotero.Items.getLibraryAndKeyFromID(reader.itemID).libraryID; } catch { /* The reader's item may have been removed. */ } }
    let libraryID = readerLibraryID || pane?.getSelectedLibraryIDs?.()[0] || Zotero.Libraries.userLibraryID;
    if (!["user", "group", "feed"].includes(Zotero.Libraries.get(libraryID)?.libraryType)) libraryID = Zotero.Libraries.userLibraryID;
    const lib = Zotero.Libraries.get(libraryID);
    const sameLibrary = row?.ref?.libraryID === libraryID;
    return { libraryID, libraryName: lib.name, collectionKey: sameLibrary && row?.isCollection?.() ? row.ref.key : undefined,
      collectionName: sameLibrary && row?.isCollection?.() ? row.ref.name : undefined, searchKey: sameLibrary && row?.isSearch?.() ? row.ref.key : undefined,
      searchName: sameLibrary && row?.isSearch?.() ? row.ref.name : undefined };
  }
  directoryContext(win) { return this.plainContext(this.mainWindowFor(win) || win); }
  context(win) { return this.outline.context(win).reader ? this.plainContext(win) : this.windows.get(win)?.native?.origin?.context || this.plainContext(win); }
  makeSpec(win, overrides = {}) { return this.search.makeQuery(win, overrides); }
  launcherFor(win) { return this.windows.get(win || Zotero.getMainWindow())?.launcher; }
  nativeFor(win) { return this.windows.get(win || Zotero.getMainWindow())?.native; }
  async ensureMainWindow(win, current = () => true) {
    if (!current()) return null;
    if (this.stopped) throw new Error(t("启动器已停用"));
    const existing = this.mainWindowFor(win);
    if (typeof existing?.ZoteroPane?.itemsView?.waitForLoad === "function") {
      await this.registerWindow(existing);
      if (!current()) return null;
      if (!this.stopped && !existing.closed && this.nativeFor(existing)) return existing;
    }
    if (!this.mainWindowPromise) this.mainWindowPromise = (async () => {
      if (!Zotero.getMainWindow()) Zotero.openMainWindow();
      const deadline = Date.now() + 15000;
      let main;
      while (!this.stopped && Date.now() < deadline) {
        main = Zotero.getMainWindow();
        if (typeof main?.ZoteroPane?.itemsView?.waitForLoad === "function" && !main.closed) {
          await this.registerWindow(main);
          if (!this.stopped && !main.closed && this.nativeFor(main)) return main;
        }
        await Zotero.Promise.delay(25);
      }
      throw new Error(t("主窗口未能准备就绪，请重试"));
    })().finally(() => { this.mainWindowPromise = null; });
    return this.mainWindowPromise;
  }
  watchWindow(win) {
    if (this.stopped || this.pendingWindows.has(win)) return;
    const loaded = event => {
      if (event && event.target !== win.document) return;
      win.removeEventListener("load", loaded); this.pendingWindows.delete(win);
      if (!this.stopped && !win.closed && win.document.documentElement.getAttribute("windowtype") === "zotero:reader") {
        this.registerWindow(win).catch(error => this.logError(error));
      }
    };
    if (win.document.readyState === "complete" && win.document.documentElement?.getAttribute("windowtype") === "zotero:reader") loaded();
    else { this.pendingWindows.set(win, loaded); win.addEventListener("load", loaded); }
  }
  async registerWindow(win) {
    if (this.stopped || !win || win.closed) return;
    if (this.windows.has(win)) return this.windows.get(win).ready;
    const entry = { cleanups: [] }; this.windows.set(win, entry);
    const cancelled = new Promise(resolve => { entry.cancel = resolve; });
    entry.ready = (async () => {
      const main = !!win.ZoteroPane || win.document.documentElement?.getAttribute("windowtype") === "navigator:browser";
      if (main) {
        // A new main window mounts its item tree before creating the collection tree.
        while (!this.stopped && !entry.removed && !win.closed && (typeof win.ZoteroPane?.itemsView?.waitForLoad !== "function"
          || typeof win.ZoteroPane?.collectionsView?.waitForLoad !== "function")) {
          await Promise.race([Zotero.Promise.delay(25), cancelled]);
        }
        if (this.stopped || entry.removed || win.closed) return;
        await Promise.race([win.ZoteroPane.collectionsView.waitForLoad(), cancelled]);
        if (this.stopped || entry.removed || win.closed) return;
        await Promise.race([win.ZoteroPane.itemsView.waitForLoad(), cancelled]);
      }
      if (this.stopped || entry.removed || win.closed) return;
      entry.launcher = new Launcher(win, this);
      if (main) {
        entry.native = await new NativeAdapter(win, this).init();
        if (this.stopped || entry.removed || win.closed) return;
        entry.tree = await new SearchTreeAdapter(win, this).init();
        if (this.stopped || entry.removed || win.closed) return;
        patch(win.Zotero_Tabs, "showTabsMenu", original => (visible, button) => {
          if (visible === false) return original.call(win.Zotero_Tabs, visible, button);
          if (entry.launcher.isOpen && entry.launcher.switchMode === "tabs") entry.launcher.hide(); else entry.launcher.showSwitch("tabs");
        }, entry.cleanups);
        patch(win.Zotero_Tabs, "select", original => (...args) => {
          const result = original.apply(win.Zotero_Tabs, args);
          this.recordTabVisit(win);
          return result;
        }, entry.cleanups);
        const revealKeyUp = event => { if (["Control", "Alt"].includes(event.key)) entry.reveal?.refresh(); };
        win.addEventListener("keyup", revealKeyUp);
        entry.cleanups.push(() => win.removeEventListener("keyup", revealKeyUp));
      }
      const show = (mode, advanced = false) => { if (entry.launcher.composing) return false; entry.launcher.show(mode, advanced); };
      entry.keys = installWindowKeys(win, this.prefs, { items: () => show("items"), advanced: () => show("items", true),
        tabs: () => entry.launcher.composing ? false : entry.launcher.showSwitch("tabs"), outline: () => entry.launcher.composing ? false : entry.launcher.showSwitch("outline"),
        directories: () => entry.launcher.composing ? false : entry.launcher.showSwitch("directories"), commands: () => entry.launcher.composing ? false : entry.launcher.showSwitch("commands") });
      const focus = () => { this.sync.schedule(); this.recordTabVisit(win); };
      win.addEventListener("focus", focus);
      entry.cleanups.push(() => win.removeEventListener("focus", focus));
    })();
    try { await entry.ready; } catch (error) { await this.unregisterWindow(win); throw error; }
  }
  async unregisterWindow(win) {
    const pending = this.pendingWindows.get(win);
    if (pending) { win.removeEventListener("load", pending); this.pendingWindows.delete(win); }
    const entry = this.windows.get(win); if (!entry) return;
    entry.removed = true; entry.cancel?.(); await entry.ready?.catch(() => {});
    if (this.windows.get(win) !== entry) return;
    await entry.reveal?.cancel();
    this.windows.delete(win);
    for (const cleanup of entry.cleanups.splice(0).reverse()) cleanup();
    entry.keys?.destroy(); if (entry.launcher) entry.launcher.onHide = null;
    entry.launcher?.destroy(); await entry.tree?.destroy(); await entry.native?.destroy();
    this.commands?.dispose(win);
    win.document.getElementById("qs-style")?.remove();
  }
  invalidate() {
    this.savedQueries?.refresh();
    for (const entry of this.windows.values()) {
      entry.native?.invalidate();
      if (entry.launcher?.isOpen) entry.launcher.schedule(90, entry.launcher.mode === "outline");
    }
  }
  releaseOutlineSearch() {
    if (![...this.windows.values()].some(entry => entry.launcher?.isOpen && entry.launcher.outlineContext
      || entry.native?.currentSpec?.filters?.some(filter => filter.type === "outline"))) this.outline.release(this.search);
  }
  layoutChanged() {
    this.savedQueries?.refresh();
    for (const entry of this.windows.values()) {
      entry.tree?.refresh().catch(error => this.logError(error));
      if (entry.launcher?.isOpen) entry.launcher.schedule();
    }
    this.sync?.schedule();
  }
  preferenceChanged(name) {
    if (this.stopped) return;
    if (name.startsWith("dav") || name.startsWith("sync")) this.restartSync();
    if (name === "globalShortcut") this.restartHotkey();
    if (name === "clipboardSearch") this.clipboard.start();
    if (["recentItems", "lastQuery", "lastQueryBindings", "lastQueryScopes", "clock", "deviceID"].includes(name)) return;
    if (name === "language") {
      this.search.metadataCache.clear();
      for (const win of Services.wm.getEnumerator(null)) refreshTranslations(win.document);
    }
    for (const [win, entry] of this.windows) {
      if (name === "clipboardSearch" && !this.prefs.get(name)) entry.launcher?.finishClipboardDraft();
      if (name.endsWith("Shortcut")) entry.keys?.refresh();
      if (name.endsWith("Prefix")) entry.launcher?.updatePrefixes();
      if (name.endsWith("Prefix")) entry.native?.updatePrefixes().catch(error => this.logError(error));
      if (name === "language") { entry.native?.invalidate(); entry.launcher?.pdfPreview?.refreshLanguage(); }
      installStyle(win.document, this.prefs);
      if (name === "highlightColor") entry.native?.updateSidebar();
      if (entry.launcher?.isOpen) entry.launcher.schedule();
      if (["fields", "sources", "recursive"].includes(name) && entry.native?.active) {
        const spec = entry.native.spec(entry.native.searchbox.value);
        spec.nativeConditions = entry.native.currentSpec?.nativeConditions;
        entry.native.applyQuery(spec).catch(error => this.logError(error));
      }
    }
    this.refreshPreferences();
  }
  restartSync() { this.sync?.stop(); this.sync?.start().catch(error => this.logError(error)); }
  updateSyncStatus() {
    for (const win of Services.wm.getEnumerator(null)) for (const node of win.document.querySelectorAll(".qs-sync-state")) localize(node, { text: this.sync.status.message });
  }
  openPreferences() {
    const win = Zotero.Utilities.Internal.openPreferences(this.paneID);
    this.renderPreferences(win);
    return win;
  }
  renderPreferences(win) { renderPreferences(win, this); }
  refreshPreferences() {
    for (const win of Services.wm.getEnumerator(null)) {
      const root = win.document.getElementById("qs-preferences-root");
      if (root) { root.qsRefreshSettings?.(); installStyle(win.document, this.prefs); }
    }
  }
  async configFile(win, action) {
    const { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
    const picker = new FilePicker();
    picker.init(win, t(action === "export" ? "导出 Quick Switcher 配置" : "导入 Quick Switcher 配置"), action === "export" ? picker.modeSave : picker.modeOpen);
    picker.appendFilter("JSON", "*.json"); picker.defaultString = "quickswitcher-config.json";
    const result = await picker.show();
    if (result === picker.returnCancel) return false;
    if (action === "export") await IOUtils.writeUTF8(picker.file, JSON.stringify(this.prefs.exportConfig(), null, 2) + "\n", { tmpPath: picker.file + ".tmp" });
    else { const bytes = await IOUtils.stat(picker.file); if (bytes.size > 256 * 1024) throw new Error(t("配置文件超过 256 KB")); this.prefs.importConfig(JSON.parse(await IOUtils.readUTF8(picker.file))); }
    return true;
  }
  async saveSearch(spec, win) {
    if (spec.scope.type === "all") throw new Error(t("请先切换到单一文库再保存搜索"));
    const dynamic = spec.filters?.some(filter => ["outline", "tabs"].includes(filter.type));
    const stored = dynamic && encodeSavedSpec(spec);
    const name = { value: (spec.rawText || spec.text).trim() || t("新建搜索") };
    if (!Services.prompt.prompt(win, t("保存搜索"), t("搜索名称"), name, null, {})) return false;
    if (!name.value.trim()) throw new Error(t("请输入搜索名称"));
    const prepared = await this.search.prepare(spec);
    const search = dynamic ? new Zotero.Search() : this.search.buildSearch(prepared);
    if (dynamic) { search.libraryID = spec.scope.libraryID; search.fromJSON({ conditions: savedQueryConditions }); }
    search.name = name.value.trim();
    const library = Zotero.Libraries.get(search.libraryID);
    if (!library.editable) throw new Error(t("当前文库没有保存搜索的权限"));
    await search.saveTx();
    if (dynamic) {
      try { await this.layout.saveQuery(libraryKey(search.libraryID), search.key, stored); }
      catch (error) { await Zotero.Searches.erase(search.id); throw error; }
      await Zotero.Notifier.trigger("modify", "search", [search.id]);
    }
    return search;
  }
  async createCollection(rows, win, current = () => true) {
    if (!current() || !rows.length) return false;
    const items = [...new Map((await Promise.all(rows.map(row => topItem(row.itemID)))).map(item => [item.id, item])).values()];
    if (!current()) return false;
    const libraryID = items[0].libraryID;
    let collection;
    const validate = () => {
      if (items.some(item => item.deleted)) throw new Error(t("所选条目已删除，请刷新结果"));
      if (items.some(item => item.libraryID !== libraryID) || collection && collection.libraryID !== libraryID) throw new Error(t("请先选择同一文库的文献"));
      const library = Zotero.Libraries.get(libraryID);
      if (!library?.editable || !library.isChildObjectAllowed("collection")) throw new Error(t("当前文库不允许创建或加入目录"));
      if (collection?.deleted) throw new Error(t("文件夹已删除或尚未同步"));
    };
    validate();
    const target = await this.launcherFor(win).chooseCollection(libraryID);
    if (!current() || !target) return false;
    if (target.collectionID !== undefined) {
      collection = await Zotero.Collections.getAsync(target.collectionID);
      if (!current()) return false;
      if (!collection) throw new Error(t("文件夹已删除或尚未同步"));
      validate();
    }
    const creating = !collection;
    if (creating) {
      if (typeof target.name !== "string" || !target.name.trim()) throw new Error(t("请输入目录名称"));
      collection = new Zotero.Collection(); collection.libraryID = libraryID; collection.name = target.name.trim();
    }
    if (!creating) {
      await collection.loadDataType("childItems");
      if (!current()) return false;
    }
    await Zotero.Items.loadDataTypes(items, ["collections"]);
    if (!current()) return false;
    const cancelled = new Error("Collection addition cancelled");
    try {
      await Zotero.DB.executeTransaction(async () => {
        if (!current()) throw cancelled;
        validate();
        if (creating) await collection.save();
        if (!current()) throw cancelled;
        await collection.addItems(items.map(item => item.id), { skipSelect: true });
        if (!current()) throw cancelled;
      });
    } catch (error) {
      const reloads = items.map(item => item.reload(["collections"], true));
      if (!creating) reloads.push(collection.reload(["childItems"], true));
      await Promise.allSettled(reloads);
      if (error === cancelled) return false;
      throw error;
    }
    return { count: items.length, name: collection.name, collectionID: collection.id };
  }
  async directoryRows(win, text = "") {
    const words = tokenize(text), rows = [];
    for (const library of this.search.libraries()) {
      if (library.type === "feed") {
        rows.push({ kind: "feed", libraryID: library.libraryID, key: library.key, title: library.name, path: `RSS › ${library.name}`, pathSegments: ["RSS", library.name], pathKeys: ["rss", library.key], win });
        continue;
      }
      const collectionRows = new Map();
      rows.push({ kind: "library", libraryID: library.libraryID, title: library.name, path: library.name, pathSegments: [library.name], pathKeys: [library.key], win });
      for (const collection of Zotero.Collections.getByLibrary(library.libraryID, true)) {
        if (collection.deleted) continue;
        const location = await this.locations.collectionPath(collection.id);
        const row = { kind: "collection", libraryID: collection.libraryID, collectionID: collection.id, key: collection.key,
          title: collection.name, path: location.path, pathSegments: location.pathSegments, pathKeys: location.pathKeys, win };
        rows.push(row); collectionRows.set(collection.key, row);
      }
      for (const search of await Zotero.Searches.getAll(library.libraryID)) {
        const parent = collectionRows.get(this.layout.get(library.key, search.key)?.parentCollectionKey);
        const pathSegments = [...(parent?.pathSegments || [library.name]), search.name];
        rows.push({ kind: "search", libraryID: search.libraryID, searchID: search.id, key: search.key, title: search.name,
          path: pathSegments.join(" › "), pathSegments, pathKeys: [...(parent?.pathKeys || [library.key]), `search:${search.key}`], win });
      }
    }
    if (rows.some(row => row.kind === "feed")) rows.push({ kind: "feeds", libraryID: 0, key: "rss", title: "RSS", path: "RSS", pathSegments: ["RSS"], pathKeys: ["rss"], win });
    return rows.filter(row => words.every(word => filterMatches(`${row.title} ${row.path}`, word)));
  }
  async directoryStart(win) {
    const reader = this.outline.context(win).reader || win.reader;
    if (reader?.itemID) {
      const location = await this.locations.get(reader.itemID);
      if (location.status !== "ready") throw new Error(location.error || t("位置暂不可用"));
      return location.locations[0] ? { kind: location.locations[0].kind || "collection", libraryID: location.libraryID, key: location.locations[0].collectionKey || location.locations[0].key }
        : { kind: Zotero.Libraries.get(location.libraryID)?.libraryType === "feed" ? "feed" : "library", libraryID: location.libraryID };
    }
    const row = this.mainWindowFor(win)?.ZoteroPane.collectionsView?.selectedTreeRow;
    return row?.isCollection?.() ? { kind: "collection", libraryID: row.ref.libraryID, key: row.ref.key }
      : row?.isSearch?.() ? { kind: "search", libraryID: row.ref.libraryID, key: row.ref.key }
        : row?.id === "F1" ? { kind: "feeds", libraryID: 0 } : row?.ref?.libraryID ? { kind: Zotero.Libraries.get(row.ref.libraryID)?.libraryType === "feed" ? "feed" : "library", libraryID: row.ref.libraryID } : null;
  }
  async parentDirectory(row) {
    if (row.kind === "feeds") return row;
    if (row.kind === "feed") return { kind: "feeds", libraryID: 0, win: row.win };
    let parentKey;
    if (row.kind === "collection") {
      const collection = await Zotero.Collections.getAsync(row.collectionID || Zotero.Collections.getIDFromLibraryAndKey(row.libraryID, row.key));
      if (!collection || collection.deleted) throw new Error(t("文件夹已删除或尚未同步"));
      parentKey = collection.parentID && (await Zotero.Collections.getAsync(collection.parentID))?.key;
    } else if (row.kind === "search") parentKey = this.layout.get(libraryKey(row.libraryID), row.key)?.parentCollectionKey;
    return parentKey ? { kind: "collection", libraryID: row.libraryID, key: parentKey, win: row.win } : { kind: "library", libraryID: row.libraryID, win: row.win };
  }
  async directoryItems(row, limit) {
    const scope = row.kind === "collection" ? { type: "collection", libraryID: row.libraryID, collectionKey: row.key, recursive: this.prefs.get("recursive") }
      : row.kind === "search" ? { type: "search", libraryID: row.libraryID, searchKey: row.key } : { type: "library", libraryID: row.libraryID };
    if (row.kind === "feeds") {
      const results = await Promise.all(this.search.libraries().filter(library => library.type === "feed").map(library => this.directoryItems({ kind: "feed", libraryID: library.libraryID }, limit)));
      const itemIDs = results.flatMap(result => result.itemIDs);
      return { results: results.flatMap(result => result.results).slice(0, limit), itemIDs, total: itemIDs.length };
    }
    return this.search.search(this.makeSpec(null, { text: "", scope }), { limit });
  }
  async selectDirectory(row, current = () => true) {
    if (!current()) return false;
    const win = await this.ensureMainWindow(row.win, current);
    if (!current()) return false;
    win.Zotero_Tabs.select("zotero-pane");
    const collectionID = row.kind === "collection" && (row.collectionID || Zotero.Collections.getIDFromLibraryAndKey(row.libraryID, row.key));
    if (row.kind === "collection" && !collectionID) throw new Error(t("文件夹已删除或尚未同步"));
    const id = row.kind === "collection" ? `C${collectionID}` : row.kind === "search" ? `S${row.searchID || Zotero.Searches.getIDFromLibraryAndKey(row.libraryID, row.key)}` : row.kind === "feeds" ? "F1" : `L${row.libraryID}`;
    if (["feed", "feeds"].includes(row.kind)) {
      const index = win.ZoteroPane.collectionsView.getRowIndexByID("F1");
      if (index !== false && !win.ZoteroPane.collectionsView.isContainerOpen(index)) await win.ZoteroPane.collectionsView.toggleOpenState(index);
      if (!current()) return false;
    }
    await win.ZoteroPane.collectionsView.selectByID(id);
    if (!current()) return false;
    const success = win.ZoteroPane.collectionsView.selectedTreeRow?.id === id;
    if (success) {
      win.focus(); win.ZoteroPane.collectionsView.focus();
      if (row.itemID) await this.revealLocations(win, row.itemID, current);
    }
    return current() && success;
  }
  async revealLocations(win, itemID, current = () => true) {
    const entry = this.windows.get(win), view = win.ZoteroPane.collectionsView;
    if (!current() || !entry || entry.removed || this.stopped || win.closed) return;
    const version = entry.revealVersion = (entry.revealVersion || 0) + 1;
    const rowID = view.selectedTreeRow?.id, selected = win.ZoteroPane.getSelectedItems(true).join(",");
    const sameSelection = () => !win.closed && view.selectedTreeRow?.id === rowID && win.ZoteroPane.getSelectedItems(true).join(",") === selected;
    // Native tree focus is deferred and clears collection highlights on blur.
    await Zotero.Promise.delay(0);
    if (!current()) return;
    const locations = await Promise.all((Array.isArray(itemID) ? itemID : [itemID]).map(id => this.locations.get(id)));
    if (!current() || entry.removed || this.stopped || win.closed || entry.revealVersion !== version || !sameSelection()) return;
    const unavailable = locations.find(location => location.status !== "ready");
    if (unavailable) throw new Error(unavailable.error || t("位置暂不可用"));
    await entry.reveal?.cancel();
    if (!current() || entry.removed || this.stopped || win.closed || entry.revealVersion !== version || !sameSelection()) return;
    const ids = [...new Set(locations.flatMap(result => result.locations).filter(location => Number.isSafeInteger(location.collectionID)).map(location => `C${location.collectionID}`))];
    if (!ids.length) return;
    let timer, releaseTimer, painting, cancelled = false;
    const paint = () => painting ||= view.setHighlightedRows(ids).finally(() => { painting = null; });
    const reveal = {
      refresh: () => {
        if (cancelled) return;
        // Native Ctrl/Option keyup clears the highlight; repaint after its handler.
        win.clearTimeout(releaseTimer);
        releaseTimer = win.setTimeout(() => {
          if (!cancelled && entry.reveal === reveal && !entry.removed && !this.stopped && !entry.launcher?.isOpen && win.Zotero_Tabs.selectedID === "zotero-pane" && sameSelection()) {
            paint().catch(error => this.logError(error));
          }
        }, 0);
      },
      cancel: async () => {
        cancelled = true; win.clearTimeout(timer); win.clearTimeout(releaseTimer);
        await painting?.catch(() => {});
        if (entry.reveal !== reveal) return;
        entry.reveal = null;
        if (sameSelection()) await view.setHighlightedRows();
      },
    };
    entry.reveal = reveal;
    try {
      await paint();
      if (!current()) { await reveal.cancel(); return; }
      if (!cancelled && entry.reveal === reveal) timer = win.setTimeout(() => reveal.cancel().catch(error => this.logError(error)), 2200);
    } catch (error) { await reveal.cancel(); throw error; }
  }
  openOrganizationPicker(search, win) {
    const launcher = this.launcherFor(win); launcher.show("directories");
    launcher.directoryChoice = async row => {
      if (!["library", "collection"].includes(row.kind) || row.libraryID !== search.libraryID) throw new Error(t("请选择当前搜索所属文库的普通文件夹或文库根级"));
      await this.layout.place(libraryKey(search.libraryID), search.key, { parentCollectionKey: row.kind === "collection" ? row.key : null,
        anchorCollectionKey: null, anchorSide: "after", order: Date.now() });
      return true;
    };
    localize(launcher.input, { placeholder: ["选择「{name}」所在文件夹…", { name: search.name }] });
  }
  recordTabVisit(win) {
    const tab = win.Zotero_Tabs?._tabs.find(tab => tab.id === win.Zotero_Tabs.selectedID);
    if (!win.reader && (!tab || tab.id === "zotero-pane")) return;
    const visit = { time: Date.now(), order: ++this.visitSequence };
    if (win.reader) this.readerVisits.set(win, visit);
    else { if (!this.tabVisits.has(win)) this.tabVisits.set(win, new Map()); this.tabVisits.get(win).set(tab.id, visit); }
    const itemID = win.reader?.itemID || tab?.data?.itemID;
    if (itemID) this.recentReads.set(itemID, visit);
  }
  async recentRows(win, limit) {
    const libraries = this.search.libraries().map(lib => lib.libraryID);
    if (!libraries.length) return { results: [], total: 0, warnings: [] };
    const native = await Zotero.DB.queryAsync(`SELECT COALESCE(IA.parentItemID, IA.itemID) AS itemID, MAX(IA.lastRead) AS lastRead
      FROM itemAttachments IA JOIN items I ON I.itemID = COALESCE(IA.parentItemID, IA.itemID)
      WHERE I.libraryID IN (${libraries.map(() => "?").join(",")}) AND IA.lastRead IS NOT NULL
      AND IA.itemID NOT IN (SELECT itemID FROM deletedItems) AND I.itemID NOT IN (SELECT itemID FROM deletedItems)
      GROUP BY COALESCE(IA.parentItemID, IA.itemID) ORDER BY MAX(IA.lastRead) DESC LIMIT 200`, libraries);
    const visits = [...this.recentReads].map(([itemID, visit]) => ({ itemID, time: visit.time, order: visit.order }));
    visits.push(...native.map(row => ({ itemID: row.itemID, time: row.lastRead * 1000, order: 0 })));
    visits.sort((a, b) => b.time - a.time || b.order - a.order);
    const tops = new Map();
    for (const { itemID } of visits) {
      try {
        const item = await topItem(itemID);
        if (!item.deleted && libraries.includes(item.libraryID) && !tops.has(item.id)) tops.set(item.id, item);
      } catch { /* Deleted or unsynced reading records must not hide valid recent items. */ }
    }
    const visible = [...tops.values()].slice(0, limit);
    const spec = this.makeSpec(null, { text: "" });
    return { results: await Promise.all(visible.map(item => this.search.result(item, spec))), itemIDs: [...tops.keys()], total: tops.size, warnings: [] };
  }
  async tabRows(win, text = "", { literal = false } = {}) {
    const words = literal ? [] : tokenize(text).map(normalize), rows = [];
    for (const owner of Zotero.getMainWindows()) {
      for (const tab of owner.Zotero_Tabs._tabs) {
        if (tab.id === "zotero-pane") continue;
        let item, data;
        if (tab.data?.itemID) { try { item = await topItem(tab.data.itemID); data = await this.search.getMetadata(item); } catch { /* Keep existing tabs searchable when their item is unavailable. */ } }
        const visit = this.tabVisits.get(owner)?.get(tab.id);
        const row = { kind: "tab", tabID: tab.id, win: owner, itemID: item?.id, libraryID: item?.libraryID, attachmentID: tab.data?.itemID, title: data?.title || tab.title || t("无题名"), citationKey: data?.citationKey || "",
          authors: data?.creator || "", creatorDetails: data?.creatorDetails, year: data?.date || "", itemType: data?.itemType, itemIconType: data?.itemIconType, publicationTitle: data?.publicationTitle, publisher: data?.publisher,
          current: owner === win && tab.id === owner.Zotero_Tabs.selectedID, recent: visit?.time || (tab.timeSelected || tab.timeUnselected || 0) * 1000, visitOrder: visit?.order || 0 };
        if (literal ? switchMatches(`${row.title} ${row.authors} ${row.year} ${row.citationKey}`, text) : words.every(word => normalize(`${row.title} ${row.authors} ${row.year} ${row.citationKey}`).includes(word))) rows.push(row);
      }
    }
    for (const owner of Services.wm.getEnumerator("zotero:reader")) {
      if (owner.closed || !owner.reader) continue;
      const reader = owner.reader;
      let item, data;
      try { item = await topItem(reader.itemID); data = await this.search.getMetadata(item); } catch { /* Keep existing readers searchable when their item is unavailable. */ }
      const visit = this.readerVisits.get(owner);
      const row = { kind: "reader", reader, win: owner, itemID: item?.id, libraryID: item?.libraryID, attachmentID: reader.itemID, title: data?.title || t("无题名"), citationKey: data?.citationKey || "", authors: data?.creator || "", creatorDetails: data?.creatorDetails, year: data?.date || "", itemType: data?.itemType, itemIconType: data?.itemIconType, publicationTitle: data?.publicationTitle, publisher: data?.publisher,
        current: owner === win, recent: visit?.time || 0, visitOrder: visit?.order || 0 };
      if (literal ? switchMatches(`${row.title} ${row.authors} ${row.year} ${row.citationKey}`, text) : words.every(word => normalize(`${row.title} ${row.authors} ${row.year} ${row.citationKey}`).includes(word))) rows.push(row);
    }
    return rows.sort((a, b) => Number(a.current) - Number(b.current) || b.recent - a.recent || b.visitOrder - a.visitOrder);
  }
  async openTab(row) {
    if (row.kind === "reader") {
      if (row.win.closed || row.win.reader !== row.reader) throw new Error(t("阅读器已关闭，请重新检索"));
      row.win.focus(); await row.reader.focus();
      if (row.win.closed || row.win.reader !== row.reader) throw new Error(t("阅读器已关闭，请重新检索"));
      return true;
    }
    if (row.win.closed || !row.win.Zotero_Tabs._tabs.some(tab => tab.id === row.tabID)) throw new Error(t("标签页已关闭，请重新检索"));
    row.win.focus(); row.win.Zotero_Tabs.select(row.tabID); return true;
  }
  async openPDFWindow(row) {
    const pdf = row.attachmentID ? { attachmentID: row.attachmentID } : await localPDF(row.itemID);
    const attachment = pdf.attachmentID && await Zotero.Items.getAsync(pdf.attachmentID);
    if (!attachment?.isPDFAttachment() || !await attachment.getFilePathAsync()) throw new Error(t("当前标签页没有本机 PDF"));
    const reader = await Zotero.Reader.open(attachment.id, { pageIndex: await initialPDFPage(row, attachment.id) }, { openInWindow: true, allowDuplicate: true });
    await reader?._initPromise; await reader?.focus(); return !!reader;
  }
  async openItemURL(row) {
    const item = await topItem(row.itemID);
    Zotero.launchURL(itemWebURL(item)); return true;
  }
  async locateItems(rows, current = () => true) {
    const cancelled = { count: 0, failed: rows, cancelled: true };
    if (!current()) return cancelled;
    const loaded = await Promise.allSettled(rows.map(row => topItem(row.itemID))), valid = [], failed = [];
    if (!current()) return cancelled;
    for (const [index, result] of loaded.entries()) {
      if (result.status === "fulfilled" && result.value && !result.value.deleted) valid.push({ item: result.value, row: rows[index] });
      else failed.push(rows[index]);
    }
    const first = valid[0]?.row;
    if (!first) return { count: 0, failed };
    const opened = await this.openItem(first, { locate: true, current });
    if (!current()) return cancelled;
    if (!opened) return { count: 0, failed: rows };
    const win = await this.ensureMainWindow(first.win, current);
    if (!current()) return cancelled;
    const pane = win.ZoteroPane, selected = pane.collectionsView.selectedTreeRow;
    const members = valid.map(entry => entry.item).filter(item => item.libraryID === selected.ref?.libraryID && (!selected.isCollection?.() || item.getCollections().includes(selected.ref.id)));
    await pane.itemsView.selectItems([...new Set(members.map(item => item.id))]);
    if (!current()) return cancelled;
    const selectedIDs = new Set(pane.getSelectedItems(true));
    for (const entry of valid) if (!selectedIDs.has(entry.item.id)) failed.push(entry.row);
    pane.itemsView.focus(); await this.revealLocations(win, valid.map(entry => entry.item.id), current);
    if (!current()) return cancelled;
    return { count: rows.length - failed.length, failed };
  }
  async openItem(row, { locate = false, location, current = () => true } = {}) {
    if (!current()) return false;
    const item = await topItem(row.itemID);
    if (!current()) return false;
    const win = await this.ensureMainWindow(row.win, current);
    if (!current()) return false;
    if (locate || location) {
      if (!location) {
        const locations = await this.locations.get(item);
        if (!current()) return false;
        if (locations.status !== "ready") throw new Error(locations.error || t("位置暂不可用"));
        location = locations.locations[0];
      }
      win.Zotero_Tabs.select("zotero-pane");
      if (location) {
        if (location.kind === "feed") {
          if (!await this.selectDirectory({ ...location, win }, current) || !current()) return false;
          await win.ZoteroPane.itemsView.selectItem(item.id); return current() && win.ZoteroPane.getSelectedItems(true).includes(item.id);
        }
        if (!item.getCollections().includes(location.collectionID)) throw new Error(t("条目已不在此文件夹中，正在刷新位置"));
        await win.ZoteroPane.collectionsView.selectByID(`C${location.collectionID}`);
        if (!current()) return false;
        if (win.ZoteroPane.collectionsView.selectedTreeRow?.id !== `C${location.collectionID}`) return false;
        await win.ZoteroPane.itemsView.selectItem(item.id);
        if (!current()) return false;
        const success = win.ZoteroPane.getSelectedItems(true).includes(item.id);
        if (success) { win.focus(); win.ZoteroPane.itemsView.focus(); await this.revealLocations(win, item.id, current); }
        return current() && success;
      }
      await win.ZoteroPane.selectItem(item.id);
      if (!current()) return false;
      const success = win.ZoteroPane.getSelectedItems(true).includes(item.id);
      if (success) win.focus();
      return success;
    }
    let attachment = item.isAttachment() ? item : item.isRegularItem() ? await item.getBestAttachment() : null;
    if (!current()) return false;
    if (attachment && !["pdf", "epub"].includes(attachment.attachmentReaderType)) {
      const attachments = await loadedItems(item.getAttachments?.() || []);
      if (!current()) return false;
      attachment = attachments.find(candidate => ["pdf", "epub"].includes(candidate.attachmentReaderType));
    }
    if (attachment) { await Zotero.Reader.open(attachment.id, null, { allowDuplicate: false }); }
    else { await win.ZoteroPane.selectItem(item.id); if (!current() || !win.ZoteroPane.getSelectedItems(true).includes(item.id)) return false; win.focus(); }
    if (!current()) return false;
    this.prefs.set("recentItems", [item.id, ...this.prefs.get("recentItems").filter(id => id !== item.id)].slice(0, 200));
    return true;
  }
  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      this.stopped = true;
      this.clipboard?.destroy();
      this.globalWindowWait?.cancel(); this.globalWindowWait = this.globalWindowPromise = null;
      if (this.globalWindow && !this.globalWindow.closed) this.globalWindow.close();
      for (const entry of this.windows.values()) entry.cancel?.();
      if (this.windowListener) Services.wm.removeListener(this.windowListener);
      for (const [win, loaded] of this.pendingWindows) win.removeEventListener("load", loaded);
      this.pendingWindows.clear(); await this.sync?.stop();
      await this.hotkey.stop();
      for (const win of Services.wm.getEnumerator(null)) {
        const root = win.document.getElementById("qs-preferences-root");
        if (root) await root.qsFlushCredential?.(true);
      }
      if (this.paneID) Zotero.PreferencePanes.unregister(this.paneID);
      for (const win of [...this.windows.keys()]) await this.unregisterWindow(win);
      this.search.destroy(); this.locations.destroy(); this.directoryCounts.destroy(); await this.outline.destroy(); await this.layout.destroy(); await this.config?.destroy();
      this.savedQueries?.destroy();
      this.commands?.destroy();
    })();
    return this.stopPromise;
  }
}

let app;
export async function start(data) {
  app = new Application(data); Zotero.QuickSwitcherRuntime = app;
  try { await app.init(); } catch (error) { await stop(); throw error; }
}
export async function registerWindow(win) { return app?.registerWindow(win); }
export async function unregisterWindow(win) { return app?.unregisterWindow(win); }
export async function stop() { if (app) { const current = app; app = null; try { await current.stop(); } finally { if (Zotero.QuickSwitcherRuntime === current) delete Zotero.QuickSwitcherRuntime; } } }
