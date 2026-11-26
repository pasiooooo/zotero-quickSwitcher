// SPDX-License-Identifier: AGPL-3.0-or-later
import { t, itemTypeLabel, typeLabels } from "./i18n.mjs";
import { tokenize, normalize, matchRanges, makeSnippet, plainText, libraryKey, loadedItems, topItem } from "./core.mjs";
import { authorMatches, groupAuthors } from "./authors.mjs";
import { filterMatches } from "./filter-match.mjs";
import { outlineMatches } from "./outline.mjs";

const labels = { title: "题名", creator: "作者", date: "年份", year: "年份", publicationTitle: "Publication", publisher: "Publisher", itemType: "条目类型", DOI: "DOI", citationKey: "引用键", tag: "标签", abstractNote: "摘要", note: "笔记", annotationText: "批注", annotationComment: "批注评论", fulltextContent: "全文" };
const defaults = ["title", "creator", "date", "DOI", "citationKey", "tag", "abstractNote"];
const textOps = new Set(["contains", "is", "beginsWith"]);
const fieldTypes = ["year", "venue", "type", "tag"];
const tagGlob = filter => !filter.ref && !filter.quoted && /[*?]/u.test(filter.value) && !/^\*+$/u.test(filter.value);

function metadata(item) {
  const get = field => plainText(item.getField(field, false, true) || "");
  const creators = item.getCreators?.() || [];
  const authors = creators.map(c => [c.firstName, c.lastName].filter(Boolean).join(" ")).join("; ");
  const date = get("date");
  return { title: get("title") || item.attachmentFilename || t("无题名"), creator: authors,
    date: date.match(/\d{4}/)?.[0] || date.slice(0, 4), DOI: get("DOI"), citationKey: get("citationKey"),
    tag: (item.getTags?.() || []).map(t => t.tag).join("; "), abstractNote: get("abstractNote"), dateText: date,
    publicationTitle: get("publicationTitle"), publisher: get("publisher"), itemType: Zotero.ItemTypes?.getName?.(item.itemTypeID) || "",
    itemIconType: item.isPDFAttachment?.() ? "attachmentPDF" : item.isEPUBAttachment?.() ? "attachmentEPUB" : Zotero.ItemTypes?.getName?.(item.itemTypeID) || "" };
}

function addGroup(search, terms) {
  if (terms.length === 1) { search.addCondition(terms[0][0], "contains", terms[0][1]); return; }
  search.addCondition("groupStart", "true", ""); search.addCondition("joinMode", "any", "");
  for (const [field, value] of terms) search.addCondition(field, "contains", value);
  search.addCondition("groupEnd", "true", "");
}

function addFilterLeaf(search, leaf) {
  if (leaf.conditions.length === 1) {
    const condition = leaf.conditions[0]; search.addCondition(condition.condition, condition.operator, condition.value); return;
  }
  // Zotero flattens ALL groups; OR false keeps each negative block inside SQL parentheses.
  const guard = leaf.join === "all" && leaf.conditions.length > 1;
  if (guard) { search.addCondition("groupStart", "true", ""); search.addCondition("joinMode", "any", ""); }
  search.addCondition("groupStart", "true", ""); search.addCondition("joinMode", leaf.join, "");
  if (leaf.conditions.length > 64) {
    const size = Math.max(64, Math.ceil(leaf.conditions.length / 64));
    for (let i = 0; i < leaf.conditions.length; i += size) addFilterLeaf(search, { join: leaf.join, conditions: leaf.conditions.slice(i, i + size) });
  } else for (const condition of leaf.conditions) search.addCondition(condition.condition, condition.operator, condition.value);
  search.addCondition("groupEnd", "true", "");
  if (guard) {
    search.addCondition("groupStart", "true", ""); search.addCondition("joinMode", "all", "");
    search.addCondition("title", "is", ""); search.addCondition("title", "isNot", "");
    search.addCondition("groupEnd", "true", ""); search.addCondition("groupEnd", "true", "");
  }
}

function filterLeaf(filter, libraryID) {
    if (filter.type === "tag" && !tagGlob(filter)) {
      const exact = !!(filter.ref || filter.quoted);
      if (!exact && /^\*+$/u.test(filter.value)) return { join: "all", conditions: [{ condition: "numTags", operator: filter.negated ? "is" : "isGreaterThan", value: "0" }] };
      const operator = exact ? (filter.negated ? "isNot" : "is") : (filter.negated ? "doesNotContain" : "contains");
      return { join: "all", conditions: [{ condition: "tag", operator, value: filter.ref?.key ?? filter.value }] };
    }
    const matches = filter.matches.filter(match => libraryID == null || match.libraryID === libraryID);
    let leaf;
    if (filter.type === "author" && filter.allAuthors) leaf = { join: "all", conditions: [{ condition: "creator", operator: filter.negated ? "isEmpty" : "isNotEmpty", value: "" }] };
    else if (filter.type === "venue" && filter.allValues) leaf = { join: filter.negated ? "all" : "any", conditions: ["publicationTitle", "publisher"].map(condition => ({ condition, operator: filter.negated ? "isEmpty" : "isNotEmpty", value: "" })) };
    else if (filter.type === "directory" && matches.some(match => ["library", "feed"].includes(match.kind))) leaf = !filter.negated;
    else {
      const conditions = [...new Map(matches.map(match => {
        const condition = ["outline", "tabs"].includes(filter.type) ? "itemID" : filter.type === "author" ? "creator" : fieldTypes.includes(filter.type) ? match.field : match.kind === "search" ? "savedSearch" : "collection";
        const value = ["outline", "tabs"].includes(filter.type) ? match.itemID : filter.type === "author" ? match.name : fieldTypes.includes(filter.type) ? match.value : match.key;
        return [`${condition}:${value}`, { condition, operator: filter.negated ? "isNot" : "is", value }];
      })).values()];
      leaf = conditions.length ? { join: filter.negated ? "all" : "any", conditions } : !!filter.negated;
    }
    return leaf;
}

function addFilterGroups(search, filters, libraryID) {
  const groups = [[]];
  for (const filter of filters) {
    if (filter.join === "or" && groups.at(-1).length) groups.push([]);
    groups.at(-1).push(filterLeaf(filter, libraryID));
  }
  const branches = groups.filter(group => !group.includes(false)).map(group => group.filter(leaf => leaf !== true));
  if (branches.some(branch => !branch.length)) return;
  if (!branches.length) {
    // A condition and its negation express false without a non-persistent item-ID snapshot.
    search.addCondition("title", "is", ""); search.addCondition("title", "isNot", ""); return;
  }
  search.addCondition("groupStart", "true", ""); search.addCondition("joinMode", "any", "");
  for (const branch of branches) {
    search.addCondition("groupStart", "true", ""); search.addCondition("joinMode", "all", "");
    for (const leaf of branch) addFilterLeaf(search, leaf);
    search.addCondition("groupEnd", "true", "");
  }
  search.addCondition("groupEnd", "true", "");
}

function validateQueryTree(tree, filters = [], depth = 0, count = { value: 0 }) {
  if (!tree || typeof tree !== "object" || Array.isArray(tree) || depth > 32 || ++count.value > 512) throw new Error(t("检索式结构无效"));
  if (tree.op) {
    if (!["AND", "OR", "NOT"].includes(tree.op) || !Array.isArray(tree.children) || !tree.children.length
      || tree.op === "NOT" && tree.children.length !== 1) throw new Error(t("检索式结构无效"));
    for (const child of tree.children) validateQueryTree(child, filters, depth + 1, count);
  } else if (Object.hasOwn(tree, "filterIndex")) {
    if (!Number.isInteger(tree.filterIndex) || tree.filterIndex < 0 || tree.filterIndex >= filters.length) throw new Error(t("检索式结构无效"));
  } else if (typeof tree.text !== "string" || !tree.text.trim() || tree.text.length > 2048
    || tree.quoted !== undefined && typeof tree.quoted !== "boolean") throw new Error(t("检索式结构无效"));
}

function addQueryTree(search, tree, spec, negated = false) {
  if (tree.op === "NOT") return addQueryTree(search, tree.children[0], spec, !negated);
  if (tree.op) {
    const op = negated ? tree.op === "AND" ? "OR" : "AND" : tree.op;
    if (tree.children.length === 1) return addQueryTree(search, tree.children[0], spec, negated);
    search.addCondition("groupStart", "true", ""); search.addCondition("joinMode", op === "OR" ? "any" : "all", "");
    for (const child of tree.children) addQueryTree(search, child, spec, negated);
    search.addCondition("groupEnd", "true", ""); return;
  }
  if (Object.hasOwn(tree, "filterIndex")) {
    const filter = spec.resolvedFilters[tree.filterIndex], leaf = filterLeaf({ ...filter, negated: !!filter.negated !== negated }, search.libraryID);
    if (typeof leaf !== "boolean") addFilterLeaf(search, leaf);
    else {
      search.addCondition("groupStart", "true", ""); search.addCondition("joinMode", leaf ? "any" : "all", "");
      search.addCondition("title", "is", ""); search.addCondition("title", "isNot", ""); search.addCondition("groupEnd", "true", "");
    }
    return;
  }
  const fields = (spec.fields || defaults).map(field => field === "date" ? "year" : field);
  if (spec.sources?.notes) fields.push("note");
  if (spec.sources?.annotations) fields.push("annotationText", "annotationComment");
  if (spec.sources?.fulltext) fields.push("fulltextContent");
  addFilterLeaf(search, { join: negated ? "all" : "any", conditions: [...new Set(fields)].map(condition => ({ condition, operator: negated ? "doesNotContain" : "contains", value: tree.text })) });
}

export function queryEvidenceSpec(spec) {
  if (!spec.queryTree) return spec;
  if (spec.filters?.length && spec.resolvedFilters?.length !== spec.filters.length) return { ...spec, text: "", queryTree: undefined };
  const conditions = [];
  addQueryTree({ libraryID: spec.scope?.type === "all" ? null : spec.scope?.libraryID,
    addCondition(condition, operator, value) { conditions.push({ condition, operator, value }); } }, spec.queryTree, spec);
  return { ...spec, text: "", queryTree: undefined, resolvedFilters: undefined,
    nativeConditions: [...(spec.nativeConditions || []), ...conditions] };
}

export class SearchService {
  constructor(prefs, { onInvalidate = () => {}, directories = async () => [], outlines = async () => ({ rows: [] }), tabs = async () => [] } = {}) {
    this.prefs = prefs; this.onInvalidate = onInvalidate; this.directories = directories; this.outlines = outlines; this.tabs = tabs; this.metadataCache = new Map();
    this.authorGeneration = 0; this.filterGeneration = 0; this.authorCache = null; this.authorPending = null; this.fieldCache = new Map();
    this.observer = Zotero.Notifier.registerObserver({ notify: (action, type, ids) => {
      if (type === "item") for (const id of ids) this.metadataCache.delete(id);
      else if (type !== "collection-item") this.metadataCache.clear();
      if (["item", "group", "feed", "feedItem"].includes(type)) { this.authorGeneration++; this.authorCache = null; this.fieldCache.clear(); }
      else if (type === "item-tag" || type === "tag") this.fieldCache.delete("tag");
      this.filterGeneration++;
      this.onInvalidate();
    } }, ["item", "item-tag", "tag", "file", "collection-item", "collection", "search", "group", "feed", "feedItem"]);
  }
  destroy() { Zotero.Notifier.unregisterObserver(this.observer); this.metadataCache.clear(); this.authorGeneration++; this.filterGeneration++; this.authorCache = null; this.fieldCache.clear(); }
  libraries() {
    return Zotero.Libraries.getAll().filter(lib => ["user", "group", "feed"].includes(lib.libraryType)).map(lib => ({ libraryID: lib.libraryID, key: libraryKey(lib.libraryID), name: lib.name, type: lib.libraryType }));
  }
  makeQuery(win, overrides = {}) {
    const pane = win?.ZoteroPane || Zotero.getMainWindow()?.ZoteroPane;
    let libID = pane?.getSelectedLibraryIDs?.()[0] || Zotero.Libraries.userLibraryID;
    if (!["user", "group", "feed"].includes(Zotero.Libraries.get(libID)?.libraryType)) libID = Zotero.Libraries.userLibraryID;
    return { text: "", fields: this.prefs.get("fields") || defaults, sources: this.prefs.get("sources") || {},
      scope: this.prefs.get("defaultScope") === "all" ? { type: "all" } : { type: "library", libraryID: libID }, ...overrides };
  }
  async allAuthorRows() {
    if (this.authorCache) return this.authorCache;
    const generation = this.authorGeneration;
    if (!this.authorPending || this.authorPending.generation !== generation) {
      const pending = { generation };
      pending.promise = (async () => {
        const libraries = this.libraries().map(lib => lib.libraryID);
        if (!libraries.length) return [];
        const records = await Zotero.DB.queryAsync(`SELECT C.firstName, C.lastName, C.fieldMode, I.libraryID, COUNT(DISTINCT I.itemID) AS count
          FROM creators C JOIN itemCreators IC ON IC.creatorID = C.creatorID JOIN items I ON I.itemID = IC.itemID
          WHERE I.libraryID IN (${libraries.map(() => "?").join(",")})
          AND I.itemID NOT IN (SELECT itemID FROM deletedItems)
          GROUP BY C.firstName, C.lastName, C.fieldMode, I.libraryID`, libraries);
        // Zotero database rows are proxies; copy only the selected columns before caching them.
        return groupAuthors(records.map(record => ({ firstName: record.firstName, lastName: record.lastName, fieldMode: record.fieldMode, libraryID: record.libraryID, count: record.count })));
      })();
      this.authorPending = pending;
    }
    const pending = this.authorPending;
    try {
      const rows = await pending.promise;
      if (generation !== this.authorGeneration) return this.allAuthorRows();
      this.authorCache = rows; return rows;
    } finally { if (this.authorPending === pending) this.authorPending = null; }
  }
  async authorRows(text = "") {
    const rows = await this.allAuthorRows();
    if (!text.trim()) return rows;
    const exact = [], partial = [];
    for (const row of rows) if (authorMatches(row, text)) (authorMatches(row, text, { exact: true }) ? exact : partial).push(row);
    return [...exact, ...partial];
  }
  async fieldRows(type, text = "") {
    if (!fieldTypes.includes(type)) throw new Error(t("未知快捷筛选字段"));
    if (!this.fieldCache.has(type)) this.fieldCache.set(type, (async () => {
      const libraries = this.libraries().map(library => library.libraryID);
      if (!libraries.length) return [];
      const topLevel = "I.itemID NOT IN (SELECT itemID FROM deletedItems) AND I.itemID NOT IN (SELECT itemID FROM itemAttachments WHERE parentItemID IS NOT NULL) AND I.itemID NOT IN (SELECT itemID FROM itemNotes WHERE parentItemID IS NOT NULL) AND I.itemID NOT IN (SELECT itemID FROM itemAnnotations)";
      let records;
      if (type === "type") {
        const rows = await Zotero.DB.queryAsync(`SELECT I.itemTypeID, I.libraryID, COUNT(*) AS count FROM items I WHERE I.libraryID IN (${libraries.map(() => "?").join(",")}) AND ${topLevel} GROUP BY I.itemTypeID, I.libraryID`, libraries);
        records = rows.map(row => { const type = Zotero.ItemTypes.getName(row.itemTypeID); return { libraryID: row.libraryID, count: row.count, field: "itemType", value: type, title: itemTypeLabel(type), aliases: typeLabels[type] || [] }; });
      } else if (type === "tag") {
        const rows = await Zotero.DB.queryAsync(`SELECT T.name, I.libraryID, COUNT(DISTINCT I.itemID) AS count FROM itemTags IT
          JOIN tags T ON T.tagID=IT.tagID JOIN items I ON I.itemID=IT.itemID WHERE I.libraryID IN (${libraries.map(() => "?").join(",")})
          AND ${topLevel} GROUP BY T.tagID, I.libraryID`, libraries);
        records = rows.map(row => ({ libraryID: row.libraryID, count: row.count, field: "tag", value: row.name, title: row.name }));
      } else {
        const fields = type === "year" ? ["date"] : ["publicationTitle", "publisher"];
        const ids = field => [...new Set([Zotero.ItemFields.getID(field), ...(Zotero.ItemFields.getTypeFieldsFromBase(field) || [])])];
        const fieldIDs = [...new Set(fields.flatMap(ids))];
        const source = type === "year" ? "'year'" : `CASE WHEN D.fieldID IN (${ids("publicationTitle").join(",")}) THEN 'publicationTitle' ELSE 'publisher' END`;
        const value = type === "year" ? "SUBSTR(V.value, 1, 4)" : "V.value";
        const rows = await Zotero.DB.queryAsync(`SELECT ${source} AS field, ${value} AS value, I.libraryID, COUNT(DISTINCT I.itemID) AS count FROM items I JOIN itemData D ON I.itemID=D.itemID JOIN itemDataValues V ON D.valueID=V.valueID WHERE I.libraryID IN (${libraries.map(() => "?").join(",")}) AND D.fieldID IN (${fieldIDs.map(() => "?").join(",")}) AND ${topLevel} GROUP BY ${source}, ${value}, I.libraryID`, [...libraries, ...fieldIDs]);
        records = rows.map(row => ({ libraryID: row.libraryID, count: row.count, field: row.field, value: row.value, title: plainText(row.value) }));
      }
      const grouped = new Map();
      for (const record of records) {
        if (!record.title || type === "year" && !/^[1-9]\d{3}$/u.test(record.title)) continue;
        const key = type === "venue" ? `${record.field}:${normalize(record.title)}` : record.value;
        if (!grouped.has(key)) grouped.set(key, { kind: type, key, title: record.title, field: record.field, records: [], count: 0 });
        const row = grouped.get(key); row.records.push(record); row.count += Number(record.count);
      }
      return [...grouped.values()].sort((a, b) => type === "year" ? b.title.localeCompare(a.title) : b.count - a.count || a.title.localeCompare(b.title));
    })());
    const pending = this.fieldCache.get(type); let rows;
    try { rows = await pending; }
    catch (error) { if (pending === this.fieldCache.get(type)) this.fieldCache.delete(type); throw error; }
    if (pending !== this.fieldCache.get(type)) return this.fieldRows(type, text);
    if (type === "type") rows = rows.map(row => ({ ...row, title: itemTypeLabel(row.key) }));
    return rows.filter(row => !text.trim() || filterMatches(row.title, text) || type === "type" && (filterMatches(row.key, text) || row.records.some(record => record.aliases.some(alias => filterMatches(alias, text)))));
  }
  async prepare(spec) {
    if (spec.queryError) throw new Error(t(spec.queryError));
    if (spec.queryTree) validateQueryTree(spec.queryTree, spec.filters);
    if (!spec.filters?.length) return spec;
    if (spec.filters.length > 64 || spec.filters.some(filter => !["author", "directory", ...fieldTypes, "outline", "tabs"].includes(filter.type)
      || typeof filter.value !== "string" || ![undefined, "and", "or"].includes(filter.join)
      || filter.negated !== undefined && typeof filter.negated !== "boolean")) throw new Error(t("筛选条件无效"));
    if (!spec.filters.some(filter => ["outline", "tabs"].includes(filter.type)) && spec.resolvedFilters?.length === spec.filters.length && spec.filterGeneration === this.filterGeneration
      && spec.filters.every((filter, index) => {
        const previous = spec.resolvedFilters[index];
        return filter.type === previous.type && filter.value === previous.value && filter.negated === previous.negated && filter.join === previous.join && filter.quoted === previous.quoted
          && filter.ref?.kind === previous.ref?.kind && filter.ref?.libraryID === previous.ref?.libraryID && filter.ref?.key === previous.ref?.key && filter.ref?.field === previous.ref?.field;
      })) return spec;
    const generation = this.filterGeneration;
    const [authors, directories, outline, tabs] = await Promise.all([
      spec.filters.some(filter => filter.type === "author" && (filter.ref || !/^\*+$/u.test(filter.value.trim()))) ? this.allAuthorRows() : [],
      spec.filters.some(filter => filter.type === "directory") ? this.directories().then(rows => rows.filter(row => !(row.kind === "search" && row.libraryID === spec.scope.libraryID && row.key === spec.excludeSearch))) : [],
      spec.filters.some(filter => filter.type === "outline") ? this.outlines(spec) : null,
      spec.filters.some(filter => filter.type === "tabs") ? this.tabs(spec) : [],
    ]);
    const fieldRows = new Map(await Promise.all([...new Set(spec.filters.filter(filter => fieldTypes.includes(filter.type) && (filter.type !== "tag" || tagGlob(filter))).map(filter => filter.type))].map(async type => [type, await this.fieldRows(type)])));
    if (generation !== this.filterGeneration) return this.prepare({ ...spec, resolvedFilters: undefined });
    const resolvedFilters = spec.filters.map(filter => {
      let matches;
      if (filter.type === "tabs") {
        matches = tabs.filter(row => filter.ref ? row.attachmentID === filter.ref.attachmentID : filterMatches(`${row.title} ${row.authors} ${row.year} ${row.citationKey || ""}`, filter.quoted ? JSON.stringify(filter.value) : filter.value))
          .filter(row => row.itemID).map(row => ({ kind: "tab", itemID: row.itemID, libraryID: row.libraryID, attachmentID: row.attachmentID, title: row.title, key: String(row.attachmentID) }));
      } else if (filter.type === "outline") {
        const text = filter.quoted ? JSON.stringify(filter.value) : filter.value;
        matches = (outline?.rows || []).filter(row => filter.ref ? row.attachmentID === filter.ref.attachmentID && row.outlineKey === filter.ref.key
          : outlineMatches(row, text)).map(row => ({ kind: "outline", itemID: row.itemID, libraryID: row.libraryID, attachmentID: row.attachmentID, key: row.outlineKey, title: row.title, path: [...row.parents, row.title].join(" › ") }));
      } else if (filter.type === "author") {
        if (!filter.ref && !filter.quoted && /^\*+$/u.test(filter.value.trim())) return { ...filter, matches: [], allAuthors: true };
        matches = authors.filter(row => filter.ref ? filter.ref.kind === "author" && row.key === filter.ref.key : authorMatches(row, filter.value, { exact: !!filter.quoted })).flatMap(row => row.records)
          .map(record => ({ ...record, name: [record.firstName, record.lastName].filter(Boolean).join(" ").trim() }));
      } else if (fieldTypes.includes(filter.type)) {
        if (filter.type === "tag" && !tagGlob(filter)) return { ...filter, matches: [] };
        if (filter.type === "venue" && !filter.ref && !filter.quoted && /^\*+$/u.test(filter.value.trim())) return { ...filter, matches: [], allValues: true };
        matches = fieldRows.get(filter.type).filter(row => filter.ref ? row.kind === filter.ref.kind && row.key === filter.ref.key && (!filter.ref.field || row.field === filter.ref.field)
          : filterMatches(row.title, filter.value, { exact: !!filter.quoted }) || filter.type === "type" && filterMatches(row.key, filter.value, { exact: !!filter.quoted })).flatMap(row => row.records.map(record => ({ ...record, key: row.key, title: row.title })));
      } else {
        matches = directories.filter(row => filter.ref
          ? row.kind === filter.ref.kind && row.libraryID === filter.ref.libraryID && (["library", "feed", "feeds"].includes(row.kind) || row.key === filter.ref.key)
          : filterMatches(row.title, filter.value, { exact: !!filter.quoted }) || filter.value.includes("›") && filterMatches(row.pathSegments?.join(" › ") || row.path, filter.value, { exact: !!filter.quoted }))
          .map(row => ({ kind: row.kind, libraryID: row.libraryID, key: row.key, title: row.title, path: row.path }));
        if (matches.some(row => row.kind === "feeds")) matches = [...matches, ...directories.filter(row => row.kind === "feed")];
      }
      return { ...filter, matches };
    });
    return { ...spec, resolvedFilters, filterGeneration: generation, ...(outline ? { outlineProgress: { completed: outline.completed, documents: outline.documents, pending: outline.pending } } : {}) };
  }
  buildSearch(spec, libraryID) {
    if (spec.queryError) throw new Error(t(spec.queryError));
    if (spec.queryTree) validateQueryTree(spec.queryTree, spec.filters);
    const search = new Zotero.Search();
    const targetLibrary = libraryID ?? (spec.scope.type === "all" ? null : (spec.scope.libraryID || Zotero.Libraries.userLibraryID));
    if (targetLibrary !== null) search.libraryID = targetLibrary;
    if (spec.filters?.length && (!spec.resolvedFilters || search.libraryID === null && spec.filters.some(filter => filter.type === "directory"))) throw new Error(t("请先解析筛选条件并指定文库"));
    search.addCondition("joinMode", "all", "");
    if (spec.nativeConditions?.length) {
      const flags = new Set(["resultLevel", "recursive", "includeParents", "includeChildren", "includeParentsAndChildren", "noChildren", "deleted"]);
      search.addCondition("groupStart", "true", "");
      for (const c of spec.nativeConditions) if (!flags.has(c.condition)) search.addCondition(c.condition, c.operator, c.value);
      search.addCondition("groupEnd", "true", "");
      for (const c of spec.nativeConditions) if (flags.has(c.condition)) search.addCondition(c.condition, c.operator, c.value);
    }
    {
      const fields = spec.fields || defaults;
      if (spec.queryTree?.op === "AND") for (const child of spec.queryTree.children) addQueryTree(search, child, spec);
      else if (spec.queryTree) addQueryTree(search, spec.queryTree, spec);
      else for (const term of tokenize(spec.text)) {
        const terms = fields.map(field => [field === "date" ? "year" : field, term]);
        if (spec.sources?.notes) terms.push(["note", term]);
        if (spec.sources?.annotations) terms.push(["annotationText", term], ["annotationComment", term]);
        if (spec.sources?.fulltext) terms.push(["fulltextContent", term]);
        addGroup(search, terms);
      }
      if (!spec.sources?.notes && !spec.nativeConditions && !spec.resolvedFilters?.some(filter => filter.type === "type" && !filter.negated && filter.matches.some(match => match.value === "note"))) search.addCondition("itemType", "isNot", "note");
    }
    if (spec.filters?.length) {
      if (!spec.queryTree) addFilterGroups(search, spec.resolvedFilters, search.libraryID);
      if (spec.resolvedFilters.some(filter => filter.type === "type")) search.addCondition("noChildren", "true", "");
      if (spec.resolvedFilters.some(filter => filter.type === "directory" && filter.matches.some(match => match.kind === "collection"))
        && (spec.recursive ?? spec.scope.recursive ?? this.prefs?.get("recursive")) !== false) search.addCondition("recursive", "true", "");
    }
    if (!spec.nativeConditions?.some(c => c.condition === "resultLevel")) search.addCondition("resultLevel", "item", "");
    if (spec.scope.type === "collection" && spec.scope.collectionKey) {
      search.addCondition("collection", "is", spec.scope.collectionKey);
      if (spec.scope.recursive !== false) search.addCondition("recursive", "true", "");
    } else if (spec.scope.type === "search" && spec.scope.searchKey) {
      search.addCondition("savedSearch", "is", spec.scope.searchKey);
    }
    return search;
  }
  async getMetadata(item) {
    if (this.metadataCache.has(item.id)) return this.metadataCache.get(item.id);
    await loadedItems([item.id]);
    const value = metadata(item);
    value.normalized = Object.fromEntries(Object.entries(value).map(([field, text]) => [field, normalize(text)]));
    let offset = 0;
    value.creatorDetails = (item.getCreators?.() || []).map(creator => {
      const name = [creator.firstName, creator.lastName].filter(Boolean).join(" "), start = offset;
      offset += name.length + 2;
      return { ...creator, name, start, end: start + name.length, isAuthor: creator.creatorType === "author" || creator.creatorTypeID != null && creator.creatorTypeID === Zotero.CreatorTypes?.getID("author") };
    });
    value.creatorValues = value.creatorDetails.map(creator => creator.name);
    value.authorValues = value.creatorDetails.filter(creator => creator.isAuthor).map(creator => creator.name);
    value.tagValues = (item.getTags?.() || []).map(t => t.tag);
    this.metadataCache.set(item.id, value); return value;
  }
  result(item, spec, terms = tokenize(spec.text).map(normalize), data = this.metadataCache.get(item.id)) {
    if (!data) return this.getMetadata(item).then(value => this.result(item, spec, terms, value));
    let score = 0;
    for (const q of terms) {
      if (data.normalized.title === q) score += 100;
      else if (data.normalized.title.startsWith(q)) score += 60;
      else if (data.normalized.title.includes(q)) score += 40;
      if (data.normalized.creator.includes(q)) score += 25;
      if (data.normalized.DOI.includes(q)) score += 30;
      if (data.normalized.citationKey?.includes(q)) score += 35;
      if (data.normalized.tag.includes(q)) score += 15;
      if (data.normalized.abstractNote.includes(q)) score += 5;
    }
    const kind = item.isNote?.() ? "note" : item.isAttachment?.() ? "attachment" : "item";
    return { id: item.id, itemID: item.id, key: item.key, libraryID: item.libraryID, kind,
      title: data.title, authors: data.creator, creatorDetails: data.creatorDetails, year: data.date, citationKey: data.citationKey, itemType: data.itemType, itemIconType: data.itemIconType, publicationTitle: data.publicationTitle, publisher: data.publisher, tags: item.getTags?.().map(t => t.tag) || [], abstract: data.abstractNote, score,
      evidence: [] };
  }
  metadataEvidence(data, itemID, spec) {
    const conditions = [...(spec.nativeConditions || []), ...tokenize(spec.text).flatMap(value => (spec.fields || defaults).map(field => ({ condition: field, operator: "contains", value })))];
    for (const filter of spec.resolvedFilters || []) if (filter.type === "tag") conditions.push(...(filterLeaf(filter, spec.scope?.libraryID).conditions || []));
    const byField = new Map();
    for (const condition of conditions) {
      if (!["contains", "is", "beginsWith", "doesNotContain", "isNot", "isAfter", "isBefore", "isInTheLast"].includes(condition.operator)) continue;
      if (condition.condition === "title" && condition.value === "" && ["is", "isNot"].includes(condition.operator)) continue;
      const role = ["author", "editor", "bookAuthor"].includes(condition.condition) && condition.condition;
      let field = condition.condition === "year" ? "date" : role ? "creator" : condition.condition;
      const fieldID = !labels[field] && Zotero.ItemFields?.getID(field);
      const baseID = fieldID && data.itemTypeID && Zotero.ItemFields.getBaseIDFromTypeAndField(data.itemTypeID, fieldID);
      if (baseID) field = Zotero.ItemFields.getName(baseID);
      const label = labels[field] || fieldID && Zotero.ItemFields.getLocalizedString(field);
      const text = field === "date" && condition.condition !== "year" ? data.dateText || data.date : data[field];
      if (!text || !label) continue;
      const roleCreators = role && data.creatorDetails?.filter(creator => creator.creatorType === role || creator.creatorTypeID === Zotero.CreatorTypes?.getID(role));
      const values = role ? roleCreators?.map(creator => creator.name) || (role === "author" ? data.authorValues || data.creatorValues || [text] : [])
        : field === "creator" ? data.creatorValues || [text] : field === "tag" ? data.tagValues || [text] : [text];
      const normalizedValue = normalize(condition.value);
      const matches = values.some(value => condition.operator === "is" ? normalize(value) === normalizedValue
        : condition.operator === "beginsWith" ? normalize(value).startsWith(normalizedValue) : normalize(value).includes(normalizedValue));
      if (textOps.has(condition.operator)) {
        if (!matches) continue;
        const ranges = roleCreators ? roleCreators.flatMap(creator => matchRanges(creator.name, condition.value).map(range => ({ start: range.start + creator.start, end: range.end + creator.start }))) : matchRanges(text, condition.value);
        if (!ranges.length) continue;
        if (!byField.has(field)) byField.set(field, { field, label, text, ranges: [], sourceItemID: itemID });
        byField.get(field).ranges.push(...ranges);
      } else if (condition.operator === "doesNotContain" && !values.some(value => normalize(value).includes(normalizedValue))
        || condition.operator === "isNot" && !values.some(value => normalize(value) === normalizedValue)) {
        const description = t("{field}满足排除条件：{value}", { field: t(labels[field] || field), value: condition.value });
        byField.set(`negative-${field}`, { field, label: "排除条件", text: description, ranges: [], sourceItemID: itemID });
      } else if (["isAfter", "isBefore", "isInTheLast"].includes(condition.operator)) {
        const description = t("{field}：{text}；条件 {operator} {value}", { field: t(labels[field] || field), text, operator: condition.operator, value: condition.value });
        byField.set(`condition-${field}`, { field, label: "高级条件", text: description, ranges: [], sourceItemID: itemID });
      }
    }
    for (const [index, filter] of (spec.resolvedFilters || []).entries()) {
      if (["year", "venue", "type"].includes(filter.type)) {
        const fields = filter.type === "year" ? ["year"] : filter.type === "type" ? ["itemType"] : ["publicationTitle", "publisher"];
        const hits = fields.filter(field => filter.allValues ? !!data[field] : filter.matches.some(match => match.field === field && normalize(plainText(match.value)) === normalize(data[field === "year" ? "date" : field] || "")));
        if (!filter.negated) for (const field of hits) {
          const key = field === "year" ? "date" : field, text = data[key];
          if (!byField.has(key)) byField.set(key, { field: key, label: labels[key], text, ranges: [], sourceItemID: itemID });
          const ranges = matchRanges(text, filter.value); byField.get(key).ranges.push(...(ranges.length ? ranges : [{ start: 0, end: text.length }]));
        }
        else if (!hits.length) byField.set(`negative-field-${index}`, { field: fields[0], label: "排除条件", text: t("{field}排除：{value}", { field: t(labels[fields[0]]), value: filter.value }), ranges: [], sourceItemID: itemID });
        continue;
      }
      if (filter.type !== "author") continue;
      const names = new Set(filter.matches.map(match => match.name));
      const matched = (data.creatorValues || []).filter(name => filter.allAuthors || names.has(name));
      if (!filter.negated && matched.length) {
        if (!byField.has("creator")) byField.set("creator", { field: "creator", label: labels.creator, text: data.creator, ranges: [], sourceItemID: itemID });
        byField.get("creator").ranges.push(...matched.flatMap(name => matchRanges(data.creator, name)));
      } else if (filter.negated && !matched.length) {
        byField.set(`negative-author-${index}`, { field: "creator", label: "排除条件", text: t("不含作者：{value}", { value: (this.prefs.get("authorPrefix") || "@") + filter.value }), ranges: [], sourceItemID: itemID });
      }
    }
    return [...byField.values()].map(e => ({ ...e, ranges: e.ranges.sort((a, b) => a.start - b.start), snippet: makeSnippet(e.text, e.ranges) }));
  }
  async search(spec, { limit, recent = [] } = {}) {
    spec = await this.prepare(spec);
    const ids = spec.scope.type === "all" && spec.filters?.length
      ? [...new Set((await Promise.all(this.libraries().map(lib => this.buildSearch(spec, lib.libraryID).search()))).flat())]
      : await this.buildSearch(spec).search();
    const candidates = await loadedItems(ids);
    const libraries = new Set(this.libraries().map(lib => lib.libraryID));
    const tops = new Map(), includeNotes = spec.sources?.notes || spec.nativeConditions
      || spec.resolvedFilters?.some(filter => filter.type === "type" && !filter.negated && filter.matches.some(match => match.value === "note"));
    for (const candidate of candidates) {
      if (candidate.deleted || !libraries.has(candidate.libraryID)) continue;
      const top = candidate.parentID ? await topItem(candidate) : candidate;
      if (!top.deleted && (!top.isNote?.() || includeNotes)) tops.set(top.id, top);
    }
    const terms = tokenize(spec.text).map(normalize);
    if (limit === 0) return { results: [], itemIDs: [...tops.keys()], total: tops.size, warnings: [] };
    let results = [...tops.values()].map(item => this.result(item, spec, terms));
    if (results.some(result => typeof result.then === "function")) results = await Promise.all(results);
    results.sort((a, b) => b.score - a.score || (recent.includes(a.id) ? recent.indexOf(a.id) : Infinity) - (recent.includes(b.id) ? recent.indexOf(b.id) : Infinity) || a.title.localeCompare(b.title));
    const visible = results.slice(0, limit);
    const evidenceSpec = queryEvidenceSpec(spec);
    for (const result of visible) result.evidence = this.metadataEvidence(this.metadataCache.get(result.id), result.id, evidenceSpec);
    return { results: visible, itemIDs: results.map(result => result.itemID), total: results.length, warnings: spec.sources?.fulltext ? ["全文仅覆盖 Zotero 已索引的内容"] : [], outlineProgress: spec.outlineProgress };
  }
  async evidenceForItem(item, spec) {
    spec = await this.prepare(spec);
    spec = queryEvidenceSpec(spec);
    item = await topItem(item);
    const data = { ...await this.getMetadata(item), itemTypeID: item.itemTypeID };
    for (const condition of spec.nativeConditions || []) {
      const id = Zotero.ItemFields?.getID(condition.condition);
      if (!id || !Zotero.ItemFields.getFieldIDFromTypeAndBase(item.itemTypeID, id)) continue;
      const baseID = Zotero.ItemFields.getBaseIDFromTypeAndField(item.itemTypeID, id), field = Zotero.ItemFields.getName(baseID || id);
      if (!Object.hasOwn(data, field)) data[field] = plainText(item.getField(field, false, true) || "");
    }
    const evidence = this.metadataEvidence(data, item.id, spec);
    if (item.isRegularItem?.()) await loadedItems([item.id], ["childItems"]);
    const attachments = item.isRegularItem?.() ? await loadedItems(item.getAttachments?.() || []) : item.isAttachment?.() ? [item] : [];
    for (const attachment of attachments) {
      const entries = this.metadataEvidence(await this.getMetadata(attachment), attachment.id, spec);
      for (const entry of entries) if (entry.field === "title") { entry.label = "附件题名"; evidence.push(entry); }
    }
    const conditions = [...(spec.nativeConditions || []), ...tokenize(spec.text).flatMap(value => [
      ...(spec.sources?.notes ? [{ condition: "note", operator: "contains", value }] : []),
      ...(spec.sources?.annotations ? [{ condition: "annotationText", operator: "contains", value }, { condition: "annotationComment", operator: "contains", value }] : []),
      ...(spec.sources?.fulltext ? [{ condition: "fulltextContent", operator: "contains", value }] : []),
    ])];
    const add = (field, text, sourceItemID) => {
      const ranges = conditions.filter(c => c.condition === field && textOps.has(c.operator)).flatMap(c => matchRanges(text, c.value, { fulltext: field === "fulltextContent" }));
      if (ranges.length) evidence.push({ field, label: labels[field], text, ranges: ranges.sort((a, b) => a.start - b.start), snippet: makeSnippet(text, ranges.sort((a, b) => a.start - b.start)), sourceItemID });
    };
    if (conditions.some(c => c.condition === "note")) {
      const notes = item.isNote?.() ? [item] : await loadedItems(item.getNotes?.() || [], ["note"]);
      for (const note of notes) { await note.loadAllData?.(); add("note", plainText(note.getNote()), note.id); }
    }
    if (attachments.length && conditions.some(c => c.condition.startsWith("annotation"))) {
      const placeholders = attachments.map(() => "?").join(",");
      const ids = await Zotero.DB.columnQueryAsync(`SELECT itemID FROM itemAnnotations WHERE parentItemID IN (${placeholders})`, attachments.map(a => a.id));
      const annotations = await loadedItems(ids, ["annotation"]);
      for (const annotation of annotations) { add("annotationText", plainText(annotation.annotationText), annotation.id); add("annotationComment", plainText(annotation.annotationComment), annotation.id); }
    }
    if (conditions.some(c => c.condition === "fulltextContent")) {
      for (const attachment of attachments) {
        const file = Zotero.Fulltext.getItemCacheFile(attachment).path;
        if (await IOUtils.exists(file)) {
          const text = await Zotero.File.getContentsAsync(file, "utf-8", Zotero.Prefs.get("fulltext.textMaxLength"));
          add("fulltextContent", text, attachment.id);
        }
      }
    }
    return evidence;
  }
}
