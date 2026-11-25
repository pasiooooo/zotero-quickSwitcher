import test from "node:test";
import assert from "node:assert/strict";
import { OutlineService } from "../src/outline.mjs";
import * as outlineTree from "../src/outline-tree.mjs";

test("current outline follows the focused split path and falls back to the closest preceding page", () => {
  const rows = [
    { outlineKey: "0", pageIndex: 0, location: { pageIndex: 0 } },
    { outlineKey: "0.0", pageIndex: 3, location: { pageIndex: 3 } },
    { outlineKey: "1", pageIndex: 6, location: { pageIndex: 6 } },
    { outlineKey: "2", pageIndex: 6, location: undefined },
  ];
  const state = { primary: false, primaryViewStats: { pageIndex: 0, outlinePath: [0] }, secondaryViewStats: { pageIndex: 7, outlinePath: [1] } };
  const reader = { _internalReader: { _state: state } };
  assert.equal(outlineTree.currentOutlineRow(rows, reader), rows[2]);
  state.secondaryViewStats.outlinePath = [0, 0, 2]; assert.equal(outlineTree.currentOutlineRow(rows, reader), rows[1]);
  state.secondaryViewStats.outlinePath = null; assert.equal(outlineTree.currentOutlineRow(rows, reader), rows[2]);
  state.secondaryViewStats.pageIndex = 4; assert.equal(outlineTree.currentOutlineRow(rows, reader), rows[1]);
  assert.equal(outlineTree.currentOutlineRow(rows, null), null); assert.equal(outlineTree.currentOutlineRow([], reader), null);
});

test("native outline following replaces the original scroll once, preserves bottom and restores its owned hook", async () => {
  const saved = globalThis.Zotero, nativeCalls = [], service = Object.create(OutlineService.prototype); let handler, removedHandler, keydown, removedKeydown;
  const container = { scrollTop: 0, scrollHeight: 1000, clientHeight: 200, clientTop: 0, getBoundingClientRect: () => ({ top: 0 }) };
  class FakeElement {
    scrollIntoView(options) { nativeCalls.push(options); }
    matches() { return !!this.outline; }
    closest() { return this.outline ? {} : null; }
    getBoundingClientRect() { return { top: 300 - container.scrollTop, bottom: 332 - container.scrollTop }; }
  }
  const original = FakeElement.prototype.scrollIntoView;
  const doc = { defaultView: { Element: FakeElement }, getElementById: id => id === "sidebarContent" ? container : null,
    addEventListener(type, callback) { assert.equal(type, "keydown"); keydown = callback; },
    removeEventListener(type, callback) { assert.equal(type, "keydown"); removedKeydown = callback; } };
  Object.assign(service, { io: { read: async () => "" }, currentLoads: new Map(), interests: new Map(), cache: new Map(), epoch: 0, flush: async () => {}, onError(error) { throw error; } });
  globalThis.Zotero = { DataDirectory: { dir: "fixture" }, Reader: { _readers: [{ _initPromise: Promise.resolve(), _iframeWindow: { document: doc } }],
    registerEventListener(type, callback) { assert.equal(type, "renderToolbar"); handler = callback; },
    unregisterEventListener(type, callback) { assert.equal(type, "renderToolbar"); removedHandler = callback; } }, Notifier: { unregisterObserver() {} } };
  try {
    await service.init(); handler({ doc });
    const replacement = FakeElement.prototype.scrollIntoView, row = new FakeElement(); row.outline = true;
    assert.notEqual(replacement, original);
    handler({ doc }); assert.equal(FakeElement.prototype.scrollIntoView, replacement);
    row.scrollIntoView({ block: "nearest" }); assert.equal(container.scrollTop, 300); assert.deepEqual(nativeCalls, []);
    container.scrollTop = 800; row.scrollIntoView({ block: "nearest" }); assert.equal(container.scrollTop, 800);
    keydown({ key: "ArrowUp", target: row }); row.scrollIntoView({ block: "nearest" }); assert.equal(container.scrollTop, 300);
    await Promise.resolve();
    new FakeElement().scrollIntoView({ block: "nearest" }); assert.deepEqual(nativeCalls, [{ block: "nearest" }]);
    await service.destroy(); assert.equal(FakeElement.prototype.scrollIntoView, original); assert.equal(removedHandler, handler); assert.equal(removedKeydown, keydown);
    service.followOutline(doc); assert.equal(FakeElement.prototype.scrollIntoView, original);
  } finally { globalThis.Zotero = saved; }
});

test("outline switching targets its originating Reader instance and rejects a stale one", async () => {
  const saved = { Zotero: globalThis.Zotero, Components: globalThis.Components };
  const events = [];
  const closeButtons = [];
  const document = { getElementById: id => id === "secondary-view" ? { append(node) { closeButtons.push(node); } } : null,
    createElement: () => ({ style: {}, listeners: {}, setAttribute() {}, remove() { this.removed = true; }, addEventListener(type, listener) { this.listeners[type] = listener; } }) };
  const make = name => ({ itemID: 11, _initPromise: Promise.resolve(), _iframeWindow: { document }, _window: { closed: false, innerWidth: 900, innerHeight: 600, focus() {} },
    async navigate(location) { events.push([name, "primary", location.pageIndex]); }, async focus() {},
    _internalReader: { primaryPage: 1, _state: { primaryViewStats: { pageIndex: 1 } }, _primaryView: { async navigate(location) { events.push([name, "restore", location.pageIndex]); } }, toggleVerticalSplit() { events.push([name, "vertical"]); this._secondaryView = { initializedPromise: Promise.resolve(), async navigate(location) { events.push([name, "secondary", location.pageIndex]); } }; },
      disableSplitView() { events.push([name, "close"]); }, focusView(primary) { events.push([name, "focus", primary]); } } });
  const first = make("first"), current = make("current"), service = Object.create(OutlineService.prototype);
  globalThis.Zotero = { Items: { getAsync: async () => ({ isPDFAttachment: () => true, getFilePathAsync: async () => "fixture.pdf" }) }, Reader: { _readers: [first, current] } };
  globalThis.Components = { utils: { cloneInto: value => value } };
  try {
    const row = { attachmentID: 11, location: { pageIndex: 3 } };
    await service.open(row, { reader: current });
    assert.deepEqual(events, [["current", "primary", 3]]);
    events.length = 0;
    await service.open(row, { reader: current, split: true });
    assert.deepEqual(events, [["current", "vertical"], ["current", "secondary", 3], ["current", "restore", 1], ["current", "focus", false]]);
    assert.equal(current._internalReader.primaryPage, 1);
    assert.equal(closeButtons.length, 1);
    closeButtons[0].listeners.click();
    assert.equal(closeButtons[0].removed, true);
    assert.deepEqual(events.at(-1), ["current", "close"]);
    current._window.closed = true;
    await assert.rejects(service.open(row, { reader: current }), /PDF/);
  } finally { globalThis.Zotero = saved.Zotero; globalThis.Components = saved.Components; }
});

test("stopping outline services removes split controls without closing a native split", async () => {
  const saved = globalThis.Zotero; let removed = 0, unregistered = false;
  const reader = { _iframeWindow: { document: { getElementById: id => id === "qs-split-close" ? { remove() { removed++; } } : null } } };
  const closed = { get _iframeWindow() { throw new Error("Closed reader"); } };
  const service = Object.create(OutlineService.prototype);
  Object.assign(service, { currentLoads: new Map(), interests: new Set(), cache: new Map(), epoch: 0, flush: async () => {} });
  globalThis.Zotero = { Reader: { _readers: [reader, closed] }, Notifier: { unregisterObserver() { unregistered = true; } } };
  try { await service.destroy(); assert.equal(removed, 1); assert.equal(unregistered, true); assert.equal(service.destroyed, true); }
  finally { globalThis.Zotero = saved; }
});
