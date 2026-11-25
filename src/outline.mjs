// SPDX-License-Identifier: AGPL-3.0-or-later
import { readPDFOutline } from "../addon/content/pdf-outline-data.js";
import { PDFOutlineLoader } from "./pdf-preview.mjs";
import { tokenize, normalize, topItem } from "./core.mjs";
import { filterMatches } from "./filter-match.mjs";
import { t } from "./i18n.mjs";
import { profileJSONStore } from "./layout.mjs";
import { patch } from "./native.mjs";
import { scrollOutlineRow } from "./outline-scroll.mjs";

const MAX_OUTLINE_CACHE_BYTES = 32 * 1024 * 1024;
const outlineFields = ["title", "parents", "outlineKey", "parentKey", "depth", "location", "pageIndex"];
export function parseOutlineCache(text, dataDirectory) {
  if (new TextEncoder().encode(text).length > MAX_OUTLINE_CACHE_BYTES) throw new Error("Outline cache is too large");
  const value = JSON.parse(text);
  if (value?.schemaVersion !== 1 || value.dataDirectory !== dataDirectory || !Array.isArray(value.entries) || value.entries.length > 100000) throw new Error("Invalid outline cache");
  return new Map(value.entries.map(([id, entry]) => {
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(entry?.itemID) || entry.itemID <= 0
      || typeof entry.fingerprint !== "string" || entry.fingerprint.length > 32768 || !Array.isArray(entry.rows) || entry.rows.length > 20000) throw new Error("Invalid cached PDF outline");
    const rows = entry.rows.map(row => {
      if (!row || typeof row.title !== "string" || !row.title.trim() || /[\x00-\x1F]/u.test(row.title)
        || !Array.isArray(row.parents) || row.parents.length > 64 || row.parents.some(title => typeof title !== "string" || /[\x00-\x1F]/u.test(title))
        || typeof row.outlineKey !== "string" || !/^\d+(?:\.\d+)*$/u.test(row.outlineKey) || row.outlineKey.length > 512
        || !(row.parentKey === null || typeof row.parentKey === "string" && row.outlineKey.startsWith(row.parentKey + "."))
        || !Number.isSafeInteger(row.depth) || row.depth !== row.parents.length
        || row.pageIndex !== undefined && (!Number.isSafeInteger(row.pageIndex) || row.pageIndex < 0)
        || row.location !== undefined && (!row.location || Array.isArray(row.location) || typeof row.location !== "object"
          || !Object.hasOwn(row.location, "dest") && !Object.hasOwn(row.location, "position") && !Number.isSafeInteger(row.location.pageIndex))) throw new Error("Invalid cached outline title");
      return Object.fromEntries(outlineFields.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]));
    });
    return [id, { itemID: entry.itemID, fingerprint: entry.fingerprint, rows }];
  }));
}

export function outlineMatches(row, text, terms = tokenize(text)) {
  const path = [...row.parents, row.title].join(" › ");
  return terms.every(term => filterMatches(path, term));
}
export function availableReader(reader) {
  try { return !!reader && !reader._window?.closed && !reader._isTabClosed; }
  catch { return false; }
}

export class OutlineService {
  constructor({ metadata, onInvalidate = () => {}, io, onError = () => {} }) {
    this.metadata = metadata; this.onInvalidate = onInvalidate; this.io = io; this.onError = onError;
    this.cache = new Map(); this.records = new Map(); this.interests = new Map(); this.currentLoads = new Map(); this.epoch = 0;
    this.observer = Zotero.Notifier.registerObserver({ notify: (action, type, ids) => {
      const changed = new Set(ids.map(Number));
      let affected = type === "group";
      for (const [id, entry] of this.cache) if (type === "group" || changed.has(id) || changed.has(entry.itemID)) { this.cache.delete(id); affected = true; }
      for (const [id, entry] of this.records) if ((type === "file" || ["delete", "trash"].includes(action)) && (changed.has(id) || changed.has(entry.itemID))) { this.records.delete(id); affected = true; this.dirty = true; }
      if (type === "group" || type === "item" && ["add", "delete", "trash", "restore"].includes(action)) { this.candidateIDs = null; affected = true; }
      if (affected) { this.epoch++; this.onInvalidate(); }
      if (this.dirty) this.scheduleSave();
    } }, ["item", "file", "group"]);
  }
  async init() {
    this.io ||= profileJSONStore("quickswitcher-outlines.json", MAX_OUTLINE_CACHE_BYTES);
    this.dataDirectory = Zotero.DataDirectory.dir;
    try { const text = await this.io.read(); if (text) this.records = parseOutlineCache(text, this.dataDirectory); }
    catch (error) { this.onError(error); }
    this.readerToolbar = ({ doc }) => this.followOutline(doc);
    Zotero.Reader.registerEventListener?.("renderToolbar", this.readerToolbar);
    for (const reader of Zotero.Reader._readers || []) if (availableReader(reader)) {
      Promise.resolve(reader._initPromise).then(() => { if (!this.destroyed && availableReader(reader)) this.followOutline(reader._iframeWindow.document); }).catch(error => this.onError(error));
    }
    return this;
  }
  followOutline(doc) {
    if (this.destroyed || this.outlineScrolls?.has(doc)) return;
    this.outlineScrolls ||= new WeakMap();
    const cleanups = [], prototype = (doc.defaultView.wrappedJSObject || doc.defaultView).Element.prototype;
    let navigating = false;
    const keydown = event => {
      if (!["ArrowUp", "ArrowDown"].includes(event.key) || !event.target?.closest?.("#outlineView")) return;
      navigating = true; queueMicrotask(() => { navigating = false; });
    };
    doc.addEventListener("keydown", keydown, true);
    cleanups.push(() => doc.removeEventListener("keydown", keydown, true));
    patch(prototype, "scrollIntoView", original => {
      const replacement = function (options) {
        if (options?.block === "nearest" && this.matches("#sidebarContent > .viewWrapper:not(.hidden) > #outlineView .item")) {
          return scrollOutlineRow(doc.getElementById("sidebarContent"), this, !navigating);
        }
        return original.call(this, options);
      };
      return globalThis.Components?.utils?.exportFunction ? Components.utils.exportFunction(replacement, prototype) : replacement;
    }, cleanups);
    this.outlineScrolls.set(doc, cleanups);
  }
  scheduleSave() {
    if (!this.io || this.saveTimer || this.destroyed) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flush().catch(error => this.onError(error)); }, 750);
  }
  async flush() {
    clearTimeout(this.saveTimer); this.saveTimer = null;
    await this.saving?.catch(() => {});
    if (!this.io || !this.dirty) return;
    const text = JSON.stringify({ schemaVersion: 1, dataDirectory: this.dataDirectory, entries: [...this.records] });
    if (new TextEncoder().encode(text).length > MAX_OUTLINE_CACHE_BYTES) { this.onError(new Error("Outline cache is too large")); return; }
    this.dirty = false;
    this.saving = this.io.write(text).catch(error => { this.dirty = true; throw error; });
    await this.saving;
  }
  context(win) {
    let reader = win?.reader;
    const tabID = win?.Zotero_Tabs?.selectedID;
    if (!reader && tabID && tabID !== "zotero-pane") reader = Zotero.Reader._readers?.find(reader => availableReader(reader) && reader.tabID === tabID) || Zotero.Reader.getByTabID(tabID);
    if (!availableReader(reader)) return { type: "all" };
    const item = reader && Zotero.Items.get(reader.itemID);
    if (!item?.isPDFAttachment()) return { type: "all" };
    const top = item.parentID ? Zotero.Items.get(item.parentID) : item;
    return { type: "pdf", attachmentID: item.id, title: top?.getDisplayTitle() || item.getDisplayTitle(), reader };
  }
  async candidates() {
    if (this.candidateIDs) return this.candidateIDs;
    const epoch = this.epoch;
    const libraries = Zotero.Libraries.getAll().filter(lib => ["user", "group"].includes(lib.libraryType)).map(lib => lib.libraryID);
    if (!libraries.length) return [];
    const rows = await Zotero.DB.queryAsync(`SELECT I.itemID, COALESCE(A.parentItemID, I.itemID) AS topItemID FROM items I JOIN itemAttachments A ON A.itemID = I.itemID
      WHERE I.libraryID IN (${libraries.map(() => "?").join(",")}) AND A.contentType = 'application/pdf'
      AND I.itemID NOT IN (SELECT itemID FROM deletedItems)
      AND (A.parentItemID IS NULL OR A.parentItemID NOT IN (SELECT itemID FROM deletedItems)) ORDER BY I.itemID`, libraries);
    const ids = rows.map(row => Number(row.itemID));
    if (epoch === this.epoch) { this.candidateIDs = ids; this.candidateItems = new Map(rows.map(row => [Number(row.itemID), Number(row.topItemID)])); }
    return ids;
  }
  async load(id, win, reader) {
    const epoch = this.epoch, item = await Zotero.Items.getAsync(id);
    if (!item || item.deleted || !item.isPDFAttachment()) return { rows: [], unavailable: true };
    const path = await item.getFilePathAsync();
    if (!path) return { rows: [], itemID: item.parentID || item.id, unavailable: true };
    const stat = await IOUtils.stat(path), fingerprint = `${path}:${stat.size}:${stat.lastModified}`;
    const cached = this.cache.get(id);
    if (cached?.fingerprint === fingerprint && cached.itemID === (item.parentID || item.id)) return cached;
    const persisted = this.records.get(id), reused = persisted?.fingerprint === fingerprint;
    let rows = reused ? persisted.rows : undefined;
    if (!rows && availableReader(reader) && reader.itemID === id) {
      await reader._initPromise;
      const view = reader._internalReader?._primaryView;
      await view?.initializedPromise;
      const pdf = view?._iframeWindow?.PDFViewerApplication?.pdfDocument;
      if (pdf) {
        const outline = reader._internalReader?._state?.outline;
        rows = await readPDFOutline(outline?.length ? {
          numPages: pdf.numPages, getOutline: async () => outline,
          getDestination: name => pdf.getDestination(name), getPageIndex: ref => pdf.getPageIndex(ref),
        } : pdf);
      }
    }
    if (!rows) {
      if (!this.loader || this.loader.win !== win) { this.loader?.destroy(); this.loader = new PDFOutlineLoader(win); }
      rows = await this.loader.read(path);
    }
    const top = await topItem(item), metadata = await this.metadata(top);
    if (epoch === this.epoch && (!reused || persisted.itemID !== top.id)) {
      this.records.set(id, { fingerprint, itemID: top.id, rows: rows.map(row => Object.fromEntries(outlineFields.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]))) });
      this.dirty = true; this.scheduleSave();
    }
    const value = { fingerprint, itemID: top.id, rows: rows.map(row => ({ ...metadata, ...row, kind: "outline", itemID: top.id,
      attachmentID: id, libraryID: top.libraryID, documentTitle: metadata.title, evidence: [], win })) };
    if (epoch === this.epoch) this.cache.set(id, value);
    return value;
  }
  async search(text, scope, { owner, win, onUpdate = () => {}, itemIDs }) {
    if (scope.type === "pdf") {
      this.release(owner);
      let cancel, timer;
      const cancelled = new Promise((resolve, reject) => { cancel = () => reject(new Error("Outline loading cancelled")); timer = win.setTimeout(() => reject(new Error(t("PDF 大纲读取超时"))), 60000); });
      this.currentLoads.set(owner, cancel);
      try {
        const value = await Promise.race([(async () => {
          await this.work?.catch(() => {});
          if (this.currentLoads.get(owner) !== cancel) throw new Error("Outline loading cancelled");
          return this.load(scope.attachmentID, win, scope.reader || this.reader(scope.attachmentID));
        })(), cancelled]);
        const terms = tokenize(text), rows = !itemIDs || itemIDs.has(value.itemID) ? value.rows.filter(row => outlineMatches(row, text, terms)) : [];
        return { rows, allRows: value.rows, total: rows.length, completed: 1, documents: 1, pending: false, unavailable: !!value.unavailable };
      } finally { win.clearTimeout(timer); if (this.currentLoads.get(owner) === cancel) this.currentLoads.delete(owner); }
    }
    const interest = this.interests.get(owner) || { validated: new Set() };
    Object.assign(interest, { win, onUpdate }); this.interests.set(owner, interest);
    const candidates = await this.candidates(), ids = itemIDs ? candidates.filter(id => itemIDs.has(this.candidateItems?.get(id) || this.cache.get(id)?.itemID || this.records.get(id)?.itemID)) : candidates, allowed = new Set(ids);
    interest.ids = allowed;
    const allRows = [...this.cache].filter(([id]) => allowed.has(id)).flatMap(([, entry]) => entry.rows);
    allRows.sort((a, b) => normalize(a.documentTitle).localeCompare(normalize(b.documentTitle)) || a.attachmentID - b.attachmentID
      || a.outlineKey.localeCompare(b.outlineKey, undefined, { numeric: true }));
    const terms = tokenize(text), rows = allRows.filter(row => outlineMatches(row, text, terms));
    const completed = ids.filter(id => this.cache.has(id)).length;
    this.index(ids);
    return { rows, allRows, total: rows.length, completed, documents: ids.length, pending: completed < ids.length,
      unavailable: [...this.cache].filter(([id, entry]) => allowed.has(id) && entry.unavailable).length };
  }
  index(ids) {
    const validated = id => this.cache.has(id) && [...this.interests.values()].every(interest => interest.validated.has(id));
    if (this.work || !this.interests.size || !ids.some(id => !validated(id))) return;
    const epoch = this.epoch;
    this.work = (async () => {
      for (const id of ids) {
        if (epoch !== this.epoch || !this.interests.size) break;
        if (![...this.interests.values()].some(interest => interest.ids.has(id))) continue;
        if (validated(id)) continue;
        const win = [...this.interests.values()].find(interest => !interest.win.closed)?.win;
        if (!win) break;
        try {
          const reader = this.reader(id);
          const value = await this.load(id, win, reader);
          if (epoch === this.epoch) this.cache.set(id, value);
        } catch (error) {
          if (epoch !== this.epoch || !this.interests.size) break;
          this.cache.set(id, { rows: [], unavailable: true, error: String(error) });
        }
        for (const interest of this.interests.values()) interest.validated.add(id);
        this.notify();
      }
    })().finally(() => {
      this.work = null; this.loader?.destroy(); this.notify(true); this.scheduleSave();
    });
  }
  notify(immediate = false) {
    if (this.updateTimer && !immediate) return;
    clearTimeout(this.updateTimer); this.updateTimer = null;
    const notify = () => { this.updateTimer = null; for (const interest of this.interests.values()) interest.onUpdate(); };
    if (immediate) notify(); else this.updateTimer = setTimeout(notify, 150);
  }
  release(owner) {
    this.cancel(owner);
    const existed = this.interests.delete(owner);
    if (existed && !this.interests.size) { clearTimeout(this.updateTimer); this.updateTimer = null; if (!this.work) this.loader?.destroy(); this.scheduleSave(); }
  }
  cancel(owner) {
    const cancel = this.currentLoads.get(owner);
    if (cancel) { this.currentLoads.delete(owner); cancel(); if (!this.interests.size) this.loader?.destroy(); }
  }
  reader(id) { return Zotero.Reader._readers?.find(reader => availableReader(reader) && reader.itemID === id); }
  async open(row, { split = false, reader: preferredReader } = {}) {
    const item = await Zotero.Items.getAsync(row.attachmentID);
    if (!item?.isPDFAttachment() || item.deleted || !await item.getFilePathAsync()) throw new Error(t("PDF 不在本机"));
    const reader = preferredReader === undefined ? this.reader(row.attachmentID) : availableReader(preferredReader) && preferredReader.itemID === row.attachmentID ? preferredReader : null;
    if (preferredReader !== undefined && !reader || split && !reader) throw new Error(t("当前 PDF 已改变，请重新打开大纲切换"));
    if (reader) {
      await reader._initPromise;
      if (reader.tabID) reader._window.Zotero_Tabs.select(reader.tabID);
      if (split) {
        const internal = reader._internalReader, vertical = reader._window.innerWidth >= reader._window.innerHeight;
        const pageIndex = internal._state?.primaryViewStats?.pageIndex;
        const primaryLocation = internal._primaryView?._iframeWindow?.PDFViewerApplication?.pdfViewer?._location;
        const primary = primaryLocation ? { dest: [primaryLocation.pageNumber - 1, { name: "XYZ" }, primaryLocation.left, primaryLocation.top, null] } : Number.isSafeInteger(pageIndex) ? { pageIndex } : null;
        internal[vertical ? "toggleVerticalSplit" : "toggleHorizontalSplit"](true);
        const deadline = Date.now() + 5000;
        while (!internal._secondaryView && Date.now() < deadline) await Zotero.Promise.delay(20);
        if (!internal._secondaryView) throw new Error(t("分屏未能准备就绪"));
        await internal._secondaryView.initializedPromise;
        await internal._secondaryView.navigate(Components.utils.cloneInto(row.location, reader._iframeWindow));
        // Splitting resizes the first PDF viewport; restore its reading anchor after reflow.
        if (primary) await internal._primaryView.navigate(Components.utils.cloneInto(primary, reader._iframeWindow), Components.utils.cloneInto({ skipHistory: true }, reader._iframeWindow));
        const doc = reader._iframeWindow.document;
        doc.getElementById("qs-split-close")?.remove();
        const close = doc.createElement("button");
        close.id = "qs-split-close"; close.type = "button"; close.textContent = "×"; close.title = t("关闭分屏"); close.setAttribute("aria-label", close.title);
        close.style.cssText = "position:absolute;top:4px;inset-inline-end:18px;z-index:5;width:16px;height:16px;padding:0;border:0;border-radius:50%;font:12px/16px sans-serif;color:#fff;background:#555;opacity:.3;cursor:pointer";
        const fade = visible => () => { close.style.opacity = visible ? "1" : ".3"; };
        close.addEventListener("pointerenter", fade(true)); close.addEventListener("focus", fade(true));
        close.addEventListener("pointerleave", fade(false)); close.addEventListener("blur", fade(false));
        close.addEventListener("click", () => { close.remove(); internal.disableSplitView(); });
        doc.getElementById("secondary-view")?.append(close);
        reader._window.focus(); internal.focusView(false); return true;
      }
      await reader.navigate(row.location); await reader.focus();
    } else {
      const tabID = Zotero.getMainWindow()?.Zotero_Tabs.getTabIDByItemID(row.attachmentID);
      // Bypass dead reader proxies while loading an existing suspended tab when present.
      const opened = await Zotero.Reader.open(row.attachmentID, row.location, { allowDuplicate: true, ...(tabID ? { tabID } : {}) });
      await opened?._initPromise;
      if (opened?.tabID) opened._window.Zotero_Tabs.select(opened.tabID);
      await opened?.focus();
    }
    return true;
  }
  async destroy() {
    this.destroyed = true; clearTimeout(this.updateTimer); this.updateTimer = null;
    if (this.readerToolbar) Zotero.Reader.unregisterEventListener?.("renderToolbar", this.readerToolbar);
    for (const reader of Zotero.Reader._readers || []) {
      try {
        const doc = reader._iframeWindow.document;
        for (const cleanup of this.outlineScrolls?.get(doc)?.reverse() || []) cleanup();
        this.outlineScrolls?.delete(doc);
        doc.getElementById("qs-split-close")?.remove();
      } catch { /* A reader may have closed during shutdown. */ }
    }
    for (const owner of this.currentLoads.keys()) this.cancel(owner);
    this.interests.clear(); this.epoch++; this.loader?.destroy();
    Zotero.Notifier.unregisterObserver(this.observer); this.cache.clear();
    await this.work?.catch(() => {}); await this.flush().catch(error => this.onError(error));
  }
}
