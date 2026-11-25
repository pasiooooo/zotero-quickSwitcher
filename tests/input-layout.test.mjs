import test from "node:test";
import assert from "node:assert/strict";
import { measureInputMarkers, inputMarkerLayout, markerDeltaAt, inputWordRange, sourceSpanAt } from "../src/input-layout.mjs";
import { DEFAULT_PREFIXES, parseLauncherInput } from "../src/launcher-query.mjs";
import { inputScopeBlocks } from "../src/input-scopes.mjs";

function measurement(widths) {
  const measured = [], context = { font: "original", measureText(marker) { measured.push([marker, this.font]); return { width: widths[marker] ?? 10 }; } };
  return { context, measured };
}

test("all configured markers and command @ use the widest glyph plus equal horizontal space", () => {
  const { context, measured } = measurement({ ":": 4, "@": 14, "年": 20, "：": 22 });
  const metrics = measureInputMarkers({ author: "年", year: "：", venue: ":", duplicate: ":" }, "20px Fixture", context);
  assert.equal(metrics.width, 30); assert.equal(metrics.padding, 8);
  assert.deepEqual([...metrics.widths], [["年", 20], ["：", 22], [":", 4], ["@", 14]]);
  assert.equal(measured.length, 4); assert.ok(measured.every(([, font]) => font === "20px Fixture"));
  assert.equal(context.font, "original");
});

test("marker positions preserve raw text and accumulate only completed marker slots", () => {
  const value = "年(A) :1900 @B", scopes = [
    { type: "author", start: 0, open: 1, close: 3 },
    { type: "author", start: 0, open: 2, close: 3 },
    { type: "year", start: 5, markerEnd: 6, end: 10 },
    { type: "author", start: 11, markerEnd: 12, end: 13 },
    { type: "logic", start: 1, open: 1, close: 3 },
  ];
  const { context } = measurement({ "年": 20, ":": 4, "@": 14 });
  const metrics = measureInputMarkers({ author: "年", year: ":" }, "20px Fixture", context), layout = inputMarkerLayout(value, scopes, metrics);
  assert.deepEqual(layout.map(marker => [marker.start, marker.end, marker.width, marker.delta]), [[0, 1, 28, 8], [5, 6, 28, 24], [11, 12, 28, 14]]);
  assert.deepEqual([0, 1, 5, 6, 11, 12, 13].map(index => markerDeltaAt(layout, index)), [0, 8, 8, 32, 32, 46, 46]);
  assert.equal(markerDeltaAt(layout, 12) - markerDeltaAt(layout, 5), 38, "a selection includes only slot expansion within its range");
  assert.equal(value, "年(A) :1900 @B");
});

test("layout uses parsed field markers without coloring escaped or quoted guide text", () => {
  const value = String.raw`"@literal :1900" \@literal @(A) :2000`;
  const { context } = measurement({ "@": 14, ":": 4 }), metrics = measureInputMarkers(DEFAULT_PREFIXES, "20px Fixture", context);
  const scopes = inputScopeBlocks(value, [], parseLauncherInput(value, "items", value.length)), layout = inputMarkerLayout(value, scopes, metrics);
  assert.deepEqual(layout.map(marker => marker.start), [value.indexOf("@(A)"), value.indexOf(":2000")]);
});

test("logical DOM spans ignore element padding and use the following text at marker boundaries", () => {
  const nodes = ["@", "(", "年", ")", ":", "1900"].map(textContent => ({ nodeType: 3, textContent }));
  const root = { nodeType: 1, ownerDocument: { createTreeWalker: (_, filter) => {
    assert.equal(filter, 4); let index = 0; return { nextNode: () => nodes[index++] ?? null };
  } } };
  assert.deepEqual(sourceSpanAt(root, 0), { node: nodes[0], offset: 0 });
  assert.deepEqual(sourceSpanAt(root, 1), { node: nodes[1], offset: 0 });
  assert.deepEqual(sourceSpanAt(root, 5), { node: nodes[5], offset: 0 });
  assert.deepEqual(sourceSpanAt(root, 7), { node: nodes[5], offset: 2 });
  assert.deepEqual(sourceSpanAt(root, 9), { node: nodes[5], offset: 4 });
  assert.equal(sourceSpanAt(root, 10), null);
  assert.equal(sourceSpanAt(root, -1), null);
});

test("double-click ranges use the right-hand word or whitespace block at a boundary and the last block at input end", () => {
  const value = "word \t next";
  assert.deepEqual(inputWordRange(value, 0), { start: 0, end: 4 });
  assert.deepEqual(inputWordRange(value, 3), { start: 0, end: 4 });
  assert.deepEqual(inputWordRange(value, 4), { start: 4, end: 7 });
  assert.deepEqual(inputWordRange(value, 6), { start: 4, end: 7 });
  assert.deepEqual(inputWordRange(value, 7), { start: 7, end: 11 });
  assert.deepEqual(inputWordRange(value, 11), { start: 7, end: 11 });
  assert.deepEqual(inputWordRange("", 0), { start: 0, end: 0 });
  for (const index of [-1, 12, 1.5]) assert.equal(inputWordRange(value, index), null);
});

test("double-click ranges keep Unicode letters, digits and underscores together and never split a surrogate pair", () => {
  const value = "A\u{10400}_2 \u{1F600}!";
  for (const index of [0, 1, 2, 3, 4]) assert.deepEqual(inputWordRange(value, index), { start: 0, end: 5 });
  for (const index of [6, 7]) assert.deepEqual(inputWordRange(value, index), { start: 6, end: 8 });
  assert.deepEqual(inputWordRange(value, 8), { start: 8, end: 9 });
  assert.deepEqual(inputWordRange(value, 9), { start: 8, end: 9 });
  assert.deepEqual(inputWordRange("中文_123", 2), { start: 0, end: 6 });
});
