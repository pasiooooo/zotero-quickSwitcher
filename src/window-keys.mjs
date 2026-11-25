// SPDX-License-Identifier: AGPL-3.0-or-later
import { isAltGr, matchesShortcut, parseShortcut } from "./keys.mjs";
import { t } from "./i18n.mjs";

const namedKeys = {
  space: "SPACE", tab: "TAB", enter: "RETURN", return: "RETURN", escape: "ESCAPE", esc: "ESCAPE",
  backspace: "BACK", delete: "DELETE", del: "DELETE", insert: "INSERT", home: "HOME", end: "END",
  pageup: "PAGE_UP", pagedown: "PAGE_DOWN", arrowup: "UP", arrowdown: "DOWN", arrowleft: "LEFT", arrowright: "RIGHT",
};
const nativeNames = { BACK: "Backspace", RETURN: "Enter", ESCAPE: "Escape", PAGE_UP: "PageUp", PAGE_DOWN: "PageDown", UP: "ArrowUp", DOWN: "ArrowDown", LEFT: "ArrowLeft", RIGHT: "ArrowRight", SEMICOLON: ";" };

export function nativeShortcut(key, isMac) {
  const code = (key.getAttribute("keycode") || "").replace(/^VK_/u, "");
  let value = key.getAttribute("key") || nativeNames[code] || code;
  if (value === " ") value = "Space";
  if (!value) return null;
  const modifiers = (key.getAttribute("modifiers") || "").split(/[\s,]+/u).filter(Boolean);
  try { return parseShortcut([...modifiers, value].join("+"), isMac); } catch { return null; }
}

// Accepts parseShortcut() output; also validates the key before preferences are written.
export function keyAttributes(shortcut) {
  const value = shortcut.key.toLowerCase();
  const code = (Object.hasOwn(namedKeys, value) ? namedKeys[value] : null) || (/^f(?:[1-9]|1\d|2[0-4])$/u.test(value) ? value.toUpperCase() : null);
  if (!code && shortcut.key.length !== 1) throw new Error(t("不支持的快捷键按键：{key}", { key: shortcut.key }));
  return { ...(code ? { keycode: "VK_" + code } : { key: shortcut.key.toUpperCase() }),
    modifiers: [shortcut.ctrl && "control", shortcut.meta && "meta", shortcut.alt && "alt", shortcut.shift && "shift"].filter(Boolean).join(",") };
}

function sameShortcut(a, b) {
  if (!a || !b) return false;
  try { return JSON.stringify(keyAttributes(a)) === JSON.stringify(keyAttributes(b)); } catch { return false; }
}

export function installWindowKeys(win, prefs, callbacks) {
  const doc = win.document, isMac = !!globalThis.Zotero?.isMac;
  let sets = [], originals = [], listeners = [], bindings = [], claimed = null, destroyed = false;
  const clear = () => {
    for (const [command, handler] of listeners) command.removeEventListener("command", handler);
    listeners = [];
    for (const { key, disabled } of originals) {
      if (key.getAttribute("disabled") !== "true") continue;
      if (disabled === null) key.removeAttribute("disabled"); else key.setAttribute("disabled", disabled);
    }
    originals = [];
    for (const set of sets) set.remove();
    sets = []; bindings = []; claimed = null;
  };
  const refresh = () => {
    if (destroyed) return;
    const nativeKeys = [...doc.querySelectorAll("key")].filter(key => !key.hasAttribute("data-qs-key"));
    const wanted = [{ name: "items", value: prefs.get("launcherShortcut") }, { name: "advanced", value: prefs.get("advancedShortcut") },
      { name: "outline", value: prefs.get("outlineShortcut") || "Alt+'" }, { name: "directories", value: prefs.get("directoryShortcut") || "Alt+/" }];
    if (callbacks.commands) wanted.push({ name: "commands", value: prefs.get("commandShortcut") || "Alt+P" });
    const tabs = prefs.get("tabsShortcut");
    if (tabs !== "native") wanted.push({ name: "tabs", value: tabs });
    else {
      const nativeTabs = doc.getElementById("key_showTabsMenu") || globalThis.Zotero?.getMainWindow?.()?.document.getElementById("key_showTabsMenu");
      const shortcut = nativeTabs && nativeShortcut(nativeTabs, isMac);
      wanted.push(shortcut ? { name: "tabs", shortcut, nativeMain: doc.documentElement.getAttribute("windowtype") !== "zotero:reader" && !!doc.getElementById("key_showTabsMenu"),
        nativeKeycode: !nativeTabs.getAttribute("key") && nativeTabs.getAttribute("keycode") } : { name: "tabs", value: "Accel+;" });
    }
    const next = wanted.map(binding => ({ ...binding, shortcut: binding.shortcut || parseShortcut(binding.value, isMac) }));
    const commandset = doc.createXULElement("commandset"), keyset = doc.createXULElement("keyset"), seen = new Set();
    commandset.id = "qs-window-commands"; keyset.id = "qs-window-keys";
    const prepared = [], preparedListeners = [], active = [];
    for (const binding of next) {
      const { name, shortcut, nativeKeycode, nativeMain } = binding;
      const attributes = keyAttributes(shortcut), signature = JSON.stringify(attributes);
      if (seen.has(signature)) continue;
      seen.add(signature); active.push(binding);
      if (nativeMain) continue;
      if (nativeKeycode) { delete attributes.key; attributes.keycode = nativeKeycode; }
      const command = doc.createXULElement("command"), key = doc.createXULElement("key");
      command.id = `qs-command-${name}`; key.id = `qs-key-${name}`;
      key.setAttribute("data-qs-key", ""); key.setAttribute("reserved", "true"); key.setAttribute("command", command.id);
      for (const [attribute, value] of Object.entries(attributes)) key.setAttribute(attribute, value);
      const handler = event => {
        const source = event.sourceEvent || event;
        if (event.defaultPrevented || source.defaultPrevented || source.repeat || source.isComposing || source.keyCode === 229 || isAltGr(source, isMac)) return;
        if (callbacks[name](event) !== false) { event.preventDefault(); event.stopPropagation(); }
      };
      command.addEventListener("command", handler); preparedListeners.push([command, handler]);
      commandset.append(command); keyset.append(key); prepared.push(shortcut);
    }
    clear();
    try {
      for (const key of nativeKeys) {
        const shortcut = nativeShortcut(key, isMac);
        if (!shortcut || !prepared.some(wanted => sameShortcut(shortcut, wanted)) || key.getAttribute("disabled") === "true") continue;
        originals.push({ key, disabled: key.getAttribute("disabled") }); key.setAttribute("disabled", "true");
      }
      listeners = preparedListeners; sets = [commandset, keyset]; doc.documentElement.append(commandset, keyset); bindings = active;
    } catch (error) { clear(); throw error; }
  };
  const consume = event => { event.preventDefault(); event.stopImmediatePropagation(); };
  const capture = event => {
    if (event.isComposing || event.keyCode === 229 || isAltGr(event, isMac) || event.target?.closest?.(".qs-shortcut-input")) return;
    const sameKey = claimed && (claimed.code ? event.code === claimed.code : event.key === claimed.key);
    if (event.type !== "keydown") {
      if (!sameKey && !(event.type === "keyup" && event.key === "Alt" && claimed?.shortcut.alt)) return;
      consume(event);
      if (event.type === "keyup" && (event.key === "Alt" || !claimed.shortcut.alt)) claimed = null;
      return;
    }
    if (event.repeat) { if (sameKey) consume(event); return; }
    const binding = bindings.find(({ shortcut }) => matchesShortcut(event, shortcut, isMac));
    if (!binding) { if (!["Control", "Shift", "Alt", "Meta"].includes(event.key)) claimed = null; return; }
    if (callbacks[binding.name](event) === false) return;
    claimed = { ...binding, code: event.code, key: event.key };
    consume(event);
  };
  const blur = () => { claimed = null; };
  refresh();
  // Window capture precedes document plugin handlers and the native Alt menu access keys.
  for (const type of ["keydown", "keypress", "keyup"]) win.addEventListener(type, capture, true);
  win.addEventListener("blur", blur);
  return { refresh, destroy() { if (!destroyed) {
    destroyed = true; clear();
    for (const type of ["keydown", "keypress", "keyup"]) win.removeEventListener(type, capture, true);
    win.removeEventListener("blur", blur);
  } } };
}
