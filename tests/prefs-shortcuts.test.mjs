import test from "node:test";
import assert from "node:assert/strict";
import { preferenceFixture } from "./fixtures/preferences.mjs";

test("clicking a shortcut records the physical combination and saves it immediately", t => {
  const f = preferenceFixture(t), input = f.field("launcherShortcut");
  assert.ok(input.hasAttribute("readonly"));
  f.fire(input, "click");
  const event = f.press(input, { key: "L", code: "KeyL", ctrlKey: true, shiftKey: true });
  assert.equal(event.defaultPrevented, true);
  assert.equal(f.app.prefs.get("launcherShortcut"), "Accel+Shift+L");
  assert.equal(input.value, "Ctrl+Shift+L");
  assert.equal(input.dataset.recording, undefined);
});

test("Escape and leaving the shortcut field cancel while Tab remains available for navigation", t => {
  const f = preferenceFixture(t), input = f.field("advancedShortcut"), before = input.value;
  f.fire(input, "click"); f.press(input, { key: "Escape", code: "Escape" });
  assert.equal(input.value, before);
  assert.equal(f.app.prefs.get("advancedShortcut"), "Alt+F");
  f.fire(input, "click"); const tab = f.press(input, { key: "Tab", code: "Tab" });
  assert.equal(tab.defaultPrevented, false);
  f.fire(input, "blur"); assert.equal(input.value, before);
  assert.equal(input.dataset.recording, undefined);
});

test("invalid, repeated or composing presses never overwrite a shortcut and duplicates can be corrected", t => {
  const f = preferenceFixture(t), input = f.field("launcherShortcut"); f.fire(input, "click");
  for (const key of [{ key: "Shift", code: "ShiftLeft", shiftKey: true }, { key: "p", code: "KeyP" },
    { key: "L", code: "KeyL", ctrlKey: true, repeat: true }, { key: "Dead", code: "KeyL", altKey: true },
    { key: "Process", code: "KeyL", ctrlKey: true, isComposing: true },
    { key: "L", code: "KeyL", ctrlKey: true, altKey: true, getModifierState: name => name === "AltGraph" }]) {
    f.press(input, key); assert.equal(f.app.prefs.get("launcherShortcut"), "Alt+O");
  }
  f.press(input, { key: "F", code: "KeyF", altKey: true });
  assert.equal(f.app.prefs.get("launcherShortcut"), "Alt+O");
  assert.equal(input.dataset.recording, "true");
  f.press(input, { key: "K", code: "KeyK", ctrlKey: true, altKey: true });
  assert.equal(f.app.prefs.get("launcherShortcut"), "Accel+Alt+K");
});

test("recording supports platform accelerators, named keys and functional keys", t => {
  const f = preferenceFixture(t); globalThis.Zotero.isMac = true;
  const input = f.field("launcherShortcut"); f.fire(input, "click");
  f.press(input, { key: "L", code: "KeyL", metaKey: true, shiftKey: true });
  assert.equal(f.app.prefs.get("launcherShortcut"), "Accel+Shift+L"); assert.equal(input.value, "Cmd+Shift+L");
  f.fire(input, "click"); f.press(input, { key: " ", code: "Space", metaKey: true });
  assert.equal(f.app.prefs.get("launcherShortcut"), "Accel+Space");
  f.fire(input, "click"); f.press(input, { key: "Home", code: "Home", ctrlKey: true });
  assert.equal(f.app.prefs.get("launcherShortcut"), "Control+Home");
  f.fire(input, "click"); f.press(input, { key: "F12", code: "F12" });
  assert.equal(f.app.prefs.get("launcherShortcut"), "F12");
});

test("clicking the tabs shortcut preserves its independent Alt chord until one is recorded", t => {
  const f = preferenceFixture(t), input = f.field("tabsShortcut");
  assert.equal(input.value, "Alt+;");
  assert.match(input.getAttribute("title"), /组合键/u);
  f.fire(input, "click"); f.fire(input, "blur");
  assert.equal(f.app.prefs.get("tabsShortcut"), "Alt+;");
  f.fire(input, "click"); f.press(input, { key: ";", code: "Semicolon", ctrlKey: true, altKey: true });
  assert.equal(f.app.prefs.get("tabsShortcut"), "Accel+Alt+;");
  assert.equal(input.value, "Ctrl+Alt+;");
});

test("the fourth outline shortcut records a chord and participates in duplicate validation", t => {
  const f = preferenceFixture(t), input = f.field("outlineShortcut");
  assert.ok(input.hasAttribute("readonly")); assert.equal(input.value, "Alt+'");
  f.fire(input, "click"); f.press(input, { key: "O", code: "KeyO", altKey: true });
  assert.equal(f.app.prefs.get("outlineShortcut"), "Alt+'"); assert.equal(input.dataset.recording, "true");
  f.press(input, { key: "O", code: "KeyO", altKey: true, shiftKey: true }); assert.equal(f.app.prefs.get("outlineShortcut"), "Alt+Shift+O");
  assert.throws(() => f.app.prefs.importConfig({ schemaVersion: 1, settings: { fontSize: 16, outlineShortcut: "Alt+F" } }), /重复/);
  assert.equal(f.app.prefs.get("fontSize"), 14);
  f.fire(input, "click"); f.press(input, { key: "'", code: "Quote", altKey: true });
  assert.equal(f.app.prefs.get("outlineShortcut"), "Alt+'");
});
