import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PREFIXES, parseLauncherInput, parseSwitchInput, replaceLauncherFilter, migrateLauncherPrefixes } from "../src/launcher-query.mjs";
import { tokenize } from "../src/core.mjs";

const custom = { author: "~", directory: "$", year: "^", venue: "&", type: "=", current: ";", outline: "`", fulltext: "/", tabs: "|" };

test("escaped guides inside quoted phrases are literal tokens rather than backslash searches", () => {
  const parsed = parseLauncherInput(String.raw`"Report\@Draft \/Items" literal\@name literal\/name \:2024 \!Nature \%book`);
  assert.equal(parsed.filters, undefined);
  assert.deepEqual(tokenize(parsed.text), ["Report@Draft /Items", "literal@name", "literal/name", ":2024", "!Nature", "%book"]);
});

test("ordinary, fulltext, tabs, directory and outline input use the same literal escape semantics", () => {
  const value = String.raw`"head\@name \/body" a\\b quote\"word`;
  const cases = [
    [value, "items", "global"], [" " + value, "items", "fulltext"], [value, "tabs", "tabs"], ["\t" + value, "items", "global"],
    [value, "directories", "directories"], ["/" + value, "directories", "directories"], [value, "outline", "outline"], ["'" + value, "outline", "outline"],
  ];
  for (const [input, mode, kind] of cases) {
    const parsed = parseLauncherInput(input, mode);
    assert.equal(parsed.kind, kind, input); assert.equal(parsed.filters, undefined);
    assert.deepEqual(tokenize(parsed.text), ["head@name /body", String.raw`a\b`, 'quote"word'], input);
  }
});

test("escaping a leading default or custom guide prevents every mode and filter trigger", () => {
  for (const prefixes of [DEFAULT_PREFIXES, custom]) for (const marker of Object.values(prefixes)) {
    const input = "\\" + marker + "literal", parsed = parseLauncherInput(input, "items", input.length, prefixes);
    assert.equal(parsed.mode, "items", JSON.stringify(input)); assert.equal(parsed.kind, "global", JSON.stringify(input));
    assert.equal(parsed.filters, undefined); assert.equal(parsed.current, undefined);
    assert.deepEqual(tokenize(parsed.text), [marker + "literal"]);
  }
});

test("custom guides and inactive default guides decode inside phrases and explicit picker contexts", () => {
  const value = String.raw`"scope\~author \$directory \^year \&venue \=type" \@name \/name`;
  for (const mode of ["items", "tabs", "directories", "outline"]) {
    const parsed = parseLauncherInput(value, mode, value.length, custom);
    assert.equal(parsed.filters, undefined);
    assert.deepEqual(tokenize(parsed.text), ["scope~author $directory ^year &venue =type", "@name", "/name"]);
  }
});

test("odd slash counts quote a guide while even counts preserve literal slashes before a real filter", () => {
  for (let count = 1; count <= 6; count++) {
    const value = "word" + "\\".repeat(count) + "@Roe ", parsed = parseLauncherInput(value);
    const literal = "word" + "\\".repeat(Math.floor(count / 2));
    if (count % 2) { assert.equal(parsed.filters, undefined); assert.deepEqual(tokenize(parsed.text), [literal + "@Roe"]); }
    else {
      assert.deepEqual(tokenize(parsed.text), [literal]); assert.equal(parsed.filters[0].value, "Roe");
      assert.equal(parsed.filters[0].start, 4 + count); assert.equal(parsed.filters[0].marker, 4 + count);
    }
  }
});

test("slash parity within a quoted phrase preserves literal slashes without introducing filters", () => {
  for (let count = 1; count <= 6; count++) {
    const value = '"word' + "\\".repeat(count) + '@Roe"', parsed = parseLauncherInput(value);
    assert.equal(parsed.filters, undefined);
    assert.deepEqual(tokenize(parsed.text), ["word" + "\\".repeat(Math.floor(count / 2)) + "@Roe"]);
  }
});

test("Windows separators, commas, escaped quotes, backslashes and a trailing slash retain their literal meaning", () => {
  const value = String.raw`C:\Demo\paper.pdf notes, a\"b c\\d unknown\q` + " trailing\\";
  const parsed = parseLauncherInput(value);
  assert.deepEqual(tokenize(parsed.text), [String.raw`C:\Demo\paper.pdf`, "notes,", 'a"b', String.raw`c\d`, String.raw`unknown\q`, "trailing\\"]);
  assert.deepEqual(tokenize(parseLauncherInput(String.raw`"C:\Demo\paper.pdf, notes"`).text), [String.raw`C:\Demo\paper.pdf, notes`]);
});

test("decoded filter names preserve raw caret ranges and exact quoted replacement boundaries", () => {
  const value = String.raw`fault\/paper /Root\@Branch @"O\"Neil" tail`;
  const marker = value.indexOf("/Root"), caret = value.indexOf("\\@Branch") + 2;
  const parsed = parseLauncherInput(value, "items", caret), filter = parsed.filters[0];
  assert.equal(filter.start, marker); assert.equal(filter.marker, marker); assert.equal(filter.bodyStart, marker + 1);
  assert.equal(value.slice(filter.start, filter.end), String.raw`/Root\@Branch`); assert.equal(filter.value, "Root@Branch");
  assert.equal(parsed.activeFilter.value, "Root@"); assert.equal(parsed.filters[1].value, 'O"Neil');
  assert.deepEqual(tokenize(parsed.text), ["fault/paper", "tail"]);
  const replaced = replaceLauncherFilter(value, parsed.activeFilter, "New /Root");
  assert.equal(replaced.value, String.raw`fault\/paper /"New /Root" @"O\"Neil" tail`);
  assert.equal(replaced.value.slice(replaced.caret), String.raw`@"O\"Neil" tail`);
});

test("an unquoted multiword directory draft treats escaped guides as part of its literal name", () => {
  const value = String.raw`/Annual report\@Lab\/Notes`, parsed = parseLauncherInput(value);
  assert.equal(parsed.mode, "directories"); assert.equal(parsed.activeFilter.value, "Annual report@Lab/Notes");
  assert.equal(parsed.activeFilter.start, 0); assert.equal(parsed.activeFilter.end, value.length);
  const replaced = replaceLauncherFilter(value, parsed.activeFilter, "Annual report@Lab/Notes");
  assert.equal(replaced.value, '/"Annual report@Lab/Notes" ');
});

test("outline context parses metadata but quotes and escapes keep actual heading guides literal", () => {
  const parsed = parseLauncherInput("'Methods @Roe /Core :2024 !Nature %book ", "outline");
  assert.equal(parsed.mode, "outline"); assert.equal(parsed.kind, "outline"); assert.equal(parsed.outline, true);
  assert.deepEqual(parsed.filters.map(filter => filter.type), ["author", "directory", "year", "venue", "type"]);
  assert.deepEqual(tokenize(parsed.text), ["Methods"]);
  const active = parseLauncherInput("Methods @Roe", "outline");
  assert.equal(active.mode, "authors"); assert.equal(active.kind, "outline"); assert.equal(active.outline, true);
  assert.deepEqual(tokenize(active.text), ["Methods"]);
  const literal = parseLauncherInput(String.raw`'"literal @/ :2024 !Nature %book" \@heading \/heading`, "outline");
  assert.equal(literal.mode, "outline"); assert.equal(literal.filters, undefined); assert.equal(literal.outline, undefined);
  assert.deepEqual(tokenize(literal.text), ["literal @/ :2024 !Nature %book", "@heading", "/heading"]);
  for (const value of [custom.current + "Current", custom.fulltext + "Full", custom.tabs + "Tabs"]) {
    const forced = parseSwitchInput(value, "outline");
    assert.equal(forced.mode, "outline"); assert.equal(forced.kind, "switch"); assert.equal(forced.text, value);
  }
  const boolean = parseLauncherInput("'Topics @Roe OR -@Smith /Core ", "outline");
  assert.deepEqual(boolean.filters.map(({ type, value, negated, join }) => ({ type, value, negated, join })), [
    { type: "author", value: "Roe", negated: false, join: "and" },
    { type: "author", value: "Smith", negated: true, join: "or" },
    { type: "directory", value: "Core", negated: false, join: "and" },
  ]);
  assert.equal(boolean.kind, "outline"); assert.equal(boolean.outline, true);
});

test("outline replacement and prefix migration preserve literal guides and metadata semantics", () => {
  const value = String.raw`'(Methods) /old @Roe "\/literal" \/bare `;
  const parsed = parseLauncherInput(value, "items", -1), replacement = replaceLauncherFilter(value, parsed.filters[1], "/Real @Text");
  assert.ok(replacement.value.startsWith("'(Methods) "));
  assert.equal(parseLauncherInput(replacement.value, "items", -1).filters[1].value, "/Real @Text");
  const migrated = migrateLauncherPrefixes(value, DEFAULT_PREFIXES, custom), next = parseLauncherInput(migrated, "items", -1, custom);
  assert.ok(migrated.startsWith("`(Methods) ")); assert.equal(next.kind, "global");
  assert.deepEqual(next.filters.map(filter => [filter.type, filter.value]), [["outline", "Methods"], ["directory", "old"], ["author", "Roe"]]);
  assert.deepEqual(tokenize(next.text), ["/literal", "/bare"]);
  const oldCustom = "`(Methods) " + String.raw`"\~quoted" \~bare ~Roe `;
  const migratedCustom = migrateLauncherPrefixes(oldCustom, custom, DEFAULT_PREFIXES), nextCustom = parseLauncherInput(migratedCustom, "items", -1);
  assert.deepEqual(tokenize(nextCustom.text), ["~quoted", "~bare"]);
  assert.deepEqual(nextCustom.filters.map(filter => [filter.type, filter.value]), [["outline", "Methods"], ["author", "Roe"]]);
});
