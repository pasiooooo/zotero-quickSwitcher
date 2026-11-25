import test from "node:test";
import assert from "node:assert/strict";
import { initialPDFPage, localPDF, PDFPreview, PDFOutlineLoader } from "../src/pdf-preview.mjs";

function attachment(id, path, isPDF = true) {
  return { id, isRegularItem: () => false, isPDFAttachment: () => isPDF, getFilePathAsync: async () => path };
}
function library(items) { globalThis.Zotero = { Items: { getAsync: async id => items.get(id) } }; }
test("opened tab previews read the current focused PDF pane rather than cached primary positions", async () => {
  library(new Map([[4, { getAttachmentLastPageIndex: () => 1 }]]));
  const state = { primary: true, primaryViewStats: { pageIndex: 12 }, secondaryViewStats: { pageIndex: 24 } };
  const reader = { itemID: 4, _internalReader: { _state: state } };
  Zotero.Reader = { getByTabID: id => id === "tab-4" ? reader : null };
  const row = { kind: "tab", tabID: "tab-4", attachmentID: 4 };
  assert.equal(await initialPDFPage(row, 4), 12);
  state.primary = false; assert.equal(await initialPDFPage(row, 4), 24);
  state.secondaryViewStats.pageIndex = 0; assert.equal(await initialPDFPage(row, 4), 0);
  assert.deepEqual(state.primaryViewStats, { pageIndex: 12 });
});
test("separate readers of one PDF keep their own live page and closed or unloaded tabs use the stored page", async () => {
  library(new Map([[4, { getAttachmentLastPageIndex: () => 7 }]]));
  const reader = index => ({ itemID: 4, _internalReader: { _state: { primary: true, primaryViewStats: { pageIndex: index } } } });
  const a = { kind: "reader", attachmentID: 4, reader: reader(2) }, b = { ...a, reader: reader(18) };
  assert.equal(await initialPDFPage(a, 4), 2); assert.equal(await initialPDFPage(b, 4), 18);
  a.win = { closed: true }; assert.equal(await initialPDFPage(a, 4), 7);
  assert.equal(await initialPDFPage({ kind: "tab", attachmentID: 4, tabID: "unloaded" }, 4), 7);
});
test("invalid or absent reading positions fall back safely and never apply an EPUB or another PDF position", async () => {
  let saved = 3;
  library(new Map([[4, { getAttachmentLastPageIndex: () => saved }]]));
  const state = { primary: true, primaryViewStats: { pageIndex: NaN } };
  const row = { kind: "reader", attachmentID: 4, reader: { itemID: 4, _internalReader: { _state: state } } };
  assert.equal(await initialPDFPage(row, 4), 3);
  for (const value of [-1, NaN, Infinity, 1.5, undefined, "4"]) { saved = value; assert.equal(await initialPDFPage(row, 4), 0); }
  assert.equal(await initialPDFPage(row, 5), 0);
  assert.equal(await initialPDFPage({ ...row, kind: "item" }, 4), 0);
  Object.defineProperty(row.reader, "_internalReader", { get: () => { throw new Error("unavailable"); } }); saved = 6;
  assert.equal(await initialPDFPage(row, 4), 6);
});
test("PDF preview prefers the selected reader attachment and otherwise the first available native PDF", async () => {
  const missing = attachment(2, false), available = attachment(3, "/paper.pdf"), reader = attachment(4, "/reader.pdf"), epub = attachment(5, "/book.epub", false);
  const parent = { isRegularItem: () => true, getBestAttachments: async () => [missing, epub, available] };
  library(new Map([[1, parent], [2, missing], [3, available], [4, reader], [5, epub], [6, false]]));
  assert.deepEqual(await localPDF(1, 4), { attachmentID: 4, path: "/reader.pdf" });
  assert.deepEqual(await localPDF(1, 5), { attachmentID: 3, path: "/paper.pdf" });
  assert.deepEqual(await localPDF(1, 6), { attachmentID: 3, path: "/paper.pdf" });
  assert.deepEqual(await localPDF(3), { attachmentID: 3, path: "/paper.pdf" });
  assert.deepEqual(await localPDF(2), { unavailable: "PDF 不在本机" });
  assert.deepEqual(await localPDF(5), { unavailable: "无 PDF 附件" });
});

function windowFixture() {
  const messages = [], listeners = new Map();
  class Node {
    constructor() { this.children = []; this.dataset = {}; this.style = {}; this.attributes = {}; }
    setAttribute(name, value) { this.attributes[name] = value; }
    append(...children) { this.children.push(...children); }
    remove() { this.removed = true; }
    addEventListener() {}
  }
  const win = { crypto: { randomUUID: () => "fixture-session" }, setTimeout, clearTimeout, document: { createElementNS: (_, name) => {
    const node = new Node(); if (name === "iframe") node.contentWindow = { postMessage: value => messages.push(value) }; return node;
  } }, addEventListener: (type, listener) => listeners.set(type, listener), removeEventListener: (type, listener) => { if (listeners.get(type) === listener) listeners.delete(type); } };
  return { win, messages, listeners };
}
test("preview creation does no PDF I/O and closing during attachment lookup prevents a later read or frame", async () => {
  const fixture = windowFixture(); let resolvePath, reads = 0;
  library(new Map([[1, { isRegularItem: () => false, isPDFAttachment: () => true, id: 1, getFilePathAsync: () => new Promise(resolve => { resolvePath = resolve; }) }]]));
  globalThis.IOUtils = { read: async () => { reads++; return new Uint8Array([1]); } };
  const preview = new PDFPreview(fixture.win);
  assert.equal(reads, 0); assert.equal(preview.frame, undefined);
  const pending = preview.load({ itemID: 1 });
  await new Promise(setImmediate); preview.destroy(); resolvePath("/late.pdf"); await pending;
  assert.equal(reads, 0); assert.equal(preview.frame, null); assert.equal(fixture.listeners.size, 0);
});
test("PDF data waits for its own frame, sends once, and destruction retires messages and resources", async () => {
  const fixture = windowFixture(); library(new Map([[1, attachment(1, "/preview.pdf")]]));
  globalThis.IOUtils = { read: async () => new Uint8Array([37, 80, 68, 70]) };
  let closed = 0, scroll = 0;
  const preview = new PDFPreview(fixture.win, { onClose: () => closed++, onScroll: delta => scroll += delta });
  await preview.load({ itemID: 1 });
  assert.equal(fixture.messages.length, 0);
  const notify = (type, values = {}, source = preview.frame.contentWindow, origin) => preview.onMessage({ source, origin, data: { channel: "quickswitcher-pdf", session: preview.session, type, ...values } });
  notify("ready", {}, {}); assert.equal(fixture.messages.length, 0);
  notify("ready", { session: "other" }, null, "chrome://quickswitcher"); notify("ready", {}, null, "chrome://other"); assert.equal(fixture.messages.length, 0);
  notify("ready", {}, null, "chrome://quickswitcher"); notify("ready"); assert.equal(fixture.messages.length, 1); assert.deepEqual([...fixture.messages[0].bytes], [37, 80, 68, 70]);
  assert.equal(fixture.messages[0].pageIndex, 0);
  notify("height", { height: Infinity }); assert.equal(preview.frame.style.height, undefined);
  notify("rendered", { page: 1 }); assert.equal(preview.root.dataset.state, "ready");
  notify("scroll", { delta: 72 }); notify("close"); assert.equal(scroll, 72); assert.equal(closed, 1);
  const frame = preview.frame; preview.destroy(); assert.equal(frame.removed, true); assert.equal(fixture.messages.at(-1).type, "destroy"); assert.equal(fixture.listeners.size, 0);
});
test("lazy preview reads the latest tab page after file I/O and sends a zero-based starting page", async () => {
  const fixture = windowFixture(); library(new Map([[4, attachment(4, "/preview.pdf")]]));
  const state = { primary: true, primaryViewStats: { pageIndex: 1 } };
  Zotero.Reader = { getByTabID: () => ({ itemID: 4, _internalReader: { _state: state } }) };
  let releaseRead;
  globalThis.IOUtils = { read: () => new Promise(resolve => { releaseRead = resolve; }) };
  const preview = new PDFPreview(fixture.win);
  const pending = preview.load({ kind: "tab", tabID: "tab-4", itemID: 4, attachmentID: 4 });
  await new Promise(setImmediate); state.primaryViewStats.pageIndex = 9; releaseRead(new Uint8Array([1])); await pending;
  preview.onMessage({ source: preview.frame.contentWindow, data: { channel: "quickswitcher-pdf", session: preview.session, type: "ready" } });
  assert.equal(fixture.messages[0].pageIndex, 9); assert.equal(state.primaryViewStats.pageIndex, 9);
  preview.destroy();
});
test("missing and failed local PDFs keep a readable status without constructing a reader", async () => {
  const fixture = windowFixture(); library(new Map([[1, attachment(1, false)]]));
  const preview = new PDFPreview(fixture.win); await preview.load({ itemID: 1 });
  assert.equal(preview.root.dataset.state, "unavailable"); assert.equal(preview.status.textContent, "PDF 不在本机"); assert.equal(preview.frame, undefined);
  library(new Map([[2, attachment(2, "/failed.pdf")]])); globalThis.IOUtils = { read: async () => { throw new Error("locked"); } };
  await preview.load({ itemID: 2 }); assert.equal(preview.root.dataset.state, "error"); assert.equal(preview.status.title, "locked"); preview.destroy();
});

test("background outline batches reuse one iframe and reject responses from an earlier PDF request", async () => {
  const f = windowFixture(); f.win.document.documentElement = { append() {} };
  globalThis.IOUtils = { read: async () => new Uint8Array([37, 80, 68, 70]) };
  const loader = new PDFOutlineLoader(f.win), rows = [{ title: "Methods", outlineKey: "0" }];
  const first = loader.read("/one.pdf"); await new Promise(setImmediate);
  const frame = loader.frame;
  const notify = (type, request, source = frame.contentWindow, session = loader.session) => loader.message({ source, data: { channel: "quickswitcher-pdf", type, request, session, rows } });
  notify("ready"); assert.equal(f.messages.length, 1); const one = f.messages[0].request;
  notify("outline", one, {}); notify("outline", one, frame.contentWindow, "wrong-session"); assert.ok(loader.pending);
  notify("outline", one); assert.deepEqual(await first, rows); assert.equal(loader.frame, frame); assert.equal(frame.removed, undefined);
  const second = loader.read("/two.pdf"); await new Promise(setImmediate); const two = f.messages[1].request;
  assert.notEqual(one, two); assert.equal(loader.frame, frame);
  notify("outline", one); assert.ok(loader.pending); notify("outline", two); assert.deepEqual(await second, rows);
  const cancelled = loader.read("/cancelled.pdf"); await new Promise(setImmediate); loader.destroy();
  await assert.rejects(cancelled, /cancelled/); assert.equal(f.listeners.size, 0); assert.equal(frame.removed, true);
});
