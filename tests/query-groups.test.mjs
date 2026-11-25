import test from "node:test";
import assert from "node:assert/strict";
import { parseLauncherInput, replaceLauncherFilter, removeLauncherFilter, pairLauncherInput, DEFAULT_PREFIXES, migrateLauncherPrefixes } from "../src/launcher-query.mjs";
import { tokenize } from "../src/core.mjs";

const parsed = (text, caret = -1) => parseLauncherInput(text, "items", caret);
const shape = node => node.op ? { [node.op]: node.children.map(shape) } : node.filterIndex !== undefined ? { filter: node.filterIndex } : { text: node.text, quoted: node.quoted };

test("field parentheses contain a full multiword value while explicit operators form nested groups", () => {
  const value = parsed('@(Wei Li) /(Core OR Methods) :("2024") ');
  assert.equal(value.complete, undefined);
  assert.deepEqual(value.filters.map(filter => [filter.type, filter.value]), [["author", "Wei Li"], ["directory", "Core"], ["directory", "Methods"], ["year", "2024"]]);
  assert.deepEqual(shape(value.queryTree), { AND: [{ filter: 0 }, { OR: [{ filter: 1 }, { filter: 2 }] }, { filter: 3 }] });
  assert.deepEqual(parsed('(:2024 OR :2025) AND (!Nature OR -!Elsevier) ').filters.map(filter => [filter.type, filter.value]), [["year", "2024"], ["year", "2025"], ["venue", "Nature"], ["venue", "Elsevier"]]);
  const nested = parsed('(fault OR stress AND "transfer rate") AND NOT (@(A OR B) /(Core)) ');
  assert.deepEqual(shape(nested.queryTree), { AND: [{ OR: [{ text: "fault", quoted: false }, { AND: [{ text: "stress", quoted: false }, { text: "transfer rate", quoted: true }] }] }, { NOT: [{ AND: [{ OR: [{ filter: 0 }, { filter: 1 }] }, { filter: 2 }] }] }] });
});

test("phrases retain their complete text and quoted operators and guides remain literal", () => {
  const query = parsed(String.raw`("fault stress" OR "stress fault") @( "Law AND Science" OR "A\B" ) \(literal\) `);
  assert.equal(query.complete, undefined);
  assert.deepEqual(query.filters.map(filter => filter.value), ["Law AND Science", String.raw`A\B`]);
  assert.deepEqual(tokenize(query.text), ["fault stress", "stress fault", "(literal)"]);
  assert.equal(parsed('fault OR stress').queryTree.op, "OR");
  assert.equal(parsed('"fault OR stress"').queryTree, undefined);
  assert.deepEqual(shape(parsed('-@(A OR B)').queryTree), { NOT: [{ OR: [{ filter: 0 }, { filter: 1 }] }] });
});

test("caret replacement changes one inherited field leaf without swallowing its group or sibling", () => {
  const input = 'fault @(First Author OR Second Author) /(Core) ';
  const query = parsed(input, input.indexOf("Second") + 6);
  assert.equal(query.mode, "authors"); assert.equal(query.activeFilter.value, "Second");
  const selected = replaceLauncherFilter(input, query.activeFilter, "Third Author");
  assert.equal(selected.value, 'fault @(First Author OR "Third Author") /(Core) ');
  const next = parsed(selected.value);
  assert.deepEqual(next.filters.map(filter => filter.value), ["First Author", "Third Author", "Core"]);
  const first = parsed(input, input.indexOf("First") + 5);
  assert.equal(replaceLauncherFilter(input, first.activeFilter, "New Author").value, 'fault @("New Author" OR Second Author) /(Core) ');
  const empty = parsed("@()", 2), filled = replaceLauncherFilter("@()", empty.activeFilter, "Wei Li");
  assert.equal(empty.mode, "authors"); assert.equal(empty.complete, false);
  assert.equal(filled.value, '@("Wei Li") '); assert.equal(filled.caret, filled.value.length);
  const emptySpaced = parsed("@( )", 3), filledSpaced = replaceLauncherFilter("@( )", emptySpaced.activeFilter, "Wei Li");
  assert.equal(emptySpaced.mode, "authors");
  assert.equal(filledSpaced.value, '@("Wei Li") '); assert.equal(filledSpaced.caret, filledSpaced.value.length);
});

test("paired guides place the caret inside parentheses only for direct unescaped input", () => {
  for (const marker of ["@", "/", ":", "!", "%", ">", "'", " "]) assert.deepEqual(pairLauncherInput(marker, 1, "insertText"), { value: marker + "()", caret: 2 });
  for (const [text, caret, type] of [['"name@"', 6, "insertText"], [String.raw`name\@`, 6, "insertText"], ["@", 1, "insertFromPaste"], ["email: ", 6, "insertText"]]) assert.equal(pairLauncherInput(text, caret, type), null);
  assert.equal(pairLauncherInput("@()", 1, "insertText"), null);
  const custom = { ...DEFAULT_PREFIXES, author: "~", directory: "$", year: "^", venue: "&", type: "=" };
  assert.deepEqual(pairLauncherInput("~", 1, "insertText", custom), { value: "~()", caret: 2 });
  const migrated = migrateLauncherPrefixes('@("A B" OR C) /(Core) ', DEFAULT_PREFIXES, custom);
  assert.equal(migrated, '~("A B" OR C) $(Core) ');
  assert.deepEqual(parseLauncherInput(migrated, "items", -1, custom).filters.map(filter => filter.value), ["A B", "C", "Core"]);
  for (const [value, kind] of [[">(fault)", "scoped"], ["'(Methods OR Results)", "global"], [' ("fault stress")', "fulltext"], [';(fault OR "@literal")', "global"]]) {
    const query = parsed(value); assert.equal(query.kind, kind); assert.ok(query.queryTree); assert.equal(query.complete, undefined);
  }
});

test("field guides pair and remain independently parsed directly after a closing scope", () => {
  for (const marker of ["@", "/", ":", "!", "%", "'", ";"]) {
    const typed = "@(A)" + marker, paired = pairLauncherInput(typed, typed.length, "insertText");
    assert.deepEqual(paired, { value: typed + "()", caret: typed.length + 1 });
    const query = parsed(paired.value, paired.caret);
    assert.equal(query.activeFilter?.marker, 4, marker);
    assert.equal(query.scopes.length, 2, marker);
    assert.equal(query.filters[0].value, "A", marker);
  }
  const query = parsed("@(A):(2024)!(Nature)%(journalArticle)/(Core)");
  assert.equal(query.complete, undefined);
  assert.deepEqual(query.filters.map(filter => [filter.type, filter.value]), [["author", "A"], ["year", "2024"], ["venue", "Nature"], ["type", "journalArticle"], ["directory", "Core"]]);
  assert.deepEqual(parsed("@(A)-:2024").filters.map(filter => [filter.type, filter.value, filter.negated]), [["author", "A", false], ["year", "2024", true]]);
  for (const value of [String.raw`literal\):`, String.raw`@(A)\:`, '"@(A):"']) {
    assert.equal(pairLauncherInput(value, value.length, "insertText"), null);
  }
});

test("unfinished groups and quotes retain drafts and prevent executable complete queries", () => {
  for (const value of ["@(Wei", "(fault OR)", '("fault', "@()", "()", "fault AND"]) {
    const query = parsed(value); assert.equal(query.complete, false, value); assert.ok(query.error, value);
  }
  assert.equal(parsed('@"unfinished').complete, false);
  assert.equal(parsed('/"unfinished').complete, false);
  assert.equal(parsed('fault @A OR @B ').queryTree, undefined, "existing common-word and field-OR semantics remain compatible");
});

test("removing one grouped field preserves other conditions and clears dangling Boolean operators", () => {
  const value = '@(A OR B) AND /(Core) AND "fault stress" ';
  const query = parsed(value), removed = removeLauncherFilter(value, query.filters[1]);
  const next = parsed(removed.value);
  assert.equal(next.complete, undefined); assert.deepEqual(next.filters.map(filter => filter.value), ["A", "Core"]);
  assert.deepEqual(tokenize(next.text), ["fault stress"]);
  const last = removeLauncherFilter("/(Core)", parsed("/(Core)").filters[0]); assert.equal(last.value, "");
  const wild = '@(A* OR B) AND /(Core*) ';
  const kept = parsed(removeLauncherFilter(wild, parsed(wild).filters[1]).value);
  assert.deepEqual(kept.filters.map(filter => [filter.value, filter.quoted]), [["A*", false], ["Core*", false]]);
});
