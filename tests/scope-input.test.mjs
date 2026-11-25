import test from "node:test";
import assert from "node:assert/strict";
import { parseLauncherInput, DEFAULT_PREFIXES } from "../src/launcher-query.mjs";
import { InputScopes } from "../src/input-scopes.mjs";

test("empty outline scopes show candidates only while the caret is inside the parentheses", () => {
  const inside = parseLauncherInput("'()", "items", 2);
  assert.equal(inside.mode, "outline"); assert.equal(inside.activeFilter?.type, "outline");
  assert.notEqual(inside.complete, false);
  const outside = parseLauncherInput("'()", "items", 3);
  assert.equal(outside.mode, "items"); assert.equal(outside.filters[0].type, "outline");
});

test("whitespace inside parentheses retains active filter candidate mode until stepping outside right parenthesis", () => {
  for (const caret of [2, 3]) {
    const outlineSpace = parseLauncherInput("'( )", "items", caret);
    assert.equal(outlineSpace.mode, "outline");
    assert.equal(outlineSpace.activeFilter?.type, "outline");
    assert.equal(outlineSpace.activeFilter?.value, "");
    const authorSpace = parseLauncherInput("@( )", "items", caret);
    assert.equal(authorSpace.mode, "authors");
    assert.equal(authorSpace.activeFilter?.type, "author");
    assert.equal(authorSpace.activeFilter?.value, "");
  }
  assert.equal(parseLauncherInput("'( )", "items", 4).mode, "items");
  assert.equal(parseLauncherInput("'( )", "items", 4).activeFilter, undefined);
  assert.equal(parseLauncherInput("@( )", "items", 4).mode, "items");
  assert.equal(parseLauncherInput("@( )", "items", 4).activeFilter, undefined);

  const trailingSpace = parseLauncherInput("'(Methods )", "items", 10);
  assert.equal(trailingSpace.mode, "outline");
  assert.equal(trailingSpace.activeFilter?.type, "outline");
  assert.equal(trailingSpace.activeFilter?.value, "Methods");
  assert.equal(parseLauncherInput("'(Methods )", "items", 11).mode, "items");

  const leadingSpace = parseLauncherInput("'( Methods)", "items", 2);
  assert.equal(leadingSpace.mode, "outline");
  assert.equal(leadingSpace.activeFilter?.type, "outline");
  assert.equal(leadingSpace.activeFilter?.value, "");
  assert.equal(parseLauncherInput("'( Methods)", "items", 1).mode, "items");
});

test("outline scopes work beside ordinary topic, author and year conditions without capturing outside text", () => {
  const value = 'fault @("First Author") \'(Methods OR Results) :(2024)';
  const inside = parseLauncherInput(value, "items", value.indexOf("Methods") + 4);
  const outside = parseLauncherInput(value, "items", value.length);
  assert.equal(inside.mode, "outline"); assert.equal(inside.activeFilter.value, "Meth");
  assert.equal(outside.mode, "items"); assert.equal(outside.scopedOutline, true);
  assert.deepEqual(outside.filters.map(filter => [filter.type, filter.value]), [["author", "First Author"], ["outline", "Methods"], ["outline", "Results"], ["year", "2024"]]);
  assert.deepEqual(outside.queryTree.children[0], { text: "fault", quoted: false, start: 0, end: 5 });
});

test("quoted, escaped and configured outline guides have deterministic literal versus scope behavior", () => {
  for (const value of [String.raw`fault \'literal`, 'fault "\'literal"']) {
    const query = parseLauncherInput(value, "items", value.length);
    assert.equal(query.mode, "items"); assert.equal(query.filters, undefined);
  }
  const custom = { ...DEFAULT_PREFIXES, outline: "`" };
  assert.equal(parseLauncherInput("fault `(Methods)", "items", 11, custom).mode, "outline");
  assert.equal(parseLauncherInput("fault `(Methods)", "items", 16, custom).mode, "items");
});

test("automatic boundaries are protected while manually typed grouping parentheses remain editable", () => {
  const input = new InputScopes("@()");
  assert.equal(input.guard("deleteContentBackward", 2, 2), null);
  input.add(0);
  assert.deepEqual(input.guard("deleteContentBackward", 2, 2), { caret: 1 });
  assert.deepEqual(input.guard("deleteContentForward", 2, 2), { caret: 3 });
  input.sync('@(Alice OR (Bob))');
  assert.equal(input.guard("deleteContentForward", 11, 11), null);
  const cleared = input.guard("deleteByCut", 1, input.value.length);
  assert.deepEqual(cleared, { value: "@()", caret: 2 });
  const all = input.guard("insertText", 0, input.value.length, "fault");
  assert.deepEqual(all, { value: "fault", caret: 5 });
  input.reset("@()"); input.add(0);
  assert.deepEqual(input.guard("deleteContentBackward", 1, 1), { value: "", caret: 0 });
});

test("scope records survive edits and prefix migration without protecting escaped or quoted content", () => {
  const input = new InputScopes("@(A) /(B)"); input.add(0); input.add(5);
  input.sync("@(Alice) /(B)");
  assert.deepEqual(input.records.map(scope => [scope.type, scope.marker, scope.close]), [["author", 0, 7], ["directory", 9, 12]]);
  input.sync("~(Alice) $(B)", { ...DEFAULT_PREFIXES, author: "~", directory: "$" });
  assert.equal(input.records.length, 2);
  const escaped = new InputScopes("@(A)"); escaped.add(0); escaped.sync(String.raw`\@(A)`);
  assert.equal(escaped.records.length, 0);
  const quoted = new InputScopes("@(A)"); quoted.add(0); quoted.sync('"@(A)"');
  assert.equal(quoted.records.length, 0);
  const invalid = new InputScopes("plain", [{ type: "outline", marker: 0, open: 1, close: 4 }]);
  assert.equal(invalid.records.length, 0);
});

test("leaving a scope reserves one following space and keeps adjacent or nested scopes intact", () => {
  const input = new InputScopes("@(A):(2024)"); input.add(0); input.add(4);
  const leave = input.leave(3, parseLauncherInput(input.value, "items", 3));
  assert.deepEqual(leave, { value: "@(A) :(2024)", caret: 5 });
  input.sync(leave.value);
  assert.deepEqual(input.records.map(scope => [scope.type, scope.marker, scope.close]), [["author", 0, 3], ["year", 5, 11]]);
  assert.equal(parseLauncherInput(leave.value, "items", leave.caret).activeFilter, undefined);
  assert.deepEqual(input.leave(3, parseLauncherInput(input.value, "items", 3)), leave);
  const final = input.leave(11, parseLauncherInput(input.value, "items", 11));
  assert.deepEqual(final, { value: "@(A) :(2024) ", caret: 13 });
  assert.equal(input.leave(4), null);
  input.reset("@(A)  tail"); input.add(0);
  assert.deepEqual(input.leave(3), { value: "@(A)  tail", caret: 5 });
  input.reset("@((A))"); input.add(0);
  const inner = input.leave(4, parseLauncherInput(input.value, "items", 4));
  assert.deepEqual(inner, { value: "@((A) )", caret: 6 });
  input.sync(inner.value);
  assert.deepEqual(input.leave(6, parseLauncherInput(input.value, "items", 6)), { value: "@((A) ) ", caret: 8 });
});

test("draft quotes, user grouping and word deletions retain the immutable outer scope", () => {
  const input = new InputScopes("@()"); input.add(0);
  input.sync('@("');
  assert.equal(input.records.length, 0, "a programmatic replacement that drops the boundary is not a protected token");
  input.reset("@()"); input.add(0); input.sync('@(")');
  assert.equal(input.records.length, 1);
  assert.equal(input.skipClosing(input.records[0].close), false);
  input.sync('@("A OR (B)');
  assert.equal(input.records.length, 1); assert.equal(input.records[0].close, 10);
  const restored = new InputScopes(input.value, input.records); assert.equal(restored.records.length, 1);
  input.reset("@(Alpha Beta)"); input.add(0);
  assert.equal(input.skipClosing(input.value.length - 1), true);
  input.reset("@()"); input.add(0); input.sync("@((A)");
  assert.equal(input.skipClosing(4), false);
  input.sync("@((A))"); assert.equal(input.skipClosing(5), true);
  input.reset("@(Alpha Beta)"); input.add(0);
  assert.deepEqual(input.guard("deleteWordForward", 2, 2), { value: "@(Beta)", caret: 2 });
  assert.deepEqual(input.guard("deleteHardLineBackward", input.value.length - 1, input.value.length - 1), { value: "@()", caret: 2 });
});

test("word and line deletions from outside a scope cannot leave half of its automatic boundary", () => {
  const input = new InputScopes("@(Alice Smith) tail"); input.add(0);
  assert.deepEqual(input.guard("deleteWordBackward", 15, 15), { value: "@(Alice)tail", caret: 7 });
  assert.deepEqual(input.guard("deleteSoftLineBackward", input.value.length, input.value.length), { value: "", caret: 0 });
  input.reset("@(Alice Smith) tail"); input.add(0);
  assert.deepEqual(input.guard("deleteSoftLineForward", 1, 1), { caret: 2 });
  assert.deepEqual(input.guard("deleteSoftLineForward", 2, 2), { value: "@() tail", caret: 2 });
  assert.equal(input.guard("deleteWordBackward", 0, 0), null);
});
