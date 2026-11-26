// SPDX-License-Identifier: AGPL-3.0-or-later
import { libraryKey, compareVersions, UUID } from "./core.mjs";
import { patch } from "./native.mjs";
import { t } from "./i18n.mjs";

const KEY = /^[A-Z0-9]{8}$/u, LIBRARY = /^(u|g\d+)$/u;
const fields = new Set(["title", "creator", "date", "DOI", "citationKey", "tag", "abstractNote"]);
export const savedQueryConditions = [{ condition: "joinMode", operator: "all" }, { condition: "title", operator: "is", value: "" }, { condition: "title", operator: "isNot", value: "" }];
const sameConditions = conditions => JSON.stringify(conditions.map(({ condition, operator, value }) => ({ condition, operator, ...(value ? { value } : {}) })))
  === JSON.stringify(savedQueryConditions.map(({ condition, operator, value }) => ({ condition, operator, ...(value ? { value } : {}) })));

export function validateSavedSpec(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec) || typeof spec.text !== "string" || spec.text.length > 2048
    || typeof spec.rawText !== "string" || spec.rawText.length > 2048 || !Array.isArray(spec.fields) || spec.fields.length > fields.size || spec.fields.some(field => !fields.has(field))
    || !spec.scope || spec.scope.libraryID !== undefined || !["library", "collection", "search"].includes(spec.scope.type) || !spec.sources
    || ["notes", "annotations", "fulltext"].some(source => typeof spec.sources[source] !== "boolean")
    || !Array.isArray(spec.filters) || spec.filters.length > 64 || spec.nativeConditions !== undefined) throw new Error(t("保存搜索扩展条件无效"));
  if (spec.scope.type !== "library" && !KEY.test(spec.scope[spec.scope.type === "collection" ? "collectionKey" : "searchKey"])) throw new Error(t("保存搜索扩展条件无效"));
  for (const filter of spec.filters) {
    if (!["author", "directory", "year", "venue", "type", "tag", "tabs", "outline"].includes(filter?.type)
      || typeof filter.value !== "string" || filter.value.length > 2048 || ![undefined, "and", "or"].includes(filter.join)
      || filter.negated !== undefined && typeof filter.negated !== "boolean" || filter.quoted !== undefined && typeof filter.quoted !== "boolean") throw new Error(t("保存搜索扩展条件无效"));
    const ref = filter.ref;
    if (ref && (typeof ref !== "object" || Array.isArray(ref) || typeof ref.kind !== "string" || typeof ref.key !== "string" || ref.key.length > 2048
      || ref.libraryID !== undefined || ref.attachmentID !== undefined || ref.title !== undefined && (typeof ref.title !== "string" || ref.title.length > 2048)
      || ref.libraryKey !== undefined && !LIBRARY.test(ref.libraryKey) || ref.attachmentKey !== undefined && !KEY.test(ref.attachmentKey)
      || ref.field !== undefined && (ref.kind === "tag" ? ref.field !== "tag" : !["publicationTitle", "publisher"].includes(ref.field)))) throw new Error(t("保存搜索扩展条件无效"));
  }
  if (spec.outlineSource && (!['all', 'pdf'].includes(spec.outlineSource.type) || spec.outlineSource.type === "pdf" && !KEY.test(spec.outlineSource.attachmentKey))) throw new Error(t("保存搜索扩展条件无效"));
  let nodes = 0;
  const visit = (node, depth = 0) => {
    if (!node || typeof node !== "object" || Array.isArray(node) || depth > 32 || ++nodes > 512) throw new Error(t("检索式结构无效"));
    if (node.op) {
      if (!["AND", "OR", "NOT"].includes(node.op) || !Array.isArray(node.children) || !node.children.length || node.op === "NOT" && node.children.length !== 1) throw new Error(t("检索式结构无效"));
      for (const child of node.children) visit(child, depth + 1);
    } else if (Object.hasOwn(node, "filterIndex")) {
      if (!Number.isInteger(node.filterIndex) || !spec.filters[node.filterIndex]) throw new Error(t("检索式结构无效"));
    } else if (typeof node.text !== "string" || !node.text.trim() || node.text.length > 2048 || node.quoted !== undefined && typeof node.quoted !== "boolean") throw new Error(t("检索式结构无效"));
  };
  if (spec.queryTree) visit(spec.queryTree);
  return spec;
}

export function mergeSavedQueryRecords(...maps) {
  const records = {};
  for (const map of maps) {
    if (!map || typeof map !== "object" || Array.isArray(map) || Object.keys(map).length > 10000) throw new Error(t("保存搜索扩展记录无效"));
    for (const [key, record] of Object.entries(map)) {
      if (!LIBRARY.test(record?.libraryKey) || !KEY.test(record.searchKey) || key !== `${record.libraryKey}:${record.searchKey}`
        || !Number.isSafeInteger(record.version?.clock) || record.version.clock < 0 || !UUID.test(record.version.deviceID)) throw new Error(t("保存搜索扩展记录无效"));
      if (record.spec !== null) validateSavedSpec(record.spec);
      if (!records[key] || compareVersions(record.version, records[key].version) > 0) records[key] = structuredClone(record);
    }
  }
  return records;
}

export function encodeSavedSpec(spec) {
  const scope = { ...spec.scope }; delete scope.libraryID;
  const filters = (spec.filters || []).map(filter => {
    const saved = { type: filter.type, value: filter.value, ...(filter.join ? { join: filter.join } : {}), ...(filter.negated ? { negated: true } : {}), ...(filter.quoted ? { quoted: true } : {}) };
    if (filter.ref) {
      const ref = filter.ref; saved.ref = { kind: ref.kind, key: ref.key, ...(ref.field ? { field: ref.field } : {}) };
      if (ref.title) saved.ref.title = ref.title;
      if (ref.libraryID) saved.ref.libraryKey = libraryKey(ref.libraryID);
      if (ref.attachmentID) {
        const attachment = Zotero.Items.getLibraryAndKeyFromID(ref.attachmentID);
        saved.ref.attachmentKey = attachment.key;
        saved.ref.libraryKey = libraryKey(attachment.libraryID);
        if (ref.kind === "tab") saved.ref.key = attachment.key;
      }
    }
    return saved;
  });
  const stored = { text: spec.text || "", rawText: spec.rawText || spec.text || "", fields: spec.fields || [], sources: { notes: false, annotations: false, fulltext: false, ...spec.sources }, scope, filters,
    ...(spec.queryTree ? { queryTree: structuredClone(spec.queryTree) } : {}), ...(spec.recursive !== undefined ? { recursive: !!spec.recursive } : {}) };
  if (spec.outlineSource) stored.outlineSource = spec.outlineSource.type === "pdf" ? { type: "pdf", attachmentKey: Zotero.Items.getLibraryAndKeyFromID(spec.outlineSource.attachmentID).key } : { type: "all" };
  return validateSavedSpec(stored);
}

export function decodeSavedSpec(stored, libraryID) {
  validateSavedSpec(stored);
  const libraryIDFor = key => key === "u" ? Zotero.Libraries.userLibraryID : Zotero.Groups.getLibraryIDFromGroupID(Number(key.slice(1)));
  const filters = stored.filters.map(filter => {
    if (!filter.ref) return { ...filter };
    const ref = { ...filter.ref }, id = ref.libraryKey ? libraryIDFor(ref.libraryKey) : libraryID;
    if (ref.libraryKey) ref.libraryID = id || -1;
    if (ref.attachmentKey) ref.attachmentID = id && Zotero.Items.getIDFromLibraryAndKey(id, ref.attachmentKey) || -1;
    return { ...filter, ref };
  });
  const outlineSource = stored.outlineSource && (stored.outlineSource.type === "pdf" ? { type: "pdf", attachmentID: Zotero.Items.getIDFromLibraryAndKey(libraryID, stored.outlineSource.attachmentKey) || -1 } : { type: "all" });
  return { ...structuredClone(stored), scope: { ...stored.scope, libraryID }, filters, ...(outlineSource ? { outlineSource } : {}) };
}

export class SavedQueryAdapter {
  constructor(app) { this.app = app; this.cleanups = []; this.pending = new Map(); this.dependencies = new Map(); this.compiled = new Map(); }
  spec(search) {
    const key = search?.key || search?._qsSavedKey;
    if (!key || !search.libraryID || !sameConditions(search.toJSON().conditions)) return null;
    const stored = this.app.layout.getQuery(libraryKey(search.libraryID), key);
    const compiled = this.compiled.get(`${search.libraryID}:${key}`);
    return stored && (compiled?.stored === stored ? compiled.spec : decodeSavedSpec(stored, search.libraryID));
  }
  init() {
    const adapter = this;
    const observer = Zotero.Notifier.registerObserver({ notify: action => { if (["add", "close"].includes(action)) this.refresh(); } }, ["tab"]);
    this.cleanups.push(() => Zotero.Notifier.unregisterObserver(observer));
    patch(Zotero.Search.prototype, "hasPostSearchFilter", original => function (...args) { return !!adapter.spec(this) || original.apply(this, args); }, this.cleanups);
    patch(Zotero.Search.prototype, "clone", original => function (...args) {
      const clone = original.apply(this, args);
      if (adapter.spec(this)) clone._qsSavedKey = this.key || this._qsSavedKey;
      return clone;
    }, this.cleanups);
    patch(Zotero.Search.prototype, "search", original => async function (asTempTable) {
      const spec = adapter.spec(this);
      if (!spec) return original.call(this, asTempTable);
      if (adapter.app.stopped) return asTempTable ? Zotero.Search.idsToTempTable([]) : [];
      const key = `${this.libraryID}:${this.key || this._qsSavedKey}`;
      if (!adapter.pending.has(key)) {
        const stored = adapter.app.layout.getQuery(libraryKey(this.libraryID), this.key || this._qsSavedKey);
        const promise = (async () => {
          const prepared = await adapter.app.search.prepare({ ...spec, excludeSearch: this.key || this._qsSavedKey });
          if (adapter.app.stopped) return [];
          adapter.compiled.set(key, { stored, spec: prepared });
          const dependencies = (prepared.resolvedFilters || []).flatMap(filter => filter.type === "directory" ? filter.matches.filter(match => match.kind === "search").map(match => `${match.libraryID}:${match.key}`) : []);
          if (prepared.scope.type === "search") dependencies.push(`${prepared.scope.libraryID}:${prepared.scope.searchKey}`);
          adapter.dependencies.set(key, dependencies);
          const visit = (dependency, path = new Set()) => {
            if (path.has(dependency)) throw new Error(t("保存搜索循环依赖"));
            for (const next of adapter.dependencies.get(dependency) || []) visit(next, new Set([...path, dependency]));
          };
          visit(key);
          return await original.call(adapter.app.search.buildSearch(prepared), false) || [];
        })().finally(() => { adapter.pending.delete(key); adapter.dependencies.delete(key); });
        adapter.pending.set(key, { stored, promise });
      }
      const pending = adapter.pending.get(key), ids = await pending.promise;
      if (adapter.app.stopped) return asTempTable ? Zotero.Search.idsToTempTable([]) : [];
      if (adapter.app.layout.getQuery(libraryKey(this.libraryID), this.key || this._qsSavedKey) !== pending.stored) return this.search(asTempTable);
      return asTempTable ? Zotero.Search.idsToTempTable(ids) : ids;
    }, this.cleanups);
    return this;
  }
  refresh() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.app.stopped) return;
      this.app.directoryCounts.epoch++; this.app.directoryCounts.searches.clear();
      for (const [win, entry] of this.app.windows) {
        const row = win.ZoteroPane?.collectionsView?.selectedTreeRow;
        if (row?.isSearch?.() && this.spec(row.ref) && !entry.native?.active) {
          row.clearCache();
          win.ZoteroPane.itemsView.refresh().catch(error => this.app.logError(error));
        }
      }
    }, 100);
  }
  destroy() { clearTimeout(this.timer); this.compiled.clear(); for (const cleanup of this.cleanups.splice(0).reverse()) cleanup(); }
}
