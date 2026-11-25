import test from "node:test";
import assert from "node:assert/strict";
import { parseLauncherInput } from "../src/launcher-query.mjs";
import { buildWosExpression } from "../src/wos-query.mjs";

const expression = (text, spec, options) => buildWosExpression(parseLauncherInput(text, "items", -1), spec, options);
test("WoS copy retains topic, author, year and publication while removing local directories and item types", () => {
  const value = expression('fault @Roe :2020 !Nature /Project %book ');
  assert.equal(value.error, "");
  for (const tag of ["TS", "AU", "PY", "SO", "PUBL"]) assert.ok(value.copyText.includes(tag + "=("));
  assert.ok(value.text.includes("ZOTERO_DIR")); assert.ok(value.text.includes("ZOTERO_TYPE"));
  assert.ok(!value.copyText.includes("ZOTERO")); assert.ok(!value.copyText.includes("Project")); assert.ok(!value.copyText.includes("book"));
});
test("publication bindings select the actual SO or PUBL field without copying the display disambiguation suffix", () => {
  const spec = { filters: [{ type: "venue", value: "Nature · 2", ref: { field: "publisher", title: "Nature", kind: "venue" } }] };
  const value = expression('fault !"Nature · 2" ', spec);
  assert.ok(value.copyText.includes("PUBL=(Nature)")); assert.ok(!value.copyText.includes("SO=")); assert.ok(!value.copyText.includes("·"));
});
test("phrases and literal Boolean names survive serialization and NOT remains a binary operator", () => {
  const value = expression('"stress transfer" @Roe -@Smith !"Law AND NOT Science" ');
  assert.ok(value.copyText.includes('TS=("stress transfer")'));
  assert.ok(value.copyText.includes(" NOT AU=(Smith)"));
  assert.ok(value.copyText.includes('"Law AND NOT Science"'));
});
test("removing local OR branches keeps portable Boolean grouping and does not leave dangling operators", () => {
  const value = expression('rock /Project OR @Roe -@Smith ');
  assert.equal(value.error, ""); assert.ok(!value.copyText.includes("ZOTERO"));
  assert.ok(value.copyText.includes("OR")); assert.ok(value.copyText.includes("NOT AU=(Smith)"));
});
test("native advanced OR groups remain OR in the generated query", () => {
  const value = expression("", { nativeConditions: [{ condition: "joinMode", operator: "any" }, { condition: "title", operator: "contains", value: "stress" }, { condition: "publisher", operator: "is", value: "Elsevier" }] });
  assert.ok(value.copyText.includes('TI=(stress) OR PUBL=("Elsevier")'));
});
test("year-only and negative-only queries remain visible but cannot overwrite the clipboard with unusable WoS input", () => {
  const year = expression(":2020 /Project "); assert.ok(year.text.includes("PY=(2020)")); assert.equal(year.copyText, ""); assert.match(year.error, /年份条件/);
  const negative = expression("-@Roe "); assert.equal(negative.copyText, ""); assert.match(negative.error, /肯定查询/);
});
test("field-specific text exports use the actual WoS field and private citation keys never become topics", () => {
  assert.equal(expression("fault", { fields: ["title"] }).copyText, "TI=(fault)");
  const citation = expression("QSSwitchNativeKey", { fields: ["citationKey"] });
  assert.equal(citation.copyText, ""); assert.ok(citation.text.includes("ZOTERO_CITEKEY"));
  assert.equal(expression("", { nativeConditions: [{ condition: "citationKey", operator: "contains", value: "QSSwitchNativeKey" }] }).copyText, "");
  assert.ok(expression("@A* ").error); assert.equal(expression("@Ab* ").copyText, "AU=(Ab*)");
});
test("tabs, current folder and full-text source are displayed as local conditions and excluded from copy", () => {
  const tabs = buildWosExpression(parseLauncherInput("rock", "tabs")); assert.equal(tabs.copyText, "TS=(rock)"); assert.ok(tabs.text.includes("ZOTERO_TABS"));
  const scoped = expression(">rock", {}, { scopeLabel: "Library › Project" }); assert.equal(scoped.copyText, "TS=(rock)"); assert.ok(scoped.text.includes("ZOTERO_SCOPE"));
  const full = expression(" rock"); assert.equal(full.copyText, "TS=(rock)"); assert.ok(full.text.includes("ZOTERO_FULLTEXT"));
});

test("outline mode displays global or current-PDF local conditions and never copies heading titles as TS", () => {
  const all = expression("'Methods @Roe /Core");
  assert.ok(all.text.includes("ZOTERO_OUTLINE=(")); assert.ok(all.text.includes("ZOTERO_OUTLINE_TEXT=("));
  assert.ok(all.text.includes("ZOTERO_OUTLINE_TEXT=(Methods)")); assert.equal(all.copyText, "AU=(Roe)"); assert.equal(all.hasLocal, true);
  assert.ok(!all.text.includes("TS=")); assert.ok(all.text.includes("AU=")); assert.ok(all.text.includes("ZOTERO_DIR=(Core)"));
  const pdf = buildWosExpression(parseLauncherInput('Methods "long phrase"', "outline"), { outlineScope: { type: "pdf", attachmentID: 10, title: "Rock & Stress" } });
  assert.ok(pdf.text.includes('ZOTERO_OUTLINE=("Rock & Stress")')); assert.ok(pdf.text.includes("ZOTERO_OUTLINE_TEXT="));
  assert.equal(pdf.copyText, ""); assert.ok(!pdf.text.includes("TS="));
  const withAuthor = buildWosExpression({ mode: "outline", kind: "outline", text: "Methods" }, { outlineScope: { type: "all" }, nativeConditions: [{ condition: "author", operator: "contains", value: "Roe" }] });
  assert.equal(withAuthor.copyText, "AU=(Roe)"); assert.ok(!withAuthor.copyText.includes("Methods")); assert.ok(!withAuthor.copyText.includes("ZOTERO"));
  assert.ok(buildWosExpression({ mode: "outline", kind: "outline", text: "" }, { outlineScope: { type: "all" } }).text.includes("ZOTERO_OUTLINE="));
  const escaped = buildWosExpression(parseLauncherInput(String.raw`'"Report\@Draft" \/literal`, "outline", -1));
  assert.ok(escaped.text.includes('ZOTERO_OUTLINE_TEXT=(Report@Draft AND /literal)')); assert.equal(escaped.copyText, "");
});
test("resolved year wildcard values serialize as valid year alternatives", () => {
  const value = expression("rock :202* ", { resolvedFilters: [{ type: "year", value: "202*", matches: [{ value: "2020" }, { value: "2024" }] }] });
  assert.ok(value.copyText.includes("PY=(2020 OR 2024)")); assert.equal(value.error, "");
});

test("an unfinished phrase remains visible while typing and cannot be copied as a completed WoS query", () => {
  for (const input of ['"unfinished', '\'"unfinished @Roe']) {
    const value = expression(input);
    assert.ok(value.text.includes("unfinished")); assert.equal(value.copyText, ""); assert.match(value.error, /双引号/);
  }
});

test("structured query trees preserve Boolean precedence, unary NOT and exact quoted single words", () => {
  const query = { text: "", filters: [{ type: "author", value: "Roe", negated: false }], queryTree: {
    op: "AND", children: [
      { op: "OR", children: [{ text: "fault" }, { op: "AND", children: [{ text: "stress" }, { text: "transfer" }] }] },
      { op: "NOT", children: [{ filterIndex: 0 }] },
    ],
  } };
  const value = buildWosExpression(query);
  assert.equal(value.error, "");
  assert.equal(value.copyText, "((TS=(fault) OR (TS=(stress) AND TS=(transfer))) NOT AU=(Roe))");
  const phrase = buildWosExpression({ text: "", filters: [], queryTree: { text: "fault", quoted: true } });
  assert.equal(phrase.copyText, 'TS=("fault")');
  assert.equal(expression('"fault"').copyText, 'TS=("fault")');
});

test("incomplete structured queries and literal embedded quotes cannot be copied", () => {
  const incomplete = buildWosExpression({ text: "draft", complete: false, filters: [], queryTree: { text: "draft" } });
  assert.equal(incomplete.copyText, ""); assert.ok(incomplete.text.includes("draft")); assert.match(incomplete.error, /尚未完成/);
  const quoted = buildWosExpression({ text: "", filters: [], queryTree: { text: 'fault "transfer"', quoted: true } });
  assert.equal(quoted.copyText, ""); assert.match(quoted.error, /双引号/);
  const group = buildWosExpression({ text: "(draft", complete: false, filters: [], queryTree: { text: "draft" } });
  assert.equal(group.copyText, ""); assert.ok(group.text.includes("ZOTERO_TEXT"));
});

test("structured NOT and filter negation combine by parity", () => {
  const query = { text: "", filters: [{ type: "author", value: "Roe", negated: true }], queryTree: {
    op: "AND", children: [{ text: "fault" }, { op: "NOT", children: [{ filterIndex: 0 }] }],
  } };
  assert.equal(buildWosExpression(query).copyText, "(TS=(fault) AND AU=(Roe))");
});

test("unclosed native condition groups remain visible and cannot be copied", () => {
  const value = buildWosExpression({ text: "", filters: [] }, { nativeConditions: [
    { condition: "groupStart", operator: "true" },
    { condition: "joinMode", operator: "all" },
    { condition: "title", operator: "contains", value: "fracture" },
  ] });
  assert.equal(value.copyText, ""); assert.match(value.error, /分组/);
});

test("native full-text keywords remain portable and prefix conditions gain a wildcard", () => {
  const value = buildWosExpression({ text: "", filters: [] }, { nativeConditions: [
    { condition: "fulltextContent", operator: "contains", value: "fracture" },
    { condition: "title", operator: "beginsWith", value: "Induced" },
  ] });
  assert.ok(value.copyText.includes("TS=(fracture)")); assert.ok(value.copyText.includes("TI=(Induced*)"));
  assert.ok(!value.copyText.includes("ZOTERO"));
});

test("structured filters use their prepared year matches and publication field binding", () => {
  const year = buildWosExpression({
    text: "", filters: [{ type: "year", value: "202*" }],
    queryTree: { op: "AND", children: [{ text: "fault" }, { filterIndex: 0 }] },
  }, { resolvedFilters: [{ type: "year", value: "202*", matches: [{ value: "2020" }, { value: "2024" }] }] });
  assert.ok(year.copyText.includes("PY=(2020 OR 2024)")); assert.equal(year.error, "");
  const venue = buildWosExpression({
    text: "", filters: [{ type: "venue", value: "Nature · 2" }],
    queryTree: { op: "AND", children: [{ text: "fault" }, { filterIndex: 0 }] },
  }, { filters: [{ type: "venue", value: "Nature · 2", ref: { field: "publisher", title: "Nature" } }] });
  assert.ok(venue.copyText.includes("PUBL=(Nature)")); assert.ok(!venue.copyText.includes("SO="));
});

test("nested positive topics support years and grouped exclusions retain a binary NOT", () => {
  const grouped = expression('(fault OR uplift) :(2024) NOT @(A OR B) ');
  assert.equal(grouped.error, "");
  assert.ok(grouped.copyText.includes("PY=(2024)"));
  assert.ok(grouped.copyText.includes(" NOT (AU=(A) OR AU=(B))"));
  const native = buildWosExpression({ text: "" }, { nativeConditions: [
    { condition: "title", operator: "contains", value: "fault" },
    { condition: "groupStart", operator: "true" }, { condition: "joinMode", operator: "any" },
    { condition: "title", operator: "is", value: "" }, { condition: "title", operator: "isNot", value: "" },
    { condition: "groupEnd", operator: "true" },
  ] });
  assert.equal(native.copyText, "TI=(fault)");
  assert.ok(native.text.includes("ZOTERO_CONDITION"));
});

test("negative OR branches inherit positive context instead of producing unary WoS NOT", () => {
  const mixed = expression('fault AND (NOT @(A) OR @(B)) ');
  assert.equal(mixed.error, "");
  assert.equal(mixed.copyText, "((TS=(fault) NOT AU=(A)) OR (TS=(fault) AND AU=(B)))");
  const nested = expression('fault AND (NOT @(A) AND NOT @(B)) ');
  assert.equal(nested.copyText, "(TS=(fault) NOT AU=(A) NOT AU=(B))");
  const noPositive = expression('(NOT @(A) OR @(B)) ');
  assert.equal(noPositive.copyText, ""); assert.match(noPositive.error, /肯定查询/);
  const large = expression('base AND ' + Array.from({ length: 9 }, (_, index) => `(NOT @(A${index}) OR @(B${index}))`).join(" AND ") + " ");
  assert.equal(large.copyText, ""); assert.match(large.error, /组合过多/);
});

test("structured outline text stays local beside portable metadata, and empty ASTs remain safe", () => {
  const outline = buildWosExpression({
    mode: "outline", kind: "outline", text: "Methods", filters: [{ type: "author", value: "Researcher" }],
    queryTree: { op: "AND", children: [{ text: "Methods" }, { filterIndex: 0 }] },
  }, { outlineScope: { type: "all" } });
  assert.ok(outline.text.includes("ZOTERO_OUTLINE_TEXT=(Methods)"));
  assert.equal(outline.copyText, "AU=(Researcher)");
  assert.ok(!outline.copyText.includes("TS="));
  const empty = buildWosExpression({ text: "", filters: [], queryTree: { op: "AND", children: [] } });
  assert.equal(empty.copyText, ""); assert.match(empty.error, /条件/);
});

test("scoped outline text remains local while topics outside its parentheses remain portable", () => {
  const value = expression('fault \'(Methods OR Results) :(2024) ');
  assert.ok(value.text.includes("ZOTERO_OUTLINE_TEXT=(Methods)"));
  assert.ok(value.text.includes("ZOTERO_OUTLINE_TEXT=(Results)"));
  assert.equal(value.copyText, "(TS=(fault) AND PY=(2024))");
  const empty = expression("'()");
  assert.ok(empty.text.includes("ZOTERO_OUTLINE_TEXT=(*)"));
  assert.equal(empty.copyText, "");
});
