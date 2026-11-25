// SPDX-License-Identifier: AGPL-3.0-or-later
import { parseShortcut } from "./keys.mjs";
import { t } from "./i18n.mjs";

const SIGNATURE = 0x51537774, HOTKEY_ID = 1, NOT_HANDLED = -9874;
const KEYBOARD = 0x6b657962, PRESSED = 5, RELEASED = 6;
const DIRECT_OBJECT = 757935405, HOTKEY_TYPE = 1751869796;
// shortcut: ANSI physical positions, not translated characters; use UCKeyTranslate if alternate keyboard layouts need character-based registration.
const keyCodes = Object.freeze({ __proto__: null,
  a: 0x00, s: 0x01, d: 0x02, f: 0x03, h: 0x04, g: 0x05, z: 0x06, x: 0x07, c: 0x08, v: 0x09, b: 0x0b,
  q: 0x0c, w: 0x0d, e: 0x0e, r: 0x0f, y: 0x10, t: 0x11, "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15,
  "6": 0x16, "5": 0x17, "=": 0x18, "9": 0x19, "7": 0x1a, "-": 0x1b, "8": 0x1c, "0": 0x1d, "]": 0x1e,
  o: 0x1f, u: 0x20, "[": 0x21, i: 0x22, p: 0x23, l: 0x25, j: 0x26, "'": 0x27, k: 0x28, ";": 0x29,
  "\\": 0x2a, ",": 0x2b, "/": 0x2c, n: 0x2d, m: 0x2e, ".": 0x2f, "`": 0x32,
  enter: 0x24, return: 0x24, tab: 0x30, space: 0x31, backspace: 0x33, escape: 0x35, esc: 0x35,
  delete: 0x75, del: 0x75, insert: 0x72, home: 0x73, pageup: 0x74, end: 0x77, pagedown: 0x79,
  arrowleft: 0x7b, arrowright: 0x7c, arrowdown: 0x7d, arrowup: 0x7e,
  f1: 0x7a, f2: 0x78, f3: 0x63, f4: 0x76, f5: 0x60, f6: 0x61, f7: 0x62, f8: 0x64, f9: 0x65,
  f10: 0x6d, f11: 0x67, f12: 0x6f, f13: 0x69, f14: 0x6b, f15: 0x71, f16: 0x6a, f17: 0x40, f18: 0x4f, f19: 0x50, f20: 0x5a,
});

export function macHotkeyFromShortcut(value) {
  const chord = parseShortcut(value, true), key = chord.key.toLowerCase();
  if (!Object.hasOwn(keyCodes, key)) throw new Error(t("不支持的快捷键按键：{key}", { key: chord.key }));
  return { keyCode: keyCodes[key], modifiers: (chord.meta ? 256 : 0) | (chord.shift ? 512 : 0) | (chord.alt ? 2048 : 0) | (chord.ctrl ? 4096 : 0) };
}

// AppKit desktop points have a bottom-up Y axis; Gecko positions use device pixels.
export function macScreenBounds(point, screens) {
  if (!point || !Array.isArray(screens) || !screens.length) return null;
  const contains = ({ frame }) => point.x >= frame.x && point.x < frame.x + frame.width && point.y >= frame.y && point.y < frame.y + frame.height;
  const screen = screens.find(contains);
  if (!screen) return null;
  const { visibleFrame: visible, scale } = screen, primaryHeight = screens[0].frame.height;
  if (![point.x, point.y, visible.x, visible.y, visible.width, visible.height, primaryHeight, scale].every(Number.isFinite)
    || visible.width <= 0 || visible.height <= 0 || scale <= 0) return null;
  const left = Math.round(visible.x * scale), top = Math.round((primaryHeight - visible.y - visible.height) * scale);
  return { left, top, width: Math.round((visible.x + visible.width) * scale) - left,
    height: Math.round((primaryHeight - visible.y) * scale) - top, scale };
}

const nativeError = (name, code) => Object.assign(new Error(`${name} failed (OSStatus ${code})`), { code });
const number = value => Number(value.toString());

export function macTopmostWindow(C, window, alive = () => true) {
  const library = C.open("/usr/lib/libobjc.A.dylib"), abi = C.default_abi;
  try {
    const selector = library.declare("sel_registerName", abi, C.voidptr_t, C.char.ptr);
    const responds = library.declare("objc_msgSend", abi, C.bool, C.voidptr_t, C.voidptr_t, C.voidptr_t);
    const object = library.declare("objc_msgSend", abi, C.voidptr_t, C.voidptr_t, C.voidptr_t);
    const level = library.declare("objc_msgSend", abi, C.intptr_t, C.voidptr_t, C.voidptr_t);
    const setLevel = library.declare("objc_msgSend", abi, C.void_t, C.voidptr_t, C.voidptr_t, C.intptr_t);
    const order = library.declare("objc_msgSend", abi, C.void_t, C.voidptr_t, C.voidptr_t);
    const levelSelector = selector("setLevel:"), respondsSelector = selector("respondsToSelector:");
    if (!responds(window, respondsSelector, levelSelector) && responds(window, respondsSelector, selector("window"))) window = object(window, selector("window"));
    if (window.isNull() || !responds(window, respondsSelector, levelSelector)) throw new Error("Native macOS launcher window unavailable");
    const orderSelector = selector("orderFrontRegardless"), original = level(window, selector("level"));
    let restored = false;
    return {
      raise() {
        // Floating-window level stays below AppKit menus and modal panels.
        setLevel(window, levelSelector, C.intptr_t(Math.max(3, number(original))));
        order(window, orderSelector);
      },
      restore() {
        if (restored) return;
        restored = true;
        try { if (alive()) setLevel(window, levelSelector, original); }
        finally { library.close(); }
      },
    };
  } catch (error) { library.close(); throw error; }
}

function createMacAPI() {
  if (!Services.tm.isMainThread) throw new Error("macOS hotkeys require the main thread");
  const { ctypes: C } = ChromeUtils.importESModule("resource://gre/modules/ctypes.sys.mjs");
  const abi = C.default_abi, ptr = C.voidptr_t, u32 = C.uint32_t, i32 = C.int32_t, libraries = [];
  let callback = null, handler = ptr(), hotkey = ptr();
  try {
    const open = path => { const library = C.open(path); libraries.push(library); return library; };
    const carbon = open("/System/Library/Frameworks/Carbon.framework/Carbon");
    open("/System/Library/Frameworks/Foundation.framework/Foundation");
    open("/System/Library/Frameworks/AppKit.framework/AppKit");
    const objc = open("/usr/lib/libobjc.A.dylib");
    const declare = (name, result, ...args) => carbon.declare(name, abi, result, ...args);
    const HotKeyID = C.StructType("QSHotKeyID", [{ signature: u32 }, { id: u32 }]);
    const EventType = C.StructType("QSEventType", [{ eventClass: u32 }, { eventKind: u32 }]);
    const Callback = C.FunctionType(abi, i32, [ptr, ptr, ptr]).ptr;
    const target = declare("GetApplicationEventTarget", ptr)();
    const install = declare("InstallEventHandler", i32, ptr, Callback, u32, EventType.ptr, ptr, ptr.ptr);
    const register = declare("RegisterEventHotKey", i32, u32, u32, HotKeyID, ptr, u32, ptr.ptr);
    const unregister = declare("UnregisterEventHotKey", i32, ptr), remove = declare("RemoveEventHandler", i32, ptr);
    const parameter = declare("GetEventParameter", i32, ptr, u32, u32, u32.ptr, u32, u32.ptr, ptr);
    const eventKind = declare("GetEventKind", u32, ptr), eventClass = declare("GetEventClass", u32, ptr);
    const Point = C.StructType("QSNSPoint", [{ x: C.double }, { y: C.double }]);
    const Size = C.StructType("QSNSSize", [{ width: C.double }, { height: C.double }]);
    const Rect = C.StructType("QSNSRect", [{ origin: Point }, { size: Size }]);
    const classNamed = objc.declare("objc_getClass", abi, ptr, C.char.ptr);
    const selectorNamed = objc.declare("sel_registerName", abi, ptr, C.char.ptr), selectors = new Map();
    const selector = name => { if (!selectors.has(name)) selectors.set(name, selectorNamed(name)); return selectors.get(name); };
    const send = objc.declare("objc_msgSend", abi, ptr, ptr, ptr);
    const sendIndex = objc.declare("objc_msgSend", abi, ptr, ptr, ptr, C.size_t);
    const sendCount = objc.declare("objc_msgSend", abi, C.size_t, ptr, ptr);
    const sendPID = objc.declare("objc_msgSend", abi, i32, ptr, ptr);
    const sendDouble = objc.declare("objc_msgSend", abi, C.double, ptr, ptr);
    const sendPoint = objc.declare("objc_msgSend", abi, Point, ptr, ptr);
    const sendVoid = objc.declare("objc_msgSend", abi, C.void_t, ptr, ptr);
    const architecture = Services.appinfo.XPCOMABI.split("-")[0];
    if (!["x86_64", "aarch64", "arm64"].includes(architecture)) throw new Error("Unsupported macOS architecture: " + architecture);
    const sendRect = architecture === "x86_64"
      ? objc.declare("objc_msgSend_stret", abi, C.void_t, Rect.ptr, ptr, ptr)
      : objc.declare("objc_msgSend", abi, Rect, ptr, ptr);
    const rect = (object, name) => {
      let result;
      if (architecture === "x86_64") { result = Rect(); sendRect(result.address(), object, selector(name)); }
      else result = sendRect(object, selector(name));
      return { x: result.origin.x, y: result.origin.y, width: result.size.width, height: result.size.height };
    };
    const pool = read => {
      const value = send(send(classNamed("NSAutoreleasePool"), selector("alloc")), selector("init"));
      if (value.isNull()) throw new Error("NSAutoreleasePool unavailable");
      try { return read(); } finally { sendVoid(value, selector("drain")); }
    };
    const required = value => { if (value.isNull()) throw new Error("macOS foreground application unavailable"); return value; };
    return {
      install(receive) {
        callback = Callback((next, event, userData) => receive(event), null, NOT_HANDLED);
        const events = EventType.array(2)([EventType(KEYBOARD, PRESSED), EventType(KEYBOARD, RELEASED)]);
        const status = install(target, callback, events.length, events.addressOfElement(0), null, handler.address());
        if (status) throw nativeError("InstallEventHandler", status);
      },
      register({ keyCode, modifiers }) {
        const status = register(keyCode, modifiers, HotKeyID(SIGNATURE, HOTKEY_ID), target, 1, hotkey.address());
        if (status) throw nativeError("RegisterEventHotKey", status);
      },
      readEvent(event) {
        if (eventClass(event) !== KEYBOARD) return null;
        const id = HotKeyID(), status = parameter(event, DIRECT_OBJECT, HOTKEY_TYPE, null, HotKeyID.size, null, id.address());
        if (status) return null;
        return { signature: id.signature, id: id.id, kind: eventKind(event) };
      },
      frontApp() {
        return pool(() => {
          const workspace = required(send(classNamed("NSWorkspace"), selector("sharedWorkspace")));
          const app = required(send(workspace, selector("frontmostApplication")));
          const pid = sendPID(app, selector("processIdentifier"));
          if (pid === Services.appinfo.processID) return { own: true };
          const url = required(send(app, selector("executableURL"))), pathString = required(send(url, selector("path")));
          const chars = required(send(pathString, selector("UTF8String"))), path = C.cast(chars, C.char.ptr).readString();
          const name = path.split("/").at(-1);
          if (!name) return null;
          return { name, path };
        });
      },
      cursorScreen() {
        return pool(() => {
          const point = sendPoint(classNamed("NSEvent"), selector("mouseLocation"));
          const array = send(classNamed("NSScreen"), selector("screens"));
          if (array.isNull()) return null;
          const count = number(sendCount(array, selector("count"))), screens = [];
          if (!Number.isSafeInteger(count) || count < 1 || count > 128) return null;
          for (let index = 0; index < count; index++) {
            const screen = sendIndex(array, selector("objectAtIndex:"), index);
            if (screen.isNull()) return null;
            screens.push({ frame: rect(screen, "frame"), visibleFrame: rect(screen, "visibleFrame"), scale: sendDouble(screen, selector("backingScaleFactor")) });
          }
          return macScreenBounds({ x: point.x, y: point.y }, screens);
        });
      },
      removeHotkey() {
        if (!hotkey.isNull()) { const status = unregister(hotkey); if (status) throw nativeError("UnregisterEventHotKey", status); hotkey = ptr(); }
        // Retain the callback and libraries if removal fails: Carbon can still call this address.
        if (!handler.isNull()) { const status = remove(handler); if (status) throw nativeError("RemoveEventHandler", status); handler = ptr(); }
        callback = null;
      },
      stop() {
        this.removeHotkey();
        for (const library of libraries.splice(0).reverse()) library.close();
      },
    };
  } catch (error) {
    for (const library of libraries.reverse()) { try { library.close(); } catch { /* Finish opening-failure cleanup. */ } }
    throw error;
  }
}

export class MacGlobalHotkey {
  constructor({ apiFactory = createMacAPI, queue = callback => setTimeout(callback, 0) } = {}) {
    this.apiFactory = apiFactory; this.queue = queue; this.api = null; this.sourceApp = null; this.generation = 0;
    this.pending = Promise.resolve(); this.timer = null; this.triggers = new Set(); this.pressed = false;
  }
  start(shortcut, onTrigger, onError = () => {}) {
    const generation = ++this.generation;
    this.clearTimers();
    return this.pending = this.pending.catch(() => {}).then(() => this.release()).then(() => {
      if (generation !== this.generation || !globalThis.Zotero?.isMac) return false;
      const hotkey = shortcut ? macHotkeyFromShortcut(shortcut) : null;
      const api = this.api = this.apiFactory(), current = () => this.api === api && this.generation === generation;
      const report = error => { try { onError(error); } catch { /* Never propagate into Carbon. */ } };
      const track = () => {
        try { const app = api.frontApp(); if (!app?.own) this.sourceApp = app || null; }
        catch { this.sourceApp = null; }
        return this.sourceApp;
      };
      const receive = event => {
        if (!current()) return NOT_HANDLED;
        try {
          const data = api.readEvent(event);
          if (!data || data.signature !== SIGNATURE || data.id !== HOTKEY_ID || ![PRESSED, RELEASED].includes(data.kind)) return NOT_HANDLED;
          if (data.kind === RELEASED) { this.pressed = false; return 0; }
          if (this.pressed) return 0;
          this.pressed = true;
          const source = track(); let screen = null;
          try { screen = api.cursorScreen(); } catch { /* The main window can supply a fallback screen. */ }
          const timer = this.queue(() => {
            this.triggers.delete(timer);
            if (!current()) return;
            try { Promise.resolve(onTrigger(screen, source)).catch(report); } catch (error) { report(error); }
          });
          this.triggers.add(timer);
          return 0;
        } catch (error) { report(error); return NOT_HANDLED; }
      };
      try {
        if (hotkey) { api.install(receive); api.register(hotkey); }
        track();
        this.timer = setInterval(() => { if (current()) track(); }, 250);
        return true;
      } catch (error) {
        error.message += ` (${shortcut})`;
        if (error.code === -9878) {
          try {
            api.removeHotkey(); track();
            this.timer = setInterval(() => { if (current()) track(); }, 250);
            throw error;
          } catch (cleanupError) {
            if (cleanupError === error) throw error;
            report(cleanupError);
          }
        }
        try { api.stop(); this.api = null; } catch (cleanupError) { report(cleanupError); }
        this.sourceApp = null;
        throw error;
      }
    });
  }
  clearTimers() {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    for (const timer of this.triggers) clearTimeout(timer);
    this.triggers.clear(); this.pressed = false;
  }
  release() {
    this.clearTimers(); this.sourceApp = null;
    if (this.api) { this.api.stop(); this.api = null; }
  }
  stop() {
    ++this.generation; this.clearTimers(); this.sourceApp = null;
    return this.pending = this.pending.catch(() => {}).then(() => this.release());
  }
}
