// SPDX-License-Identifier: AGPL-3.0-or-later
import { t, localize } from "./i18n.mjs";
import { libraryKey, normalize } from "./core.mjs";
import { patch } from "./native.mjs";

const MIME = "application/x-zotero-quickswitcher-search";
export function subtreeEnd(rows, index) {
  const level = rows[index].level;
  let end = index + 1;
  while (end < rows.length && rows[end].level > level) end++;
  return end;
}
export function layoutSlot(placement, collectionKeys) {
  const anchor = collectionKeys.indexOf(placement?.anchorCollectionKey);
  return anchor < 0 ? collectionKeys.length : anchor + (placement.anchorSide === "after" ? 1 : 0);
}

export class SearchTreeAdapter {
  constructor(win, app) { this.win = win; this.app = app; this.native = app.nativeFor?.(win); this.view = win.ZoteroPane.collectionsView; this.cleanups = []; this.queries = []; this.closed = false; }
  parent(query) {
    const placement = this.app.layout.get(libraryKey(query.libraryID), query.key);
    if (!placement?.parentCollectionKey) return null;
    try { const parent = Zotero.Collections.getByLibraryAndKey(query.libraryID, placement.parentCollectionKey); return parent && !parent.deleted ? parent : null; }
    catch { return null; }
  }
  children(object) {
    return this.queries.filter(query => query.libraryID === object.libraryID && (this.parent(query)?.id || null) === (object._ObjectType === "Collection" ? object.id : null));
  }
  async prepare() {
    this.queries = (await Promise.all(Zotero.Libraries.getAll().filter(lib => ["user", "group"].includes(lib.libraryType)).map(lib => Zotero.Searches.getAll(lib.libraryID)))).flat().filter(query => !query.deleted);
  }
  async init() {
    await this.prepare();
    patch(this.view, "_matchesFilter", original => (object, reset) => {
      const result = original.call(this.view, object, reset);
      if (object._ObjectType === "Collection" && this.children(object).some(query => original.call(this.view, query, reset).matchesFilter)) return { ...result, hasChildMatchingFilter: true };
      return result;
    }, this.cleanups);
    patch(this.view, "isContainerEmpty", original => index => {
      const row = this.view.getRow(index);
      return original.call(this.view, index) && (!row?.isCollection() || !this.children(row.ref).length);
    }, this.cleanups);
    patch(this.view, "_expandRow", original => async (rows, index, force) => {
      const row = rows[index], count = rows.length;
      const allowed = force || this.view._containerState[row.id] === true;
      const result = await original.call(this.view, rows, index, force);
      if (this.closed || !(row.isLibrary(true) && row.isOpen || row.isCollection() && allowed)) return result;
      const children = this.children(row.ref).filter(query => this.view._includedInTree(query));
      for (let i = subtreeEnd(rows, index) - 1; i > index; i--) if (rows[i].level === row.level + 1 && rows[i].isSearch()) rows.splice(i, 1);
      const collections = rows.slice(index + 1, subtreeEnd(rows, index)).filter(child => child.level === row.level + 1 && child.isCollection());
      const keys = collections.map(child => child.ref.key);
      const ordered = children.map((query, i) => ({ query, p: this.app.layout.get(libraryKey(query.libraryID), query.key), fallback: (i + 1) * 1024 }));
      ordered.sort((a, b) => layoutSlot(a.p, keys) - layoutSlot(b.p, keys) || (a.p?.order ?? a.fallback) - (b.p?.order ?? b.fallback) || a.query.name.localeCompare(b.query.name));
      for (const entry of ordered.reverse()) {
        const slot = layoutSlot(entry.p, keys);
        let target;
        if (slot < collections.length) target = rows.indexOf(collections[slot]);
        else if (collections.length) target = subtreeEnd(rows, rows.indexOf(collections.at(-1)));
        else target = index + 1 + (rows[index + 1]?.isRecentlyRead?.() ? 1 : 0);
        rows.splice(target, 0, new Zotero.CollectionTreeRow(this.view, "search", entry.query, row.level + 1));
      }
      if (children.length) row.isOpen = true;
      return rows.length - count;
    }, this.cleanups);
    patch(this.view, "selectByID", original => async (id, visible) => {
      if (id.startsWith("S")) {
        const query = await Zotero.Searches.getAsync(Number(id.slice(1))), parent = query && this.parent(query);
        if (parent) {
          await this.view.expandToCollection(parent.id);
          const index = this.view.getRowIndexByID("C" + parent.id);
          if (index !== false && !this.view.isContainerOpen(index)) await this.view.toggleOpenState(index);
        }
      }
      return original.call(this.view, id, visible);
    }, this.cleanups);
    patch(this.view, "notify", original => async (...args) => {
      const result = await original.apply(this.view, args);
      if (["collection", "search", "group"].includes(args[1])) await this.refresh();
      return result;
    }, this.cleanups);
    patch(this.view, "onDragStart", original => (event, index) => {
      original.call(this.view, event, index);
      const row = this.view.getRow(index);
      if (row.isSearch()) { this.drag = { libraryID: row.ref.libraryID, key: row.ref.key }; event.dataTransfer.setData(MIME, JSON.stringify(this.drag)); event.dataTransfer.effectAllowed = "all"; }
    }, this.cleanups);
    patch(this.view, "onDragEnd", original => (...args) => { this.drag = null; return original.apply(this.view, args); }, this.cleanups);
    patch(this.view, "onDragOver", original => (event, index) => {
      const drag = this.dragData(event), target = this.view.getRow(index);
      if (!drag) return original.call(this.view, event, index);
      event.preventDefault();
      if (drag.libraryID !== target.ref.libraryID || !["collection", "search", "library", "group"].includes(target.type)) { event.dataTransfer.dropEffect = "none"; return; }
      const rect = this.view.tree.getRowElement(index).getBoundingClientRect(), fraction = (event.clientY - rect.top) / rect.height;
      this.orientation = target.isLibrary(true) ? 0 : fraction < .25 ? -1 : fraction > .75 ? 1 : target.isSearch() ? 1 : 0;
      Zotero.DragDrop.currentOrientation = this.orientation;
      this.view.setDropEffect(event, "move"); this.view._setDropRow(index);
    }, this.cleanups);
    patch(this.view, "onDrop", original => async (event, index) => {
      const drag = this.dragData(event);
      if (!drag) return original.call(this.view, event, index);
      event.preventDefault(); this.view._setDropRow(null);
      try { await this.drop(drag, this.view.getRow(index), this.orientation || 0); }
      catch (error) { this.app.logError(error); }
      finally { this.drag = null; }
    }, this.cleanups);
    const menu = this.win.document.getElementById("zotero-collectionmenu");
    if (menu) {
      const command = this.win.document.createXULElement("menuitem"); command.id = "qs-organize-search"; localize(command, { label: "组织搜索位置…" });
      const reset = this.win.document.createXULElement("menuitem"); reset.id = "qs-reset-search-layout"; localize(reset, { label: "恢复默认搜索位置" });
      const show = () => { command.hidden = reset.hidden = !this.view.selectedTreeRow?.isSearch(); };
      command.addEventListener("command", () => this.app.openOrganizationPicker(this.view.selectedTreeRow.ref, this.win));
      reset.addEventListener("command", () => { const search = this.view.selectedTreeRow.ref; this.app.layout.place(libraryKey(search.libraryID), search.key, null).catch(error => this.app.logError(error)); });
      menu.append(command, reset); menu.addEventListener("popupshowing", show);
      this.cleanups.push(() => { menu.removeEventListener("popupshowing", show); command.remove(); reset.remove(); });
    }
    await this.refresh(); return this;
  }
  dragData(event) {
    if (!Array.from(event.dataTransfer?.types || []).includes(MIME)) return null;
    try { return this.drag || JSON.parse(event.dataTransfer.getData(MIME)); } catch { return null; }
  }
  async drop(drag, target, orientation) {
    const query = this.queries.find(query => query.key === drag.key && query.libraryID === drag.libraryID);
    if (!query || target.ref.libraryID !== query.libraryID) throw new Error(t("保存搜索只能在其所属文库中组织位置"));
    if (target.isSearch() && target.ref.id === query.id) return false;
    let p;
    if (target.isCollection() && orientation === 0) p = { parentCollectionKey: target.ref.key, anchorCollectionKey: null, anchorSide: "after", order: Date.now() };
    else if (target.isLibrary(true)) p = { parentCollectionKey: null, anchorCollectionKey: null, anchorSide: "after", order: Date.now() };
    else if (target.isCollection()) {
      const parent = target.ref.parentID ? Zotero.Collections.get(target.ref.parentID) : null;
      p = { parentCollectionKey: parent?.key || null, anchorCollectionKey: target.ref.key, anchorSide: orientation < 0 ? "before" : "after", order: Date.now() };
    } else if (target.isSearch()) {
      const parent = this.parent(target.ref), current = this.app.layout.get(libraryKey(query.libraryID), target.ref.key);
      const siblings = this.children(parent || Zotero.Libraries.get(query.libraryID));
      p = { parentCollectionKey: parent?.key || null, anchorCollectionKey: current?.anchorCollectionKey || null, anchorSide: current?.anchorSide || "after", order: 0 };
      const same = siblings.map((s, i) => ({ query: s, placement: this.app.layout.get(libraryKey(s.libraryID), s.key), fallback: (i + 1) * 1024 }))
        .filter(s => s.query.id !== query.id && (s.placement?.anchorCollectionKey || null) === p.anchorCollectionKey && (s.placement?.anchorSide || "after") === p.anchorSide)
        .sort((a, b) => (a.placement?.order ?? a.fallback) - (b.placement?.order ?? b.fallback));
      const index = same.findIndex(s => s.query.id === target.ref.id), order = s => s?.placement?.order ?? s?.fallback;
      const value = order(same[index]);
      p.order = orientation < 0 ? ((order(same[index - 1]) ?? value - 2048) + value) / 2 : ((order(same[index + 1]) ?? value + 2048) + value) / 2;
      if (!Number.isFinite(p.order) || p.order === order(same[index - 1]) || p.order === order(same[index + 1]) || p.order === value) {
        for (const [i, sibling] of same.entries()) await this.app.layout.place(libraryKey(sibling.query.libraryID), sibling.query.key,
          { ...(sibling.placement || p), order: (i + 1) * 1024 });
        p.order = (index + 1) * 1024 + (orientation < 0 ? -512 : 512);
      }
    } else throw new Error(t("请选择普通文件夹或保存搜索前后位置"));
    await this.app.layout.place(libraryKey(query.libraryID), query.key, p);
    await this.refresh(); await this.view.selectByID("S" + query.id); return true;
  }
  refresh() {
    if (this.closed) return Promise.resolve();
    if (this.refreshing) { this.queued = true; return this.refreshing; }
    this.refreshing = (async () => {
      do {
        this.queued = false;
        const selected = this.view.getSelectedRows().map(row => row.id), scroll = this.view.tree?._jsWindow?.scrollOffset || 0;
        await this.prepare();
        if (this.closed) return;
        try {
          await this.view.reload();
          if (!this.closed && selected.length === 1) await this.view.selectByID(selected[0], false);
          else if (!this.closed && selected.length > 1) {
            const selection = this.view.selection;
            selection.clearSelection();
            for (const id of selected) { const index = this.view.getRowIndexByID(id); if (index !== false) selection.toggleSelect(index); }
          }
        } finally {
          // Zotero 10 reload() suppresses select events and leaves restoration to its caller.
          this.view.selection.selectEventsSuppressed = false;
        }
        // A search-save notifier can be awaited by the current serial selection handler.
        if (!this.closed && !this.native?.collectionChanging) await this.view._onSelectionChange();
        this.view.tree?._jsWindow?.scrollTo(scroll);
      } while (this.queued && !this.closed);
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  async destroy() {
    this.closed = true; this.drag = null;
    await this.refreshing?.catch(() => {});
    for (const cleanup of this.cleanups.splice(0).reverse()) cleanup();
    if (this.win.closed) return;
    try { await this.view.reload(); }
    catch (error) { this.app.logError(error); }
    finally { this.view.selection.selectEventsSuppressed = false; }
    if (!this.native?.collectionChanging) await this.view._onSelectionChange().catch(error => this.app.logError(error));
  }
}
