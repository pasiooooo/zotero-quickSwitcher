// SPDX-License-Identifier: AGPL-3.0-or-later
/* global ctypes */
"use strict";

function windowsPayload({ kind = "files", bytes, textBytes, htmlBytes }) {
  const checked = (buffer, minimum) => {
    if (Object.prototype.toString.call(buffer) !== "[object ArrayBuffer]" || buffer.byteLength < minimum || buffer.byteLength > 16 * 1024 * 1024) throw new Error("Invalid clipboard data");
    return new Uint8Array(buffer);
  };
  if (kind === "files") {
    const data = checked(bytes, 26), view = new DataView(bytes);
    if (data.length % 2 || view.getUint32(0, true) !== 20 || view.getUint32(16, true) !== 1 || data.slice(-4).some(byte => byte)) throw new Error("Invalid file clipboard data");
    return [{ name: "Preferred DropEffect", data: new Uint8Array([1, 0, 0, 0]), label: "copy effect" }, { format: 15, data, label: "CF_HDROP" }];
  }
  if (kind !== "references") throw new Error("Invalid clipboard operation");
  const text = checked(textBytes, 2), html = checked(htmlBytes, 106), view = new DataView(textBytes);
  if (text.length % 2 || text.length + html.length > 16 * 1024 * 1024 || text.at(-1) || text.at(-2) || html.at(-1)) throw new Error("Invalid reference clipboard data");
  for (let i = 0; i < text.length - 2; i += 2) if (!view.getUint16(i, true)) throw new Error("Invalid Unicode clipboard text");
  for (let i = 0; i < html.length - 1; i++) if (!html[i]) throw new Error("Invalid HTML clipboard text");
  const ascii = (start, end) => String.fromCharCode(...html.subarray(start, end));
  const header = /^Version:1\.0\r\nStartHTML:(\d{10})\r\nEndHTML:(\d{10})\r\nStartFragment:(\d{10})\r\nEndFragment:(\d{10})\r\n/u.exec(ascii(0, 105));
  if (!header) throw new Error("Invalid HTML clipboard header");
  const [start, end, first, last] = header.slice(1).map(Number), before = "<!--StartFragment-->", after = "<!--EndFragment-->";
  if (start !== header[0].length || end !== html.length - 1 || first < start + before.length || first > last || last + after.length > end
    || ascii(first - before.length, first) !== before || ascii(last, last + after.length) !== after) throw new Error("Invalid HTML clipboard offsets");
  return [{ format: 13, data: text, label: "CF_UNICODETEXT" }, { name: "HTML Format", data: html, label: "CF_HTML" }];
}

function windowsClipboard(payload) {
  const { owner } = payload, formats = windowsPayload(payload);
  if (typeof owner !== "string" || !/^(?:0x[0-9a-f]+|[0-9]+)$/iu.test(owner)) throw new Error("Invalid clipboard owner");
  // UInt64 accepts hexadecimal handles without rounding through a JS Number.
  const hwnd = ctypes.voidptr_t(ctypes.UInt64(owner));
  if (hwnd.isNull()) throw new Error("Invalid clipboard owner");
  const handles = [], assigned = new Set(); let user32, kernel32, close, free, opened = false;
  const failed = operation => new Error(`${operation} failed (Windows ${ctypes.winLastError || 0})`);
  try {
    user32 = ctypes.open("user32.dll"); kernel32 = ctypes.open("kernel32.dll");
    const abi = ctypes.winapi_abi, ptr = ctypes.voidptr_t, uint = ctypes.uint32_t;
    const fn = (lib, name, result, ...args) => lib.declare(name, abi, result, ...args);
    const open = fn(user32, "OpenClipboard", ctypes.int32_t, ptr); close = fn(user32, "CloseClipboard", ctypes.int32_t);
    const isWindow = fn(user32, "IsWindow", ctypes.int32_t, ptr);
    const empty = fn(user32, "EmptyClipboard", ctypes.int32_t), set = fn(user32, "SetClipboardData", ptr, uint, ptr);
    const register = fn(user32, "RegisterClipboardFormatW", uint, ctypes.jschar.ptr);
    const alloc = fn(kernel32, "GlobalAlloc", ptr, uint, ctypes.size_t), lock = fn(kernel32, "GlobalLock", ptr, ptr);
    const unlock = fn(kernel32, "GlobalUnlock", ctypes.int32_t, ptr); free = fn(kernel32, "GlobalFree", ptr, ptr);
    if (!isWindow(hwnd)) throw new Error("Clipboard owner window has closed");
    const prepared = formats.map(({ name, format, data, label }) => {
      format ||= register(name); if (!format) throw failed("RegisterClipboardFormatW");
      const handle = alloc(2, data.length); if (handle.isNull()) throw failed("GlobalAlloc"); handles.push(handle);
      const address = lock(handle); if (address.isNull()) throw failed("GlobalLock");
      try {
        const target = ctypes.cast(address, ctypes.uint8_t.array(data.length).ptr).contents;
        for (let i = 0; i < data.length; i++) target[i] = data[i];
      } finally { unlock(handle); }
      return { format, handle, label };
    });
    if (!open(hwnd)) return { retry: true, code: ctypes.winLastError || 0 };
    opened = true;
    if (!empty()) throw failed("EmptyClipboard");
    for (const { format, handle, label } of prepared) {
      if (set(format, handle).isNull()) throw failed(`SetClipboardData(${label})`);
      assigned.add(handle);
    }
    return { copied: true };
  } finally {
    try { if (opened && !close()) throw failed("CloseClipboard"); }
    finally {
      try { for (const handle of handles) if (!assigned.has(handle)) free(handle); }
      finally { try { kernel32?.close(); } finally { user32?.close(); } }
    }
  }
}

function macClipboard({ paths }) {
  if (!Array.isArray(paths) || !paths.length || paths.some(path => typeof path !== "string" || !path || path.includes("\0"))) throw new Error("Invalid file clipboard data");
  let foundation, appkit, objc, pool, drain;
  try {
    foundation = ctypes.open("/System/Library/Frameworks/Foundation.framework/Foundation");
    appkit = ctypes.open("/System/Library/Frameworks/AppKit.framework/AppKit");
    objc = ctypes.open("/usr/lib/libobjc.A.dylib");
    const ptr = ctypes.voidptr_t, abi = ctypes.default_abi;
    const getClass = objc.declare("objc_getClass", abi, ptr, ctypes.char.ptr), selector = objc.declare("sel_registerName", abi, ptr, ctypes.char.ptr);
    // Fixed signatures work on both x86_64 and arm64; no Objective-C variadic dispatch.
    const send = objc.declare("objc_msgSend", abi, ptr, ptr, ptr);
    const sendVoid = objc.declare("objc_msgSend", abi, ctypes.void_t, ptr, ptr);
    const sendVoidObject = objc.declare("objc_msgSend", abi, ctypes.void_t, ptr, ptr, ptr);
    const sendInteger = objc.declare("objc_msgSend", abi, ctypes.intptr_t, ptr, ptr);
    const sendObject = objc.declare("objc_msgSend", abi, ptr, ptr, ptr, ptr);
    const sendString = objc.declare("objc_msgSend", abi, ptr, ptr, ptr, ctypes.char.ptr);
    const sendSize = objc.declare("objc_msgSend", abi, ptr, ptr, ptr, ctypes.size_t);
    const sendBool = objc.declare("objc_msgSend", abi, ctypes.bool, ptr, ptr, ptr);
    const pasteboardClass = getClass("NSPasteboard");
    if (pasteboardClass.isNull()) throw new Error("NSPasteboard is unavailable");
    pool = send(send(getClass("NSAutoreleasePool"), selector("alloc")), selector("init"));
    if (pool.isNull()) throw new Error("NSAutoreleasePool is unavailable");
    drain = () => sendVoid(pool, selector("drain"));
    const array = sendSize(getClass("NSMutableArray"), selector("arrayWithCapacity:"), paths.length);
    if (array.isNull()) throw new Error("Unable to allocate pasteboard items");
    for (const path of paths) {
      const string = sendString(getClass("NSString"), selector("stringWithUTF8String:"), path);
      const url = sendObject(getClass("NSURL"), selector("fileURLWithPath:"), string);
      if (url.isNull()) throw new Error("Invalid file URL");
      sendVoidObject(array, selector("addObject:"), url);
    }
    const board = send(pasteboardClass, selector("generalPasteboard"));
    if (board.isNull()) throw new Error("NSPasteboard is unavailable");
    sendInteger(board, selector("clearContents"));
    if (!sendBool(board, selector("writeObjects:"), array)) throw new Error("NSPasteboard writeObjects failed");
    return { copied: true };
  } finally {
    try { drain?.(); }
    finally { objc?.close(); appkit?.close(); foundation?.close(); }
  }
}

self.onmessage = ({ data }) => {
  let attempts = 0;
  const run = () => {
    try {
      const result = data.platform === "win" ? windowsClipboard(data) : data.platform === "mac" ? macClipboard(data) : null;
      if (!result) throw new Error("Unsupported file clipboard platform");
      if (result.retry && attempts++ < 20) { setTimeout(run, 50); return; }
      if (result.retry) throw new Error(`Clipboard unavailable (Windows ${result.code}); try again`);
      self.postMessage({ type: "copied" });
    } catch (error) { self.postMessage({ type: "error", message: String(error?.message || error) }); }
    self.close();
  };
  run();
};
