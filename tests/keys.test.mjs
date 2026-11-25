import test from "node:test";
import assert from "node:assert/strict";
import { parseShortcut, matchesShortcut, shortcutLabel, shortcutFromEvent } from "../src/keys.mjs";

test("platform accelerators, exact modifiers and physical key work", () => {
  assert.equal(matchesShortcut({ key: "P", code: "KeyP", ctrlKey: true, shiftKey: true }, "Accel+Shift+P"), true);
  assert.equal(matchesShortcut({ key: "P", code: "KeyP", metaKey: true, shiftKey: true }, "Accel+Shift+P", true), true);
  assert.equal(matchesShortcut({ key: "P", code: "KeyP", ctrlKey: true, shiftKey: true, altKey: true }, "Accel+Shift+P"), false);
  assert.equal(matchesShortcut({ key: ";", code: "Semicolon", ctrlKey: true }, "Accel+;"), true);
  assert.equal(matchesShortcut({ key: "‘", code: "Quote", altKey: true }, "Alt+'"), true);
  assert.equal(matchesShortcut({ key: "'", code: "Quote", altKey: true }, "Alt+‘"), true);
});
test("typing, composition and AltGr cannot activate commands", () => {
  assert.throws(() => parseShortcut("P"));
  assert.throws(() => parseShortcut("Ctrl+P+Q"));
  assert.equal(matchesShortcut({ code: "KeyP", ctrlKey: true, shiftKey: true, isComposing: true }, "Accel+Shift+P"), false);
  assert.equal(matchesShortcut({ code: "KeyP", ctrlKey: true, altKey: true, getModifierState: () => true }, "Ctrl+Alt+P"), false);
  for (const properties of [{ keyCode: 229 }, { key: "Dead" }, { key: "Process" }]) {
    assert.equal(matchesShortcut({ code: "KeyP", ctrlKey: true, ...properties }, "Ctrl+P"), false);
  }
});

test("parsed shortcuts and named key aliases match their native keycodes", () => {
  for (const [key, value] of [["Enter", "Control+Return"], ["Escape", "Control+Esc"], ["Delete", "Control+Del"], [" ", "Control+Space"]]) {
    assert.equal(matchesShortcut({ key, ctrlKey: true }, parseShortcut(value)), true);
  }
  assert.equal(matchesShortcut({ key: "1", code: "Digit1", ctrlKey: true }, parseShortcut("Control+1")), true);
  assert.equal(matchesShortcut({ key: ";", code: "Semicolon", metaKey: true }, parseShortcut("Accel+;", true), true), true);
});

test("shortcut labels display the recorded keys without punctuation descriptions", () => {
  assert.equal(shortcutLabel("Accel+;"), "Ctrl+;");
  assert.equal(shortcutLabel("Accel+;", true), "Cmd+;");
  assert.equal(shortcutLabel("Alt+;"), "Alt+;");
  assert.equal(shortcutLabel("Control+Alt+;"), "Ctrl+Alt+;");
  assert.equal(shortcutLabel("Accel+Shift+P"), "Ctrl+Shift+P");
});

test("shifted punctuation maps to the same physical combination whether recorded as a key or a symbol", () => {
  assert.deepEqual(parseShortcut("Alt+#"), parseShortcut("Alt+Shift+3"));
  assert.equal(matchesShortcut({ key: "#", code: "Digit3", altKey: true, shiftKey: true }, "Alt+#"), true);
  assert.equal(matchesShortcut({ key: "3", code: "Digit3", altKey: true }, "Alt+#"), false);
  assert.equal(matchesShortcut({ key: "?", code: "Slash", altKey: true, shiftKey: true }, "Alt+?"), true);
  assert.deepEqual(parseShortcut("Alt+{"), parseShortcut("Alt+Shift+["));
  assert.equal(matchesShortcut({ key: "{", code: "BracketLeft", altKey: true, shiftKey: true }, "Alt+{"), true);
  assert.equal(matchesShortcut({ key: "}", code: "BracketRight", altKey: true, shiftKey: true }, "Alt+}"), true);
  assert.equal(matchesShortcut({ key: "~", code: "Backquote", altKey: true, shiftKey: true }, "Alt+~"), true);
  assert.equal(matchesShortcut({ key: "<", code: "Comma", altKey: true, shiftKey: true }, "Alt+<"), true);
  assert.equal(matchesShortcut({ key: ">", code: "Period", altKey: true, shiftKey: true }, "Alt+>"), true);
  assert.equal(matchesShortcut({ key: "|", code: "Backslash", altKey: true, shiftKey: true }, "Alt+|"), true);
  assert.equal(matchesShortcut({ key: "_", code: "Minus", altKey: true, shiftKey: true }, "Alt+_"), true);
  assert.equal(matchesShortcut({ key: ":", code: "Semicolon", altKey: true, shiftKey: true }, "Alt+:"), true);
  assert.equal(shortcutFromEvent({ key: "{", code: "BracketLeft", altKey: true, shiftKey: true }), "Alt+Shift+[");
  assert.equal(shortcutFromEvent({ key: "~", code: "Backquote", altKey: true, shiftKey: true }), "Alt+Shift+`");
  assert.equal(matchesShortcut({ key: "“", code: "BracketLeft", altKey: true, shiftKey: true, getModifierState: () => true }, "Alt+{", true), true);
  assert.equal(shortcutFromEvent({ key: "“", code: "BracketLeft", altKey: true, shiftKey: true, getModifierState: () => true }, true), "Alt+Shift+[");
});

test("macOS Option reported as AltGraph still matches and records the configured physical chord", () => {
  const event = { key: "Ï", code: "KeyF", altKey: true, shiftKey: true, getModifierState: name => name === "AltGraph" };
  assert.equal(matchesShortcut(event, "Option+Shift+F", true), true);
  assert.equal(shortcutFromEvent(event, true), "Alt+Shift+F");
  assert.equal(matchesShortcut({ ...event, code: "" , keyCode: 70 }, "Alt+Shift+F", true), true);
  assert.equal(matchesShortcut(event, "Alt+Shift+F", false), false);
  assert.equal(matchesShortcut({ ...event, isComposing: true }, "Alt+Shift+F", true), false);
});
