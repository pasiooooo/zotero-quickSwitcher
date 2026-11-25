import test from "node:test";
import assert from "node:assert/strict";
import { tokenize, matchRanges, makeSnippet, mergeLayoutRecords, validateLayoutRecord } from "../src/core.mjs";

test("AND tokens and quoted phrases preserve literal input", () => {
  assert.deepEqual(tokenize('fault "stress transfer" 岩石'), ["fault", "stress transfer", "岩石"]);
  assert.throws(() => tokenize('"unfinished'));
});
test("original offsets handle accents, combining characters and UTF16", () => {
  const text = "🙂 Café cafe\u0301 STRAẞE";
  const hits = matchRanges(text, "cafe");
  assert.deepEqual(hits.map(r => text.slice(r.start, r.end)), ["Café", "cafe\u0301"]);
  assert.equal(matchRanges(text, "strasse").length, 1);
  assert.equal(matchRanges("decision-making", "decision making", { fulltext: true }).length, 1);
});
test("snippet centres on late evidence instead of truncating the index", () => {
  const text = "a".repeat(600) + " seismogenic fault " + "b".repeat(200);
  const snippet = makeSnippet(text, matchRanges(text, "fault"));
  assert.ok(snippet.text.includes("fault"));
  assert.equal(snippet.text.slice(snippet.ranges[0].start, snippet.ranges[0].end), "fault");
});
const deviceA = "00000000-0000-4000-8000-000000000001";
const deviceB = "00000000-0000-4000-8000-000000000002";
const record = (deviceID, clock, parent = null) => ({ libraryKey: "u", searchKey: "AAAA2222", placement: { parentCollectionKey: parent, anchorCollectionKey: null, anchorSide: "after", order: 1 }, version: { clock, deviceID } });
test("per-record merges converge and a reset cannot resurrect old placements", () => {
  const a = { "u:AAAA2222": record(deviceA, 2, "BBBB2222") };
  const b = { "u:AAAA2222": record(deviceB, 2, "CCCC2222") };
  assert.deepEqual(mergeLayoutRecords(a, b), mergeLayoutRecords(b, a));
  const reset = { "u:AAAA2222": { ...record(deviceA, 3), placement: null } };
  assert.equal(mergeLayoutRecords(a, b, reset)["u:AAAA2222"].placement, null);
  assert.equal(validateLayoutRecord({ ...record(deviceA, 1), libraryKey: "__proto__" }), false);
});
