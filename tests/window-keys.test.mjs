import test from "node:test";
import assert from "node:assert/strict";
import { installWindowKeys, keyAttributes } from "../src/window-keys.mjs";
import { findShortcutConflicts, parseShortcut } from "../src/keys.mjs";

// Models XUL registration and command dispatch only, not trusted keyboard delivery.
class Element {
  constructor(name) { this.localName = name; this.attributes = new Map(); this.children = []; this.listeners = new Map(); }
  get id() { return this.getAttribute("id") || ""; }
  set id(value) { this.setAttribute("id", value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  append(...elements) { for (const element of elements) { element.remove(); this.children.push(element); element.parentNode = this; } }
  remove() { if (this.parentNode) { this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; } }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  removeEventListener(type, fn) { if (this.listeners.get(type) === fn) this.listeners.delete(type); }
  command(sourceEvent, defaultPrevented = false) {
    const event = { sourceEvent, defaultPrevented, stopped: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
    this.listeners.get("command")?.(event); return event;
  }
}
function windowFixture(windowtype = "zotero:main") {
  const root = new Element("window"); root.setAttribute("windowtype", windowtype);
  const all = () => { const result = []; const visit = element => { result.push(element); element.children.forEach(visit); }; visit(root); return result; };
  const document = { documentElement: root, createXULElement: name => new Element(name),
    getElementById: id => all().find(element => element.id === id) || null,
    querySelectorAll: selector => all().filter(element => element.localName === "key" && (selector !== "key[key]" || element.hasAttribute("key"))) };
  const mainKeyset = new Element("keyset"); mainKeyset.id = "mainKeyset"; root.append(mainKeyset);
  const win = new EventTarget();
  return Object.assign(win, { document, key(id, attributes) { const key = new Element("key"); key.id = id;
    for (const [name, value] of Object.entries(attributes)) key.setAttribute(name, value);
    mainKeyset.append(key); return key; } });
}
function setup({ reader = false, isMac = false } = {}) {
  const main = windowFixture();
  const advanced = main.key("key_advancedSearch", { key: "F", modifiers: "accel,shift", oncommand: "nativeAdvanced()" });
  const tabs = main.key("key_showTabsMenu", { key: ";", modifiers: "accel", command: "cmd_showTabsMenu", disabled: "false" });
  const win = reader ? windowFixture("zotero:reader") : main;
  globalThis.Zotero = { isMac, getMainWindow: () => main };
  const settings = { launcherShortcut: "Accel+Shift+P", advancedShortcut: "Accel+Shift+F", tabsShortcut: "native", outlineShortcut: "Alt+'" };
  const prefs = { get: name => settings[name] }, calls = [];
  const callbacks = Object.fromEntries(["items", "advanced", "tabs", "outline"].map(name => [name, event => { calls.push({ name, event }); }]));
  return { win, main, advanced, tabs, settings, prefs, calls, callbacks, get: id => win.document.getElementById(id) };
}

test("main window has complete reserved XUL keys and preserves native tabs and commands", () => {
  const f = setup(), manager = installWindowKeys(f.win, f.prefs, f.callbacks);
  assert.deepEqual(f.get("qs-window-keys").children.map(key => key.id), ["qs-key-items", "qs-key-advanced", "qs-key-outline", "qs-key-directories"]);
  assert.equal(f.get("qs-window-commands").children.length, 4);
  for (const key of f.get("qs-window-keys").children) {
    assert.equal(key.getAttribute("reserved"), "true"); assert.equal(key.hasAttribute("data-qs-key"), true);
    assert.equal(key.hasAttribute("oncommand"), false); assert.ok(f.get(key.getAttribute("command")));
  }
  assert.equal(f.get("qs-key-items").getAttribute("modifiers"), "control,shift");
  assert.equal(f.advanced.getAttribute("disabled"), "true");
  assert.equal(f.advanced.getAttribute("oncommand"), "nativeAdvanced()");
  assert.equal(f.tabs.getAttribute("disabled"), "false"); assert.equal(f.get("qs-key-tabs"), null);
  manager.destroy(); assert.equal(f.advanced.getAttribute("disabled"), null); assert.equal(f.get("qs-window-keys"), null);
});

test("reader native tabs copies the main window's actual chord without changing the main key", () => {
  const f = setup({ reader: true }); f.tabs.setAttribute("key", "T"); f.tabs.setAttribute("modifiers", "accel,alt");
  const manager = installWindowKeys(f.win, f.prefs, f.callbacks);
  assert.equal(f.get("qs-key-tabs").getAttribute("key"), "T");
  assert.equal(f.get("qs-key-tabs").getAttribute("modifiers"), "control,alt");
  assert.equal(f.tabs.getAttribute("disabled"), "false");
  assert.equal(f.advanced.getAttribute("disabled"), null); manager.destroy();
});

test("reader native tabs falls back to Accel semicolon when the main key is unavailable", () => {
  const f = setup({ reader: true, isMac: true }); globalThis.Zotero.getMainWindow = () => null;
  const manager = installWindowKeys(f.win, f.prefs, f.callbacks);
  assert.equal(f.get("qs-key-tabs").getAttribute("key"), ";");
  assert.equal(f.get("qs-key-tabs").getAttribute("modifiers"), "meta"); manager.destroy();
});

test("reader copies native keycodes and disables a matching local keycode binding", () => {
  const f = setup({ reader: true }); f.tabs.removeAttribute("key"); f.tabs.setAttribute("keycode", "VK_F10");
  const local = f.win.key("key_otherTabs", { keycode: "VK_F10", modifiers: "accel", disabled: "false" });
  const manager = installWindowKeys(f.win, f.prefs, f.callbacks);
  assert.equal(f.get("qs-key-tabs").getAttribute("keycode"), "VK_F10"); assert.equal(local.getAttribute("disabled"), "true");
  assert.equal(f.tabs.getAttribute("disabled"), "false"); manager.destroy(); assert.equal(local.getAttribute("disabled"), "false");
});

test("reader preserves the native semicolon keycode rather than converting it to a character", () => {
  const f = setup({ reader: true }); f.tabs.removeAttribute("key"); f.tabs.setAttribute("keycode", "VK_SEMICOLON");
  const manager = installWindowKeys(f.win, f.prefs, f.callbacks);
  assert.equal(f.get("qs-key-tabs").getAttribute("keycode"), "VK_SEMICOLON");
  assert.equal(f.get("qs-key-tabs").hasAttribute("key"), false); manager.destroy();
});

test("refresh replaces complete sets, restores previous collisions and preserves prior disabled state", () => {
  const f = setup(), second = f.win.key("key_other", { key: "G", modifiers: "accel,shift", disabled: "false" });
  const alreadyDisabled = f.win.key("key_disabled", { key: "F", modifiers: "accel,shift", disabled: "true" });
  const duplicate = f.win.key("key_duplicate", { key: "F", modifiers: "shift,control" });
  const manager = installWindowKeys(f.win, f.prefs, f.callbacks), oldSet = f.get("qs-window-keys");
  assert.equal(duplicate.getAttribute("disabled"), "true");
  f.settings.advancedShortcut = "Accel+Shift+G"; manager.refresh();
  assert.equal(oldSet.parentNode, null); assert.notEqual(f.get("qs-window-keys"), oldSet);
  assert.equal(f.advanced.getAttribute("disabled"), null); assert.equal(duplicate.getAttribute("disabled"), null);
  assert.equal(alreadyDisabled.getAttribute("disabled"), "true"); assert.equal(second.getAttribute("disabled"), "true");
  manager.destroy(); assert.equal(second.getAttribute("disabled"), "false");
  manager.destroy(); manager.refresh(); assert.equal(f.get("qs-window-keys"), null);
});

test("cleanup restores only owned disabled changes and leaves later key, modifier and command changes", () => {
  const f = setup(), second = f.win.key("key_duplicate", { key: "F", modifiers: "accel,shift" });
  const manager = installWindowKeys(f.win, f.prefs, f.callbacks);
  f.advanced.setAttribute("key", "H"); f.advanced.setAttribute("modifiers", "alt"); f.advanced.setAttribute("oncommand", "otherPlugin()");
  second.setAttribute("disabled", "false");
  manager.destroy();
  assert.equal(f.advanced.getAttribute("key"), "H"); assert.equal(f.advanced.getAttribute("modifiers"), "alt");
  assert.equal(f.advanced.getAttribute("oncommand"), "otherPlugin()"); assert.equal(f.advanced.getAttribute("disabled"), null);
  assert.equal(second.getAttribute("disabled"), "false");
});

test("command callbacks guard composition, AltGraph and cancelled events and honor false returns", () => {
  const f = setup(); f.settings.tabsShortcut = "Accel+;";
  const manager = installWindowKeys(f.win, f.prefs, f.callbacks), command = f.get("qs-command-items");
  command.command({ isComposing: true }); command.command({ getModifierState: value => value === "AltGraph" }); command.command({}, true);
  assert.equal(f.calls.length, 0);
  const event = command.command({}); assert.equal(f.calls[0].event, event); assert.equal(event.defaultPrevented, true); assert.equal(event.stopped, true);
  f.get("qs-command-advanced").command({}); f.get("qs-command-tabs").command({});
  assert.deepEqual(f.calls.map(call => call.name), ["items", "advanced", "tabs"]);
  f.callbacks.items = () => false;
  const ignored = command.command({}); assert.equal(ignored.defaultPrevented, false); assert.equal(ignored.stopped, false);
  manager.destroy(); assert.equal(f.tabs.getAttribute("disabled"), "false");
  const callCount = f.calls.length; command.command({}); assert.equal(f.calls.length, callCount); assert.equal(command.listeners.size, 0);
});

test("named keys and functional keys use keycodes and platform-aware modifiers", () => {
  const f = setup({ isMac: true }); f.settings.launcherShortcut = "Accel+Space"; f.settings.advancedShortcut = "F12"; f.settings.tabsShortcut = "Alt+ArrowDown";
  const manager = installWindowKeys(f.win, f.prefs, f.callbacks);
  assert.equal(f.get("qs-key-items").getAttribute("keycode"), "VK_SPACE"); assert.equal(f.get("qs-key-items").getAttribute("modifiers"), "meta");
  assert.equal(f.get("qs-key-advanced").getAttribute("keycode"), "VK_F12"); assert.equal(f.get("qs-key-advanced").getAttribute("modifiers"), "");
  assert.equal(f.get("qs-key-tabs").getAttribute("keycode"), "VK_DOWN"); manager.destroy();
});

test("unsupported native named keys are ignored while invalid preferences preserve existing keys", () => {
  const f = setup(); f.win.key("key_unknown", { keycode: "VK_CONTEXT_MENU", modifiers: "control" });
  const manager = installWindowKeys(f.win, f.prefs, f.callbacks), oldSet = f.get("qs-window-keys");
  f.settings.launcherShortcut = "Ctrl+UnknownKey"; assert.throws(() => manager.refresh(), /不支持/u);
  for (const value of ["Ctrl+constructor", "Ctrl+__proto__", "F25"]) assert.throws(() => keyAttributes(parseShortcut(value)), /不支持/u);
  assert.equal(f.get("qs-window-keys"), oldSet); assert.equal(f.advanced.getAttribute("disabled"), "true"); manager.destroy();
});

test("duplicate configured chords have one owner and conflict reporting excludes only owned keys", () => {
  const f = setup(); f.settings.advancedShortcut = f.settings.launcherShortcut;
  const manager = installWindowKeys(f.win, f.prefs, f.callbacks);
  assert.deepEqual(f.get("qs-window-keys").children.map(key => key.id), ["qs-key-items", "qs-key-outline", "qs-key-directories"]);
  assert.deepEqual(findShortcutConflicts(f.win, "Accel+Shift+P"), []);
  assert.deepEqual(findShortcutConflicts(f.win, "Accel+Shift+F"), ["key_advancedSearch"]);
  manager.destroy();
});

test("priority keydown consumes a configured Alt chord before other handlers and activates once", () => {
  const f = setup(); f.settings.launcherShortcut = "Alt+F";
  const manager = installWindowKeys(f.win, f.prefs, f.callbacks);
  let otherCalls = 0;
  f.win.addEventListener("keydown", () => { otherCalls++; });
  const event = new Event("keydown", { cancelable: true }); Object.assign(event, { key: "f", code: "KeyF", altKey: true });
  f.win.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(otherCalls, 0);
  assert.deepEqual(f.calls.map(call => call.name), ["items"]);
  const press = new Event("keypress", { cancelable: true }); Object.assign(press, { key: "f", code: "KeyF", altKey: true });
  f.win.dispatchEvent(press);
  assert.equal(press.defaultPrevented, true); assert.equal(f.calls.length, 1);
  f.get("qs-command-items").command(event);
  assert.equal(f.calls.length, 1);
  const repeat = new Event("keydown", { cancelable: true }); Object.assign(repeat, { key: "f", code: "KeyF", altKey: true, repeat: true });
  f.win.dispatchEvent(repeat); assert.equal(repeat.defaultPrevented, true); assert.equal(f.calls.length, 1);
  const release = new Event("keyup", { cancelable: true }); Object.assign(release, { key: "Alt", code: "AltLeft" });
  f.win.dispatchEvent(release); assert.equal(release.defaultPrevented, true);
  const nextRelease = new Event("keyup", { cancelable: true }); Object.assign(nextRelease, { key: "Alt", code: "AltLeft" });
  f.win.dispatchEvent(nextRelease); assert.equal(nextRelease.defaultPrevented, false);
  manager.destroy();
  const native = new Event("keydown", { cancelable: true }); Object.assign(native, { key: "f", code: "KeyF", altKey: true });
  f.win.dispatchEvent(native);
  assert.equal(native.defaultPrevented, false); assert.equal(otherCalls, 1);
});

test("priority shortcut processing ignores composition and lets refused commands continue", () => {
  const f = setup(); f.settings.launcherShortcut = "Alt+F";
  const manager = installWindowKeys(f.win, f.prefs, f.callbacks);
  for (const properties of [{ isComposing: true }, { keyCode: 229 }, { getModifierState: () => true }, { repeat: true }]) {
    const event = new Event("keydown", { cancelable: true }); Object.assign(event, { key: "f", code: "KeyF", altKey: true, ...properties });
    f.win.dispatchEvent(event); assert.equal(event.defaultPrevented, false);
  }
  assert.equal(f.calls.length, 0);
  f.callbacks.items = () => false;
  const refused = new Event("keydown", { cancelable: true }); Object.assign(refused, { key: "f", code: "KeyF", altKey: true });
  f.win.dispatchEvent(refused); assert.equal(refused.defaultPrevented, false); manager.destroy();
});

test("native tabs uses priority handling and refreshed bindings retire the former chord", () => {
  const f = setup(), manager = installWindowKeys(f.win, f.prefs, f.callbacks);
  const press = (key, code, props) => { const event = new Event("keydown", { cancelable: true }); Object.assign(event, { key, code, ...props }); f.win.dispatchEvent(event); return event; };
  assert.equal(press(";", "Semicolon", { ctrlKey: true }).defaultPrevented, true);
  assert.equal(f.calls[0].name, "tabs");
  f.settings.launcherShortcut = "Alt+F"; manager.refresh();
  assert.equal(press("P", "KeyP", { ctrlKey: true, shiftKey: true }).defaultPrevented, false);
  assert.equal(press("f", "KeyF", { altKey: true }).defaultPrevented, true);
  assert.equal(f.calls.at(-1).name, "items"); manager.destroy();
});

test("macOS Option plus Shift is claimed before character insertion even when Gecko reports AltGraph", () => {
  const f = setup({ isMac: true }); f.settings.advancedShortcut = "Alt+Shift+F";
  const manager = installWindowKeys(f.win, f.prefs, f.callbacks);
  let textInsertions = 0;
  f.win.addEventListener("keydown", () => textInsertions++);
  const fire = (type, properties) => {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { key: "Ï", code: "KeyF", altKey: true, shiftKey: true, getModifierState: name => name === "AltGraph", ...properties });
    f.win.dispatchEvent(event); return event;
  };
  assert.equal(fire("keydown").defaultPrevented, true);
  assert.equal(fire("keypress").defaultPrevented, true);
  assert.equal(fire("keyup").defaultPrevented, true);
  assert.equal(textInsertions, 0); assert.deepEqual(f.calls.map(call => call.name), ["advanced"]);
  assert.equal(fire("keydown", { isComposing: true }).defaultPrevented, false);
  f.settings.advancedShortcut = "Alt+Shift+G"; manager.refresh();
  assert.equal(fire("keydown").defaultPrevented, false);
  assert.equal(fire("keydown", { key: "˝", code: "KeyG" }).defaultPrevented, true);
  manager.destroy();
  assert.equal(fire("keydown", { key: "˝", code: "KeyG" }).defaultPrevented, false);
});
