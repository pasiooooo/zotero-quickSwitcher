import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { ClipboardService, dropFilesBytes, referenceClipboardBytes } from "../src/clipboard.mjs";

function fixture() {
  const original = Object.fromEntries(["Zotero", "IOUtils", "ChromeWorker", "Cc", "Ci", "Services"].map(key => [key, globalThis[key]]));
  const settings = { citationStyle: "", citationLocale: "", citationRules: [] }, native = { "export.quickCopy.setting": "bibliography=native", "export.quickCopy.locale": "en-US" };
  const items = new Map(), calls = [], engineCalls = [], styles = [{ styleID: "native", title: "Native" }, { styleID: "ppt", title: "Presentation" }, { styleID: "gb", title: "GB" }];
  const main = { Zotero_File_Interface: { copyItemsToClipboard(...args) { calls.push(args); } } };
  const win = { docShell: { treeOwner: { QueryInterface() { return { getInterface() { return { nativeHandle: "0x1234" }; } }; } } } };
  const engine = { updateItems(ids) { this.ids = ids; }, previewCitationCluster(citation, _a, _b, format) { return format + ":" + citation.citationItems.map(item => item.id).join(","); }, free() { this.freed = true; } };
  globalThis.Zotero = { isWin: true, isMac: false, Prefs: { get: key => native[key] }, Items: { getAsync: async id => items.get(id) },
    Styles: { init: async () => {}, getVisible: () => Object.freeze(styles), get: id => styles.find(style => style.styleID === id) && { getCiteProc: (...args) => { engineCalls.push([id, ...args]); return engine; } } },
    QuickCopy: { unserializeSetting: value => ({ mode: "bibliography", id: value.split("=")[1] }) }, getMainWindow: () => main,
    File: { pathToFile: path => ({ path }) }, Cite: { makeFormattedBibliographyOrCitationList: (_engine, items, format) => format + ":" + items.map(item => item.id).join(",") } };
  globalThis.IOUtils = { exists: async path => !path.includes("missing") };
  globalThis.Ci = { nsIInterfaceRequestor: {}, nsIBaseWindow: {}, nsITransferable: {}, nsISupportsString: {}, nsIClipboard: { kGlobalClipboard: 1 } };
  const clipboard = [];
  globalThis.Cc = { "@mozilla.org/widget/transferable;1": { createInstance: () => ({ values: {}, init() {}, addDataFlavor() {}, setTransferData(key, value) { this.values[key] = value.data ?? value; }, getTransferData(key, data) { data.value = { QueryInterface: () => ({ data: this.values[key] }) }; } }) },
    "@mozilla.org/supports-string;1": { createInstance: () => ({ data: "" }) } };
  globalThis.Services = { clipboard: { setData(value) { clipboard.push(value.values); } }, io: { newFileURI: file => ({ spec: "file://" + file.path }) } };
  const workers = [];
  globalThis.ChromeWorker = class {
    constructor(url) { this.url = url; workers.push(this); }
    postMessage(data) { this.data = data; queueMicrotask(() => this.onmessage?.({ data: { type: "copied" } })); }
    terminate() { this.terminated = true; }
  };
  const regular = (id, attachments = []) => { const item = { id, isRegularItem: () => true, isPDFAttachment: () => false, getBestAttachments: async () => attachments }; items.set(id, item); return item; };
  const pdf = (id, path, parentID) => { const item = { id, parentID, isRegularItem: () => false, isPDFAttachment: () => true, getFilePathAsync: async () => path }; items.set(id, item); return item; };
  return { settings, native, items, calls, engineCalls, styles, main, win, workers, engine, clipboard, regular, pdf,
    service: new ClipboardService({ get: key => settings[key] }), restore() { for (const [key, value] of Object.entries(original)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } };
}

test("DROPFILES encodes full UTF-16 paths and a final empty path with copy-compatible header", () => {
  const paths = ["C:\\文献\\😀.pdf", "D:\\other.pdf"], bytes = dropFilesBytes(paths), view = new DataView(bytes.buffer);
  assert.equal(view.getUint32(0, true), 20); assert.equal(view.getUint32(16, true), 1);
  assert.deepEqual([...bytes.slice(4, 16)], Array(12).fill(0));
  const text = new TextDecoder("utf-16le").decode(bytes.slice(20));
  assert.equal(text, paths.join("\0") + "\0\0");
  for (const value of [[], [""], ["C:\\a\0b.pdf"], [null], "C:\\file.pdf"]) assert.throws(() => dropFilesBytes(value));
});

function referenceFragment(bytes) {
  const data = new Uint8Array(bytes), header = new TextDecoder().decode(data.slice(0, 105));
  const offsets = Object.fromEntries([...header.matchAll(/(StartHTML|EndHTML|StartFragment|EndFragment):(\d+)/gu)].map(([, key, value]) => [key, Number(value)]));
  return { header, offsets, html: new TextDecoder().decode(data.slice(offsets.StartFragment, offsets.EndFragment)) };
}

test("clipboard suggestions require an observed recent copy, honor settings, and reject changed or invalid text", () => {
  const context = fixture(); let sequence = 1, text = "  fault\r\nmechanics  ", reads = 0, changeDuringRead = false;
  context.settings.clipboardSearch = true; context.settings.clipboardSeconds = 3;
  Services.clipboard.getDataSnapshotSync = () => {
    const captured = sequence;
    return { get valid() { return captured === sequence; }, flavorList: ["text/plain"] };
  };
  Services.clipboard.getData = value => { reads++; value.values["text/plain"] = text; if (changeDuringRead) sequence++; };
  try {
    context.service.updateClipboard();
    assert.equal(context.service.recentText(), ""); assert.equal(reads, 0);
    context.service.clipboardCheckedAt = performance.now() - 100; sequence++;
    assert.equal(context.service.recentText(), "fault mechanics");
    context.service.clipboardChangedAt = performance.now() - 4000;
    assert.equal(context.service.recentText(), ""); assert.equal(reads, 1);
    context.settings.clipboardSeconds = 5;
    assert.equal(context.service.recentText(), "fault mechanics");
    context.settings.clipboardSearch = false;
    assert.equal(context.service.recentText(), ""); assert.equal(reads, 2);
    context.settings.clipboardSearch = true;
    for (const value of ["a\0b", "a".repeat(2049), "\r\n  "]) {
      text = value; sequence++; assert.equal(context.service.recentText(), "");
    }
    text = "new"; sequence++; changeDuringRead = true;
    assert.equal(context.service.recentText(), "");
    context.service.destroy(); assert.equal(context.service.snapshot, null);
    context.settings.clipboardSearch = false; context.service.start(); assert.equal(context.service.timer, null);
  } finally { context.service.destroy(); context.restore(); }
});

test("reference clipboard encodes rich HTML byte offsets and Unicode text without losing Chinese or supplementary characters", () => {
  const html = '<div class="csl-entry">晓禾 林 😀 <i>Überblick</i> &amp; 中文</div>', text = "晓禾 林 😀\nÜberblick\r\n中文\rEnd";
  const payload = referenceClipboardBytes(text, html), unicode = new Uint8Array(payload.textBytes), rich = new Uint8Array(payload.htmlBytes);
  assert.equal(new TextDecoder("utf-16le").decode(unicode), "晓禾 林 😀\r\nÜberblick\r\n中文\r\nEnd\0");
  const parsed = referenceFragment(payload.htmlBytes), { StartHTML, EndHTML, StartFragment, EndFragment } = parsed.offsets;
  assert.equal(parsed.html, html); assert.equal(StartHTML, parsed.header.length); assert.equal(EndHTML, rich.length - 1); assert.equal(rich.at(-1), 0);
  assert.equal(EndFragment - StartFragment, new TextEncoder().encode(html).length); assert.notEqual(EndFragment - StartFragment, html.length);
  assert.equal(new TextDecoder().decode(rich.slice(StartFragment - 20, StartFragment)), "<!--StartFragment-->");
  assert.equal(new TextDecoder().decode(rich.slice(EndFragment, EndHTML)), "<!--EndFragment--></body></html>");
  for (const [plain, fragment] of [[null, html], [text, undefined], ["a\0b", html], [text, "a\0b"], ["a".repeat(8 * 1024 * 1024), html], [text, "中".repeat(6 * 1024 * 1024)]]) assert.throws(() => referenceClipboardBytes(plain, fragment));
});

test("CSL picker copies the installed immutable array and native quick-copy supplies the default", async () => {
  const f = fixture(); try {
    const rows = await f.service.styles(); assert.deepEqual(rows.map(row => row.styleID), ["gb", "native", "ppt"]);
    assert.equal(f.styles[0].styleID, "native"); assert.equal(await f.service.styleForApp(null), "native");
    assert.deepEqual(await f.service.formatForApp(null), { styleID: "native", locale: "en-US" });
  } finally { f.restore(); }
});

test("application rules match executable basenames without case sensitivity and a manual CSL overrides them", async () => {
  const f = fixture(); try {
    f.settings.citationStyle = "gb"; f.settings.citationRules = [{ app: "POWERPNT.EXE", styleID: "ppt", locale: "zh-CN" }];
    assert.deepEqual(await f.service.formatForApp({ name: "powerpnt.exe" }), { styleID: "ppt", locale: "zh-CN" });
    assert.equal(await f.service.styleForApp({ path: "C:\\Program Files\\Office\\POWERPNT.EXE" }), "ppt");
    assert.deepEqual(await f.service.formatForApp({ name: "powerpnt.exe" }, "gb"), { styleID: "gb", locale: undefined });
    assert.equal(await f.service.styleForApp({ name: "WINWORD.EXE" }), "gb");
    f.settings.citationLocale = "zh-CN";
    assert.deepEqual(await f.service.formatForApp({ name: "powerpnt.exe" }, "gb"), { styleID: "gb", locale: "zh-CN" });
    assert.equal(f.native["export.quickCopy.setting"], "bibliography=native");
  } finally { f.restore(); }
});

test("missing explicit or rule CSL rejects without silently copying in another style", async () => {
  const f = fixture(); try {
    f.settings.citationStyle = "missing"; await assert.rejects(f.service.styleForApp(null), /missing/u);
    f.settings.citationStyle = "gb"; f.settings.citationRules = [{ app: "powerpnt.exe", styleID: "uninstalled" }];
    await assert.rejects(f.service.styleForApp({ name: "powerpnt.exe" }), /uninstalled/u);
    await assert.rejects(f.service.formatForApp(null, "unknown"), /unknown/u);
  } finally { f.restore(); }
});

test("non-Windows citation batches keep the native interface, reference deduplication and unsupported rows", async () => {
  const f = fixture(); try {
    Zotero.isWin = false;
    const item = f.regular(1); f.pdf(2, "C:\\a.pdf", 1); f.items.set(3, { id: 3, parentID: 2 }); f.items.set(4, { id: 4, isRegularItem: () => false });
    const invalid = [{ itemID: 4 }, { itemID: 99 }], result = await f.service.copy("citation", [{ itemID: 1 }, { itemID: 2 }, { itemID: 3 }, ...invalid], { win: f.win });
    assert.deepEqual(result, { count: 1, failed: invalid });
    assert.deepEqual(f.calls[0], [[item], "native", "en-US", false, true]);
    await f.service.copy("bibliography", [{ itemID: 1 }], { win: f.win, styleID: "gb" });
    assert.equal(f.calls[1][4], false); assert.equal(f.calls[1][1], "gb");
  } finally { f.restore(); }
});

test("invalid batches never touch the clipboard and native copy failures reject the entire write", async () => {
  const f = fixture(); try {
    Zotero.isWin = false;
    assert.deepEqual(await f.service.copy("citation", [{ itemID: 999 }]), { count: 0, failed: [{ itemID: 999 }] }); assert.equal(f.calls.length, 0);
    f.regular(1); f.main.Zotero_File_Interface.copyItemsToClipboard = () => { throw new Error("clipboard busy"); };
    await assert.rejects(f.service.copy("citation", [{ itemID: 1 }]), /clipboard busy/u);
    await assert.rejects(f.service.copy("other", []), /复制动作/u);
  } finally { f.restore(); }
});

test("cancelled copying stops before later rows or handing old data to the clipboard", async () => {
  const f = fixture(); try {
    let current = true, secondRead = false;
    const first = f.pdf(1, "C:\\first.pdf"), second = f.pdf(2, "C:\\second.pdf");
    first.getFilePathAsync = async () => { current = false; return "C:\\first.pdf"; };
    second.getFilePathAsync = async () => { secondRead = true; return "C:\\second.pdf"; };
    const rows = [{ itemID: 1 }, { itemID: 2 }];
    assert.deepEqual(await f.service.copy("pdf", rows, { win: f.win, current: () => current }), { count: 0, failed: rows, cancelled: true });
    assert.equal(secondRead, false); assert.equal(f.workers.length, 0);
    current = true; f.regular(3); Zotero.isWin = false;
    f.service.formatForApp = async () => { current = false; return { styleID: "native" }; };
    assert.equal((await f.service.copy("citation", [{ itemID: 3 }], { win: f.win, current: () => current })).cancelled, true);
    assert.equal(f.calls.length, 0); assert.equal(f.clipboard.length, 0);
  } finally { f.restore(); }
});

test("reader-only reference copying uses HTML and text with one freed citeproc engine", async () => {
  const f = fixture(); try {
    Zotero.isWin = false;
    Zotero.getMainWindow = () => null; f.regular(1); f.regular(2);
    assert.equal((await f.service.copy("citation", [{ itemID: 1 }, { itemID: 2 }], { win: f.win })).count, 2);
    assert.deepEqual(f.clipboard[0], { "text/html": "html:1,2", "text/plain": "text:1,2" });
    assert.equal(f.engine.freed, true); assert.deepEqual(f.engine.ids, [1, 2]);
    f.engine.freed = false; Zotero.Cite.makeFormattedBibliographyOrCitationList = () => { throw new Error("render failed"); };
    await assert.rejects(f.service.copy("bibliography", [{ itemID: 1 }]), /render failed/u);
    assert.equal(f.engine.freed, true); assert.equal(f.clipboard.length, 1);
  } finally { f.restore(); }
});

test("Windows references bypass Gecko writes, keep CSL rules and deduplication, and await the native write result", async () => {
  const f = fixture(); try {
    f.regular(1); f.pdf(2, "C:\\a.pdf", 1); const bad = { itemID: 99 };
    f.settings.citationLocale = "en-US";
    f.settings.citationRules = [{ app: "POWERPNT.EXE", styleID: "ppt", locale: "zh-CN" }];
    let release;
    ChromeWorker = class {
      constructor() { f.workers.push(this); }
      postMessage(data) { this.data = data; release = () => this.onmessage({ data: { type: "copied" } }); }
      terminate() { this.terminated = true; }
    };
    let resolved = false;
    const pending = f.service.copy("citation", [{ itemID: 1 }, { itemID: 2 }, bad], { win: f.win, app: { name: "powerpnt.exe" } }).then(result => { resolved = true; return result; });
    for (let i = 0; !release && i < 30; i++) await Promise.resolve();
    assert.equal(resolved, false); assert.equal(f.workers.length, 1); assert.equal(f.calls.length, 0); assert.equal(f.clipboard.length, 0);
    assert.deepEqual(f.engineCalls, [["ppt", "zh-CN", "html", { cache: true }]]); assert.equal(f.engine.freed, true);
    assert.equal(f.workers[0].data.kind, "references"); assert.equal(f.workers[0].data.owner, "0x1234");
    assert.equal(referenceFragment(f.workers[0].data.htmlBytes).html, "html:1");
    assert.equal(new TextDecoder("utf-16le").decode(f.workers[0].data.textBytes), "text:1\0");
    release(); assert.deepEqual(await pending, { count: 1, failed: [bad] }); assert.equal(f.workers[0].terminated, true);
    ChromeWorker = class {
      postMessage() { queueMicrotask(() => this.onmessage({ data: { type: "error", message: "SetClipboardData(CF_HTML) failed (Windows 5)" } })); }
      terminate() {}
    };
    await assert.rejects(f.service.copy("bibliography", [{ itemID: 1 }], { win: f.win, styleID: "gb" }), /CF_HTML.*Windows 5/u);
    assert.deepEqual(f.engineCalls[1], ["gb", "en-US", "html", { cache: true }]);
    assert.equal(f.calls.length, 0); assert.equal(f.clipboard.length, 0);
  } finally { f.restore(); }
});

test("PDF batches prefer each opened attachment, deduplicate actual files, and preserve unavailable rows", async () => {
  const f = fixture(); try {
    const first = f.pdf(10, "C:\\a.pdf", 1), opened = f.pdf(11, "C:\\opened.pdf", 1); f.regular(1, [first]);
    f.regular(2, [f.pdf(20, "C:\\A.pdf", 2)]); f.regular(3, [f.pdf(30, "C:\\missing.pdf", 3)]);
    const bad = { itemID: 3 }, result = await f.service.copy("pdf", [{ itemID: 1, attachmentID: opened.id }, { itemID: 1 }, { itemID: 2 }, bad], { win: f.win });
    assert.deepEqual(result, { count: 2, failed: [bad] }); assert.equal(f.workers.length, 1);
    assert.deepEqual(f.workers[0].data.paths, ["C:\\opened.pdf", "C:\\A.pdf"]);
    assert.equal(f.workers[0].data.owner, "0x1234"); assert.equal(f.workers[0].terminated, true);
    assert.equal(new DataView(f.workers[0].data.bytes).getUint32(16, true), 1);
  } finally { f.restore(); }
});

test("PDF clipboard worker errors reject, and a missing Windows owner cannot empty the clipboard", async () => {
  const f = fixture(); try {
    f.regular(1, [f.pdf(10, "C:\\a.pdf", 1)]);
    await assert.rejects(f.service.copy("pdf", [{ itemID: 1 }], { win: {} }), /有效窗口/u); assert.equal(f.workers.length, 0);
    const zero = { docShell: { treeOwner: { QueryInterface: () => ({ getInterface: () => ({ nativeHandle: "0x0" }) }) } } };
    await assert.rejects(f.service.copy("pdf", [{ itemID: 1 }], { win: zero }), /有效窗口/u); assert.equal(f.workers.length, 0);
    ChromeWorker = class { postMessage() { queueMicrotask(() => this.onmessage({ data: { type: "error", message: "locked" } })); } terminate() { this.terminated = true; } };
    await assert.rejects(f.service.copy("pdf", [{ itemID: 1 }], { win: f.win }), /locked/u);
  } finally { f.restore(); }
});

test("macOS file batches use per-file native pasteboard URLs rather than text paths", async () => {
  const f = fixture(); try {
    Zotero.isWin = false; Zotero.isMac = true;
    f.regular(1, [f.pdf(10, "/tmp/one.pdf", 1)]); f.regular(2, [f.pdf(20, "/tmp/two.pdf", 2)]);
    assert.equal((await f.service.copy("pdf", [{ itemID: 1 }, { itemID: 2 }], { win: f.win })).count, 2);
    assert.equal(f.workers[0].data.platform, "mac"); assert.deepEqual(f.workers[0].data.paths, ["/tmp/one.pdf", "/tmp/two.pdf"]); assert.equal(f.clipboard.length, 0);
  } finally { f.restore(); }
});

test("Windows worker retries busy clipboard without changing it and frees memory not handed to Windows", async () => {
  const source = await readFile(new URL("../addon/content/clipboard-worker.js", import.meta.url), "utf8");
  const calls = [], messages = [], handles = [], timers = []; let busy = true;
  const ptr = value => ({ value, isNull: () => !value }), functions = {
    IsWindow: handle => { calls.push(["owner", handle.value]); return 1; },
    OpenClipboard: () => { calls.push("open"); return busy ? 0 : 1; }, CloseClipboard: () => calls.push("close"), EmptyClipboard: () => { calls.push("empty"); return 1; },
    SetClipboardData: (format, handle) => { calls.push(["set", format, handle]); return ptr(1); }, RegisterClipboardFormatW: () => 77,
    GlobalAlloc: (_flags, length) => { const handle = ptr(handles.length + 1); handle.array = new Array(length); handles.push(handle); return handle; },
    GlobalLock: handle => handle, GlobalUnlock: () => {}, GlobalFree: handle => calls.push(["free", handle]),
  };
  const ctypes = { winapi_abi: {}, voidptr_t: ptr, uint32_t: {}, int32_t: {}, size_t: {}, jschar: { ptr: {} }, UInt64: value => BigInt(value),
    open: name => ({ declare: symbol => functions[symbol], close: () => calls.push(name + " closed") }),
    uint8_t: { array: () => ({ ptr: {} }) }, cast: handle => ({ contents: handle.array }) };
  const context = { ctypes, Uint8Array, DataView, setTimeout: action => timers.push(action), self: { postMessage: value => messages.push(value), close: () => calls.push("worker closed") } };
  vm.runInNewContext(source, context);
  context.self.onmessage({ data: { platform: "win", owner: "0x123456789abcdef0", bytes: dropFilesBytes(["C:\\a.pdf"]).buffer } });
  assert.equal(calls.find(call => Array.isArray(call) && call[0] === "owner")[1], 0x123456789abcdef0n);
  assert.equal(calls.includes("empty"), false); assert.equal(calls.filter(call => Array.isArray(call) && call[0] === "free").length, 2);
  busy = false; timers.shift()();
  assert.equal(messages[0].type, "copied"); assert.equal(calls.filter(call => call === "empty").length, 1);
  const writes = calls.filter(call => Array.isArray(call) && call[0] === "set"); assert.deepEqual(writes.map(call => call[1]), [77, 15]);
  assert.deepEqual(writes[0][2].array, [1, 0, 0, 0]); assert.equal(calls.filter(call => Array.isArray(call) && call[0] === "free").length, 2);
  functions.IsWindow = () => 0;
  context.self.onmessage({ data: { platform: "win", owner: "12345", bytes: dropFilesBytes(["C:\\a.pdf"]).buffer } });
  assert.equal(messages.at(-1).type, "error"); assert.match(messages.at(-1).message, /window has closed/u);
  assert.equal(calls.filter(call => call === "empty").length, 1);
  context.self.onmessage({ data: { platform: "win", owner: "0", bytes: dropFilesBytes(["C:\\a.pdf"]).buffer } });
  assert.match(messages.at(-1).message, /Invalid clipboard owner/u);
});

async function windowsWorker() {
  const source = await readFile(new URL("../addon/content/clipboard-worker.js", import.meta.url), "utf8"), calls = [], messages = [], handles = [], timers = [];
  const ptr = value => ({ value, isNull: () => !value }), functions = {
    IsWindow: () => 1,
    OpenClipboard: () => { calls.push("open"); return 1; }, CloseClipboard: () => { calls.push("close"); return 1; },
    EmptyClipboard: () => { calls.push("empty"); return 1; },
    SetClipboardData: (format, handle) => { calls.push(["set", format, handle]); return ptr(1); },
    RegisterClipboardFormatW: name => { calls.push(["register", name]); return 77; },
    GlobalAlloc: (_flags, length) => { const handle = ptr(handles.length + 1); handle.array = new Array(length); handles.push(handle); calls.push(["alloc", handle]); return handle; },
    GlobalLock: handle => handle, GlobalUnlock: () => 1, GlobalFree: handle => calls.push(["free", handle]),
  };
  const ctypes = { winapi_abi: {}, winLastError: 5, voidptr_t: ptr, uint32_t: {}, int32_t: {}, size_t: {}, jschar: { ptr: {} }, UInt64: value => BigInt(value),
    open: name => ({ declare: symbol => (...args) => functions[symbol](...args), close: () => calls.push(["libraryClose", name]) }),
    uint8_t: { array: () => ({ ptr: {} }) }, cast: handle => ({ contents: handle.array }) };
  const context = { ctypes, Uint8Array, DataView, setTimeout: action => timers.push(action), self: { postMessage: value => messages.push(value), close() {} } };
  vm.runInNewContext(source, context);
  return { ptr, ctypes, functions, calls, handles, messages, timers, invoke: payload => context.self.onmessage({ data: { platform: "win", owner: "0x1234", ...payload } }) };
}

test("Windows reference worker writes exact Unicode and CF_HTML formats and hands off both prepared buffers", async () => {
  const f = await windowsWorker(), payload = referenceClipboardBytes("中文 😀", "<i>中文 😀</i>");
  f.invoke({ kind: "references", ...payload });
  assert.equal(f.messages.at(-1).type, "copied"); assert.equal(f.calls.includes("close"), true);
  const written = f.calls.filter(call => Array.isArray(call) && call[0] === "set");
  assert.deepEqual(written.map(call => call[1]), [13, 77]);
  assert.deepEqual(written[0][2].array, [...new Uint8Array(payload.textBytes)]);
  assert.deepEqual(written[1][2].array, [...new Uint8Array(payload.htmlBytes)]);
  assert.deepEqual(f.calls.filter(call => Array.isArray(call) && call[0] === "register").map(call => call[1]), ["HTML Format"]);
  assert.equal(f.calls.filter(call => Array.isArray(call) && call[0] === "free").length, 0);
  assert.ok(f.calls.findLastIndex(call => Array.isArray(call) && call[0] === "alloc") < f.calls.indexOf("empty"));
  assert.equal(f.calls.filter(call => Array.isArray(call) && call[0] === "libraryClose").length, 2);
});

test("Windows reference worker rejects malformed types, termini, sizes and byte offsets before accessing the clipboard", async () => {
  const good = referenceClipboardBytes("中文", "<i>中文</i>"), corrupt = good.htmlBytes.slice(0);
  new Uint8Array(corrupt).set(new TextEncoder().encode("0000000001"), 23);
  const invalid = [
    { kind: "unexpected" },
    { kind: "references", ...good, textBytes: [1, 2] },
    { kind: "references", ...good, textBytes: new ArrayBuffer(3) },
    { kind: "references", ...good, textBytes: new Uint8Array([65, 0]).buffer },
    { kind: "references", ...good, textBytes: new Uint8Array([0, 0, 0, 0]).buffer },
    { kind: "references", ...good, htmlBytes: corrupt },
    { kind: "references", ...good, textBytes: new ArrayBuffer(16 * 1024 * 1024) },
    { kind: "files", bytes: [20, 1] },
  ];
  for (const payload of invalid) {
    const f = await windowsWorker(); f.invoke(payload);
    assert.equal(f.messages.at(-1).type, "error"); assert.equal(f.calls.length, 0);
  }
});

test("Windows reference failures never report copied and free only handles that Windows has not accepted", async () => {
  for (const stage of ["register", "allocate", "lock", "empty", "unicode", "html", "close", "kernel32"]) {
    const f = await windowsWorker(), payload = referenceClipboardBytes("中文 😀", "<i>中文 😀</i>");
    if (stage === "register") f.functions.RegisterClipboardFormatW = () => 0;
    if (stage === "allocate") f.functions.GlobalAlloc = () => f.ptr(0);
    if (stage === "lock") f.functions.GlobalLock = () => f.ptr(0);
    if (stage === "empty") f.functions.EmptyClipboard = () => { f.calls.push("empty"); return 0; };
    if (["unicode", "html"].includes(stage)) f.functions.SetClipboardData = (format, handle) => {
      f.calls.push(["set", format, handle]); return f.ptr(format === (stage === "unicode" ? 13 : 77) ? 0 : 1);
    };
    if (stage === "close") f.functions.CloseClipboard = () => { f.calls.push("close"); return 0; };
    if (stage === "kernel32") {
      const open = f.ctypes.open;
      f.ctypes.open = name => { if (name === "kernel32.dll") throw new Error("kernel32 load failed"); return open(name); };
    }
    f.invoke({ kind: "references", ...payload });
    assert.equal(f.messages.at(-1).type, "error", stage); assert.equal(f.messages.some(message => message.type === "copied"), false, stage);
    const freed = f.calls.filter(call => Array.isArray(call) && call[0] === "free").map(call => call[1]);
    const accepted = stage === "html" ? [f.handles[0]] : stage === "close" ? f.handles : [];
    assert.deepEqual(freed, f.handles.filter(handle => !accepted.includes(handle)), stage);
    assert.equal(f.calls.filter(call => Array.isArray(call) && call[0] === "libraryClose").length, stage === "kernel32" ? 1 : 2, stage);
    if (["register", "allocate", "lock", "kernel32"].includes(stage)) assert.equal(f.calls.includes("empty"), false, stage);
    else assert.equal(f.calls.filter(call => call === "close").length, 1, stage);
    if (stage === "html") assert.match(f.messages.at(-1).message, /CF_HTML.*Windows 5/u);
  }
});

test("Windows reference busy retries are bounded and never clear the clipboard before it opens", async () => {
  const f = await windowsWorker(); f.functions.OpenClipboard = () => { f.calls.push("open"); return 0; };
  f.invoke({ kind: "references", ...referenceClipboardBytes("A", "<i>A</i>") });
  for (let i = 0; f.timers.length && i < 30; i++) f.timers.shift()();
  assert.equal(f.timers.length, 0); assert.equal(f.calls.filter(call => call === "open").length, 21);
  assert.equal(f.calls.includes("empty"), false); assert.equal(f.messages.at(-1).type, "error");
  assert.match(f.messages.at(-1).message, /Windows 5/u);
  assert.equal(f.calls.filter(call => Array.isArray(call) && call[0] === "free").length, f.handles.length);
});

test("macOS worker loads AppKit, writes file URLs and releases libraries on success and failure", async () => {
  const source = await readFile(new URL("../addon/content/clipboard-worker.js", import.meta.url), "utf8");
  const calls = [], messages = [];
  const ptr = value => ({ value, isNull: () => !value }); let write = true, failAppkit = false;
  const ctypes = { default_abi: {}, voidptr_t: {}, char: { ptr: {} }, void_t: {}, intptr_t: {}, size_t: {}, bool: {},
    open(name) {
      calls.push(["open", name]);
      if (failAppkit && name.includes("AppKit")) throw new Error("AppKit load failed");
      return { close: () => calls.push(["close", name]), declare(symbol) {
        if (symbol === "objc_getClass") return name => {
          if (name === "NSPasteboard") assert.ok(calls.some(call => call[0] === "open" && call[1].includes("AppKit")));
          return ptr(name);
        };
        if (symbol === "sel_registerName") return name => name;
        return (object, selector, value) => {
          calls.push([selector, value?.value ?? value]);
          if (selector === "writeObjects:") return write;
          if (selector === "stringWithUTF8String:") return ptr(value);
          if (selector === "fileURLWithPath:") return ptr("file:" + value.value);
          if (selector === "clearContents") return 1;
          return ptr(selector === "init" ? "pool" : selector);
        };
      } };
    } };
  const context = { ctypes, Uint8Array, DataView, setTimeout() { throw new Error("Mac should not retry"); }, self: { postMessage: value => messages.push(value), close() {} } };
  vm.runInNewContext(source, context);
  const invoke = () => context.self.onmessage({ data: { platform: "mac", paths: ["/tmp/文献.pdf", "/tmp/two.pdf"] } });
  invoke(); assert.equal(messages.at(-1).type, "copied");
  assert.deepEqual(calls.filter(call => call[0] === "fileURLWithPath:").map(call => call[1]), ["/tmp/文献.pdf", "/tmp/two.pdf"]);
  assert.equal(calls.filter(call => call[0] === "drain").length, 1);
  assert.equal(calls.filter(call => call[0] === "close").length, 3);
  write = false; invoke(); assert.match(messages.at(-1).message, /writeObjects failed/u);
  assert.equal(calls.filter(call => call[0] === "drain").length, 2);
  assert.equal(calls.filter(call => call[0] === "close").length, 6);
  failAppkit = true; invoke(); assert.match(messages.at(-1).message, /AppKit load failed/u);
  assert.equal(calls.at(-1)[0], "close"); assert.match(calls.at(-1)[1], /Foundation/u);
});
