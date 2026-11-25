// SPDX-License-Identifier: AGPL-3.0-or-later
// ChromeWorker: owns one system-wide hotkey. RegisterHotKey posts WM_HOTKEY to the registering thread, so this thread also pumps.
/* global ctypes */
"use strict";

const WM_HOTKEY = 0x0312, PM_REMOVE = 1, QS_ALLINPUT = 0x04FF, WAIT_FAILED = 0xFFFFFFFF;
const MONITOR_DEFAULTTONEAREST = 2, HOTKEY_ID = 1, WAIT_MS = 200;
const { int32_t, uint32_t, voidptr_t } = ctypes;
const POINT = new ctypes.StructType("POINT", [{ x: int32_t }, { y: int32_t }]);
const RECT = new ctypes.StructType("RECT", [{ left: int32_t }, { top: int32_t }, { right: int32_t }, { bottom: int32_t }]);
const MSG = new ctypes.StructType("MSG", [{ hwnd: voidptr_t }, { message: uint32_t }, { wParam: ctypes.uintptr_t },
  { lParam: ctypes.intptr_t }, { time: uint32_t }, { pt: POINT }]);
const MONITORINFO = new ctypes.StructType("MONITORINFO", [{ cbSize: uint32_t }, { rcMonitor: RECT }, { rcWork: RECT }, { dwFlags: uint32_t }]);

let user32 = null, kernel32 = null, api = null, registered = false, monitoring = false, timer = null;
let ownPID = 0, foregroundPID = 0, sourceApp = null;
const message = new MSG();

function declare() {
  user32 = ctypes.open("user32.dll");
  kernel32 = ctypes.open("kernel32.dll");
  const abi = ctypes.winapi_abi, fn = (name, result, ...args) => user32.declare(name, abi, result, ...args);
  const kernel = (name, result, ...args) => kernel32.declare(name, abi, result, ...args);
  api = {
    RegisterHotKey: fn("RegisterHotKey", int32_t, voidptr_t, int32_t, uint32_t, uint32_t),
    UnregisterHotKey: fn("UnregisterHotKey", int32_t, voidptr_t, int32_t),
    PeekMessageW: fn("PeekMessageW", int32_t, MSG.ptr, voidptr_t, uint32_t, uint32_t, uint32_t),
    MsgWaitForMultipleObjects: fn("MsgWaitForMultipleObjects", uint32_t, uint32_t, voidptr_t, int32_t, uint32_t, uint32_t),
    GetCursorPos: fn("GetCursorPos", int32_t, POINT.ptr),
    MonitorFromPoint: fn("MonitorFromPoint", voidptr_t, POINT, uint32_t),
    GetMonitorInfoW: fn("GetMonitorInfoW", int32_t, voidptr_t, MONITORINFO.ptr),
    GetForegroundWindow: fn("GetForegroundWindow", voidptr_t),
    GetWindowThreadProcessId: fn("GetWindowThreadProcessId", uint32_t, voidptr_t, uint32_t.ptr),
    GetCurrentProcessId: kernel("GetCurrentProcessId", uint32_t),
    OpenProcess: kernel("OpenProcess", voidptr_t, uint32_t, int32_t, uint32_t),
    QueryFullProcessImageNameW: kernel("QueryFullProcessImageNameW", int32_t, voidptr_t, uint32_t, ctypes.jschar.ptr, uint32_t.ptr),
    CloseHandle: kernel("CloseHandle", int32_t, voidptr_t),
  };
  ownPID = api.GetCurrentProcessId();
}

// Work area (taskbar excluded) of the monitor under the pointer, in device pixels of the virtual desktop.
function cursorScreen() {
  try {
    const point = new POINT(), info = new MONITORINFO();
    info.cbSize = MONITORINFO.size;
    if (!api.GetCursorPos(point.address())) return null;
    const monitor = api.MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST);
    if (monitor.isNull() || !api.GetMonitorInfoW(monitor, info.address())) return null;
    const work = info.rcWork;
    return { left: work.left, top: work.top, width: work.right - work.left, height: work.bottom - work.top };
  } catch { return null; }
}

function release() {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  if (registered) api.UnregisterHotKey(null, HOTKEY_ID);
  registered = monitoring = false;
  foregroundPID = 0;
  sourceApp = null;
  if (user32) user32.close();
  if (kernel32) kernel32.close();
  user32 = kernel32 = api = null;
}

// Keep the last external foreground app while focus is inside Zotero. Read only the executable identity, never document titles.
function currentApp() {
  try {
    const hwnd = api.GetForegroundWindow(), pid = new uint32_t();
    if (hwnd.isNull() || !api.GetWindowThreadProcessId(hwnd, pid.address())) {
      foregroundPID = 0; sourceApp = null;
      self.postMessage({ type: "app", app: null });
      return null;
    }
    if (pid.value === ownPID || pid.value === foregroundPID) return sourceApp;
    foregroundPID = pid.value;
    const handle = api.OpenProcess(0x1000, 0, pid.value); // PROCESS_QUERY_LIMITED_INFORMATION
    let app = null;
    if (!handle.isNull()) {
      try {
        const buffer = new (ctypes.jschar.array(32768))(), length = new uint32_t(32768);
        if (api.QueryFullProcessImageNameW(handle, 0, buffer, length.address())) {
          const path = buffer.readString(); app = { name: path.split(/[\\/]/u).at(-1), path };
        }
      } finally { api.CloseHandle(handle); }
    }
    sourceApp = app;
    self.postMessage({ type: "app", app });
  } catch {
    foregroundPID = 0;
    sourceApp = null;
    self.postMessage({ type: "app", app: null });
  }
  return sourceApp;
}

function fail(code, text) {
  release();
  self.postMessage({ type: "error", code, message: text });
  self.close();
}

// A blocking GetMessageW would never let "stop" arrive, so wait in short slices and return to the worker event loop between them.
function pump() {
  timer = null;
  if (!monitoring) return;
  currentApp();
  const waited = api.MsgWaitForMultipleObjects(0, null, 0, WAIT_MS, QS_ALLINPUT);
  if (waited === WAIT_FAILED) { fail(ctypes.winLastError, "MsgWaitForMultipleObjects failed"); return; }
  while (api.PeekMessageW(message.address(), null, 0, 0, PM_REMOVE)) {
    if (message.message === WM_HOTKEY && registered) self.postMessage({ type: "hotkey", screen: cursorScreen(), app: currentApp() });
  }
  timer = setTimeout(pump, 0);
}

self.onmessage = ({ data }) => {
  if (data.type === "start" && !monitoring) {
    try {
      declare();
      if (data.vk && !api.RegisterHotKey(null, HOTKEY_ID, data.modifiers, data.vk)) {
        // 1409 = ERROR_HOTKEY_ALREADY_REGISTERED: another program owns this combination.
        const code = ctypes.winLastError;
        registered = false;
        monitoring = true;
        self.postMessage({ type: "registered", hotkeyRegistered: false, code, message: code === 1409 ? "Hotkey is already registered by another program" : "RegisterHotKey failed" });
        pump();
        return;
      }
    } catch (error) { fail(0, String(error?.message || error)); return; }
    registered = !!data.vk;
    monitoring = true;
    self.postMessage({ type: "registered", hotkeyRegistered: true });
    pump();
  } else if (data.type === "stop") {
    release();
    self.postMessage({ type: "stopped" });
    self.close();
  }
};
