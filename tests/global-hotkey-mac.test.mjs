import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MacGlobalHotkey, macHotkeyFromShortcut, macScreenBounds } from "../src/global-hotkey-mac.mjs";

const signature = 0x51537774, pressed = { signature, id: 1, kind: 5 }, released = { ...pressed, kind: 6 };
const app = { name: "Microsoft PowerPoint", path: "/Applications/Microsoft PowerPoint.app/Contents/MacOS/Microsoft PowerPoint" };
const screen = { left: -1920, top: -155, width: 1920, height: 1055, scale: 1 };

test("macOS maps modifier chords and physical ANSI keys, including zero-valued A", () => {
  for (const [value, expected] of [
    ["Alt+O", { keyCode: 31, modifiers: 2048 }], ["Alt+A", { keyCode: 0, modifiers: 2048 }],
    ["Accel+Shift+K", { keyCode: 40, modifiers: 256 | 512 }], ["Ctrl+Alt+1", { keyCode: 18, modifiers: 4096 | 2048 }],
    ["Alt+;", { keyCode: 41, modifiers: 2048 }], ["Alt+:", { keyCode: 41, modifiers: 2048 | 512 }],
    ["Alt+’", { keyCode: 39, modifiers: 2048 }], ["Alt+?", { keyCode: 44, modifiers: 2048 | 512 }],
    ["Cmd+Return", { keyCode: 36, modifiers: 256 }], ["Ctrl+ArrowDown", { keyCode: 125, modifiers: 4096 }],
    ["F12", { keyCode: 111, modifiers: 0 }], ["Ctrl+F20", { keyCode: 90, modifiers: 4096 }],
  ]) assert.deepEqual(macHotkeyFromShortcut(value), expected);
  for (const value of ["", "O", "Shift+O", "Alt", "Alt+O+P", "F21", "Ctrl+F24", "Alt+constructor", "Alt+€", null]) assert.throws(() => macHotkeyFromShortcut(value));
});

test("pointer screen uses visibleFrame, flips Y, and preserves negative coordinates and Retina scale", () => {
  const screens = [
    { frame: { x: 0, y: 0, width: 1440, height: 900 }, visibleFrame: { x: 0, y: 50, width: 1440, height: 825 }, scale: 2 },
    { frame: { x: -1920, y: 300, width: 1920, height: 1080 }, visibleFrame: { x: -1920, y: 300, width: 1920, height: 1055 }, scale: 1.5 },
  ];
  assert.deepEqual(macScreenBounds({ x: 200, y: 200 }, screens), { left: 0, top: 50, width: 2880, height: 1650, scale: 2 });
  assert.deepEqual(macScreenBounds({ x: -400, y: 600 }, screens), { left: -2880, top: -682, width: 2880, height: 1582, scale: 1.5 });
  assert.equal(macScreenBounds({ x: 9999, y: 100 }, screens), null);
  assert.equal(macScreenBounds(null, screens), null);
  assert.equal(macScreenBounds({ x: 200, y: 200 }, [{ ...screens[0], scale: 0 }]), null);
});

function fakeHost(t, options = {}) {
  const previous = globalThis.Zotero, interval = globalThis.setInterval, clear = globalThis.clearInterval;
  globalThis.Zotero = { isMac: options.isMac !== false };
  const intervals = [], queued = [], calls = [], errors = [], triggers = [];
  globalThis.setInterval = (fn, ms) => { const token = { fn, ms }; intervals.push(token); return token; };
  globalThis.clearInterval = token => { token.cleared = true; };
  t.after(() => { globalThis.Zotero = previous; globalThis.setInterval = interval; globalThis.clearInterval = clear; });
  const api = {
    app, receive: null, removeError: null,
    install(receive) { calls.push("install"); this.receive = receive; if (options.installError) throw options.installError; },
    register(hotkey) { calls.push(["register", hotkey]); if (options.registerError) throw options.registerError; },
    readEvent(event) { if (options.readError) throw options.readError; return event; },
    frontApp() { if (this.app instanceof Error) throw this.app; return this.app; },
    cursorScreen() { if (options.screenError) throw options.screenError; return screen; },
    removeHotkey() { calls.push("removeHotkey"); if (this.removeError) throw this.removeError; this.receive = null; },
    stop() { this.removeHotkey(); calls.push("closeLibraries"); },
  };
  const view = new MacGlobalHotkey({ apiFactory: () => { calls.push("open"); return api; }, queue: fn => { queued.push(fn); return queued.length; } });
  const flush = () => { while (queued.length) queued.shift()(); };
  return { view, api, calls, queued, intervals, errors, triggers, flush,
    start: shortcut => view.start(shortcut, (screen, app) => triggers.push({ screen, app }), error => errors.push(error)) };
}

test("registration filters foreign events, suppresses repeats and captures source before deferred activation", async t => {
  const env = fakeHost(t); assert.equal(await env.start("Alt+O"), true);
  assert.deepEqual(env.calls[2], ["register", { keyCode: 31, modifiers: 2048 }]);
  assert.equal(env.intervals[0].ms, 250);
  const receive = env.api.receive;
  for (const event of [null, { ...pressed, signature: 44 }, { ...pressed, id: 99 }, { ...pressed, kind: 1 }]) assert.equal(receive(event), -9874);
  assert.equal(receive(pressed), 0); assert.equal(receive(pressed), 0); assert.equal(env.queued.length, 1);
  env.api.app = { name: "Microsoft Word", path: "/Applications/Microsoft Word.app/Contents/MacOS/Microsoft Word" };
  env.intervals[0].fn(); env.flush();
  assert.deepEqual(env.triggers, [{ screen, app }]);
  assert.equal(receive(released), 0); assert.equal(receive(pressed), 0);
  await env.view.stop(); env.flush();
  assert.equal(env.triggers.length, 1); assert.equal(receive(pressed), -9874);
  assert.equal(env.intervals[0].cleared, true); assert.equal(env.view.api, null); assert.equal(env.view.sourceApp, null);
  assert.deepEqual(env.calls.slice(-2), ["removeHotkey", "closeLibraries"]);
  await env.view.stop();
});

test("conflicts preserve app tracking after removing the handler, and unknown apps clear old identity", async t => {
  const env = fakeHost(t, { registerError: Object.assign(new Error("occupied"), { code: -9878 }) });
  await assert.rejects(env.start("Alt+O"), error => error.code === -9878 && error.message.includes("Alt+O"));
  assert.equal(env.api.receive, null); assert.equal(env.view.api, env.api); assert.equal(env.intervals[0].cleared, undefined);
  assert.deepEqual(env.view.sourceApp, app);
  env.api.app = { own: true }; env.intervals[0].fn(); assert.deepEqual(env.view.sourceApp, app);
  env.api.app = { name: "Microsoft Word", path: "/Applications/Microsoft Word.app/Contents/MacOS/Microsoft Word" };
  env.intervals[0].fn(); assert.equal(env.view.sourceApp.name, "Microsoft Word");
  env.api.app = null; env.intervals[0].fn(); assert.equal(env.view.sourceApp, null);
  env.api.app = new Error("nil app"); env.intervals[0].fn(); assert.equal(env.view.sourceApp, null);
  await env.view.stop(); assert.equal(env.intervals[0].cleared, true); assert.equal(env.view.api, null);
});

test("empty chords track without handlers, failed setup unwinds, and replaced starts cannot fire", async t => {
  const env = fakeHost(t); assert.equal(await env.start(""), true);
  assert.deepEqual(env.calls, ["open"]); assert.equal(env.view.sourceApp.name, "Microsoft PowerPoint");
  await env.view.stop();
  const stale = env.start("Alt+O"), current = env.start("Alt+P");
  assert.equal(await stale, false); assert.equal(await current, true);
  await env.view.stop();
  env.api.register = () => { throw Object.assign(new Error("invalid native parameter"), { code: -50 }); };
  await assert.rejects(env.start("Alt+O"), error => error.code === -50);
  assert.equal(env.view.api, null); assert.equal(env.view.sourceApp, null);
});

test("failed removal retains native resources and rejects stop, then can be retried safely", async t => {
  const env = fakeHost(t); await env.start("Alt+O"); const receive = env.api.receive;
  env.api.removeError = Object.assign(new Error("RemoveEventHandler"), { code: -50 });
  await assert.rejects(env.view.stop(), /RemoveEventHandler/);
  assert.equal(env.view.api, env.api); assert.equal(env.api.receive, receive); assert.equal(receive(pressed), -9874);
  assert.ok(!env.calls.includes("closeLibraries"));
  env.api.removeError = null; await env.view.stop(); assert.equal(env.view.api, null);
});

test("native-event failures return a C status, while deferred trigger errors report once", async t => {
  const env = fakeHost(t, { screenError: new Error("screen missing") }); await env.start("Alt+O");
  assert.equal(env.api.receive(pressed), 0); env.flush(); assert.equal(env.triggers[0].screen, null);
  await env.view.stop();
  await env.view.start("Alt+O", () => Promise.reject(new Error("deferred failure")), error => env.errors.push(error));
  assert.equal(env.api.receive(pressed), 0); env.flush(); await Promise.resolve();
  assert.equal(env.errors.length, 1); assert.match(env.errors[0].message, /deferred failure/);
  await env.view.stop();
});

test("off-macOS does not load native libraries", async t => {
  const env = fakeHost(t, { isMac: false }); assert.equal(await env.start("Alt+O"), false); assert.deepEqual(env.calls, []);
});

test("actual native declarations pass by-value IDs and an element pointer, choose NSRect ABI, and retain callbacks on removal failure", t => {
  const priorServices = globalThis.Services, priorChrome = globalThis.ChromeUtils;
  t.after(() => { globalThis.Services = priorServices; globalThis.ChromeUtils = priorChrome; });
  const source = readFileSync(new URL("../src/global-hotkey-mac.mjs", import.meta.url), "utf8");
  const declaration = source.slice(source.indexOf("function createMacAPI()"), source.indexOf("\nexport class"));
  const createAPI = new Function("macScreenBounds", "nativeError", "number", "SIGNATURE", "HOTKEY_ID", "NOT_HANDLED", "KEYBOARD", "PRESSED", "RELEASED", "DIRECT_OBJECT", "HOTKEY_TYPE", `return (${declaration})`)(
    macScreenBounds, (name, code) => Object.assign(new Error(name), { code }), value => Number(value.toString()), signature, 1, -9874, 0x6b657962, 5, 6, 0x2d2d2d2d, 0x686b6964);
  for (const arch of ["aarch64-gcc3", "x86_64-gcc3"]) {
    const calls = [], state = { callback: null, removeCode: 0 }, nil = () => ({ isNull: () => true }), pointer = value => ({ value, isNull: () => false, readString: () => value });
    const Ptr = () => { const value = { null: true, isNull() { return this.null; }, address() { return this; } }; return value; }; Ptr.ptr = {};
    const scalar = size => ({ size });
    const C = { default_abi: {}, voidptr_t: Ptr, void_t: scalar(0), uint32_t: scalar(4), int32_t: scalar(4), size_t: scalar(8), double: scalar(8), char: { ptr: {} },
      cast: value => value,
      FunctionType: () => ({ ptr: fn => ({ fn }) }),
      StructType: (name, fields) => {
        const entries = fields.flatMap(field => Object.entries(field));
        const Type = (...values) => {
          const value = Object.fromEntries(entries.map(([key, type], index) => [key, values[index] ?? (typeof type === "function" ? type() : 0)]));
          value.address = () => value; return value;
        };
        Type.nameForTest = name; Type.size = entries.reduce((sum, [, field]) => sum + field.size, 0); Type.ptr = {};
        Type.array = length => items => { const value = items || Array.from({ length }, () => Type()); value.addressOfElement = index => ({ elements: value, index }); return value; };
        return Type;
      },
      open(path) { calls.push(["open", path]); return { close() { calls.push(["close", path]); }, declare(symbol, abi, result, ...args) {
        assert.equal(abi, C.default_abi);
        if (symbol === "GetApplicationEventTarget") return () => pointer("target");
        if (symbol === "InstallEventHandler") return (target, callback, count, elements, data, out) => {
          assert.equal(count, 2); assert.equal(elements.index, 0);
          assert.deepEqual(elements.elements.map(row => row.eventKind), [5, 6]);
          state.callback = callback; out.null = false; return 0;
        };
        if (symbol === "RegisterEventHotKey") return (key, mods, id, target, options, out) => {
          assert.equal(args[2].nameForTest, "QSHotKeyID"); assert.equal(args[2].size, 8);
          assert.equal(id.signature, signature); assert.equal(id.id, 1); assert.equal(options, 1); out.null = false; calls.push(["register", key, mods]); return 0;
        };
        if (symbol === "GetEventClass") return event => event.eventClass;
        if (symbol === "GetEventKind") return event => event.kind;
        if (symbol === "GetEventParameter") return (event, name, type, actual, size, actualSize, out) => {
          assert.equal(name, 0x2d2d2d2d); assert.equal(type, 0x686b6964); assert.equal(size, 8); out.signature = event.signature; out.id = event.id; return 0;
        };
        if (symbol === "UnregisterEventHotKey") return () => { calls.push(["unregister"]); return 0; };
        if (symbol === "RemoveEventHandler") return () => { assert.ok(state.callback); calls.push(["remove"]); return state.removeCode; };
        if (symbol === "objc_getClass") return name => pointer(name);
        if (symbol === "sel_registerName") return name => name;
        if (symbol === "objc_msgSend_stret") return (out, object, selector) => {
          calls.push(["stret", selector]); Object.assign(out, selector === "frame" ? { origin: { x: 0, y: 0 }, size: { width: 1440, height: 900 } } : { origin: { x: 0, y: 50 }, size: { width: 1440, height: 825 } });
        };
        if (symbol === "objc_msgSend") return (object, selector, index) => {
          if (["alloc", "init", "sharedWorkspace", "frontmostApplication", "executableURL", "path", "screens"].includes(selector)) return pointer(selector);
          if (selector === "drain") { calls.push(["drain"]); return; }
          if (selector === "processIdentifier") return 200;
          if (selector === "UTF8String") return pointer(app.path);
          if (selector === "mouseLocation") return { x: 200, y: 200 };
          if (selector === "count") return 1;
          if (selector === "objectAtIndex:") { assert.equal(index, 0); return pointer("screen"); }
          if (selector === "backingScaleFactor") return 2;
          if (["frame", "visibleFrame"].includes(selector)) {
            calls.push(["regularRect", selector]);
            return selector === "frame" ? { origin: { x: 0, y: 0 }, size: { width: 1440, height: 900 } } : { origin: { x: 0, y: 50 }, size: { width: 1440, height: 825 } };
          }
          return nil();
        };
        throw new Error("Unexpected native declaration: " + symbol);
      } }; },
    };
    globalThis.Services = { tm: { isMainThread: true }, appinfo: { XPCOMABI: arch, processID: 100 } };
    globalThis.ChromeUtils = { importESModule: () => ({ ctypes: C }) };
    const api = createAPI(); api.install(event => api.readEvent(event)?.id === 1 ? 0 : -9874); api.register(macHotkeyFromShortcut("Alt+O"));
    assert.equal(state.callback.fn(null, { ...pressed, eventClass: 0x6b657962 }, null), 0);
    assert.deepEqual(api.frontApp(), app); assert.deepEqual(api.cursorScreen(), { left: 0, top: 50, width: 2880, height: 1650, scale: 2 });
    assert.equal(calls.some(call => call[0] === "stret"), arch.startsWith("x86_64"));
    assert.equal(calls.some(call => call[0] === "regularRect"), !arch.startsWith("x86_64"));
    state.removeCode = -50; assert.throws(() => api.stop(), error => error.code === -50); assert.ok(!calls.some(call => call[0] === "close"));
    state.removeCode = 0; api.stop();
    assert.deepEqual(calls.filter(call => ["unregister", "remove", "close"].includes(call[0])).map(call => call[0]), ["unregister", "remove", "remove", "close", "close", "close", "close"]);
  }
  globalThis.Services.tm.isMainThread = false; assert.throws(createAPI, /main thread/);
});
