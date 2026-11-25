import test from "node:test";
import assert from "node:assert/strict";
import { preferenceFixture } from "./fixtures/preferences.mjs";

test("all prefix controls use click capture and save the produced punctuation rather than a shortcut", t => {
  const f = preferenceFixture(t), names = ["author", "directory", "year", "venue", "type", "current", "outline", "fulltext", "tabs"];
  assert.ok(names.every(name => f.field(name + "Prefix").hasAttribute("readonly")));
  const input = f.field("authorPrefix");
  f.fire(input, "focus");
  assert.equal(input.dataset.recording, undefined);
  assert.equal(f.press(input, { key: "Tab", code: "Tab" }).defaultPrevented, false);
  f.fire(input, "click");
  assert.equal(f.press(input, { key: "~", code: "Backquote", shiftKey: true }).defaultPrevented, true);
  assert.equal(f.app.prefs.get("authorPrefix"), "~");
  assert.equal(input.value, "~");
  assert.equal(input.dataset.recording, undefined);
});

test("switch-related prefixes record a symbol and update their shortcut while conflicts preserve the old value", t => {
  const f = preferenceFixture(t), outline = f.field("outlinePrefix"), current = f.field("currentPrefix");
  assert.equal(outline.value, "'"); assert.equal(current.value, ">");
  f.fire(outline, "click"); f.press(outline, { key: ">", code: "Period", shiftKey: true });
  assert.equal(f.app.prefs.get("outlinePrefix"), "'"); assert.equal(outline.dataset.recording, "true");
  f.press(outline, { key: ";", code: "Semicolon" }); assert.equal(f.app.prefs.get("outlinePrefix"), "'");
  f.press(outline, { key: "`", code: "Backquote" }); assert.equal(f.app.prefs.get("outlinePrefix"), "`");
  assert.equal(f.app.prefs.get("outlineShortcut"), "Alt+`"); assert.equal(outline.dataset.recording, undefined);
  f.fire(current, "click"); f.press(current, { key: ";", code: "Semicolon" }); assert.equal(f.app.prefs.get("currentPrefix"), ">");
});

test("fulltext records Space while mode prefix capture rejects Tab and returns it to navigation after Escape", t => {
  const f = preferenceFixture(t), fulltext = f.field("fulltextPrefix"), tabs = f.field("tabsPrefix");
  f.app.prefs.set("fulltextPrefix", "`");
  f.fire(fulltext, "click"); f.press(fulltext, { key: " ", code: "Space" });
  assert.equal(f.app.prefs.get("fulltextPrefix"), " "); assert.equal(fulltext.value, "Space");
  assert.equal(f.press(tabs, { key: "Enter", code: "Enter" }).defaultPrevented, true);
  assert.equal(f.press(tabs, { key: "Tab", code: "Tab" }).defaultPrevented, true);
  assert.equal(f.app.prefs.get("tabsPrefix"), ";"); f.press(tabs, { key: "Escape" });
  assert.equal(f.app.prefs.get("tabsPrefix"), ";"); assert.equal(tabs.value, ";");
  assert.equal(f.press(tabs, { key: "Tab", code: "Tab" }).defaultPrevented, false);
});

test("invalid, duplicate, composing and repeated keys preserve the prefix, and Escape/blur cancel", t => {
  const f = preferenceFixture(t), input = f.field("authorPrefix"); f.fire(input, "click");
  for (const event of [{ key: "/" }, { key: "a" }, { key: "~", ctrlKey: true }, { key: "Shift", shiftKey: true },
    { key: "~", repeat: true }, { key: "~", isComposing: true }, { key: "~", keyCode: 229 }, { key: "Dead" }, { key: "Tab" }]) {
    f.press(input, event); assert.equal(f.app.prefs.get("authorPrefix"), "@"); assert.equal(input.dataset.recording, "true");
  }
  f.press(input, { key: "Escape" }); assert.equal(input.value, "@"); assert.equal(input.dataset.recording, undefined);
  f.fire(input, "click"); f.fire(input, "blur"); assert.equal(input.value, "@"); assert.equal(input.dataset.recording, undefined);
  f.fire(input, "click"); f.press(input, { key: "~" }); assert.equal(f.app.prefs.get("authorPrefix"), "~");
});

test("AltGr and macOS Option can produce a prefix character without changing shortcut capture", t => {
  const f = preferenceFixture(t), input = f.field("authorPrefix");
  f.fire(input, "click"); f.press(input, { key: "~", ctrlKey: true, altKey: true, getModifierState: name => name === "AltGraph" });
  assert.equal(f.app.prefs.get("authorPrefix"), "~");
  globalThis.Zotero.isMac = true;
  f.fire(input, "click"); f.press(input, { key: "§", altKey: true });
  assert.equal(f.app.prefs.get("authorPrefix"), "§");
  f.fire(input, "click"); f.press(input, { key: "~", metaKey: true });
  assert.equal(f.app.prefs.get("authorPrefix"), "§");
});
