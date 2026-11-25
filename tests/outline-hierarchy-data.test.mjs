import test from "node:test";
import assert from "node:assert/strict";
import { readPDFOutline } from "../addon/content/pdf-outline-data.js";
import { Prefs } from "../src/prefs.mjs";

test("PDF structure retains groups without targets and skips untitled levels without losing the real parent", async () => {
  const rows = await readPDFOutline({ numPages: 2, getOutline: async () => [{ title: "Group", items: [
    { title: "", items: [{ title: "Methods", dest: [1, { name: "Fit" }], items: [] }] },
  ] }] });
  assert.deepEqual(rows.map(row => [row.title, row.outlineKey, row.parentKey, row.depth]), [["Group", "0", null, 0], ["Methods", "0.0.0", "0", 1]]);
  assert.equal(rows[0].location, undefined); assert.deepEqual(rows[1].location, { dest: [1, { name: "Fit" }] });
});

test("removed outline depth is ignored on import without changing active input markers", () => {
  const values = new Map(); globalThis.Zotero = { Prefs: { get: key => values.get(key), set: (key, value) => values.set(key, value) }, locale: "en-US" };
  const prefs = new Prefs();
  assert.equal(prefs.get("outlineDepth"), undefined);
  assert.equal(Object.hasOwn(prefs.exportConfig().settings, "outlineDepth"), false);
  const current = prefs.get("currentPrefix"), outline = prefs.get("outlinePrefix");
  prefs.importConfig({ schemaVersion: 1, settings: { outlineDepth: 1, theme: "dark" } });
  assert.equal(prefs.get("outlineDepth"), undefined); assert.equal(prefs.get("theme"), "dark");
  assert.equal(prefs.get("currentPrefix"), current); assert.equal(prefs.get("outlinePrefix"), outline);
});
