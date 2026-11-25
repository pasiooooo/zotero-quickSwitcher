import test from "node:test";
import assert from "node:assert/strict";
import { SearchService } from "../src/search.mjs";
import { normalize } from "../src/core.mjs";

function fixture() {
  const types = { journalArticle: 22, book: 7, report: 30 }, reads = [];
  const raw = [
    { id: 1, libraryID: 1, year: "2020", publicationTitle: "Nature", publisher: "Nature Portfolio", itemType: "journalArticle" },
    { id: 2, libraryID: 1, year: "2021", publicationTitle: "Nature Geoscience", publisher: "Springer", itemType: "journalArticle" },
    { id: 3, libraryID: 1, year: "2020", publicationTitle: "", publisher: "Elsevier", itemType: "book" },
    { id: 4, libraryID: 1, year: "2019", publicationTitle: "", publisher: "Elsevier", itemType: "report" },
    { id: 5, libraryID: 2, year: "2020", publicationTitle: "Science", publisher: "AAAS", itemType: "journalArticle" },
  ];
  const items = raw.map(row => ({ ...row, itemTypeID: types[row.itemType], getField: field => field === "date" ? row.year : field === "title" ? "fault " + row.id : row[field] || "", getCreators: () => [], getTags: () => [], isRegularItem: () => true, isNote: () => false, isAttachment: () => false }));
  const evaluate = (conditions, item) => {
    const stack = [{ join: "all", values: [] }], result = frame => frame.join === "any" ? frame.values.some(Boolean) : frame.values.every(Boolean);
    for (const c of conditions) {
      if (c.condition === "groupStart") { stack.push({ join: "all", values: [] }); continue; }
      if (c.condition === "groupEnd") { stack.at(-2).values.push(result(stack.pop())); continue; }
      if (c.condition === "joinMode") { stack.at(-1).join = c.operator; continue; }
      if (["resultLevel", "recursive", "noChildren"].includes(c.condition)) continue;
      const value = c.condition === "title" ? item.getField("title") : c.condition === "itemType" ? item.itemType : item[c.condition] || "";
      const hit = c.operator === "isEmpty" ? !value : c.operator === "isNotEmpty" ? !!value : c.operator === "contains" ? normalize(value).includes(normalize(c.value)) : normalize(value) === normalize(c.value);
      stack.at(-1).values.push(c.operator === "isNot" ? !hit : hit);
    }
    return result(stack[0]);
  };
  let observer;
  globalThis.Zotero = {
    ItemFields: { getID: name => ({ date: 6, publicationTitle: 41, publisher: 25 })[name], getTypeFieldsFromBase: name => ({ date: [56], publicationTitle: [40], publisher: [24] })[name] },
    ItemTypes: { getName: id => Object.keys(types).find(name => types[name] === id), getLocalizedString: id => typeof id === "string" ? id : Object.keys(types).find(name => types[name] === id) },
    Libraries: { userLibraryID: 1, getAll: () => [1, 2].map(libraryID => ({ libraryID, libraryType: libraryID === 1 ? "user" : "group" })), get: () => ({ name: "Library" }) }, Groups: { getByLibraryID: () => ({ groupID: 123 }) },
    Items: { getAsync: async value => Array.isArray(value) ? value.map(id => items.find(item => item.id === id)) : items.find(item => item.id === value), loadDataTypes: async () => {} },
    Notifier: { registerObserver: value => { observer = value; return 1; }, unregisterObserver() {} },
    DB: { queryAsync: async (sql, params) => {
      reads.push({ sql, params });
      if (sql.includes("I.itemTypeID")) return items.map(item => ({ itemTypeID: item.itemTypeID, libraryID: item.libraryID, count: 1 }));
      if (sql.includes("SUBSTR")) return items.map(item => ({ field: "year", value: item.year, libraryID: item.libraryID, count: 1 }));
      return items.flatMap(item => ["publicationTitle", "publisher"].filter(field => item[field]).map(field => ({ field, value: item[field], libraryID: item.libraryID, count: 1 })));
    } },
    Search: class { constructor() { this.conditions = []; } addCondition(condition, operator, value) { this.conditions.push({ condition, operator, value }); } async search() { return items.filter(item => item.libraryID === this.libraryID && evaluate(this.conditions, item)).map(item => item.id); } },
  };
  const service = new SearchService({ get: () => undefined });
  const spec = filters => ({ text: "fault", fields: ["title"], scope: { type: "library", libraryID: 1 }, filters });
  const ids = async filters => (await service.search(spec(filters))).results.map(row => row.id).sort();
  return { service, spec, ids, reads, items, notify: () => observer.notify("modify", "item", [1]) };
}
test("year, publication/publisher and item-type filters compile mixed AND, OR and exclusions", async () => {
  const f = fixture();
  const filter = (type, value, negated = false, join = "and") => ({ type, value, negated, join });
  assert.deepEqual(await f.ids([filter("year", "2020"), filter("venue", "Elsevier"), filter("type", "book")]), [3]);
  assert.deepEqual(await f.ids([filter("year", "2019"), filter("venue", "Nature", false, "or"), filter("year", "2020")]), [1, 4]);
  assert.deepEqual(await f.ids([filter("year", "2020"), filter("venue", "Elsevier", true)]), [1]);
  assert.deepEqual(await f.ids([filter("year", "202?"), filter("type", "journal*")]), [1, 2]);
});
test("a bound source selects Publisher independently of Publication and metadata evidence reports actual fields", async () => {
  const f = fixture(), row = (await f.service.fieldRows("venue", "Nature Portfolio"))[0];
  const filter = { type: "venue", value: row.title, ref: { kind: "venue", key: row.key, field: "publisher" } };
  const query = await f.service.prepare(f.spec([filter, { type: "year", value: "2020" }]));
  const evidence = f.service.metadataEvidence(await f.service.getMetadata(f.items[0]), 1, query);
  assert.ok(evidence.some(entry => entry.field === "publisher" && entry.ranges.length));
  assert.ok(evidence.some(entry => entry.field === "date" && entry.ranges.length));
  assert.ok(!evidence.some(entry => entry.field === "publicationTitle"));
});
test("field candidates share cached mapped-field reads, retain libraries and refresh after item changes", async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.service.fieldRows("year"), f.service.fieldRows("year")]);
  assert.equal(a.find(row => row.key === "2020").records.length, 3); assert.equal(a.length, b.length); assert.equal(f.reads.length, 1);
  assert.ok(f.reads[0].params.includes(56)); assert.match(f.reads[0].sql, /COUNT\(DISTINCT I.itemID\)/u);
  await f.service.fieldRows("venue"); await f.service.fieldRows("venue", "Nature"); assert.equal(f.reads.length, 2);
  assert.ok(f.reads[1].params.includes(40)); assert.ok(f.reads[1].params.includes(24));
  f.notify(); await f.service.fieldRows("year"); assert.equal(f.reads.length, 3);
});

test("metadata and source candidates share Zotero's base-field mapping for different item types", async () => {
  const f = fixture(), reads = [], item = f.items[3];
  item.getField = (field, unformatted, mapped) => { reads.push({ field, mapped }); return mapped ? ({ title: "A report", publisher: "QS Institution", publicationTitle: "Mapped Collection", date: "2024-05-06" })[field] || "" : ""; };
  const metadata = await f.service.getMetadata(item);
  assert.equal(metadata.publisher, "QS Institution"); assert.equal(metadata.publicationTitle, "Mapped Collection"); assert.equal(metadata.date, "2024");
  for (const field of ["publisher", "publicationTitle", "date"]) assert.ok(reads.some(read => read.field === field && read.mapped === true));
  assert.equal(f.service.result(item, { text: "" }).publisher, metadata.publisher);
});
