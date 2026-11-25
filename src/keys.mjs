// SPDX-License-Identifier: AGPL-3.0-or-later
import { t } from "./i18n.mjs";
const aliases = { ctrl: "Control", control: "Control", cmd: "Meta", command: "Meta", meta: "Meta", option: "Alt", alt: "Alt", shift: "Shift", accel: "Accel" };
export const shiftedKeys = Object.freeze({ "~": "`", "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0", "_": "-", ":": ";", '"': "'", "<": ",", ">": ".", "?": "/", "{": "[", "}": "]", "|": "\\" });
export const codeKeys = Object.freeze({ Semicolon: ";", Quote: "'", Slash: "/", BracketLeft: "[", BracketRight: "]", Backquote: "`", Comma: ",", Period: ".", Minus: "-", Equal: "=", Backslash: "\\" });
export const isAltGr = (event, isMac = false) => !isMac && !!event.getModifierState?.("AltGraph");

export function parseShortcut(value, isMac = false) {
  const parts = String(value).split("+").map(s => s.trim()).filter(Boolean);
  const result = { ctrl: false, meta: false, alt: false, shift: false, key: "" };
  for (const part of parts) {
    const modifier = aliases[part.toLowerCase()];
    if (modifier === "Control") result.ctrl = true;
    else if (modifier === "Meta") result.meta = true;
    else if (modifier === "Alt") result.alt = true;
    else if (modifier === "Shift") result.shift = true;
    else if (modifier === "Accel") result[isMac ? "meta" : "ctrl"] = true;
    else if (!result.key) result.key = /^[‘’]$/u.test(part) ? "'" : part.length === 1 ? part.toLowerCase() : part;
    else throw new Error(t("快捷键只能包含一个按键"));
  }
  if (!result.key || (!result.ctrl && !result.meta && !result.alt && !/^F\d{1,2}$/.test(result.key))) {
    throw new Error(t("快捷键需要 Ctrl/Cmd/Alt 或功能键，避免拦截正常输入"));
  }
  if (Object.hasOwn(shiftedKeys, result.key)) { result.key = shiftedKeys[result.key]; result.shift = true; }
  return result;
}

export function shortcutFromEvent(event, isMac = false) {
  if (event.repeat || event.isComposing || event.keyCode === 229 || isAltGr(event, isMac)
    || ["Control", "Shift", "Alt", "Meta", "OS", "AltGraph", "Dead", "Process", "Unidentified"].includes(event.key)) return null;
  const code = event.code || (event.altKey && event.keyCode >= 65 && event.keyCode <= 90 ? "Key" + String.fromCharCode(event.keyCode) : "");
  let key = /^Key[A-Z]$/u.test(code) ? code.slice(3) : /^Digit\d$/u.test(code) ? code.slice(5) : Object.hasOwn(codeKeys, code) ? codeKeys[code] : event.key;
  if (code === "Space" || key === " ") key = "Space";
  const value = [event.ctrlKey && (isMac ? "Control" : "Accel"), event.metaKey && (isMac ? "Accel" : "Meta"),
    event.altKey && "Alt", event.shiftKey && "Shift", key].filter(Boolean).join("+");
  parseShortcut(value, isMac); return value;
}

export function matchesShortcut(event, value, isMac = false) {
  if (event.isComposing || event.keyCode === 229 || isAltGr(event, isMac) || ["Dead", "Process", "Unidentified"].includes(event.key)) return false;
  let shortcut;
  try { shortcut = typeof value === "string" ? parseShortcut(value, isMac) : value; } catch { return false; }
  if (!shortcut?.key) return false;
  const code = event.code || (event.altKey && event.keyCode >= 65 && event.keyCode <= 90 ? "Key" + String.fromCharCode(event.keyCode) : "");
  let key = code.startsWith("Key") ? code.slice(3).toLowerCase() : Object.hasOwn(codeKeys, code) ? codeKeys[code] : String(event.key ?? "");
  if (code === "Space") key = "Space";
  if (code.startsWith("Digit")) key = code.slice(5);
  if (key.length === 1 && Object.hasOwn(shiftedKeys, key)) key = shiftedKeys[key];
  if (key.length === 1) key = key.toLowerCase();
  const names = { return: "enter", esc: "escape", del: "delete", " ": "space" };
  const expected = shortcut.key.toLowerCase(), actual = key.toLowerCase();
  return (names[expected] || expected) === (names[actual] || actual)
    && shortcut.ctrl === !!event.ctrlKey && shortcut.meta === !!event.metaKey
    && shortcut.alt === !!event.altKey && shortcut.shift === !!event.shiftKey;
}

export function shortcutLabel(value, isMac = false) {
  return String(value).replaceAll("Accel", isMac ? "Cmd" : "Ctrl").replaceAll("Control", "Ctrl").replaceAll("Meta", "Cmd");
}

export function findShortcutConflicts(win, value) {
  const isMac = !!globalThis.Zotero?.isMac;
  let wanted;
  try { wanted = parseShortcut(value, isMac); } catch (error) { return [error.message]; }
  const conflicts = [];
  for (const key of win.document.querySelectorAll("key[key]")) {
    if (key.hasAttribute?.("data-qs-key") || key.id?.startsWith("qs-")) continue;
    const modifiers = (key.getAttribute("modifiers") || "").split(/[\s,]+/).filter(Boolean);
    const shortcut = [...modifiers.map(m => m === "accel" ? "Accel" : m), key.getAttribute("key")].join("+");
    try {
      const parsed = parseShortcut(shortcut, isMac);
      if (JSON.stringify(parsed) === JSON.stringify(wanted)) conflicts.push(key.id || key.getAttribute("command") || "已注册快捷键");
    } catch { /* Native unmodified keys do not conflict with launcher shortcuts. */ }
  }
  return conflicts;
}
