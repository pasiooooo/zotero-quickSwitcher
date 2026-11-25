import test from "node:test";
import assert from "node:assert/strict";
import { SearchService, queryEvidenceSpec } from "../src/search.mjs";
import { normalize } from "../src/core.mjs";

test("selected-item evidence reads other native fields and canonicalizes mappings without widening the metadata cache", async () => {
  const previous = globalThis.Zotero, reads = [], names = { 1: "language", 2: "institution", 3: "publisher" };
  globalThis.Zotero = { ItemFields: { getID: value => typeof value === "number" ? value : ({ language: 1, institution: 2, publisher: 3 })[value],
    getName: id => names[id], getFieldIDFromTypeAndBase: (type, id) => id, getBaseIDFromTypeAndField: (type, id) => id === 2 ? 3 : false,
    getLocalizedString: field => field === "language" ? "Language" : field } };
  try {
    const cached = { title: "Doc", creator: "", publisher: "Institute", creatorDetails: [], creatorValues: [] };
    const service = Object.create(SearchService.prototype); service.prepare = async spec => spec; service.getMetadata = async () => cached;
    const item = { id: 1, itemTypeID: 1, isRegularItem: () => false, isAttachment: () => false,
      getField: (field, formatted, mapped) => { reads.push([field, formatted, mapped]); return field === "language" ? "en-US" : ""; } };
    const entries = await service.evidenceForItem(item, { text: "", fields: [], nativeConditions: [
      { condition: "language", operator: "contains", value: "en" }, { condition: "institution", operator: "is", value: "Institute" }] });
    assert.deepEqual(entries.map(entry => entry.field), ["language", "publisher"]); assert.deepEqual(reads, [["language", false, true]]);
    assert.equal(Object.hasOwn(cached, "language"), false); assert.equal(Object.hasOwn(cached, "itemTypeID"), false);
  } finally { globalThis.Zotero = previous; }
});
test("native author and editor evidence highlight their own creator ranges even when names share a word", () => {
  const previous = globalThis.Zotero; globalThis.Zotero = { CreatorTypes: { getID: role => ({ author: 1, editor: 2 })[role] } };
  try {
    const data = { creator: "Shared One; Shared Editor", creatorDetails: [{ name: "Shared One", start: 0, creatorTypeID: 1 }, { name: "Shared Editor", start: 12, creatorTypeID: 2 }] };
    const evidence = role => SearchService.prototype.metadataEvidence(data, 1, { text: "", fields: [], nativeConditions: [{ condition: role, operator: "contains", value: "Shared" }] });
    assert.deepEqual(evidence("author")[0].ranges, [{ start: 0, end: 6 }]); assert.deepEqual(evidence("editor")[0].ranges, [{ start: 12, end: 18 }]);
  } finally { globalThis.Zotero = previous; }
});

test("native equality and exclusions produce evidence only when the specific condition holds", () => {
  const data = { title: "fault transfer", creator: "First Author; Second Author", creatorValues: ["First Author", "Second Author"], date: "2021", tag: "fault; rocks", tagValues: ["fault", "rocks"], abstractNote: "" };
  const evidence = condition => SearchService.prototype.metadataEvidence(data, 1, { text: "", nativeConditions: [condition] });
  assert.deepEqual(evidence({ condition: "title", operator: "is", value: "fault" }), []);
  assert.equal(evidence({ condition: "title", operator: "isNot", value: "fault" })[0].label, "排除条件");
  assert.equal(evidence({ condition: "tag", operator: "is", value: "rocks" })[0].text, "fault; rocks");
  assert.deepEqual(evidence({ condition: "creator", operator: "contains", value: "Author; Second" }), []);
  assert.equal(evidence({ condition: "creator", operator: "contains", value: "Second" })[0].ranges.length, 1);
});

test("grouped evidence uses compiled leaf polarity instead of highlighting excluded query text", () => {
  const data = { title: "fault stress", creator: "Matched Creator", creatorValues: ["Matched Creator"] };
  const spec = { text: '"fault" "stress"', fields: ["title"], scope: { type: "library", libraryID: 1 },
    filters: [{ type: "author", value: "Matched" }], resolvedFilters: [{ type: "author", value: "Matched", matches: [{ libraryID: 1, name: "Matched Creator" }] }],
    queryTree: { op: "OR", children: [{ text: "fault" }, { op: "NOT", children: [{ op: "AND", children: [{ text: "stress" }, { filterIndex: 0 }] }] }] } };
  const evidence = SearchService.prototype.metadataEvidence(data, 1, queryEvidenceSpec(spec));
  assert.deepEqual(evidence.map(entry => entry.field), ["title"]);
  assert.deepEqual(evidence[0].ranges, [{ start: 0, end: 5 }]);
});

test("leading-space fulltext mode searches indexed content without adding metadata alternatives", () => {
  const conditions = [];
  globalThis.Zotero = { Search: class { addCondition(condition, operator, value) { conditions.push({ condition, operator, value }); } }, Libraries: { userLibraryID: 1 } };
  SearchService.prototype.buildSearch({ text: '"body phrase" token', fields: [], sources: { fulltext: true }, scope: { type: "library", libraryID: 1 } });
  assert.deepEqual(conditions.filter(c => c.operator === "contains"), [
    { condition: "fulltextContent", operator: "contains", value: "body phrase" },
    { condition: "fulltextContent", operator: "contains", value: "token" },
  ]);
  assert.deepEqual(SearchService.prototype.metadataEvidence({ title: "token", abstractNote: "body phrase" }, 1, { text: "token", fields: [] }), []);
});

test("global item search includes RSS libraries returned by native search", async () => {
  const libraries = [{ libraryID: 1, libraryType: "user", name: "我的文库" }, { libraryID: 2, libraryType: "feed", name: "RSS" }];
  const items = [1, 2].map(libraryID => ({ id: libraryID, libraryID, key: "TEST000" + libraryID, getField: () => "token", getCreators: () => [], getTags: () => [], isNote: () => false, isAttachment: () => false }));
  globalThis.Zotero = {
    Search: class { addCondition() {} async search() { return [1, 2]; } },
    Libraries: { userLibraryID: 1, getAll: () => libraries, get: id => libraries.find(lib => lib.libraryID === id) },
    Items: { getAsync: async ids => ids.map(id => items.find(item => item.id === id)), loadDataTypes: async () => {} },
  };
  const service = Object.create(SearchService.prototype); service.metadataCache = new Map();
  const result = await service.search({ text: "token", scope: { type: "all" } });
  assert.deepEqual(result.results.map(row => row.libraryID), [1, 2]);
});

test("an explicit note type retains standalone notes even with the default note source disabled", async t => {
  const previous = globalThis.Zotero; t.after(() => { globalThis.Zotero = previous; });
  const note = { id: 1, libraryID: 1, key: "NOTE0001", itemTypeID: 1, getField: field => field === "title" ? "Standalone note" : "",
    getCreators: () => [], getTags: () => [], isNote: () => true, isAttachment: () => false };
  globalThis.Zotero = { Libraries: { userLibraryID: 1, getAll: () => [{ libraryID: 1, libraryType: "user" }], get: () => ({ libraryType: "user" }) },
    Items: { getAsync: async ids => ids.map(() => note), loadDataTypes: async () => {} }, ItemTypes: { getName: () => "note" } };
  const service = Object.create(SearchService.prototype); service.metadataCache = new Map(); service.prepare = async spec => spec;
  service.buildSearch = () => ({ search: async () => [1] });
  const base = { text: "", fields: [], sources: { notes: false }, scope: { type: "library", libraryID: 1 } };
  assert.equal((await service.search(base)).total, 0);
  const spec = { ...base, resolvedFilters: [{ type: "type", value: "note", matches: [{ value: "note", libraryID: 1 }] }] };
  const result = await service.search(spec);
  assert.equal(result.total, 1); assert.equal(result.results[0].kind, "note"); assert.equal(result.results[0].title, "Standalone note");
  assert.deepEqual((await service.search(spec, { limit: 0 })).itemIDs, [1]);
  assert.equal((await service.search({ ...base, resolvedFilters: [{ ...spec.resolvedFilters[0], negated: true }] })).total, 0);
});

test("warm ranking preserves Unicode evidence and deduplicates attachment parents using cached metadata", async () => {
  const items = [
    { id: 1, key: "CACHE001", libraryID: 1, getTags: () => [], isNote: () => false, isAttachment: () => false },
    { id: 2, key: "CACHE002", libraryID: 1, getTags: () => [], isNote: () => false, isAttachment: () => false },
    { id: 3, parentID: 1, key: "CACHE003", libraryID: 1, isAttachment: () => true },
  ];
  globalThis.Zotero = { Search: class { addCondition() {} async search() { return [3, 2, 1]; } },
    Libraries: { userLibraryID: 1, getAll: () => [{ libraryID: 1, libraryType: "user", name: "Library" }], get: () => ({ libraryID: 1, libraryType: "user", name: "Library" }) },
    Items: { getAsync: async ids => Array.isArray(ids) ? ids.map(id => items.find(item => item.id === id)) : items.find(item => item.id === ids), loadDataTypes: async () => {} } };
  const service = Object.create(SearchService.prototype); service.metadataCache = new Map();
  for (const [id, title, abstractNote] of [[1, "FAÚLT stress transfer", ""], [2, "Other paper", "fault stress transfer"]]) {
    const data = { title, creator: "", date: "2024", DOI: "", tag: "", abstractNote, creatorValues: [], authorValues: [], tagValues: [] };
    data.normalized = Object.fromEntries(Object.entries(data).filter(([, value]) => typeof value === "string").map(([name, value]) => [name, normalize(value)]));
    service.metadataCache.set(id, data);
  }
  service.getMetadata = () => { throw new Error("Warm metadata should already be available"); };
  assert.equal(typeof service.result(items[0], { text: "fault" }).then, "undefined");
  const result = await service.search({ text: 'fault "stress transfer"', fields: ["title", "abstractNote"], scope: { type: "library", libraryID: 1 } });
  assert.deepEqual(result.results.map(row => row.itemID), [1, 2]);
  assert.equal(result.total, 2);
  assert.equal(result.results[0].title, "FAÚLT stress transfer");
  assert.ok(result.results[0].evidence.some(entry => entry.ranges.some(range => entry.text.slice(range.start, range.end) === "FAÚLT")));
  const cached = service.metadataCache.get(2); service.metadataCache.delete(2);
  service.getMetadata = async () => { service.metadataCache.set(2, cached); return cached; };
  const mixed = await service.search({ text: 'fault "stress transfer"', fields: ["title", "abstractNote"], scope: { type: "library", libraryID: 1 } });
  assert.deepEqual(mixed.results.map(row => row.itemID), [1, 2]);
  assert.equal(mixed.results[0].score, result.results[0].score);
});

test("cached metadata preserves creator boundaries, original punctuation and actual author roles", async () => {
  const creators = [{ firstName: "A.", lastName: "Researcher", creatorTypeID: 1 }, { firstName: "", lastName: 'Lab; Group "A"', fieldMode: 1, creatorType: "author" }, { firstName: "E.", lastName: "Editor", creatorTypeID: 3 }];
  globalThis.Zotero = { CreatorTypes: { getID: type => type === "author" ? 1 : 3 },
    Items: { getAsync: async () => [], loadDataTypes: async () => {} } };
  const item = { id: 9, key: "CREATOR9", libraryID: 1, getField: field => ({ title: "A paper", date: "2020-11-08" })[field] || "", getCreators: () => creators, getTags: () => [], isNote: () => false, isAttachment: () => false };
  const service = Object.create(SearchService.prototype); service.metadataCache = new Map();
  const data = await service.getMetadata(item);
  assert.deepEqual(data.creatorDetails.map(creator => creator.isAuthor), [true, true, false]);
  for (const creator of data.creatorDetails) assert.equal(data.creator.slice(creator.start, creator.end), creator.name);
  assert.deepEqual(data.authorValues, ["A. Researcher", 'Lab; Group "A"']);
  assert.equal(service.result(item, { text: "" }).creatorDetails, data.creatorDetails);
  assert.equal(service.result(item, { text: "" }).year, "2020");
});
