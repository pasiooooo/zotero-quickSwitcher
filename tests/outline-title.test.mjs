import test from "node:test";
import assert from "node:assert/strict";
import { flattenOutline, readPDFOutline } from "../addon/content/pdf-outline-data.js";

const methodTitle = "Résumé · 方法 👩‍🔬 ∑α";
const literalTitle = "Literal 0000 e\u0301 Z\u200BeroWidth 𝛼 ≤ π";

function fixture() {
  const destination = [{ num: 23, gen: 0 }, { name: "XYZ" }, 20, 430, null];
  const generatedLocation = { position: { pageIndex: 1, rects: [[20, 310, 20, 310]] } };
  const recoveredDestination = [3, { name: "Fit" }];
  const tree = [
    { title: "\u0000 Intro\u0000duction \u0000", dest: "intro", location: { dest: "intro" }, pageIndex: 0, items: [
      { title: "\u0000Résumé · 方\u0000法 👩‍🔬 ∑α\u0000", dest: destination, location: { dest: destination }, pageIndex: 1, items: [
        { title: "\u0000 \u0000", dest: [2, { name: "Fit" }], location: { dest: [2, { name: "Fit" }] }, pageIndex: 2, items: [
          { title: "Nested\u0000 heading 👩‍🔬 ≤ 𝛼", location: generatedLocation, pageIndex: 1, items: [] },
        ] },
      ] },
      { title: literalTitle, dest: "literal0000", location: { dest: "literal0000" }, pageIndex: 2, items: [] },
    ] },
    { title: "\u0000\u0000", items: [{ title: "Recovered\u0000 root", dest: recoveredDestination, location: { dest: recoveredDestination }, pageIndex: 3, items: [] }] },
    { title: "中文 English ∫₀∞ f(x) dx 0000", items: [] },
  ];
  return { tree, destination, generatedLocation, recoveredDestination };
}

function assertCleanRows(rows, data) {
  assert.ok(rows.every(row => !row.title.includes("\u0000") && row.parents.every(parent => !parent.includes("\u0000"))), "titles and ancestor paths must not contain NUL");
  assert.deepEqual(rows.map(({ title, parents, outlineKey, parentKey, depth }) => ({ title, parents, outlineKey, parentKey, depth })), [
    { title: "Introduction", parents: [], outlineKey: "0", parentKey: null, depth: 0 },
    { title: methodTitle, parents: ["Introduction"], outlineKey: "0.0", parentKey: "0", depth: 1 },
    { title: "Nested heading 👩‍🔬 ≤ 𝛼", parents: ["Introduction", methodTitle], outlineKey: "0.0.0.0", parentKey: "0.0", depth: 2 },
    { title: literalTitle, parents: ["Introduction"], outlineKey: "0.1", parentKey: "0", depth: 1 },
    { title: "Recovered root", parents: [], outlineKey: "1.0", parentKey: null, depth: 0 },
    { title: "中文 English ∫₀∞ f(x) dx 0000", parents: [], outlineKey: "2", parentKey: null, depth: 0 },
  ]);
  assert.deepEqual(rows.map(row => row.pageIndex), [0, 1, 1, 2, 3, undefined]);
  assert.strictEqual(rows[1].location.dest, data.destination);
  assert.strictEqual(rows[2].location, data.generatedLocation);
  assert.strictEqual(rows[4].location.dest, data.recoveredDestination);
  assert.deepEqual(rows[0].location, { dest: "intro" }); assert.deepEqual(rows[3].location, { dest: "literal0000" });
  assert.ok(!rows.some(row => ["0.0.0", "1"].includes(row.outlineKey)), "control-only nodes must not become fake headings");
}

test("flattenOutline strips NUL from titles and ancestor paths without shifting hierarchy or targets", () => {
  const data = fixture(), original = structuredClone(data.tree), rows = flattenOutline(data.tree);
  assertCleanRows(rows, data);
  assert.deepEqual(data.tree, original);
});

test("readPDFOutline cleans Reader/PDF.js titles while preserving exact named, explicit and generated destinations", async () => {
  const data = fixture(), original = structuredClone(data.tree);
  const rows = await readPDFOutline({ numPages: 4, getOutline: async () => data.tree,
    getDestination: async name => name === "intro" ? [0, { name: "XYZ" }, 20, 750, null] : [2, { name: "XYZ" }, 20, 750, null],
    getPageIndex: async ref => { assert.deepEqual(ref, { num: 23, gen: 0 }); return 1; } });
  assertCleanRows(rows, data);
  assert.deepEqual(data.tree, original);
});

test("valid English, Chinese, combining marks, zero-width emoji, math and literal 0000 remain intact", () => {
  const titles = ["Plain English 0000", "中文 方法 0000", "👩‍🔬 🧑🏽‍💻", "e\u0301 Résumé", "Z\u200Bero a\u200Db", "∫₀∞ f(x) dx ≤ π 𝛼 ∑α"];
  const source = titles.map(title => ({ title, items: [] })), original = structuredClone(source);
  assert.deepEqual(flattenOutline(source).map(row => row.title), titles);
  assert.deepEqual(source, original);
});

test("native C0 cleanup removes NUL, replaces other controls with spaces and skips control-only parents", async () => {
  const controls = Array.from({ length: 31 }, (_, index) => String.fromCharCode(index + 1)).join("");
  const location = { position: { pageIndex: 2, rects: [[11, 400, 11, 400]] } };
  const source = [{ title: "\u0000" + controls, items: [
    { title: "Intro\u0000duction\tScope", location, pageIndex: 2, items: [
      { title: "Left" + controls + "Right\tTail\nEnd\u0007Word\u0000Join", location, pageIndex: 2, items: [] },
    ] },
  ] }], original = structuredClone(source);
  const expected = ["Introduction Scope", "Left" + " ".repeat(31) + "Right Tail End WordJoin"];
  for (const rows of [flattenOutline(source), await readPDFOutline({ numPages: 3, getOutline: async () => source })]) {
    assert.deepEqual(rows.map(row => row.title), expected);
    assert.deepEqual(rows.map(({ parents, outlineKey, parentKey, depth }) => ({ parents, outlineKey, parentKey, depth })), [
      { parents: [], outlineKey: "0.0", parentKey: null, depth: 0 },
      { parents: ["Introduction Scope"], outlineKey: "0.0.0", parentKey: "0.0", depth: 1 },
    ]);
    assert.ok(rows.every(row => !/[\x00-\x1F]/u.test(row.title) && row.parents.every(parent => !/[\x00-\x1F]/u.test(parent))));
    assert.ok(rows.every(row => row.location === location && row.pageIndex === 2));
  }
  assert.deepEqual(source, original);
});
