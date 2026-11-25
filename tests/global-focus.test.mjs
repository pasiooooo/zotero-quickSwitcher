import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function nativeWindowFixture(overrides = {}) {
  const state = { foreground: "99", direct: true, attachAllowed: true, attached: false, pid: 100, ...overrides }, calls = [];
  function Scalar(value = 0) { if (!new.target) return new Scalar(value); this.value = String(value); this.address = () => this; this.toString = () => this.value; this.isNull = () => this.value === "0"; }
  Scalar.ptr = {}; Scalar.size = 8;
  const api = {
    GetWindowThreadProcessId(handle, pid) { if (pid) pid.value = state.pid; return handle.value === "42" ? 7 : state.foregroundThread ?? 9; },
    GetWindowLongPtrW: () => new Scalar(0), SetWindowPos: () => 1,
    GetForegroundWindow: () => new Scalar(state.foreground),
    SetForegroundWindow(handle) {
      calls.push("foreground");
      if (!state.direct && !state.attached) return 0;
      if (state.failAttached) throw new Error("native failure");
      state.foreground = handle.value; return 1;
    },
    AttachThreadInput(from, to, attached) {
      calls.push(["attach", from, to, attached]);
      if (!attached && state.failDetach) return 0;
      if (!state.attachAllowed) return 0;
      state.attached = !!attached; return 1;
    },
  };
  const library = { declare: name => { assert.ok(api[name], name); return api[name]; }, close: () => calls.push("close") };
  const ctypes = { uintptr_t: Scalar, intptr_t: Scalar, uint32_t: Scalar, int32_t: Scalar, voidptr_t: Scalar, size_t: { size: 8 }, cast: value => value, open: () => library };
  const win = { closed: false, focus: () => calls.push("focus"),
    docShell: { treeOwner: { QueryInterface: () => ({ getInterface: () => ({ nativeHandle: "42" }) }) } } };
  const source = readFileSync(new URL("../src/global-hotkey.mjs", import.meta.url), "utf8");
  const method = source.match(/function topmostWindow\([\s\S]*?(?=\n\/\/ Raise only)/u)[0];
  const create = new Function("ChromeUtils", "Services", "Zotero", "Ci", `${method}; return topmostWindow;`)(
    { importESModule: () => ({ ctypes }) }, { appinfo: { processID: 100 } }, { isWin: true, isMac: false }, {});
  return { state, calls, create: () => create(win) };
}

test("Windows invocation acquires actual foreground focus instead of only raising its window", () => {
  const fixture = nativeWindowFixture(), api = fixture.create();
  api.raise();
  assert.equal(fixture.state.foreground, "42");
  assert.deepEqual(fixture.calls, ["foreground", "focus"]);
  api.restore(); assert.equal(fixture.calls.at(-1), "close");
});

test("a denied foreground request temporarily joins input queues and always detaches", () => {
  const fixture = nativeWindowFixture({ direct: false }), api = fixture.create();
  api.raise();
  assert.equal(fixture.state.foreground, "42"); assert.equal(fixture.state.attached, false);
  assert.deepEqual(fixture.calls, ["foreground", ["attach", 7, 9, 1], "foreground", ["attach", 7, 9, 0], "focus"]);
  api.restore();
  const failed = nativeWindowFixture({ direct: false, failAttached: true }), failingAPI = failed.create();
  assert.throws(() => failingAPI.raise(), /native failure/u);
  assert.equal(failed.state.attached, false); failingAPI.restore(); assert.equal(failed.calls.at(-1), "close");
});

test("Windows refuses unsupported foreground handoffs without claiming focus or leaking native resources", () => {
  const fixture = nativeWindowFixture({ direct: false, attachAllowed: false }), api = fixture.create();
  assert.throws(() => api.raise(), /foreground/u);
  assert.equal(fixture.state.foreground, "99"); assert.equal(fixture.state.attached, false);
  assert.ok(!fixture.calls.includes("focus")); api.restore(); assert.equal(fixture.calls.at(-1), "close");
  const foreign = nativeWindowFixture({ pid: 200 });
  assert.throws(foreign.create, /another process/u); assert.deepEqual(foreign.calls, ["close"]);
});

test("already-foreground invocations never join queues, and missing or same-thread foreground owners are rejected safely", () => {
  const active = nativeWindowFixture({ foreground: "42", direct: false }), api = active.create();
  api.raise(); assert.deepEqual(active.calls, ["foreground", "focus"]); api.restore();
  for (const foregroundThread of [0, 7]) {
    const fixture = nativeWindowFixture({ direct: false, foregroundThread }), rejected = fixture.create();
    assert.throws(() => rejected.raise(), /foreground/u);
    assert.deepEqual(fixture.calls, ["foreground"]); rejected.restore();
  }
});

test("an input detachment failure is reported and does not claim keyboard focus", () => {
  const fixture = nativeWindowFixture({ direct: false, failDetach: true }), api = fixture.create();
  assert.throws(() => api.raise(), /detachment/u);
  assert.ok(!fixture.calls.includes("focus")); api.restore(); assert.equal(fixture.calls.at(-1), "close");
});
