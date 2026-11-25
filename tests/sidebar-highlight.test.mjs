import test from "node:test";
import assert from "node:assert/strict";
import { sidebarRanges } from "../src/sidebar-highlight.mjs";

test("sidebar author fields show only the matched creator's original ranges, including non-author roles", () => {
  const data = { creatorDetails: [{ firstName: "First", lastName: "Person", start: 0 }, { firstName: "Second", lastName: "Contributor", start: 14 }] };
  const entries = [{ field: "creator", text: "First Person; Second Contributor", ranges: [{ start: 14, end: 32 }] }];
  assert.deepEqual(sidebarRanges("Person", "creator-0-lastName", data, entries), []);
  assert.deepEqual(sidebarRanges("Second", "creator-1-firstName", data, entries), [{ start: 0, end: 6 }]);
  assert.deepEqual(sidebarRanges("Contributor", "creator-1-lastName", data, entries), [{ start: 0, end: 11 }]);
  assert.deepEqual(sidebarRanges("Contributor", "creator-3-lastName", data, entries), []);
});
test("sidebar full field text finds dates, case/accents and abstract tail without highlighting labels or exclusions", () => {
  const entries = [{ field: "abstractNote", text: "Tail Café", ranges: [{ start: 5, end: 9 }] }, { field: "date", text: "2024", ranges: [{ start: 0, end: 4 }] }, { field: "publisher", text: "excluded", ranges: [] }];
  assert.deepEqual(sidebarRanges("An abstract ending with CAFE", "abstractNote", {}, entries), [{ start: 24, end: 28 }]);
  assert.deepEqual(sidebarRanges("2024-06-18", "date", {}, entries), [{ start: 0, end: 4 }]);
  assert.deepEqual(sidebarRanges("Café", "publicationTitle", {}, entries), []);
  assert.deepEqual(sidebarRanges("excluded", "publisher", {}, entries), []);
});
