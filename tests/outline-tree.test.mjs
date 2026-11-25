import test from "node:test";
import assert from "node:assert/strict";
import { buildOutlineTree } from "../src/outline-tree.mjs";

const row = (outlineKey, title, options = {}) => ({ attachmentID: 1, outlineKey, title, parents: [], parentKey: null, depth: 0,
  documentTitle: "Paper", pageIndex: 0, location: { pageIndex: 0 }, kind: "outline", ...options });
const descendants = tree => tree.flatMap(node => [node, ...descendants(node.children)]);
const keys = tree => descendants(tree).map(node => node.key);
const deepRows = () => [row("0", "Intro"), row("0.0", "Methods", { parentKey: "0", depth: 1, parents: ["Intro"] }),
  row("0.0.0", "Details", { parentKey: "0.0", depth: 2, parents: ["Intro", "Methods"] })];

test("the complete heading hierarchy retains all title levels without changing source rows", () => {
  const rows = [...deepRows(), row("1", "Results")], before = structuredClone(rows), tree = buildOutlineTree(rows);
  assert.deepEqual(keys(tree), ["1:0", "1:0.0", "1:0.0.0", "1:1"]);
  assert.equal(tree.length, 2); assert.equal(tree[0].children[0].children[0].title, "Details");
  assert.deepEqual(descendants(tree).map(node => node.depth), [0, 1, 2, 0]);
  assert.ok(descendants(tree).every(node => !node.isDocument)); assert.deepEqual(rows, before);
});

test("duplicate titles keep native identities and sibling order ignores page numbers", () => {
  const rows = [row("0.10", "Same", { parentKey: "0", depth: 1, pageIndex: 0 }), row("0.2", "Same", { parentKey: "0", depth: 1, pageIndex: 8 }),
    row("0", "Same", { pageIndex: 19 }), row("0.1", "Same", { parentKey: "0", depth: 1, pageIndex: 12 })];
  const tree = buildOutlineTree(rows);
  assert.deepEqual(keys(tree), ["1:0", "1:0.1", "1:0.2", "1:0.10"]); assert.equal(new Set(keys(tree)).size, rows.length);
  assert.deepEqual(descendants(tree).map(row => row.pageIndex), [19, 12, 8, 0]); assert.equal(rows[0].outlineKey, "0.10");
});

test("PDF groups keep same-named documents separate and preserve their entire hierarchies", () => {
  const rows = [...deepRows(), ...deepRows().map(row => ({ ...row, attachmentID: 2 }))], tree = buildOutlineTree(rows, { groupDocuments: true });
  assert.deepEqual(tree.map(row => row.key), ["1:document", "2:document"]);
  assert.ok(tree.every(row => row.isDocument && row.kind === "outline" && row.outlineKey === "document" && row.location === undefined && row.pageIndex === undefined));
  assert.deepEqual(keys(tree), ["1:document", "1:0", "1:0.0", "1:0.0.0", "2:document", "2:0", "2:0.0", "2:0.0.0"]);
  assert.equal(tree[0].title, "Paper"); assert.equal(tree[1].title, "Paper");
  assert.deepEqual(tree.map(node => node.children[0].depth), [0, 0]); assert.deepEqual(tree.map(node => node.children[0].children[0].depth), [1, 1]);
});

test("filter matches keep only real ancestors and preserve destination-less structural groups", () => {
  const rows = deepRows(); rows[0].location = undefined; rows[0].pageIndex = undefined; rows[1].location = undefined; rows[1].pageIndex = undefined;
  rows.push(row("1", "Other"), row("0.1", "Sibling", { parentKey: "0", depth: 1 }));
  const tree = buildOutlineTree([rows[2]], { allRows: rows });
  assert.deepEqual(keys(tree), ["1:0", "1:0.0", "1:0.0.0"]);
  assert.equal(tree[0].location, undefined); assert.equal(tree[0].children[0].location, undefined);
  assert.equal(tree[0].children[0].children[0].location, rows[2].location);
  assert.deepEqual(descendants(tree).map(node => node.matched), [false, false, true]);
  const otherPDF = rows.map(row => ({ ...row, attachmentID: 2 }));
  assert.deepEqual(keys(buildOutlineTree([rows[2]], { allRows: [...rows, ...otherPDF] })), ["1:0", "1:0.0", "1:0.0.0"]);
  assert.deepEqual(keys(buildOutlineTree(rows)), ["1:0", "1:0.0", "1:0.0.0", "1:0.1", "1:1"]);
});

test("nearest titled parent and supplied title depth skip untitled outline levels without invented nodes", () => {
  const root = row("0", "Intro"), child = row("0.1.2", "Methods", { parentKey: "0", depth: 1, parents: ["Intro"] });
  const tree = buildOutlineTree([child], { allRows: [root, child] });
  assert.deepEqual(keys(tree), ["1:0", "1:0.1.2"]); assert.equal(tree[0].children[0].depth, 1);
  const missing = buildOutlineTree([child], { allRows: [child] });
  assert.equal(missing.length, 1); assert.equal(missing[0].key, "1:0.1.2"); assert.equal(missing[0].children.length, 0);
});

test("older rows without parent keys use only existing native path ancestors", () => {
  const root = row("0", "Intro"), child = row("0.1.2", "Methods", { parentKey: undefined, depth: undefined, parents: ["Intro"] });
  const tree = buildOutlineTree([child], { allRows: [root, child] });
  assert.deepEqual(keys(tree), ["1:0", "1:0.1.2"]); assert.equal(tree[0].children[0].depth, 1);
});

test("empty matches, leaves and invalid rows do not invent heading or document nodes", () => {
  const rows = [row("0", "Only heading"), row("1", "No target", { location: undefined, pageIndex: undefined })];
  assert.deepEqual(buildOutlineTree([], { allRows: rows, groupDocuments: true }), []);
  const tree = buildOutlineTree(rows); assert.equal(tree.length, 2); assert.ok(tree.every(node => node.children.length === 0));
  assert.equal(tree[1].location, undefined);
  assert.deepEqual(buildOutlineTree([row("0", ""), row(0, "Numeric key"), row("0", "Invalid attachment", { attachmentID: 0 })]), []);
});
