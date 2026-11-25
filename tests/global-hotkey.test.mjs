import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { GlobalHotkey, globalWindowBounds, hotkeyFromShortcut, windowLoad, keepGlobalWindowOnTop } from "../src/global-hotkey.mjs";

const NOREPEAT = 0x4000;

test("the independent panel uses the pointer monitor work area in device pixels", () => {
  assert.deepEqual(globalWindowBounds({ left: 0, top: 32, width: 2560, height: 1408, scale: 1 }, 62, 80), { left: 487, top: 126, width: 1587, height: 1126 });
  assert.deepEqual(globalWindowBounds({ left: -2560, top: -400, width: 2560, height: 1400, scale: 1.5 }, 75, 70), { left: -2240, top: -260, width: 1920, height: 980 });
});

test("shortcut strings map to RegisterHotKey modifiers and virtual keys", () => {
  assert.deepEqual(hotkeyFromShortcut("Alt+O"), { modifiers: NOREPEAT | 0x1, vk: 0x4F });
  assert.deepEqual(hotkeyFromShortcut("Alt+Shift+O"), { modifiers: NOREPEAT | 0x1 | 0x4, vk: 0x4F });
  assert.deepEqual(hotkeyFromShortcut("Ctrl+Shift+P"), { modifiers: NOREPEAT | 0x2 | 0x4, vk: 0x50 });
  assert.deepEqual(hotkeyFromShortcut("Accel+Shift+K"), { modifiers: NOREPEAT | 0x2 | 0x4, vk: 0x4B });
  assert.deepEqual(hotkeyFromShortcut("Meta+Alt+1"), { modifiers: NOREPEAT | 0x8 | 0x1, vk: 0x31 });
  assert.deepEqual(hotkeyFromShortcut("Alt+;"), { modifiers: NOREPEAT | 0x1, vk: 0xBA });
  assert.deepEqual(hotkeyFromShortcut("Alt+'"), { modifiers: NOREPEAT | 0x1, vk: 0xDE });
  assert.deepEqual(hotkeyFromShortcut("Alt+’"), { modifiers: NOREPEAT | 0x1, vk: 0xDE });
  assert.deepEqual(hotkeyFromShortcut("Alt+/"), { modifiers: NOREPEAT | 0x1, vk: 0xBF });
  assert.deepEqual(hotkeyFromShortcut("Alt+Space"), { modifiers: NOREPEAT | 0x1, vk: 0x20 });
  assert.deepEqual(hotkeyFromShortcut("Ctrl+ArrowDown"), { modifiers: NOREPEAT | 0x2, vk: 0x28 });
  assert.deepEqual(hotkeyFromShortcut("F12"), { modifiers: NOREPEAT, vk: 0x7B });
  assert.deepEqual(hotkeyFromShortcut("Ctrl+F24"), { modifiers: NOREPEAT | 0x2, vk: 0x87 });
});

test("unusable shortcuts are rejected", () => {
  for (const value of ["", "O", "Shift+O", "Alt", "Alt+O+P", "Alt+F25", "Alt+constructor", "Alt+€", null]) {
    assert.throws(() => hotkeyFromShortcut(value), Error, String(value));
  }
});

test("the public hotkey entry maps macOS chords and delegates without starting a Windows worker", async t => {
  const previous = globalThis.Zotero;
  t.after(() => { globalThis.Zotero = previous; });
  globalThis.Zotero = { isMac: true, isWin: false };
  assert.deepEqual(hotkeyFromShortcut("Cmd+Alt+O"), { modifiers: 256 | 2048, keyCode: 0x1F });
  assert.throws(() => hotkeyFromShortcut("Cmd+F24"), /F24/);
  const hotkey = new GlobalHotkey(), calls = [], seen = [];
  const app = { name: "Microsoft Word", path: "/Applications/Microsoft Word.app/Contents/MacOS/Microsoft Word" };
  hotkey.mac = { sourceApp: app, stop: async () => calls.push("stop"), start: async (shortcut, trigger) => {
    calls.push(shortcut); trigger({ left: -2560, top: 0, width: 2560, height: 1400, scale: 2 }, app); return true;
  } };
  assert.equal(await hotkey.start("Cmd+Alt+O", (screen, sourceApp) => seen.push({ screen, sourceApp })), true);
  assert.equal(hotkey.worker, null);
  assert.equal(hotkey.sourceApp, app);
  assert.deepEqual(seen, [{ screen: { left: -2560, top: 0, width: 2560, height: 1400, scale: 2 }, sourceApp: app }]);
  await hotkey.stop();
  assert.deepEqual(calls, ["stop", "Cmd+Alt+O", "stop"]);
});

// Models the worker message protocol only; no Win32 call or real ChromeWorker runs here.
class FakeWorker {
  static created = [];
  constructor(url) { this.url = url; this.posted = []; this.terminated = false; FakeWorker.created.push(this); }
  postMessage(data) {
    this.posted.push(data);
    if (data.type === "start" && FakeWorker.reply) queueMicrotask(() => this.onmessage?.({ data: FakeWorker.reply }));
    if (data.type === "stop") queueMicrotask(() => this.onmessage({ data: { type: "stopped" } }));
  }
  terminate() { this.terminated = true; }
}
function host(isWin) {
  FakeWorker.created = []; FakeWorker.reply = { type: "registered" };
  globalThis.Zotero = { isWin, getMainWindow: () => ({ devicePixelRatio: 1.5 }) };
  globalThis.ChromeWorker = FakeWorker;
}

test("start registers through the worker, forwards triggers, and stop releases it", async t => {
  t.after(() => { delete globalThis.Zotero; delete globalThis.ChromeWorker; });
  host(true);
  const hotkey = new GlobalHotkey(), seen = [];
  assert.equal(await hotkey.start("Alt+O", screen => seen.push(screen)), true);
  const [worker] = FakeWorker.created;
  assert.equal(worker.url, "chrome://quickswitcher/content/hotkey-worker.js");
  assert.deepEqual(worker.posted, [{ type: "start", modifiers: NOREPEAT | 0x1, vk: 0x4F }]);
  worker.onmessage({ data: { type: "hotkey", screen: { left: 1920, top: 0, width: 2560, height: 1400 } } });
  worker.onmessage({ data: { type: "hotkey", screen: null } });
  assert.deepEqual(seen, [{ left: 1920, top: 0, width: 2560, height: 1400, scale: 1.5 }, null]);

  // A restart waits for the old worker to unregister before the next one registers.
  const restarted = hotkey.start("Ctrl+Shift+P", () => {});
  assert.equal(FakeWorker.created.length, 1);
  assert.equal(await restarted, true);
  assert.equal(worker.posted.at(-1).type, "stop");
  assert.equal(worker.terminated, true);
  assert.equal(FakeWorker.created.length, 2);

  await hotkey.stop();
  assert.equal(FakeWorker.created[1].terminated, true);
  worker.onmessage({ data: { type: "hotkey", screen: null } });
  assert.equal(seen.length, 2);
  await hotkey.stop();
});

test("a taken combination rejects with the Win32 code but continues tracking external apps until stop", async t => {
  t.after(() => { delete globalThis.Zotero; delete globalThis.ChromeWorker; });
  host(true);
  FakeWorker.reply = { type: "registered", hotkeyRegistered: false, code: 1409, message: "Hotkey is already registered by another program" };
  const hotkey = new GlobalHotkey();
  await assert.rejects(hotkey.start("Alt+O", () => {}), error => error.code === 1409 && /Alt\+O/u.test(error.message));
  const [worker] = FakeWorker.created;
  assert.equal(worker.terminated, false);
  assert.equal(hotkey.worker, worker);

  // App tracking continues even when the hotkey combination was taken
  worker.onmessage({ data: { type: "app", app: { name: "powerpnt.exe", path: "C:\\Office\\powerpnt.exe" } } });
  assert.deepEqual(hotkey.sourceApp, { name: "powerpnt.exe", path: "C:\\Office\\powerpnt.exe" });

  // Unidentifiable foreground app explicitly clears sourceApp to null
  worker.onmessage({ data: { type: "app", app: null } });
  assert.equal(hotkey.sourceApp, null);

  // Restarting with a new combination terminates the old tracking worker
  FakeWorker.reply = { type: "registered", hotkeyRegistered: true };
  const replaced = hotkey.start("Alt+P", () => {});
  assert.equal(await replaced, true);
  assert.equal(worker.terminated, true);
  assert.equal(FakeWorker.created.length, 2);

  await hotkey.stop();
  assert.equal(FakeWorker.created[1].terminated, true);
  assert.equal(hotkey.worker, null);
  assert.equal(hotkey.sourceApp, null);
});

test("a fatal worker error during handshake terminates the worker and rejects", async t => {
  t.after(() => { delete globalThis.Zotero; delete globalThis.ChromeWorker; });
  host(true);
  FakeWorker.reply = { type: "error", code: 0, message: "Fatal worker initialization failure" };
  const hotkey = new GlobalHotkey();
  await assert.rejects(hotkey.start("Alt+O", () => {}), error => error.code === 0 && /Fatal worker/u.test(error.message));
  assert.equal(FakeWorker.created[0].terminated, true);
  assert.equal(hotkey.worker, null);
  assert.equal(hotkey.sourceApp, null);
  await assert.rejects(hotkey.start("Alt+€", () => {}));
  assert.equal(FakeWorker.created.length, 1);
});

test("a runtime error in a conflicted worker reports to onError and cleans up", async t => {
  t.after(() => { delete globalThis.Zotero; delete globalThis.ChromeWorker; });
  host(true);
  FakeWorker.reply = { type: "registered", hotkeyRegistered: false, code: 1409, message: "Hotkey is already registered by another program" };
  const hotkey = new GlobalHotkey(), errors = [];
  await assert.rejects(hotkey.start("Alt+O", () => {}, err => errors.push(err)), error => error.code === 1409);
  const [worker] = FakeWorker.created;
  assert.equal(worker.terminated, false);

  // Runtime error in tracking mode reports via onError
  worker.onmessage({ data: { type: "error", code: 6, message: "MsgWaitForMultipleObjects failed" } });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 6);
  assert.equal(worker.terminated, true);
  assert.equal(hotkey.worker, null);
  assert.equal(hotkey.sourceApp, null);
  await hotkey.stop();
});

test("start is a quiet no-op off Windows", async t => {
  t.after(() => { delete globalThis.Zotero; delete globalThis.ChromeWorker; });
  host(false);
  assert.equal(await new GlobalHotkey().start("Alt+O", () => {}), false);
  assert.equal(FakeWorker.created.length, 0);
});

test("a runtime failure is reported once after registration instead of disappearing", async t => {
  t.after(() => { delete globalThis.Zotero; delete globalThis.ChromeWorker; });
  host(true);
  const hotkey = new GlobalHotkey(), errors = [];
  assert.equal(await hotkey.start("Alt+O", () => {}, error => errors.push(error)), true);
  const [worker] = FakeWorker.created, receive = worker.onmessage;
  receive({ data: { type: "error", code: 6, message: "Runtime failure" } });
  receive({ data: { type: "error", code: 6, message: "Runtime failure" } });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 6);
  assert.equal(worker.terminated, true);
  assert.equal(hotkey.worker, null);
  await hotkey.stop();
});

test("a pending handshake can be stopped or replaced without its reply", async t => {
  t.after(() => { delete globalThis.Zotero; delete globalThis.ChromeWorker; });
  host(true); FakeWorker.reply = null;
  const hotkey = new GlobalHotkey();
  const first = hotkey.start("Alt+O", () => {});
  for (let turn = 0; turn < 10 && !FakeWorker.created.length; turn++) await Promise.resolve();
  assert.equal(FakeWorker.created.length, 1);
  const stop = hotkey.stop();
  assert.equal(await first, false);
  await stop;
  assert.equal(FakeWorker.created[0].terminated, true);

  const cancelled = hotkey.start("Alt+O", () => {});
  const immediatelyStopped = hotkey.stop();
  assert.equal(await cancelled, false);
  await immediatelyStopped;
  assert.equal(FakeWorker.created.length, 1);

  const superseded = hotkey.start("Alt+O", () => {});
  FakeWorker.reply = { type: "registered" };
  const latest = hotkey.start("Alt+P", () => {});
  assert.equal(await superseded, false);
  assert.equal(await latest, true);
  assert.equal(FakeWorker.created.length, 2);
  await hotkey.stop();
});

test("source apps are tracked without a registered chord and forwarded with triggers", async t => {
  t.after(() => { delete globalThis.Zotero; delete globalThis.ChromeWorker; });
  host(true);
  const hotkey = new GlobalHotkey(), seen = [];
  assert.equal(await hotkey.start("", (screen, app) => seen.push({ screen, app })), true);
  const [worker] = FakeWorker.created, app = { name: "powerpnt.exe", path: "C:\\Office\\powerpnt.exe" };
  assert.deepEqual(worker.posted[0], { type: "start", modifiers: 0, vk: 0 });
  worker.onmessage({ data: { type: "app", app } });
  assert.deepEqual(hotkey.sourceApp, app);
  worker.onmessage({ data: { type: "hotkey", screen: null, app } });
  assert.deepEqual(seen, [{ screen: null, app }]);
  worker.onmessage({ data: { type: "app", app: null } });
  assert.equal(hotkey.sourceApp, null);
  await hotkey.stop();
});

test("a Windows foreground lookup failure clears the previous CSL source instead of reusing it", () => {
  const messages = [], state = { hwnd: true, pidOK: true, pid: 2, canRead: true };
  function Scalar(value = 0) { this.value = value; this.address = () => this; }
  Scalar.ptr = {};
  function StructType() { return function Struct() {}; }
  const path = "C:\\Office\\winword.exe", ctypes = { int32_t: Scalar, uint32_t: Scalar, voidptr_t: Scalar, StructType, jschar: { array: () => function () { this.readString = () => path; } } };
  const api = { GetForegroundWindow: () => ({ isNull: () => !state.hwnd }), GetWindowThreadProcessId: (_, pid) => { pid.value = state.pid; return state.pidOK; },
    OpenProcess: () => ({ isNull: () => !state.canRead }), QueryFullProcessImageNameW: () => true, CloseHandle() {} };
  const context = vm.createContext({ ctypes, self: { postMessage: value => messages.push(value) }, setTimeout, clearTimeout, testAPI: api });
  vm.runInContext(readFileSync(new URL("../addon/content/hotkey-worker.js", import.meta.url), "utf8") + "\napi=testAPI; ownPID=1;", context);
  const read = () => vm.runInContext("currentApp()", context);
  assert.equal(read().name, "winword.exe");
  state.pid = 1; assert.equal(read().name, "winword.exe");
  state.hwnd = false; assert.equal(read(), null); assert.equal(messages.at(-1).app, null);
  state.hwnd = true; state.pid = 2; assert.equal(read().name, "winword.exe");
  state.pidOK = false; assert.equal(read(), null);
  state.pidOK = true; state.pid = 3; state.canRead = false; assert.equal(read(), null);
});

test("a worker which no longer accepts stop messages is still terminated", async t => {
  t.after(() => { delete globalThis.Zotero; delete globalThis.ChromeWorker; });
  host(true);
  const hotkey = new GlobalHotkey();
  await hotkey.start("Alt+O", () => {});
  const [worker] = FakeWorker.created;
  worker.postMessage = () => { throw new Error("worker closed"); };
  await hotkey.stop();
  assert.equal(worker.terminated, true);
  assert.equal(hotkey.worker, null);
});

class FakeWindow extends EventTarget {
  closed = false;
  close() { this.dispatchEvent(new Event("DOMWindowClose")); this.closed = true; this.dispatchEvent(new Event("unload")); }
}

test("global invocation raises once, then window blur restores ordinary stacking without refocusing", () => {
  const win = new FakeWindow(), calls = [], timers = [];
  win.document = new EventTarget(); win.document.documentElement = { getAttribute: () => "quickswitcher:global" };
  win.setInterval = (callback, delay) => { timers.push({ callback, delay }); return 17; };
  win.clearInterval = id => calls.push(["clear", id]);
  const stop = keepGlobalWindowOnTop(win, { apiFactory: () => ({ raise: () => calls.push("raise"), restore: () => calls.push("restore") }) });
  assert.deepEqual(calls, ["raise"]); assert.equal(timers.length, 0);
  win.dispatchEvent(new Event("blur")); assert.deepEqual(calls, ["raise", "restore"]);
  win.dispatchEvent(new Event("focus")); win.dispatchEvent(new Event("deactivate"));
  win.close(); stop(); assert.deepEqual(calls, ["raise", "restore"]);
});

test("native menu opening releases transient topmost state and a later invocation can raise again", () => {
  const win = new FakeWindow(), calls = [];
  win.document = new EventTarget(); win.document.documentElement = { getAttribute: () => "quickswitcher:global" };
  const factory = () => ({ raise: () => calls.push("raise"), restore: () => calls.push("restore") });
  const first = keepGlobalWindowOnTop(win, { apiFactory: factory });
  win.document.dispatchEvent(new Event("popupshowing")); win.document.dispatchEvent(new Event("popuphidden"));
  assert.deepEqual(calls, ["raise", "restore"]); first();
  const second = keepGlobalWindowOnTop(win, { apiFactory: factory });
  win.dispatchEvent(new Event("deactivate")); second();
  assert.deepEqual(calls, ["raise", "restore", "raise", "restore"]);
});

test("a failed initial raise reports once and still restores native ownership", () => {
  const win = new FakeWindow(), errors = [], calls = [];
  win.document = new EventTarget(); win.document.documentElement = { getAttribute: () => "quickswitcher:global" };
  const stop = keepGlobalWindowOnTop(win, { apiFactory: () => ({ raise() { calls.push("raise"); throw new Error("native failure"); }, restore() { calls.push("restore"); } }), onError: error => errors.push(error) });
  assert.equal(errors.length, 1); assert.deepEqual(calls, ["raise", "restore"]);
  stop(); win.dispatchEvent(new Event("focus")); assert.equal(errors.length, 1); assert.deepEqual(calls, ["raise", "restore"]);
  win.document.documentElement.getAttribute = () => "navigator:browser";
  assert.throws(() => keepGlobalWindowOnTop(win), /Global launcher window required/u);
});

test("loading a global window is immediately cancelled on close and can be retried", async () => {
  const win = new FakeWindow(), first = windowLoad(win, 10000);
  win.close(); assert.equal(await first.promise, null);
  const reopened = new FakeWindow(), second = windowLoad(reopened, 10000);
  reopened.dispatchEvent(new Event("load"));
  assert.equal(await second.promise, reopened);
  first.cancel(); second.cancel();
});

test("stopping while a global window loads cancels timers, and failed loads close the window", async () => {
  const win = new FakeWindow(), waiting = windowLoad(win, 10000);
  waiting.cancel(); assert.equal(await waiting.promise, null);
  const timed = new FakeWindow(), failed = windowLoad(timed, 5);
  await assert.rejects(failed.promise, /全局检索窗口/u);
  assert.equal(timed.closed, true);
  const navigating = new FakeWindow(), loading = windowLoad(navigating, 10000);
  navigating.dispatchEvent(new Event("unload"));
  navigating.dispatchEvent(new Event("load"));
  assert.equal(await loading.promise, navigating);
});

test("Application abandons a closed load and an immediate retry creates a usable window", async () => {
  // Exercise the actual method without initializing the Zotero app or its library services.
  const source = readFileSync(new URL("../src/index.mjs", import.meta.url), "utf8");
  const method = source.match(/  async globalSearch\([\s\S]*?(?=\n  mainWindowFor\()/u)[0];
  const created = [], shown = [], positions = [];
  const Services = { io: { newURI: value => value } };
  const Cc = { "@mozilla.org/appshell/appShellService;1": { getService: () => ({ createTopLevelWindow: () => {
    const win = new FakeWindow();
    win.docShell = { treeOwner: { QueryInterface: () => ({ getInterface: () => ({ setPositionAndSize: (...args) => positions.push(args) }) }) } };
    created.push(win); return { docShell: { domWindow: win } };
  } }) } };
  const Method = new Function("windowLoad", "globalWindowBounds", "keepGlobalWindowOnTop", "Services", "Zotero", "Cc", "Ci", `return class { ${method} }`)(
    windowLoad, globalWindowBounds, () => () => {}, Services, { isWin: true }, Cc, { nsIWebBrowserChrome: {} });
  const app = new Method();
  app.hotkey = { sourceApp: { name: "winword.exe", path: "C:\\Office\\winword.exe" } };
  app.prefs = { get: name => name === "width" ? 62 : 80 };
  app.windows = new Map(); app.registerWindow = async win => { if (!app.windows.has(win)) app.windows.set(win, { cleanups: [] }); };
  app.launcherFor = win => ({ root: { classList: { add() {} } }, input: { focus() {} }, show: mode => shown.push({ win, mode }) });
  const screen = { left: 0, top: 0, width: 1000, height: 800 };
  const first = app.globalSearch(screen);
  created[0].close();
  const second = app.globalSearch(screen);
  assert.equal(created.length, 2);
  created[1].dispatchEvent(new Event("load"));
  await first; await second;
  assert.deepEqual(shown, [{ win: created[1], mode: "items" }]);
  assert.deepEqual(positions, [[190, 53, 620, 640, true]]);
  assert.equal(app.globalWindowPromise, null);
  assert.equal(app.globalWindowWait, null);
  created[1].close();
});

test("Windows global search prepares a captionless resizable hidden window, acquires foreground then focuses input, and reuses it", async () => {
  const source = readFileSync(new URL("../src/index.mjs", import.meta.url), "utf8");
  const method = source.match(/  async globalSearch\([\s\S]*?(?=\n  mainWindowFor\()/u)[0];
  const events = [], created = [], launches = [], options = [];
  const Ci = { nsIWebBrowserChrome: { CHROME_OPENAS_CHROME: 1, CHROME_WINDOW_RESIZE: 2, CHROME_SUPPRESS_ANIMATION: 4, CHROME_TITLEBAR: 8 } };
  const Cc = { "@mozilla.org/appshell/appShellService;1": { getService: () => ({ createTopLevelWindow: (...args) => {
    options.push(args);
    const win = new FakeWindow(), native = { visibility: false, setPositionAndSize() { assert.equal(this.visibility, false); events.push("position"); } };
    win.docShell = { treeOwner: { QueryInterface: () => ({ getInterface: () => native }) } };
    win.native = native; created.push(win); return { docShell: { domWindow: win } };
  } }) } };
  const Services = { io: { newURI: value => value } };
  const Zotero = { isWin: true, Utilities: { Internal: { activate() { throw new Error("Windows must not use the flashing attention helper"); } } } };
  const Method = new Function("windowLoad", "globalWindowBounds", "keepGlobalWindowOnTop", "Services", "Zotero", "Cc", "Ci", `return class { ${method} }`)(
    windowLoad, globalWindowBounds, win => { assert.equal(win.native.visibility, true); events.push("raise"); return () => events.push("restore"); }, Services, Zotero, Cc, Ci);
  const app = new Method();
  app.hotkey = { sourceApp: { name: "winword.exe", path: "C:\\Office\\winword.exe" } };
  app.prefs = { get: name => name === "width" ? 62 : 80 };
  app.windows = new Map();
  app.registerWindow = async win => {
    if (app.windows.has(win)) return;
    assert.equal(win.native.visibility, false);
    const launcher = { root: { classList: { add() {} } }, input: { focus: () => events.push("focus") },
      show(mode, advanced, sourceApp) { assert.equal(win.native.visibility, false); launches.push({ mode, advanced, sourceApp }); events.push("show"); } };
    app.windows.set(win, { launcher, cleanups: [] });
  };
  app.launcherFor = win => app.windows.get(win)?.launcher;
  const screen = { left: 0, top: 0, width: 1000, height: 800 };
  const pending = app.globalSearch(screen);
  assert.equal(created.length, 1); assert.equal(created[0].native.visibility, false); assert.equal(events.length, 0);
  created[0].dispatchEvent(new Event("load")); await pending;
  assert.equal(options[0][1], "chrome://quickswitcher/content/global.xhtml"); assert.equal(options[0][2], 7);
  assert.deepEqual(events, ["position", "show", "raise", "focus"]);
  const launcher = app.launcherFor(created[0]);
  launcher.onHide(); assert.equal(created[0].closed, false); assert.equal(created[0].native.visibility, false);
  events.length = 0;
  const nextApp = { name: "powerpnt.exe", path: "C:\\Office\\powerpnt.exe" };
  await app.globalSearch(screen, nextApp);
  assert.equal(created.length, 1); assert.equal(launches[1].sourceApp, nextApp);
  assert.deepEqual(events.slice(-4), ["position", "show", "raise", "focus"]);
  created[0].close();
});

test("stopping the application destroys its hidden reusable global window", async () => {
  const source = readFileSync(new URL("../src/index.mjs", import.meta.url), "utf8");
  const method = source.match(/  stop\(\) \{[\s\S]*?(?=\n\}\n\nlet app;)/u)[0];
  const Method = new Function("Services", `return class { ${method} }`)({ wm: { getEnumerator: () => [] } });
  const app = new Method(), frame = new FakeWindow();
  app.globalWindow = frame; app.windows = new Map(); app.pendingWindows = new Map(); app.hotkey = { stop() {} };
  for (const name of ["search", "locations", "directoryCounts", "outline", "layout"]) app[name] = { destroy() {} };
  await app.stop();
  assert.equal(app.stopped, true); assert.equal(frame.closed, true);
  assert.equal(app.globalWindowWait, null); assert.equal(app.globalWindowPromise, null);
  assert.equal(app.stop(), app.stopPromise);
});
