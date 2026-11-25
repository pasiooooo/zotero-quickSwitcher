// SPDX-License-Identifier: AGPL-3.0-or-later
import { element as h, evidenceNode, highlightTextNodes, installStyle } from "./dom.mjs";
import { tokenize, normalize, ALL_FIELDS } from "./core.mjs";
import { DEFAULT_PREFIXES, migrateLauncherPrefixes, parseLauncherInput } from "./launcher-query.mjs";
import { queryEvidenceSpec } from "./search.mjs";
import { t } from "./i18n.mjs";
import { SidebarHighlights } from "./sidebar-highlight.mjs";

export function patch(host, name, wrap, cleanups) {
  const own = Object.hasOwn(host, name), original = host[name];
  if (typeof original !== "function") throw new Error(t("Zotero 接口不可用：{name}", { name }));
  const replacement = wrap(original);
  host[name] = replacement;
  cleanups.push(() => { if (host[name] === replacement) { if (own) host[name] = original; else delete host[name]; } });
}

export class NativeAdapter {
  constructor(win, app) {
    this.win = win; this.doc = win.document; this.app = app; this.pane = win.ZoteroPane;
    this.cleanups = []; this.rowCleanups = []; this.evidence = new Map(); this.version = 0; this.queryVersion = 0;
    this.work = Promise.resolve(); this.transition = false; this.closed = false; this.active = false; this.collectionChanging = 0;
  }
  async init() {
    this.view = this.pane.itemsView;
    this.baseFilter = this.view.setFilter.bind(this.view);
    this.searchbox = this.doc.getElementById("zotero-tb-search");
    this.scope = { value: "library" };
    this.details = h(this.doc, "details", { class: "qs-native-details", hidden: true });
    this.summary = h(this.doc, "summary", { l10n: { text: "匹配依据与所属文件夹" } });
    this.detailBody = h(this.doc, "div", { class: "qs-native-details-body" });
    this.details.append(this.summary, this.detailBody);
    this.view.domEl.parentNode.insertBefore(this.details, this.view.domEl.nextSibling);
    const detailToggle = () => { if (this.details.open) this.updateDetails(); };
    this.details.addEventListener("toggle", detailToggle);
    this.cleanups.push(() => this.details.removeEventListener("toggle", detailToggle));
    this.setContext();
    const sidebar = this.doc.getElementById("zotero-item-pane");
    if (sidebar) this.sidebar = new SidebarHighlights(this.win, sidebar, this.app.prefs);
    if (this.pane.itemPane?.setReadLabel) patch(this.pane.itemPane, "setReadLabel", original => function (...args) {
      // Feed notifications can arrive after the header was replaced by another pane.
      if (!this.getCurrentPane()?.querySelector(".feed-item-toggleRead-button")) return;
      return original.apply(this, args);
    }, this.cleanups);

    patch(this.view, "setFilter", original => async (type, data) => {
      if (this.transition || this.nativeOnly() || type === "tags") return original.call(this.view, type, data);
      if (type === "search" || type === "citation-search") return this.applyQuery(this.spec(String(data || "")));
      if (type === "advanced-search") {
        this.userAdvanced = data || null;
        return this.applyQuery(this.spec(this.searchbox.value));
      }
      return original.call(this.view, type, data);
    }, this.cleanups);
    patch(this.pane, "search", original => async (...args) => {
      if (this.composing) return;
      if (this.nativeOnly()) return original.apply(this.pane, args);
      try { await this.view.setFilter("search", this.searchbox.value); this.pane.clearItemsPaneMessage(); }
      catch (error) { this.pane.setItemsPaneMessage(error.message); }
    }, this.cleanups);
    patch(this.pane, "handleSearchInput", original => (...args) => {
      if (this.nativeOnly()) return original.apply(this.pane, args);
    }, this.cleanups);
    patch(this.pane, "onCollectionSelected", original => async (...args) => {
      const selected = this.pane.collectionsView.getSelectedRows().map(row => row.id).sort().join();
      const displayed = this.view.collectionTreeRows.map(row => row.id).sort().join();
      const changed = !this.transition && selected !== displayed;
      if (changed) { this.active = false; this.currentSpec = null; this.releaseRows(); this.evidence.clear(); this.version++; this.queryVersion++; this.app.releaseOutlineSearch?.(); }
      // Native selection is serial: its filter callbacks must never await another selection.
      this.collectionChanging++;
      let result;
      try { result = await original.apply(this.pane, args); }
      finally { this.collectionChanging--; }
      if (changed && !this.closed) { this.origin = null; this.setContext(); this.readNativeSpec(); this.refreshDisplay(); }
      return result;
    }, this.cleanups);
    patch(this.view, "_renderCell", original => (...args) => {
      const cell = original.apply(this.view, args), field = args[2]?.dataKey;
      if (this.currentSpec) highlightTextNodes(cell, this.cellTerms(field, this.view.getRow(args[0])?.ref));
      return cell;
    }, this.cleanups);
    const onSelect = () => { this.updateDetails(); this.updateSidebar(); };
    this.view.onSelect.addListener(onSelect);
    this.cleanups.push(() => this.view.onSelect.removeListener(onSelect));
    const onRefresh = () => { this.readNativeSpec(); this.refreshDisplay(); };
    this.view.onRefresh.addListener(onRefresh);
    this.cleanups.push(() => this.view.onRefresh.removeListener(onRefresh));
    const composing = () => { this.composing = true; };
    const composed = () => { this.composing = false; this.pane.search(); };
    this.searchbox.addEventListener("compositionstart", composing);
    this.searchbox.addEventListener("compositionend", composed);
    this.cleanups.push(() => { this.searchbox.removeEventListener("compositionstart", composing); this.searchbox.removeEventListener("compositionend", composed); });
    installStyle(this.doc, this.app.prefs);
    this.readNativeSpec(); this.refreshDisplay();
    return this;
  }
  nativeOnly() { return this.collectionChanging > 0 || this.view.collectionTreeRows?.some(row => row.isFeedsOrFeed?.()); }
  setContext() {
    this.context = this.app.plainContext(this.win);
    this.scope.value = this.context.collectionKey || this.context.searchKey ? "local" : "library";
    this.userAdvanced = this.view.collectionTreeRows?.[0]?.advancedSearch || null;
  }
  async updatePrefixes() {
    const next = Object.fromEntries(Object.entries(DEFAULT_PREFIXES).map(([type, marker]) => [type, type === "tabs" ? marker : this.app.prefs.get(`${type}Prefix`) || marker]));
    if (JSON.stringify(next) === JSON.stringify(this.prefixSymbols)) return;
    const text = this.active && this.prefixSymbols ? migrateLauncherPrefixes(this.searchbox.value, this.prefixSymbols, next) : this.searchbox?.value || "";
    this.prefixSymbols = next;
    if (this.active) {
      this.searchbox.value = text;
      const spec = this.spec(text); spec.nativeConditions = this.currentSpec?.nativeConditions;
      await this.applyQuery(spec);
    }
  }
  spec(text = "", mode = this.scope.value) {
    this.prefixSymbols = Object.fromEntries(Object.entries(DEFAULT_PREFIXES).map(([type, marker]) => [type, type === "tabs" ? marker : this.app.prefs.get(`${type}Prefix`) || marker]));
    const query = parseLauncherInput(text, "items", -1, this.prefixSymbols);
    if (query.kind === "outline") return this.app.makeSpec(this.win, { text: query.text, rawText: text, outlineScope: { type: "all" }, filters: query.filters?.map(({ type, value, negated, join }) => ({ type, value, negated, join })) });
    const context = query.current ? this.app.plainContext(this.win) : this.origin?.context || this.context;
    if (query.current) mode = "local";
    const scope = mode === "all" ? { type: "all" } : mode === "local" && context.collectionKey
      ? { type: "collection", libraryID: context.libraryID, collectionKey: context.collectionKey, recursive: this.app.prefs.get("recursive") }
      : mode === "local" && context.searchKey ? { type: "search", libraryID: context.libraryID, searchKey: context.searchKey }
      : { type: "library", libraryID: context.libraryID };
    return this.app.makeSpec(this.win, { text: query.text, rawText: text, scope, ...(query.scopedOutline ? { outlineSource: this.currentSpec?.outlineSource || { type: "all" } } : {}), ...(query.queryTree ? { queryTree: query.queryTree } : {}), ...(query.complete === false ? { queryError: query.error || "检索式尚未完成" } : {}), filters: query.filters?.map(({ type, value, negated, join, quoted }) => {
      const ref = this.currentSpec?.filters?.find(filter => filter.type === type && filter.value === value)?.ref;
      return { type, value, negated, join, ...(quoted ? { quoted: true } : {}), ...(ref ? { ref } : {}) };
    }), nativeConditions: this.userAdvanced?.toJSON().conditions,
      ...(query.kind === "fulltext" ? ALL_FIELDS : {}) });
  }
  capture() {
    return { context: this.app.plainContext(this.win), rowIDs: this.pane.collectionsView.getSelectedRows().map(r => r.id),
      itemIDs: this.pane.getSelectedItems(true), scroll: this.view.tree?._jsWindow?.scrollOffset || 0,
      text: this.searchbox.value, advanced: this.userAdvanced, tags: this.view.collectionTreeRows?.[0]?.tags ? [...this.view.collectionTreeRows[0].tags] : [] };
  }
  applyQuery(spec) {
    if (spec.outlineScope) {
      const launcher = this.app.launcherFor(this.win); launcher.show("outline"); launcher.outlineContext = { type: "all" }; launcher.input.value = spec.rawText ?? spec.text; launcher.schedule(0);
      return Promise.resolve(false);
    }
    tokenize(spec.text);
    const version = ++this.queryVersion; this.version++;
    this.work = this.work.catch(error => this.app.logError(error)).then(async () => {
      if (this.closed || version !== this.queryVersion) return false;
      this.transition = true;
      try {
        spec = await this.app.search.prepare(spec);
        if (this.closed || version !== this.queryVersion) return false;
        const rowIDs = spec.scope.type === "all" ? this.app.search.libraries().map(lib => `L${lib.libraryID}`)
          : spec.scope.type === "collection" ? [`C${Zotero.Collections.getIDFromLibraryAndKey(spec.scope.libraryID, spec.scope.collectionKey)}`]
          : spec.scope.type === "search" ? [`S${Zotero.Searches.getIDFromLibraryAndKey(spec.scope.libraryID, spec.scope.searchKey)}`]
          : [`L${spec.scope.libraryID || this.context.libraryID}`];
        const selected = this.pane.collectionsView.getSelectedRows().map(row => row.id);
        if (!this.origin) this.origin = this.capture();
        if (selected.join() !== rowIDs.join()) {
          const success = await this.selectRows(rowIDs);
          if (!success) return false;
        }
        if (version !== this.queryVersion || this.closed) return false;
        this.releaseRows(); this.currentSpec = structuredClone(spec); this.active = true; this.evidence.clear();
        // The native folder scope follows a separate global recursion setting; use this query's scope.
        for (const row of this.view.collectionTreeRows) {
          patch(row, "getSearchObject", original => async (options = {}) => {
            if (options.unfiltered || !this.active) return original.call(row, options);
            const prepared = await this.app.search.prepare(this.currentSpec);
            const search = this.app.search.buildSearch(prepared, row.ref.libraryID);
            search.libraryID = row.ref.libraryID;
            for (const tag of row.tags || []) search.addCondition("tag", "is", tag);
            return search;
          }, this.rowCleanups);
        }
        this.searchbox.value = spec.rawText ?? spec.text;
        this.scope.value = spec.scope.type === "all" ? "all" : ["collection", "search"].includes(spec.scope.type) ? "local" : "library";
        await this.baseFilter("advanced-search", this.app.search.buildSearch(spec, this.view.collectionTreeRows[0]?.ref.libraryID));
        if (version !== this.queryVersion || this.closed) return false;
        if (this.origin?.itemIDs?.length) await this.view.selectItems(this.origin.itemIDs, false, true);
        if (spec.scope.type === "collection" || spec.scope.type === "search") this.view.tree?._jsWindow?.scrollTo(this.origin.scroll);
        this.refreshDisplay(); this.app.releaseOutlineSearch?.(); return true;
      } finally { this.transition = false; }
    });
    return this.work;
  }
  async selectRows(ids) {
    for (const id of ids) {
      if (id.startsWith("L")) await this.pane.collectionsView.expandLibrary(Number(id.slice(1)));
      else if (id.startsWith("C")) await this.pane.collectionsView.expandToCollection(Number(id.slice(1)));
    }
    // Native selectByID keeps a multi-selection when the target row is already selected.
    if (ids.length === 1 && this.pane.collectionsView.getSelectedRows().length <= 1) {
      await this.pane.collectionsView.selectByID(ids[0]);
    } else {
      const selection = this.pane.collectionsView.selection;
      selection.selectEventsSuppressed = true;
      try {
        selection.clearSelection();
        for (const id of ids) {
          const index = this.pane.collectionsView.getRowIndexByID(id);
          if (index !== false) selection.toggleSelect(index);
        }
      } finally { selection.selectEventsSuppressed = false; }
      await this.pane.collectionsView._onSelectionChange();
    }
    const selected = this.pane.collectionsView.getSelectedRows().map(row => row.id);
    return ids.length === selected.length && ids.every(id => selected.includes(id));
  }
  releaseRows() { for (const cleanup of this.rowCleanups.splice(0).reverse()) cleanup(); }
  cellTerms(field, item) {
    const spec = this.currentSpec;
    if (!spec) return [];
    if (this.highlight?.spec !== spec) {
      const terms = new Map(), creators = new Map(); let words = [];
      const evidence = queryEvidenceSpec(spec);
      try { words = tokenize(evidence.text); } catch {}
      for (const condition of evidence.nativeConditions || []) if (["contains", "is", "beginsWith"].includes(condition.operator) && condition.value) {
        if (["creator", "author", "editor", "bookAuthor"].includes(condition.condition)) {
          if (!creators.has(condition.condition)) creators.set(condition.condition, { exact: new Set(), other: [] });
          const group = creators.get(condition.condition);
          if (condition.operator === "is") group.exact.add(normalize(condition.value)); else group.other.push(condition);
        } else {
          const actual = condition.condition === "year" ? "date" : condition.condition;
          if (!terms.has(actual)) terms.set(actual, []); terms.get(actual).push(condition.value);
        }
      }
      const names = new Set((evidence.resolvedFilters || []).filter(filter => filter.type === "author" && !filter.negated).flatMap(filter => filter.matches.map(match => normalize(match.name))));
      this.highlight = { spec, words, terms, creators, names };
    }
    let actual = ({ firstCreator: "creator", year: "date" })[field] || field;
    const fieldID = item?.itemTypeID && !["creator", "date"].includes(actual) && Zotero.ItemFields?.getID(actual);
    const baseID = fieldID && Zotero.ItemFields.getBaseIDFromTypeAndField(item?.itemTypeID, fieldID);
    if (baseID) actual = Zotero.ItemFields.getName(baseID);
    const terms = [...(spec.fields?.includes(actual) ? this.highlight.words : []), ...(this.highlight.terms.get(actual) || [])];
    if (actual === "creator") for (const creator of item?.getCreators?.() || []) {
      const name = normalize([creator.firstName, creator.lastName].filter(Boolean).join(" "));
      if (this.highlight.names.has(name) || [...this.highlight.creators].some(([role, group]) => (role === "creator"
        || creator.creatorType === role || creator.creatorTypeID === Zotero.CreatorTypes.getID(role)) && (group.exact.has(name)
        || group.other.some(condition => condition.operator === "contains" ? name.includes(normalize(condition.value)) : name.startsWith(normalize(condition.value)))))) terms.push(creator.firstName, creator.lastName);
    }
    return terms.filter(Boolean);
  }
  readNativeSpec() {
    if (this.active) return;
    if (this.view.collectionTreeRows?.some(row => row.isFeedsOrFeed?.())) { this.currentSpec = null; return; }
    const row = this.view.collectionTreeRows?.[0];
    const extended = row?.isSearch?.() && this.app.savedQueries?.spec(row.ref);
    if (extended) { this.currentSpec = extended; return; }
    const conditions = row?.advancedSearch?.toJSON().conditions || (row?.isSearch?.() ? row.ref.toJSON().conditions : undefined);
    this.currentSpec = row?.searchText || conditions?.length ? this.app.makeSpec(this.win, { text: row.searchText || "", nativeConditions: conditions }) : null;
  }
  refreshDisplay() {
    if (this.closed) return;
    this.details.hidden = !this.currentSpec;
    this.view.tree?.invalidate();
    if (this.details.open) this.updateDetails();
    this.updateSidebar();
  }
  invalidate() { this.version++; this.evidence.clear(); this.updateDetails(); this.updateSidebar(); this.view.tree?.invalidate(); }
  async updateSidebar() {
    if (!this.sidebar || this.closed) return;
    const request = this.sidebarRevision = (this.sidebarRevision || 0) + 1, item = this.pane.getSelectedItems()[0];
    this.sidebar.set(null);
    if (!this.currentSpec || !item) return;
    try {
      const [data, entries] = await Promise.all([this.app.search.getMetadata(item), this.itemEvidence(item)]);
      if (!this.closed && request === this.sidebarRevision && item.id === this.pane.getSelectedItems()[0]?.id) this.sidebar.set({ ...data, itemID: item.id, itemTypeID: item.itemTypeID }, entries.filter(entry => entry.sourceItemID === item.id));
    } catch (error) { this.app.logError(error); }
  }
  async itemEvidence(item) {
    const spec = this.currentSpec;
    if (!spec || !item?.id) return [];
    if (!this.evidence.has(item.id)) {
      const pending = this.app.search.evidenceForItem(item, spec).catch(error => { this.app.logError(error); return []; });
      this.evidence.set(item.id, pending);
    }
    return this.evidence.get(item.id);
  }
  async updateDetails() {
    if (this.closed || !this.details.open || !this.currentSpec) return;
    const item = this.pane.getSelectedItems()[0], version = this.version;
    this.detailBody.replaceChildren(h(this.doc, "p", { l10n: { text: item ? "正在读取匹配详情…" : "选中一条文献查看匹配依据与全部文件夹位置" } }));
    if (!item) return;
    const [entries, location] = await Promise.all([this.itemEvidence(item), this.app.locations.get(item)]);
    if (this.closed || version !== this.version || this.pane.getSelectedItems()[0]?.id !== item.id) return;
    this.detailBody.replaceChildren(...entries.map(entry => evidenceNode(this.doc, entry)));
    if (!entries.length) this.detailBody.append(h(this.doc, "p", { l10n: { text: "满足当前高级条件或检索范围" } }));
    const paths = h(this.doc, "div", { class: "qs-preview-locations" });
    this.detailBody.append(paths);
    if (location.status === "ready") {
      for (const path of location.locations) paths.append(h(this.doc, "button", { type: "button", class: "qs-path", text: path.path, title: path.path,
        onclick: () => this.app.openItem({ itemID: item.id }, { locate: true, location: path }).catch(error => this.app.logError(error)) }));
      if (!location.locations.length) paths.textContent = t("{library} · 未归入文件夹", { library: location.libraryName });
    } else paths.textContent = t("位置暂不可用 · {error}", { error: location.error });
  }
  async destroy() {
    this.closed = true; this.version++; this.queryVersion++;
    await this.work.catch(() => {});
    this.active = false; this.releaseRows();
    for (const cleanup of this.cleanups.splice(0).reverse()) cleanup();
    if (!this.win.closed) {
      await this.baseFilter("advanced-search", this.userAdvanced || null).catch(error => this.app.logError(error));
      await this.baseFilter("search", this.searchbox.value).catch(error => this.app.logError(error));
      this.view.tree?.invalidate();
    }
    this.details.remove(); this.evidence.clear();
    this.sidebar?.destroy();
  }
}
