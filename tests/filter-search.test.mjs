import test from "node:test";
import assert from "node:assert/strict";
import { SearchService } from "../src/search.mjs";
import { normalize } from "../src/core.mjs";
import { groupAuthors } from "../src/authors.mjs";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

function fixture({ roles = false } = {}) {
  const searches = [], libraries = [{ libraryID: 1, libraryType: "user", name: "Library A" }, { libraryID: 2, libraryType: "group", name: "Library B" }];
  const ada = { firstName: "Ada", lastName: "Lovelace", creatorTypeID: 1 }, alan = { firstName: "Alan", lastName: "Turing", creatorTypeID: 1 };
  const people = [
    { firstName: "小明", lastName: "王", fieldMode: 0, libraryID: 1, count: 1 },
    { firstName: "Xiaoming", lastName: "Wang", fieldMode: 0, libraryID: 1, count: 1 },
    { ...ada, fieldMode: 0, libraryID: 1, count: 2 }, { ...alan, fieldMode: 0, libraryID: 1, count: 2 },
    { ...ada, fieldMode: 0, libraryID: 2, count: 1 },
    { firstName: "Name", lastName: "Percent_%", fieldMode: 0, libraryID: 1, count: 1 },
  ];
  const raw = [
    { id: 1, libraryID: 1, title: "fault both", creators: [ada, alan], collections: ["SAMEKEY1", "METHODS1"] },
    { id: 2, libraryID: 1, title: "fault Ada", creators: [ada], collections: ["SAMEKEY1"] },
    { id: 3, libraryID: 1, title: "fault Alan", creators: [alan], collections: ["METHODS1"] },
    { id: 4, libraryID: 1, title: "fault neither", creators: [], collections: [] },
    { id: 5, libraryID: 2, title: "fault other library", creators: [ada], collections: ["SAMEKEY1"] },
    { id: 6, libraryID: 1, title: "Chinese record", creators: [{ ...people[0], creatorTypeID: 1 }], collections: [] },
    { id: 7, libraryID: 1, title: "English record", creators: [{ ...people[1], creatorTypeID: 1 }], collections: [] },
  ];
  if (roles) {
    const contributor = { firstName: "Role", lastName: "Contributor", creatorTypeID: 2 }, presenter = { firstName: "Role", lastName: "Presenter", creatorTypeID: 3 }, editor = { firstName: "Role", lastName: "Editor", creatorTypeID: 4 };
    people.push(...[contributor, presenter, editor].map(person => ({ ...person, fieldMode: 0, libraryID: 1, count: 1 })));
    raw.push({ id: 8, libraryID: 1, title: "fault presented", creators: [contributor, presenter], collections: [] },
      { id: 9, libraryID: 1, title: "fault edited", creators: [editor], collections: [] });
  }
  const items = raw.map(row => ({ ...row, key: `ITEM000${row.id}`, getField: field => row[field] || "",
    getCreators: () => row.creators, getTags: () => [], isNote: () => false, isAttachment: () => false, isRegularItem: () => false }));
  const directories = [
    { kind: "collection", libraryID: 1, key: "PROJECT1", title: "Project", path: "Library A › Project" },
    { kind: "collection", libraryID: 1, key: "SAMEKEY1", title: "Core", path: "Library A › Project › Core", pathSegments: ["Library A", "Project", "Core"] },
    { kind: "collection", libraryID: 1, key: "METHODS1", title: "Methods", path: "Library A › Methods" },
    { kind: "collection", libraryID: 2, key: "SAMEKEY1", title: "Core", path: "Library B › Core" },
    ...libraries.map(lib => ({ kind: "library", libraryID: lib.libraryID, title: lib.name, path: lib.name })),
  ];
  const join = group => group.mode === "any" ? group.values.some(Boolean) : group.values.every(Boolean);
  const evaluate = (conditions, item) => {
    const stack = [{ mode: "all", values: [] }];
    for (const c of conditions) {
      if (c.condition === "groupStart") { stack.push({ mode: "all", values: [] }); continue; }
      if (c.condition === "groupEnd") { const group = stack.pop(); stack.at(-1).values.push(join(group)); continue; }
      if (c.condition === "joinMode") { if (!stack.at(-1).modeSet) { stack.at(-1).mode = c.operator; stack.at(-1).modeSet = true; } continue; }
      if (["recursive", "resultLevel"].includes(c.condition)) continue;
      const values = ["creator", "author"].includes(c.condition) ? item.creators.filter(p => c.condition === "creator" || p.creatorTypeID === 1).map(p => [p.firstName, p.lastName].filter(Boolean).join(" "))
        : c.condition === "collection" ? item.collections : c.condition === "savedSearch" ? item.savedSearches || []
          : c.condition === "itemType" ? ["journalArticle"] : c.condition === "itemID" ? [item.id] : [item[c.condition] || ""];
      if (c.operator === "isEmpty" || c.operator === "isNotEmpty") { stack.at(-1).values.push(c.operator === "isEmpty" ? !values.length : !!values.length); continue; }
      const positive = values.some(value => c.operator === "contains" || c.operator === "doesNotContain"
        ? normalize(value).includes(normalize(c.value)) : value === c.value);
      stack.at(-1).values.push(["isNot", "doesNotContain"].includes(c.operator) ? !positive : positive);
    }
    assert.equal(stack.length, 1, "group markers must balance"); return join(stack[0]);
  };
  let notify, authorReads = 0, directoryReads = 0;
  globalThis.Zotero = {
    Search: class {
      constructor() { this._libraryID = null; this.conditions = []; searches.push(this); }
      get libraryID() { return this._libraryID; }
      set libraryID(value) { if (value === null) throw new Error("libraryID not provided"); this._libraryID = value; }
      addCondition(condition, operator, value) { this.conditions.push({ condition, operator, value }); }
      async search() { return items.filter(item => (!this.libraryID || item.libraryID === this.libraryID) && evaluate(this.conditions, item)).map(item => item.id); }
    },
    Libraries: { userLibraryID: 1, getAll: () => libraries, get: id => libraries.find(lib => lib.libraryID === id) },
    Groups: { getByLibraryID: () => ({ groupID: 123 }) }, CreatorTypes: { getID: () => 1 },
    Items: { getAsync: async ids => Array.isArray(ids) ? ids.map(id => items.find(item => item.id === id)) : items.find(item => item.id === ids), loadDataTypes: async () => {} },
    DB: { queryAsync: async (sql, params) => { authorReads++; assert.doesNotMatch(sql, /IC\.creatorTypeID = \?/); assert.deepEqual(params, [1, 2]); return people; } },
    Notifier: { registerObserver: observer => { notify = observer.notify; return 1; }, unregisterObserver() {} },
  };
  const service = new SearchService({ get: () => undefined }, { directories: async () => { directoryReads++; return directories; } });
  const spec = filters => ({ text: "fault", fields: ["title"], scope: { type: "library", libraryID: 1 }, filters });
  const author = (value, negated = false, join = "and") => ({ type: "author", value, negated, join });
  const directory = (value, negated = false, join = "and", ref) => ({ type: "directory", value, negated, join, ...(ref ? { ref } : {}) });
  const ids = async query => (await service.search(query)).results.map(row => row.id).sort((a, b) => a - b);
  return { service, spec, author, directory, ids, searches, items, notify, reads: () => [authorReads, directoryReads] };
}

test("author AND, OR and exclusion return the expected coauthor sets, with text outside the filter expression", async () => {
  const f = fixture(), a = f.author("Ada"), b = f.author("Alan");
  assert.deepEqual(await f.ids(f.spec([a, b])), [1]);
  assert.deepEqual(await f.ids(f.spec([a, { ...b, join: "or" }])), [1, 2, 3]);
  assert.deepEqual(await f.ids(f.spec([a, { ...b, negated: true }])), [2]);
  assert.deepEqual(await f.ids(f.spec([a, { ...b, join: "or", negated: true }])), [1, 2, 4]);
  assert.deepEqual(await f.ids(f.spec([f.author("Nobody"), { ...a, join: "or" }])), [1, 2]);
  assert.deepEqual(await f.ids(f.spec([f.author("Nobody", true)])), [1, 2, 3, 4]);
  assert.deepEqual(await f.ids({ ...f.spec([a, { ...b, join: "or" }]), text: "Chinese" }), []);
});

test("structured text and field groups share AND/OR precedence and invert nested NOT without flattening phrases", async () => {
  const f = fixture(), filter = f.author("Ada"), base = { ...f.spec([filter]), text: "fault", queryTree: { op: "AND", children: [
    { op: "OR", children: [{ text: "fault Ada" }, { text: "fault both", quoted: true }] }, { filterIndex: 0 },
  ] } };
  assert.deepEqual(await f.ids(base), [1, 2]);
  assert.deepEqual(await f.ids({ ...base, queryTree: { op: "AND", children: [{ text: "fault" }, { op: "NOT", children: [{ filterIndex: 0 }] }] } }), [3, 4]);
  assert.deepEqual(await f.ids({ ...base, queryTree: { op: "NOT", children: [{ op: "OR", children: [{ filterIndex: 0 }, { text: "fault neither" }] }] } }), [3, 6, 7]);
  const prepared = await f.service.prepare(base), search = f.service.buildSearch(prepared);
  assert.equal(search.conditions.filter(condition => condition.condition === "title" && condition.operator === "contains" && condition.value === "fault both").length, 1);
  assert.ok(!search.conditions.some(condition => condition.condition === "title" && condition.value === "fault"), "display text must not become an extra implicit AND");
  assert.throws(() => f.service.buildSearch({ ...base, queryTree: { filterIndex: 3 } }), /结构/);
  await assert.rejects(f.service.prepare({ ...base, queryError: "请补全括号" }), /括号/);
});

test("outline fields constrain actual parent items and preserve OR, negation, phrases and the bound PDF", async () => {
  const f = fixture(); let reads = 0;
  const rows = [
    { itemID: 1, libraryID: 1, attachmentID: 11, outlineKey: "0", title: "Methods and model", parents: [] },
    { itemID: 2, libraryID: 1, attachmentID: 12, outlineKey: "0", title: "Model and methods", parents: [] },
    { itemID: 5, libraryID: 2, attachmentID: 15, outlineKey: "0.0", title: "Methods and model", parents: ["Overview"] },
  ];
  f.service.outlines = async () => { reads++; return { rows, completed: 3, documents: 3, pending: false }; };
  const outline = value => ({ type: "outline", value });
  assert.deepEqual(await f.ids(f.spec([outline("Methods")])), [1, 2]);
  assert.deepEqual(await f.ids(f.spec([{ ...outline("Methods and model"), quoted: true }])), [1]);
  assert.deepEqual(await f.ids(f.spec([{ ...outline("Methods"), ref: { kind: "outline", attachmentID: 12, key: "0" } }])), [2]);
  assert.deepEqual(await f.ids(f.spec([{ ...outline("Methods"), negated: true }])), [3, 4]);
  assert.deepEqual(await f.ids({ ...f.spec([outline("Methods"), f.author("Alan")]), queryTree: { op: "OR", children: [{ filterIndex: 0 }, { filterIndex: 1 }] } }), [1, 2, 3]);
  assert.deepEqual(await f.ids({ ...f.spec([outline("")]), scope: { type: "all" } }), [1, 2, 5]);
  rows.push({ itemID: 4, libraryID: 1, attachmentID: 14, outlineKey: "0", title: "Methods", parents: [] });
  assert.deepEqual(await f.ids(f.spec([outline("Methods")])), [1, 2, 4]);
  assert.ok(reads > 1);
});

test("quoted field filters are literal whole values while unquoted wildcards still expand", async () => {
  const f = fixture();
  assert.deepEqual(await f.ids(f.spec([{ ...f.author("Ada Lovelace"), quoted: true }])), [1, 2]);
  assert.deepEqual(await f.ids(f.spec([{ ...f.author("Ada*"), quoted: true }])), []);
  assert.deepEqual(await f.ids(f.spec([f.author("Ada*")])), [1, 2]);
  assert.deepEqual(await f.ids(f.spec([{ ...f.directory("Core"), quoted: true }])), [1, 2]);
  assert.deepEqual(await f.ids(f.spec([{ ...f.directory("Core*"), quoted: true }])), []);
});

test("quick author filters include contributor, presenter and editor while native author keeps its role", async () => {
  const f = fixture({ roles: true });
  assert.deepEqual(await f.ids(f.spec([f.author("Contributor"), f.author("Presenter")])), [8]);
  assert.deepEqual(await f.ids(f.spec([f.author("Presenter"), f.author("Editor", false, "or")])), [8, 9]);
  assert.deepEqual(await f.ids(f.spec([f.author("Role"), f.author("Presenter", true)])), [9]);
  assert.deepEqual(await f.ids(f.spec([f.author("*")])), [1, 2, 3, 8, 9]);
  assert.deepEqual(await f.ids(f.spec([f.author("*", true)])), [4]);
  const prepared = await f.service.prepare(f.spec([f.author("Presenter")]));
  const evidence = await f.service.evidenceForItem(f.items.find(item => item.id === 8), prepared);
  const hit = evidence.find(entry => entry.field === "creator");
  assert.ok(hit.ranges.some(range => hit.text.slice(range.start, range.end) === "Role Presenter"));
  const native = new Zotero.Search(); native.libraryID = 1; native.addCondition("author", "contains", "Role");
  assert.deepEqual(await native.search(), []);
  const data = await f.service.getMetadata(f.items.find(item => item.id === 8));
  assert.equal(data.authorValues.length, 0); assert.equal(data.creatorValues.length, 2);
  assert.equal(f.service.metadataEvidence(data, 8, { text: "", fields: [], nativeConditions: [{ condition: "author", operator: "contains", value: "Role" }] }).length, 0);
});

test("directory AND, OR, exclusion, wildcards and stable references preserve branches and library identity", async () => {
  const f = fixture(), core = f.directory("Core"), methods = f.directory("Meth?ds");
  assert.deepEqual(await f.ids(f.spec([core, methods])), [1]);
  assert.deepEqual(await f.ids(f.spec([core, { ...methods, join: "or" }])), [1, 2, 3]);
  assert.deepEqual(await f.ids(f.spec([core, { ...methods, negated: true }])), [2]);
  assert.deepEqual(await f.ids(f.spec([f.directory("No such folder")])), []);
  assert.deepEqual(await f.ids(f.spec([f.directory("No such folder", true)])), [1, 2, 3, 4]);
  assert.deepEqual(await f.ids({ ...f.spec([f.directory("stale path", false, "and", { kind: "collection", libraryID: 1, key: "SAMEKEY1" })]), scope: { type: "all" } }), [1, 2]);
  assert.deepEqual(await f.ids({ ...f.spec([f.directory("Core")]), scope: { type: "all" } }), [1, 2, 5]);
  assert.deepEqual(await f.ids(f.spec([f.directory("Library A", false, "and", { kind: "library", libraryID: 1 }), f.author("Ada")])), [1, 2]);
  assert.deepEqual(await f.ids(f.spec([f.directory("Library A", true, "and", { kind: "library", libraryID: 1 })])), []);
  assert.deepEqual(await f.ids(f.spec([f.directory("foreign", false, "and", { kind: "collection", libraryID: 2, key: "SAMEKEY1" }), { ...f.author("Ada"), join: "or" }])), [1, 2]);
  const perLibrary = f.searches.filter(search => search.conditions.some(c => c.condition === "collection"));
  assert.ok(perLibrary.every(search => search.libraryID !== null));
  assert.ok(perLibrary.some(search => search.conditions.some(c => c.condition === "recursive" && c.operator === "true")));
  const parentOnly = await f.service.prepare({ ...f.spec([f.directory("Project")]), recursive: false });
  assert.deepEqual(parentOnly.resolvedFilters[0].matches.map(match => match.key), ["PROJECT1"]);
  const parentSearch = f.service.buildSearch(parentOnly);
  assert.deepEqual(parentSearch.conditions.filter(c => c.condition === "collection").map(c => c.value), ["PROJECT1"]);
  assert.ok(!parentSearch.conditions.some(c => c.condition === "recursive"));
  const explicitPath = await f.service.prepare(f.spec([f.directory("Project › Core")]));
  assert.deepEqual(explicitPath.resolvedFilters[0].matches.map(match => match.key), ["SAMEKEY1"]);
});

test("universal author wildcard uses the native presence predicate instead of a large parameter list", async () => {
  const f = fixture();
  assert.deepEqual(await f.ids(f.spec([f.author("*")])), [1, 2, 3]);
  assert.deepEqual(await f.ids(f.spec([f.author("**", true)])), [4]);
  assert.deepEqual(f.reads(), [0, 0]);
  assert.ok(f.searches.every(search => search.conditions.filter(c => c.condition === "creator").length === 1));
  assert.deepEqual(f.searches[0].conditions.filter(c => c.condition === "creator"), [{ condition: "creator", operator: "isNotEmpty", value: "" }]);
});

test("broad expanded author filters retain every spelling inside bounded associative groups", () => {
  const f = fixture(), filter = f.author("Author*");
  const matches = Array.from({ length: 5000 }, (_, i) => ({ libraryID: 1, name: `Author ${i}` }));
  for (const negated of [false, true]) {
    const search = f.service.buildSearch({ ...f.spec([{ ...filter, negated }]), resolvedFilters: [{ ...filter, negated, matches }] });
    const stack = [0], widths = [];
    for (const condition of search.conditions) {
      if (condition.condition === "groupStart") { stack[stack.length - 1]++; stack.push(0); }
      else if (condition.condition === "groupEnd") widths.push(stack.pop());
      else if (!["joinMode", "recursive", "resultLevel"].includes(condition.condition)) stack[stack.length - 1]++;
    }
    assert.equal(stack.length, 1); assert.ok(widths.every(width => width <= 64));
    const authors = search.conditions.filter(c => c.condition === "creator");
    assert.equal(authors.length, matches.length);
    assert.deepEqual(authors.map(c => c.value), matches.map(match => match.name));
    assert.ok(authors.every(c => c.operator === (negated ? "isNot" : "is")));
  }
});

test("phonetic author filters compile real spellings and highlight the stored author rather than an invented alias", async () => {
  const f = fixture(), query = { ...f.spec([f.author("wangxiaoming")]), text: "" };
  const prepared = await f.service.prepare(query);
  assert.deepEqual(prepared.resolvedFilters[0].matches.map(match => match.name).sort(), ["Xiaoming Wang", "小明 王"]);
  assert.deepEqual(await f.ids(prepared), [6, 7]);
  const chinese = (await f.service.search(prepared)).results.find(row => row.id === 6);
  const evidence = chinese.evidence.find(entry => entry.field === "creator");
  assert.equal(evidence.text, "小明 王"); assert.deepEqual(evidence.ranges, [{ start: 0, end: 4 }]);
  const negative = await f.service.search({ ...f.spec([f.author("Nobody", true)]), text: "" });
  assert.ok(negative.results.every(row => row.evidence.some(entry => entry.label === "排除条件" && entry.text === "不含作者：@Nobody")));
  const literal = await f.service.prepare({ ...f.spec([f.author("Percent_%")]), text: "" });
  assert.deepEqual(literal.resolvedFilters[0].matches.map(match => match.name), ["Name Percent_%"]);
  assert.deepEqual(f.service.buildSearch(literal).conditions.filter(c => c.condition === "creator"), [{ condition: "creator", operator: "is", value: "Name Percent_%" }]);
});

test("author reads are shared, prepared evidence does not re-resolve folders, and notifications refresh the right caches", async () => {
  const f = fixture();
  await Promise.all([f.service.authorRows(""), f.service.authorRows("Ada")]); assert.deepEqual(f.reads(), [1, 0]);
  const prepared = await f.service.prepare(f.spec([f.author("Ada"), f.directory("Core")]));
  await f.service.prepare(prepared); await f.service.evidenceForItem(f.items[0], prepared); assert.deepEqual(f.reads(), [1, 1]);
  f.notify("modify", "collection", [1]); await f.service.prepare(prepared); assert.deepEqual(f.reads(), [1, 2]);
  f.notify("modify", "item", [1]); await f.service.authorRows("Ada"); assert.deepEqual(f.reads(), [2, 2]);
  assert.throws(() => f.service.buildSearch(f.spec([f.author("Ada")])), /先解析/);
  const all = await f.service.prepare({ ...f.spec([f.author("Ada")]), scope: { type: "all" } });
  assert.equal(f.service.buildSearch(all).libraryID, null, "all-library metadata filters can migrate to one native advanced editor");
  assert.throws(() => f.service.buildSearch({ ...all, filters: [f.directory("Core")], resolvedFilters: [{ ...f.directory("Core"), matches: [] }] }), /指定文库/);
  await assert.rejects(f.service.prepare(f.spec([{ type: "invalid", value: "Ada" }])), /无效/);
  const changed = await f.service.prepare({ ...prepared, filters: [f.author("Alan")] });
  assert.equal(changed.resolvedFilters[0].matches.length, 1);
  assert.ok(changed.resolvedFilters[0].matches.every(match => match.lastName === "Turing" && match.firstName === f.items[2].creators[0].firstName));
});

test("an author-index invalidation during a pending read returns the current generation", async () => {
  const f = fixture(); let finish, reads = 0;
  Zotero.DB.queryAsync = async () => {
    reads++;
    return reads === 1 ? new Promise(resolve => { finish = resolve; }) : [{ firstName: "Current", lastName: "Author", fieldMode: 0, libraryID: 1, count: 1 }];
  };
  const pending = f.service.authorRows("");
  f.notify("modify", "item", [1]);
  finish([{ firstName: "Stale", lastName: "Author", fieldMode: 0, libraryID: 1, count: 1 }]);
  assert.equal((await pending)[0].title, "Current Author"); assert.equal(reads, 2);
});

test("native database proxy rows are reduced to their selected columns before author expansion", async () => {
  const f = fixture(), values = { firstName: "Native", lastName: "Author", fieldMode: 0, libraryID: 1, count: 1 };
  Zotero.DB.queryAsync = async () => [new Proxy(values, {
    ownKeys: () => [...Object.keys(values), "getResultByName"],
    getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true }),
    get(target, key) { if (!(key in target)) throw new Error(`DB column '${String(key)}' not found`); return target[key]; },
  })];
  const prepared = await f.service.prepare(f.spec([f.author("Native Author")]));
  assert.equal(prepared.resolvedFilters[0].matches[0].name, "Native Author");
  assert.deepEqual(Object.keys((await f.service.authorRows(""))[0].records[0]).sort(), Object.keys(values).sort());
  assert.doesNotThrow(() => structuredClone(prepared));
});

test("selecting an author reference preserves its whole alias group without selecting a longer-name prefix match", async () => {
  const f = fixture(), short = { firstName: "Ann", lastName: "Author", fieldMode: 0, libraryID: 1, count: 1 },
    long = { firstName: "Anna", lastName: "Author", fieldMode: 0, libraryID: 1, count: 20 };
  f.service.authorCache = groupAuthors([short, long]);
  for (const [index, person] of [short, long].entries()) {
    const item = { id: 8 + index, key: `ITEM000${8 + index}`, libraryID: 1, title: "fault prefix", creators: [{ ...person, creatorTypeID: 1 }], collections: [],
      getField(field) { return this[field] || ""; }, getCreators() { return this.creators; }, getTags: () => [], isNote: () => false, isAttachment: () => false, isRegularItem: () => false };
    f.items.push(item);
  }
  const query = [short.lastName, short.firstName].join(" "), candidates = await f.service.authorRows(query);
  assert.deepEqual(candidates.map(row => row.records[0].firstName), [short.firstName, long.firstName]);
  const raw = await f.service.prepare(f.spec([f.author(query)]));
  assert.deepEqual(await f.ids(raw), [8, 9]);
  const selected = await f.service.prepare({ ...raw, filters: [{ ...f.author(query), ref: { kind: "author", key: candidates[0].key } }] });
  assert.deepEqual(selected.resolvedFilters[0].matches.map(match => match.firstName), [short.firstName]);
  assert.deepEqual(await f.ids(selected), [8]);
  const changed = await f.service.prepare({ ...selected, filters: [{ ...selected.filters[0], ref: { kind: "author", key: candidates[1].key } }] });
  assert.deepEqual(await f.ids(changed), [9]);
  const missing = await f.service.prepare({ ...selected, filters: [{ ...selected.filters[0], ref: { kind: "author", key: "missing" } }] });
  assert.deepEqual(await f.ids(missing), []);
  const excluded = await f.service.prepare({ ...selected, filters: [{ ...selected.filters[0], negated: true }] });
  assert.deepEqual(await f.ids(excluded), [1, 2, 3, 4, 9]);
  const selectedDespiteText = await f.service.prepare(f.spec([{ ...f.author("*"), ref: { kind: "author", key: candidates[0].key } }]));
  assert.deepEqual(await f.ids(selectedDespiteText), [8]);
});

// Zotero 10.0.7 combineConditions() flattens ALL groups and parenthesizes multi-child ANY groups.
function nativeDefaultLevelSQL(built) {
  const root = { children: [] }, stack = [root];
  for (const item of built) {
    const group = stack.at(-1);
    if (item.marker === "groupStart") { const child = { children: [] }; group.children.push(child); stack.push(child); }
    else if (item.marker === "groupEnd") { if (stack.length > 1) stack.pop(); }
    else if (item.marker === "joinMode") { if (!group.joinMode) group.joinMode = item.operator; }
    else if (!item.marker) group.children.push(item);
  }
  const combine = node => {
    const parts = node.children.map(child => child.children ? combine(child) : child).filter(part => part.sql);
    const any = node.joinMode === "any", sql = parts.map(part => part.sql).join(any ? " OR " : " AND ");
    return { sql: any && parts.length > 1 ? `(${sql})` : sql, params: parts.flatMap(part => part.params) };
  };
  return combine(root);
}

test("guarded negative author blocks retain native SQL parentheses and execute above SQLite's expression-depth limit", t => {
  const f = fixture(), filter = f.author("Author*", true);
  const matches = Array.from({ length: 1100 }, (_, i) => ({ libraryID: 1, name: `Author ${i}` }));
  const query = (negated, extra = []) => f.service.buildSearch({ ...f.spec([{ ...filter, negated }, ...extra]), text: "", fields: [], sources: { notes: true },
    resolvedFilters: [{ ...filter, negated, matches }, ...extra.map(value => ({ ...value, matches: [{ libraryID: 1, name: "Allowed Person" }] }))] });
  const built = conditions => conditions.filter(c => c.condition !== "recursive").map(c => ["groupStart", "groupEnd", "joinMode", "resultLevel"].includes(c.condition)
    ? { marker: c.condition, operator: c.operator }
    : { sql: `itemID ${c.operator === "isNot" ? "NOT IN" : "IN"} (SELECT itemID FROM ${["creator", "author"].includes(c.condition) ? "authors WHERE name" : "items WHERE title"} = ?)`, params: [c.value], level: "item", negate: c.operator === "isNot" });
  const negativeSearch = query(true), negative = nativeDefaultLevelSQL(built(negativeSearch.conditions)), positive = nativeDefaultLevelSQL(built(query(false).conditions));
  const mixed = nativeDefaultLevelSQL(built(query(true, [f.author("Allowed Person", false, "or")]).conditions));
  const secondFilter = f.author("Other*", true), secondMatches = Array.from({ length: 1100 }, (_, i) => ({ libraryID: 1, name: i ? `Other ${i}` : "Allowed Person" }));
  const doubleSearch = f.service.buildSearch({ ...f.spec([filter, secondFilter]), text: "", fields: [], sources: { notes: true },
    resolvedFilters: [{ ...filter, matches }, { ...secondFilter, matches: secondMatches }] });
  const doubleNegative = nativeDefaultLevelSQL(built(doubleSearch.conditions));
  const unguarded = nativeDefaultLevelSQL([{ marker: "joinMode", operator: "all" }, ...matches.map(match => ({ sql: "itemID NOT IN (SELECT itemID FROM authors WHERE name = ?)", params: [match.name], level: "item", negate: true }))]);
  assert.ok(negative.sql.includes(" OR "), "negative blocks must survive the native ALL flattening as parenthesized ANY groups");
  assert.equal(negativeSearch.conditions.filter(c => c.condition === "creator").length, 1100);
  const reference = process.env.ZOTERO_SEARCH_REFERENCE;
  if (reference) {
    assert.ok(existsSync(reference), "ZOTERO_SEARCH_REFERENCE must point to Zotero's search.js");
    const source = readFileSync(reference, "utf8"), start = source.indexOf("Zotero.Search.combineConditions = function"), end = source.indexOf("\n};", start) + 4;
    assert.ok(start >= 0 && end > start);
    const context = { Zotero: { Search: { mapPredicate: sql => sql } } };
    runInNewContext(source.slice(start, end), context);
    for (const search of [negativeSearch, query(false), query(true, [f.author("Allowed Person", false, "or")]), doubleSearch]) {
      const actual = context.Zotero.Search.combineConditions(built(search.conditions), "item");
      assert.deepEqual({ sql: actual.sql, params: Array.from(actual.params) }, nativeDefaultLevelSQL(built(search.conditions)));
    }
    t.diagnostic("SQL model matched the cached Zotero 10.0.7 combineConditions source at the item level");
  }
  const code = `import json, sqlite3, sys
queries = json.load(sys.stdin)
class LegacyConnection(sqlite3.Connection):
    def __getattribute__(self, name):
        if name in ('setlimit', 'getlimit'):
            raise AttributeError(name)
        return super().__getattribute__(name)
db = sqlite3.connect(':memory:', factory=LegacyConnection if len(sys.argv) > 1 else sqlite3.Connection)
if hasattr(db, 'setlimit'):
    db.setlimit(sqlite3.SQLITE_LIMIT_EXPR_DEPTH, 1000)
    assert db.getlimit(sqlite3.SQLITE_LIMIT_EXPR_DEPTH) == 1000
db.execute('CREATE TABLE items(itemID INTEGER PRIMARY KEY, title TEXT)')
db.execute('CREATE TABLE authors(itemID INTEGER, name TEXT)')
db.executemany('INSERT INTO items VALUES (?, ?)', [(1, 'fault'), (2, 'other'), (3, ''), (4, 'fault')])
db.executemany('INSERT INTO authors VALUES (?, ?)', [(1, 'Author 1'), (2, 'Allowed Person'), (4, 'Author 1'), (4, 'Allowed Person')])
results = []
for query in queries:
    try:
        rows = db.execute('SELECT itemID FROM items WHERE ' + query['sql'] + ' ORDER BY itemID', query['params']).fetchall()
        results.append({'ids': [row[0] for row in rows]})
    except sqlite3.OperationalError as error:
        results.append({'error': str(error)})
print(json.dumps({'sqlite': sqlite3.sqlite_version, 'results': results}))`;
  for (const legacy of [false, true]) {
    const python = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
    const result = JSON.parse(execFileSync(python, ["-c", code, ...(legacy ? ["legacy-limit-api"] : [])], { input: JSON.stringify([unguarded, negative, positive, mixed, doubleNegative]), encoding: "utf8", maxBuffer: 1024 * 1024 }));
    assert.match(result.results[0].error, /Expression tree is too large/i);
    assert.deepEqual(result.results.slice(1), [{ ids: [2, 3] }, { ids: [1, 4] }, { ids: [2, 3, 4] }, { ids: [3] }]);
    t.diagnostic(`SQLite ${result.sqlite}${legacy ? " without the Python 3.11 limit API" : ""} rejected unguarded AND and executed guarded negative, positive, mixed OR and two negative-leaf queries`);
  }
  const single = f.service.buildSearch({ ...f.spec([filter]), text: "", sources: { notes: true }, resolvedFilters: [{ ...filter, matches: matches.slice(0, 1) }] });
  assert.ok(!single.conditions.some(c => c.condition === "title"));
  const evidence = f.service.metadataEvidence({ title: "fault", creator: "Allowed Person", creatorValues: ["Allowed Person"], authorValues: ["Allowed Person"] }, 1,
    { text: "", fields: [], nativeConditions: negativeSearch.conditions, resolvedFilters: [{ ...filter, matches }] });
  assert.ok(evidence.some(entry => entry.label === "排除条件" && entry.text === "不含作者：@Author*"));
  assert.ok(evidence.every(entry => entry.field !== "title"));
});
