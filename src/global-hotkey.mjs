// SPDX-License-Identifier: AGPL-3.0-or-later
import { parseShortcut } from "./keys.mjs";
import { t } from "./i18n.mjs";
import { MacGlobalHotkey, macHotkeyFromShortcut, macTopmostWindow } from "./global-hotkey-mac.mjs";

const WORKER_URL = "chrome://quickswitcher/content/hotkey-worker.js";
const HANDSHAKE_MS = 5000, LOAD_MS = 15000;
const MOD_ALT = 0x1, MOD_CONTROL = 0x2, MOD_SHIFT = 0x4, MOD_WIN = 0x8, MOD_NOREPEAT = 0x4000;
const namedKeys = { __proto__: null, backspace: 0x08, tab: 0x09, enter: 0x0D, return: 0x0D, escape: 0x1B, esc: 0x1B, space: 0x20,
  pageup: 0x21, pagedown: 0x22, end: 0x23, home: 0x24, arrowleft: 0x25, arrowup: 0x26, arrowright: 0x27, arrowdown: 0x28,
  insert: 0x2D, delete: 0x2E, del: 0x2E,
  // shortcut: symbol codes are the US-layout OEM keys; resolve with VkKeyScanW in the worker if another layout misses them.
  ";": 0xBA, "=": 0xBB, ",": 0xBC, "-": 0xBD, ".": 0xBE, "/": 0xBF, "`": 0xC0, "[": 0xDB, "\\": 0xDC, "]": 0xDD, "'": 0xDE };

// Plugin shortcut string -> RegisterHotKey arguments. Throws like parseShortcut() on unusable input.
export function hotkeyFromShortcut(value, isMac = !!globalThis.Zotero?.isMac) {
  if (isMac) return macHotkeyFromShortcut(value);
  const shortcut = parseShortcut(value, false), key = shortcut.key.toLowerCase();
  const functionKey = /^f([1-9]|1\d|2[0-4])$/u.exec(key);
  const vk = functionKey ? 0x6F + Number(functionKey[1]) : /^[a-z0-9]$/u.test(key) ? key.toUpperCase().charCodeAt(0) : namedKeys[key];
  if (!vk) throw new Error(t("不支持的快捷键按键：{key}", { key: shortcut.key }));
  return { modifiers: MOD_NOREPEAT | (shortcut.alt && MOD_ALT) | (shortcut.ctrl && MOD_CONTROL) | (shortcut.shift && MOD_SHIFT) | (shortcut.meta && MOD_WIN), vk };
}

// Win32 reports device pixels; `scale` is device pixels per CSS pixel on that monitor.
function withScale(screen) {
  if (!screen) return null;
  if (Number.isFinite(screen.scale) && screen.scale > 0) return screen;
  let scale;
  try {
    scale = Cc["@mozilla.org/gfx/screenmanager;1"].getService(Ci.nsIScreenManager)
      .screenForRect(screen.left, screen.top, screen.width, screen.height).defaultCSSScaleFactor;
  } catch { /* Fall back to the main window's scale. */ }
  return { ...screen, scale: scale || globalThis.Zotero?.getMainWindow?.()?.devicePixelRatio || 1 };
}

export function globalWindowBounds(screen, widthPercent, heightPercent) {
  const width = Math.round(screen.width * widthPercent / 100), height = Math.round(screen.height * heightPercent / 100);
  return { left: Math.round(screen.left + (screen.width - width) / 2), top: Math.round(screen.top + (screen.height - height) / 3), width, height };
}

function topmostWindow(win) {
  const native = win.docShell.treeOwner.QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIBaseWindow);
  const handle = String(native.nativeHandle);
  if (!/^(?:0x[\da-f]+|\d+)$/iu.test(handle)) throw new Error("Invalid global window handle");
  const { ctypes: C } = ChromeUtils.importESModule("resource://gre/modules/ctypes.sys.mjs");
  const pointer = C.cast(C.uintptr_t(handle), C.voidptr_t);
  if (pointer.isNull()) throw new Error("Missing global window handle");
  if (Zotero.isMac) return macTopmostWindow(C, pointer, () => !win.closed);
  if (!Zotero.isWin) return { raise() {}, restore() {} };
  const library = C.open("user32.dll");
  try {
    const declare = (name, result, ...args) => library.declare(name, C.winapi_abi, result, ...args);
    const process = declare("GetWindowThreadProcessId", C.uint32_t, C.voidptr_t, C.uint32_t.ptr), pid = C.uint32_t();
    const threadID = process(pointer, pid.address());
    if (!threadID || pid.value !== Services.appinfo.processID) throw new Error("Global window belongs to another process");
    const style = declare(C.size_t.size === 8 ? "GetWindowLongPtrW" : "GetWindowLongW", C.intptr_t, C.voidptr_t, C.int32_t);
    const position = declare("SetWindowPos", C.int32_t, C.voidptr_t, C.voidptr_t, C.int32_t, C.int32_t, C.int32_t, C.int32_t, C.uint32_t);
    const foreground = declare("GetForegroundWindow", C.voidptr_t);
    const activate = declare("SetForegroundWindow", C.int32_t, C.voidptr_t);
    const attach = declare("AttachThreadInput", C.int32_t, C.uint32_t, C.uint32_t, C.int32_t);
    const wasTopmost = !!(Number(style(pointer, -20).toString()) & 8);
    const top = C.cast(C.intptr_t(-1), C.voidptr_t), normal = C.cast(C.intptr_t(-2), C.voidptr_t);
    let restored = false;
    return {
      raise() {
        if (!position(pointer, top, 0, 0, 0, 0, 0x213)) throw Object.assign(new Error("SetWindowPos failed"), { code: C.winLastError });
        if (!activate(pointer) && foreground().toString() !== pointer.toString()) {
          const foregroundThread = process(foreground(), null);
          if (foregroundThread && foregroundThread !== threadID && attach(threadID, foregroundThread, 1)) {
            try { activate(pointer); }
            finally { if (!attach(threadID, foregroundThread, 0)) throw new Error("Global window input detachment failed"); }
          }
        }
        if (foreground().toString() !== pointer.toString()) throw new Error("Windows declined global window foreground activation");
        win.focus();
      },
      restore() {
        if (restored) return;
        restored = true;
        try { if (!wasTopmost && !win.closed) position(pointer, normal, 0, 0, 0, 0, 0x213); }
        finally { library.close(); }
      },
    };
  } catch (error) { library.close(); throw error; }
}

// Raise only on invocation; leaving the window or opening its native menu restores ordinary stacking.
export function keepGlobalWindowOnTop(win, { apiFactory = topmostWindow, onError = () => {} } = {}) {
  if (win.document.documentElement.getAttribute("windowtype") !== "quickswitcher:global") throw new Error("Global launcher window required");
  const api = apiFactory(win);
  let stopped = false, reported = false;
  const report = error => { if (!reported) { reported = true; try { onError(error); } catch { /* Reporting cannot prevent cleanup. */ } } };
  const unload = () => { if (win.closed) stop(); };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    win.removeEventListener("blur", stop); win.removeEventListener("deactivate", stop); win.removeEventListener("DOMWindowClose", stop); win.removeEventListener("unload", unload);
    win.document.removeEventListener("popupshowing", stop, true);
    try { api.restore(); } catch (error) { report(error); }
  };
  win.addEventListener("blur", stop); win.addEventListener("deactivate", stop); win.addEventListener("DOMWindowClose", stop); win.addEventListener("unload", unload);
  win.document.addEventListener("popupshowing", stop, true);
  try { api.raise(); } catch (error) { report(error); stop(); }
  return stop;
}

// One wait for a newly opened chrome window: resolves it on load, null once it is closed or cancelled, and rejects (closing it) on timeout.
export function windowLoad(win, timeoutMs = LOAD_MS) {
  let finish;
  const promise = new Promise((resolve, reject) => {
    const loaded = () => finish(win);
    // The initial about:blank may unload while the real document loads; only a closed window ends the wait.
    const unloaded = () => { if (win.closed) finish(null); };
    const closing = () => finish(null);
    const timer = setTimeout(() => { finish(null, new Error(t("全局检索窗口未能打开"))); win.close(); }, timeoutMs);
    finish = (value, error) => {
      clearTimeout(timer); win.removeEventListener("load", loaded); win.removeEventListener("unload", unloaded); win.removeEventListener("DOMWindowClose", closing);
      if (error) reject(error); else resolve(value);
    };
    win.addEventListener("load", loaded); win.addEventListener("unload", unloaded); win.addEventListener("DOMWindowClose", closing);
  });
  return { win, promise, cancel: () => finish(null) };
}

export class GlobalHotkey {
  // Executable basename of the last external foreground program; no document titles are read.
  constructor() { this.worker = null; this.mac = null; this.pending = Promise.resolve(); this.abort = null; this.sourceApp = null; this.generation = 0; }
  get sourceApp() { return globalThis.Zotero?.isMac && this.mac ? this.mac.sourceApp : this._sourceApp; }
  set sourceApp(value) { this._sourceApp = value; }

  // Registration failures retain the platform error code (1409 / -9878 = taken).
  // An empty shortcut registers nothing and only tracks sourceApp. onError reports a worker that fails after it was running.
  start(shortcut, onTrigger, onError = () => {}) {
    const generation = ++this.generation;
    this.abort?.();
    return this.pending = this.pending.catch(() => {}).then(() => this.release()).then(() => {
      if (generation !== this.generation || !globalThis.Zotero?.isWin && !globalThis.Zotero?.isMac) return false;
      if (globalThis.Zotero.isMac) {
        this.mac ||= new MacGlobalHotkey({ queue: fn => setTimeout(fn, 0) });
        return this.mac.start(shortcut, (screen, app) => onTrigger(withScale(screen), app), onError);
      }
      const hotkey = shortcut ? hotkeyFromShortcut(shortcut) : { modifiers: 0, vk: 0 };
      const Worker = typeof ChromeWorker !== "undefined" ? ChromeWorker : globalThis.Zotero.getMainWindow()?.ChromeWorker;
      if (!Worker) throw new Error("ChromeWorker is unavailable");
      const worker = this.worker = new Worker(WORKER_URL);
      return new Promise((resolve, reject) => {
        let running = false, retired = false;
        const settled = () => { clearTimeout(timer); this.abort = null; };
        const failed = (message, code) => {
          if (retired) return;
          retired = true;
          if (this.worker === worker) this.worker = null;
          this.sourceApp = null;
          worker.onmessage = worker.onerror = null;
          worker.terminate();
          const error = Object.assign(new Error(message), { code });
          if (running) onError(error); else { settled(); reject(error); }
        };
        const timer = setTimeout(() => failed(`Hotkey worker did not respond (${shortcut})`), HANDSHAKE_MS);
        // stop() or a newer start() must not wait for a handshake that may never come; release() then retires this worker.
        this.abort = () => { settled(); worker.onmessage = worker.onerror = null; resolve(false); };
        worker.onmessage = ({ data }) => {
          if (data.type === "registered") {
            running = true;
            settled();
            if (data.hotkeyRegistered === false || data.error) {
              const code = data.code ?? data.error?.code ?? 1409;
              const msg = data.message ?? data.error?.message ?? "RegisterHotKey failed";
              reject(Object.assign(new Error(`${msg} (${shortcut}, Win32 ${code})`), { code }));
            } else {
              resolve(true);
            }
          }
          else if (data.type === "app") this.sourceApp = data.app ?? null;
          else if (data.type === "hotkey") { this.sourceApp = data.app ?? null; onTrigger(withScale(data.screen), this.sourceApp); }
          else if (data.type === "error") {
            if ((data.tracking || data.code === 1409) && !running) {
              running = true;
              settled();
              reject(Object.assign(new Error(`${data.message} (${shortcut}, Win32 ${data.code})`), { code: data.code }));
            } else {
              failed(`${data.message} (${shortcut}, Win32 ${data.code})`, data.code);
            }
          }
        };
        worker.onerror = event => { event.preventDefault?.(); failed(event.message || "Hotkey worker failed"); };
        try { worker.postMessage({ type: "start", ...hotkey }); } catch (error) { failed(error.message || String(error)); }
      });
    });
  }

  stop() { this.generation++; this.abort?.(); this.sourceApp = null; return this.pending = this.pending.catch(() => {}).then(() => this.release()); }

  // The worker unregisters on its own thread; wait for that so an immediate restart can claim the same combination.
  async release() {
    await this.mac?.stop();
    const worker = this.worker;
    this.worker = null;
    if (!worker) return;
    await new Promise(resolve => {
      const finished = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(resolve, 1000);
      worker.onmessage = ({ data }) => { if (data.type === "stopped") finished(); };
      worker.onerror = finished;
      try { worker.postMessage({ type: "stop" }); } catch { finished(); }
    });
    worker.terminate();
  }
}
