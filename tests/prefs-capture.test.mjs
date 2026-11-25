import test from "node:test";
import assert from "node:assert/strict";
import { renderPreferences } from "../src/prefs.mjs";
import { hotkeyFromShortcut } from "../src/global-hotkey.mjs";
import { preferenceFixture } from "./fixtures/preferences.mjs";

async function settings(t, isMac) {
  const fixture = preferenceFixture(t);
  await fixture.root.qsFlushCredential(true);
  Object.assign(globalThis.Zotero, { isMac, isWin: !isMac });
  renderPreferences(fixture.win, fixture.app);
  return fixture;
}

test("the actual macOS global-shortcut recorder keeps physical Control and Command distinct", async t => {
  const fixture = await settings(t, true), input = fixture.field("globalShortcut");
  assert.ok(!input.disabled);
  for (const [modifier, stored, displayed, carbon] of [
    ["ctrlKey", "Control+Alt+O", "Ctrl+Alt+O", 4096 | 2048],
    ["metaKey", "Accel+Alt+O", "Cmd+Alt+O", 256 | 2048],
  ]) {
    fixture.fire(input, "click");
    const event = fixture.press(input, { key: "œ", code: "KeyO", ctrlKey: false, metaKey: false, altKey: true, shiftKey: false, [modifier]: true });
    assert.equal(event.defaultPrevented, true);
    assert.equal(fixture.app.prefs.get("globalShortcut"), stored);
    assert.equal(input.value, displayed);
    assert.equal(hotkeyFromShortcut(stored, true).modifiers, carbon);
    assert.equal(input.dataset.recording, undefined);
  }
});

test("the actual Windows global-shortcut recorder preserves Control recording and display", async t => {
  const fixture = await settings(t, false), input = fixture.field("globalShortcut");
  fixture.fire(input, "click");
  fixture.press(input, { key: "o", code: "KeyO", ctrlKey: true, metaKey: false, altKey: true, shiftKey: false });
  assert.equal(fixture.app.prefs.get("globalShortcut"), "Accel+Alt+O");
  assert.equal(input.value, "Ctrl+Alt+O");
  assert.equal(hotkeyFromShortcut(input.value, false).modifiers, 0x0002 | 0x0001 | 0x4000);
});
