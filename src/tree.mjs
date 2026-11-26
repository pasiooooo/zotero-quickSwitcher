// SPDX-License-Identifier: AGPL-3.0-or-later
import { t, localize } from "./i18n.mjs";
import { libraryKey } from "./core.mjs";
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
  collectionKeys(parent) {
    const collections = parent._ObjectType === "Collection" ? Zotero.Collections.getByParent(parent.id) : Zotero.Collections.getByLibrary(parent.libraryID);
    return collections.filter(collection => !collection.deleted).map(collection => collection.key);
  }
  orderedChildren(parent, keys) {
    const library = libraryKey(parent.libraryID);
    return this.children(parent).map(query => {
      const placement = this.app.layout.get(library, query.key);
      return { query, placement, slot: layoutSlot(placement, keys), order: placement?.order ?? this.defaultOrders.get(query.id) };
    }).sort((first, second) => first.slot - second.slot || first.order - second.order || first.query.name.localeCompare(second.query.name) || first.query.key.localeCompare(second.query.key));
  }
  async prepare() {
    const libraries = await Promise.all(Zotero.Libraries.getAll().filter(lib => ["user", "group"].includes(lib.libraryType))
      .map(async lib => (await Zotero.Searches.getAll(lib.libraryID)).filter(query => !query.deleted)));
    this.queries = libraries.flat();
    this.defaultOrders = new Map(libraries.flatMap(queries => queries.map((query, index) => [query.id, (index + 1) * 1024])));
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
      for (let i = subtreeEnd(rows, index) - 1; i > index; i--) if (rows[i].level === row.level + 1 && rows[i].isSearch()) rows.splice(i, 1);
      const keys = this.collectionKeys(row.ref), ordered = this.orderedChildren(row.ref, keys).filter(entry => this.view._includedInTree(entry.query));
      const starts = new Map(); let end = index + 1 + (rows[index + 1]?.isRecentlyRead?.() ? 1 : 0);
      for (let child = index + 1; child < rows.length && rows[child].level > row.level;) {
        const next = subtreeEnd(rows, child);
        if (rows[child].isCollection()) { starts.set(rows[child].ref.key, child); end = next; }
        child = next;
      }
      const gaps = [...keys.map(key => starts.get(key)), end];
      for (let slot = keys.length - 1; slot >= 0; slot--) gaps[slot] ??= gaps[slot + 1];
      for (const { query, slot } of ordered.reverse()) rows.splice(gaps[slot], 0, new Zotero.CollectionTreeRow(this.view, "search", query, row.level + 1));
      if (ordered.length) row.isOpen = true;
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
    patch(this.view, "onDragEnd", original => (...args) => { this.drag = null; this.markDrop(null); return original.apply(this.view, args); }, this.cleanups);
    patch(this.view, "onDragOver", original => (event, index) => {
      const drag = this.dragData(event);
      if (!drag) { this.markDrop(null); return original.call(this.view, event, index); }
      event.preventDefault();
      const hit = this.dropTarget(event, index, drag);
      this.view.setDropEffect(event, hit ? "move" : "none");
      Zotero.DragDrop.currentOrientation = hit?.orientation ?? 0;
      this.view._setDropRow(hit ? index : null); this.markDrop(hit);
    }, this.cleanups);
    patch(this.view, "onDrop", original => async (event, index) => {
      const drag = this.dragData(event);
      if (!drag) return original.call(this.view, event, index);
      const hit = this.dropTarget(event, index, drag);
      this.view._setDropRow(null); this.markDrop(null); Zotero.DragDrop.currentDropEffect = null;
      try { if (hit) await this.drop(drag, hit.target, hit.orientation); }
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
  dropTarget(event, index, drag) {
    const target = this.view.getRow(index);
    if (!target?.ref || target.ref.libraryID !== drag.libraryID || !["collection", "search", "library", "group"].includes(target.type) || target.isSearch() && target.ref.key === drag.key) return null;
    const element = this.view.tree.getRowElement(index), rect = element?.getBoundingClientRect();
    if (!rect?.height) return null;
    const fraction = (event.clientY - rect.top) / rect.height;
    const orientation = target.isLibrary(true) ? 0 : target.isSearch() ? (fraction < .5 ? -1 : 1) : fraction < 1 / 3 ? -1 : fraction > 2 / 3 ? 1 : 0;
    return { target, element, orientation };
  }
  markDrop(hit) {
    if (this.dropMarker !== hit?.element) this.dropMarker?.removeAttribute("data-qs-search-drop");
    this.dropMarker = hit?.element;
    if (hit) hit.element.setAttribute("data-qs-search-drop", hit.orientation < 0 ? "before" : hit.orientation > 0 ? "after" : "inside");
  }
  async drop(drag, target, orientation) {
    const query = this.queries.find(query => query.key === drag.key && query.libraryID === drag.libraryID);
    if (!query || target.ref.libraryID !== query.libraryID) throw new Error(t("保存搜索只能在其所属文库中组织位置"));
    if (target.isSearch() && target.ref.id === query.id) return false;
    if (!["library", "group", "collection", "search"].includes(target.type)) throw new Error(t("请选择普通文件夹或保存搜索前后位置"));
    const library = libraryKey(query.libraryID), into = target.isLibrary(true) || target.isCollection() && !orientation;
    const parent = target.isSearch() ? this.parent(target.ref) : target.isCollection() ? (into ? target.ref : target.ref.parentID ? Zotero.Collections.get(target.ref.parentID) : null) : null;
    const current = target.isSearch() && this.app.layout.get(library, target.ref.key);
    const destination = { parentCollectionKey: parent?.key ?? null, anchorCollectionKey: target.isCollection() && !into ? target.ref.key : current?.anchorCollectionKey ?? null,
      anchorSide: target.isCollection() && !into ? (orientation < 0 ? "before" : "after") : current?.anchorSide ?? "after" };
    const container = parent || Zotero.Libraries.get(query.libraryID), keys = this.collectionKeys(container), slot = layoutSlot(destination, keys);
    const siblings = this.orderedChildren(container, keys).filter(entry => entry.slot === slot && entry.query.id !== query.id);
    let index = into || orientation < 0 ? siblings.length : 0;
    if (target.isSearch()) {
      index = siblings.findIndex(entry => entry.query.id === target.ref.id);
      if (index < 0) return false;
      if (orientation > 0) index++;
    }
    const before = siblings[index - 1]?.order ?? -Infinity, after = siblings[index]?.order ?? Infinity;
    const order = before === -Infinity ? (after === Infinity ? 1024 : after - 1024) : after === Infinity ? before + 1024 : before / 2 + after / 2;
    if (before < order && order < after) await this.app.layout.place(library, query.key, { ...destination, order });
    else {
      siblings.splice(index, 0, { query, placement: destination });
      await this.app.layout.placeMany(library, siblings.map((entry, position) => [entry.query.key, { ...(entry.placement || destination), order: (position + 1) * 1024 }]));
    }
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
    this.closed = true; this.drag = null; this.markDrop(null);
    await this.refreshing?.catch(() => {});
    for (const cleanup of this.cleanups.splice(0).reverse()) cleanup();
    if (this.win.closed) return;
    try { await this.view.reload(); }
    catch (error) { this.app.logError(error); }
    finally { this.view.selection.selectEventsSuppressed = false; }
    if (!this.native?.collectionChanging) await this.view._onSelectionChange().catch(error => this.app.logError(error));
  }
}
