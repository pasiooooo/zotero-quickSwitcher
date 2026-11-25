import test from "node:test";
import assert from "node:assert/strict";
import { buildLocationTree, locationMatchRanges } from "../src/location-tree.mjs";

test("shared ancestors are shown once while direct memberships keep separate terminals", () => {
  const paths = [
    { libraryID: 1, collectionID: 10, pathSegments: ["我的文库", "项目 A"], pathKeys: ["u", "A"] },
    { libraryID: 1, collectionID: 11, pathSegments: ["我的文库", "项目 A", "核心"], pathKeys: ["u", "A", "core"] },
    { libraryID: 1, collectionID: 12, pathSegments: ["我的文库", "项目 A", "方法"], pathKeys: ["u", "A", "methods"] },
  ];
  const tree = buildLocationTree(paths);
  assert.equal(tree.size, 1); assert.equal(tree.get("u").children.size, 1);
  const project = tree.get("u").children.get("A");
  assert.deepEqual(project.entries, [paths[0]]); assert.equal(project.children.size, 2);
  assert.equal(tree.get("u").path, "我的文库");
  assert.equal(project.path, "我的文库 › 项目 A");
  assert.equal(project.children.get("core").path, "我的文库 › 项目 A › 核心");
  assert.equal(project.children.get("core").entries[0].collectionID, 11);
});

test("location highlights follow actual library and collection keys, including ancestors and same-name branches", () => {
  const tree = buildLocationTree([
    { libraryID: 1, pathSegments: ["My Library", "Project", "Core"], pathKeys: ["u", "PROJECT1", "CORE0001"] },
    { libraryID: 1, pathSegments: ["My Library", "Other", "Core"], pathKeys: ["u", "OTHER001", "CORE0002"] },
  ]);
  const spec = { resolvedFilters: [
    { type: "directory", value: "My Library", matches: [{ kind: "library", libraryID: 1 }] },
    { type: "directory", value: "Project", matches: [{ kind: "collection", libraryID: 1, key: "PROJECT1" }] },
    { type: "directory", value: "Core", matches: [{ kind: "collection", libraryID: 1, key: "CORE0001" }] },
  ] };
  const root = tree.get("u"), project = root.children.get("PROJECT1"), other = root.children.get("OTHER001");
  assert.deepEqual(locationMatchRanges(root, spec), [{ start: 0, end: 10 }]);
  assert.ok(locationMatchRanges(project, spec).length); assert.ok(locationMatchRanges(project.children.get("CORE0001"), spec).length);
  assert.equal(locationMatchRanges(other.children.get("CORE0002"), spec).length, 0);
  assert.equal(locationMatchRanges({ ...root, libraryID: 2 }, spec).length, 0);
  assert.equal(locationMatchRanges(root, { resolvedFilters: [{ ...spec.resolvedFilters[0], negated: true }] }).length, 0);
  assert.equal(locationMatchRanges(root, { ...spec, queryTree: { op: "NOT", children: [{ filterIndex: 0 }] } }).length, 0);
  assert.ok(locationMatchRanges(root, { ...spec, queryTree: { op: "NOT", children: [{ op: "NOT", children: [{ filterIndex: 0 }] }] } }).length);
});

test("stable path keys distinguish same-named siblings and libraries with matching names", () => {
  const tree = buildLocationTree([
    { libraryID: 1, pathSegments: ["文库", "重复名字"], pathKeys: ["u", "A"] },
    { libraryID: 1, pathSegments: ["文库", "重复名字"], pathKeys: ["u", "B"] },
    { libraryID: 2, pathSegments: ["文库", "重复名字"] },
  ]);
  assert.equal(tree.size, 2); assert.equal(tree.get("u").children.size, 2);
  assert.deepEqual([...tree.get("u").children.keys()], ["A", "B"]);
});
