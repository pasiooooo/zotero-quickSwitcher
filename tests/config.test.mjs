import test from "node:test";
import assert from "node:assert/strict";
import { ConfigStore, parseConfig } from "../src/config.mjs";
import { Prefs, CONFIG_GROUPS, DEFAULTS } from "../src/prefs.mjs";
import { LEGACY_PREFIXES } from "../src/launcher-query.mjs";
import { WebDAVSync } from "../src/webdav.mjs";
import { A, B, memoryStore, placement } from "./fixtures/layout.mjs";

globalThis.Zotero = { isMac: false, Prefs: {} };
globalThis.DOMParser = class {
  parseFromString(text) { return { querySelector: () => null, getElementsByTagNameNS: () => [...text.matchAll(/<d:href>([^<]+)<\/d:href>/g)].map(match => ({ textContent: match[1] })) }; }
};
async function client(deviceID, settings = {}, state = null) {
  let text = state, failure = false, hold = null, config, batchCalls = 0;
  const values = new Map(Object.entries(settings).map(([name, value]) => ["quickswitcher." + name, value])), errors = [], prefs = new Prefs(() => {}, entries => { batchCalls++; config?.changed(entries).catch(error => errors.push(error)); });
  for (const name of ["get", "apply", "migrateInputSettings"]) {
    const original = prefs[name];
    prefs[name] = function (...args) {
      const previous = Zotero.Prefs;
      Zotero.Prefs = { get: key => values.get(key), set: (key, value) => values.set(key, value) };
      try { return original.apply(this, args); } finally { Zotero.Prefs = previous; }
    };
  }
  const io = { read: async () => text, write: async value => { if (hold) await hold; if (failure) throw new Error("disk error"); text = value; } };
  config = await new ConfigStore({ prefs, deviceID, io }).init();
  const layout = (await memoryStore(deviceID)).store;
  return { prefs, config, layout, values, errors, io, fail: value => { failure = value; }, hold: value => { hold = value; }, saved: () => text, batches: () => batchCalls };
}
function server() {
  const files = new Map(), calls = []; let offline = false, pauseGET;
  const transport = { root: "https://dav.invalid/", namespace: "account", init: async () => {}, request: async (method, url, options = {}) => {
    calls.push({ method, url }); if (offline) throw new Error("offline");
    if (method === "MKCOL") return { status: 201, text: "" };
    if (method === "PROPFIND") return { status: 207, text: '<d:multistatus xmlns:d="DAV:">' + [...files.keys()].reverse().filter(key => key.startsWith(url)).map(key => `<d:href>${key}</d:href>`).join("") + "</d:multistatus>" };
    if (method === "GET") { await pauseGET?.(url); return { status: files.has(url) ? 200 : 404, text: files.get(url) || "" }; }
    if (method === "PUT") { files.set(url, options.body); return { status: 201, text: "" }; }
    throw new Error("Unexpected method");
  } };
  return { files, calls, transport, offline: value => { offline = value; }, pause: value => { pauseGET = value; } };
}

test("retired outline-depth records are omitted while current configuration and validation survive", async () => {
  const state = { schemaVersion: 1, deviceID: A, clock: 2, records: {
    outlineDepth: { values: { outlineDepth: 3 }, version: { clock: 2, deviceID: A } },
    theme: { values: { theme: "dark" }, version: { clock: 2, deviceID: A } },
  } };
  const parsed = parseConfig(JSON.stringify(state));
  assert.equal(Object.hasOwn(parsed.records, "outlineDepth"), false); assert.deepEqual(parsed.records.theme, state.records.theme);
  const current = await client(A, { theme: "dark" }, JSON.stringify(state));
  await current.config.reconcile();
  assert.equal(Object.hasOwn(current.config.snapshot().records, "outlineDepth"), false);
  assert.equal(current.config.clock, 2); assert.equal(current.prefs.get("theme"), "dark");
  assert.throws(() => parseConfig(JSON.stringify({ ...state, records: { unknownGroup: state.records.outlineDepth } })));
});
const syncFor = (c, remote) => new WebDAVSync({ prefs: c.prefs, config: c.config, layout: c.layout, transport: remote.transport });
const configURL = id => `https://dav.invalid/quickswitcher-config/account/${id}.json`;

test("configuration payload includes only portable settings and persists one complete prefix/shortcut group per batch", async () => {
  const a = await client(A);
  a.prefs.apply([["davURL", "https://private.invalid/"], ["davUsername", "private-name"], ["lastQuery", "private query"], ["recentItems", [10]], ["syncInterval", 300]]);
  await a.config.work; assert.deepEqual(a.config.records, {});
  a.prefs.apply([["authorPrefix", "#"], ["yearPrefix", "^"], ["launcherShortcut", "Ctrl+K"], ["advancedShortcut", "Alt+F"]]);
  await a.config.work;
  assert.equal(a.config.clock, 1); assert.equal(a.config.records.prefixes.values.authorPrefix, "#");
  assert.deepEqual(Object.keys(a.config.records.shortcuts.values), CONFIG_GROUPS.shortcuts);
  await a.config.initializeMissing();
  assert.deepEqual(Object.keys(a.config.records).sort(), Object.keys(CONFIG_GROUPS).sort());
  assert.doesNotMatch(a.saved(), /private\.invalid|private-name|private query|recentItems|davURL|syncEnabled|syncSettings|lastQuery/);
});
test("new devices first inherit existing remote configuration without generating feedback versions", async () => {
  const remote = server(), a = await client(A), b = await client(B), sa = syncFor(a, remote), sb = syncFor(b, remote);
  a.prefs.set("theme", "dark"); await sa.sync(); const version = { ...a.config.records.theme.version };
  await sb.sync(); assert.equal(b.prefs.get("theme"), "dark");
  assert.deepEqual(b.config.records.theme.version, version); assert.equal(b.config.pending.size, 0);
  assert.equal(b.config.clock, a.config.clock); assert.deepEqual(a.config.records, b.config.records);
  assert.ok(remote.calls.filter(call => call.method === "PUT").every(call => call.url.endsWith(A + ".json") || call.url.endsWith(B + ".json")));
});
test("offline edits merge independent settings and keep each shortcut/prefix group valid after same-clock conflicts", async () => {
  const remote = server(), a = await client(A), b = await client(B), sa = syncFor(a, remote), sb = syncFor(b, remote);
  await sa.sync(); await sb.sync();
  remote.offline(true);
  a.prefs.apply([["authorPrefix", "#"], ["yearPrefix", "^"], ["theme", "dark"]]);
  b.prefs.apply([["authorPrefix", ":"], ["yearPrefix", "@"], ["width", 70]]);
  await Promise.all([a.config.work, b.config.work]); await assert.rejects(sa.sync(), /offline/);
  assert.equal(a.config.dirty, true); remote.offline(false);
  await sa.sync(); await sb.sync(); await sa.sync();
  assert.deepEqual(a.config.records, b.config.records); assert.equal(a.prefs.get("theme"), "dark"); assert.equal(a.prefs.get("width"), 70);
  assert.equal(a.prefs.get("authorPrefix"), ":"); assert.equal(new Set(Object.values(a.config.records.prefixes.values)).size, CONFIG_GROUPS.prefixes.length);
  a.prefs.apply([["launcherShortcut", "Ctrl+K"], ["advancedShortcut", "Ctrl+L"]]);
  b.prefs.apply([["launcherShortcut", "Ctrl+L"], ["advancedShortcut", "Ctrl+K"]]);
  await Promise.all([a.config.work, b.config.work]); await sa.sync(); await sb.sync(); await sa.sync();
  assert.deepEqual(a.config.records.shortcuts, b.config.records.shortcuts); assert.doesNotThrow(() => a.prefs.validate(Object.entries(a.config.records.shortcuts.values)));
});
test("disabled config sync leaves configuration untouched while legacy layout clients continue to interoperate", async () => {
  const remote = server(), a = await client(A), b = await client(B), sa = syncFor(a, remote), sb = syncFor(b, remote);
  a.prefs.set("theme", "dark"); await sa.sync(); b.prefs.set("syncSettings", false);
  const before = remote.calls.length; await sb.sync(); assert.equal(b.prefs.get("theme"), "auto");
  assert.ok(remote.calls.slice(before).every(call => !call.url.includes("quickswitcher-config")));
  const legacy = new WebDAVSync({ prefs: b.prefs, layout: b.layout, transport: remote.transport });
  await a.layout.place("u", "SEARCH22", placement("FOLDER22")); await sa.sync(); await legacy.sync();
  assert.equal(b.layout.get("u", "SEARCH22").parentCollectionKey, "FOLDER22");
  assert.equal(JSON.parse(remote.files.get(configURL(A))).records.theme.values.theme, "dark");
});
test("remote private fields, malformed groups and own unknown files cannot replace valid configuration", async () => {
  const remote = server(), a = await client(A), sa = syncFor(a, remote); await sa.sync();
  const original = a.prefs.get("theme"), base = { schemaVersion: 1, deviceID: B, clock: 20, records: {} };
  remote.files.set(configURL(B), JSON.stringify({ ...base, records: { davURL: { values: { davURL: "https://evil.invalid/" }, version: { clock: 20, deviceID: B } } } }));
  await sa.sync(); assert.equal(sa.status.state, "warning"); assert.equal(a.prefs.get("theme"), original); assert.equal(a.prefs.get("davURL"), "");
  const duplicate = structuredClone(a.config.records.prefixes); duplicate.version = { clock: 20, deviceID: B }; duplicate.values.authorPrefix = duplicate.values.directoryPrefix;
  remote.files.set(configURL(B), JSON.stringify({ ...base, records: { prefixes: duplicate } }));
  await sa.sync(); assert.equal(sa.status.state, "warning"); assert.notEqual(a.prefs.get("authorPrefix"), a.prefs.get("directoryPrefix"));
  a.prefs.set("theme", "dark"); await a.config.work; remote.files.set(configURL(A), '{"schemaVersion":99}');
  await assert.rejects(sa.sync(), /本设备/); assert.equal(a.config.dirty, true); assert.equal(remote.files.get(configURL(A)), '{"schemaVersion":99}');
  assert.throws(() => parseConfig("x".repeat(256 * 1024 + 1)), /256 KB/);
});
test("disk failures preserve pending preferences and retries advance the configuration clock only after persistence", async () => {
  const a = await client(A); a.fail(true); a.prefs.set("theme", "dark"); await assert.rejects(a.config.work, /disk error/);
  assert.equal(a.config.clock, 0); assert.deepEqual(a.config.records, {}); assert.equal(a.config.pending.size, 1); assert.equal(a.prefs.get("theme"), "dark");
  a.fail(false); await a.config.reconcile(); assert.equal(a.config.clock, 1); assert.equal(JSON.parse(a.saved()).records.theme.values.theme, "dark");
  await a.config.markSynced(0); assert.equal(a.config.dirty, true); await a.config.markSynced(1); assert.equal(a.config.dirty, false);
});
test("local changes made while a remote merge awaits disk IO remain applied and receive the next durable version", async () => {
  const a = await client(A); await a.config.initializeMissing();
  let release; a.hold(new Promise(resolve => { release = resolve; }));
  const merge = a.config.merge({ theme: { values: { theme: "dark" }, version: { clock: 10, deviceID: B } } });
  await new Promise(resolve => setImmediate(resolve)); a.prefs.set("theme", "light"); release(); a.hold(null);
  await merge; await a.config.work; assert.equal(a.prefs.get("theme"), "light"); assert.equal(a.config.records.theme.values.theme, "light"); assert.equal(a.config.clock, 11);
});
test("stopping a sync while a config response arrives cancels remote application and uploads", async () => {
  const remote = server(), a = await client(A), b = await client(B), sa = syncFor(a, remote), sb = syncFor(b, remote);
  await sb.sync(); b.prefs.set("theme", "dark"); await sb.sync();
  let release, reached; const requested = new Promise(resolve => { reached = resolve; });
  remote.pause(url => url.includes("quickswitcher-config") ? new Promise(resolve => { release = resolve; reached(); }) : null);
  const pending = sa.sync(); await requested; const puts = remote.calls.filter(call => call.method === "PUT").length; sa.stop(); release();
  assert.equal(await pending, false); assert.equal(a.prefs.get("theme"), "auto"); assert.equal(remote.calls.filter(call => call.method === "PUT").length, puts);
});

test("stopping during received configuration disk IO restores local state without applying the cancelled settings", async () => {
  const remote = server(), a = await client(A), b = await client(B), sa = syncFor(a, remote), sb = syncFor(b, remote);
  await sa.sync(); await sb.sync(); b.prefs.set("theme", "dark"); await sb.sync();
  const before = a.saved(), write = a.io.write;
  let release, reached; const blocked = new Promise(resolve => { release = resolve; }), requested = new Promise(resolve => { reached = resolve; });
  a.io.write = async value => { if (JSON.parse(value).records.theme.values.theme === "dark") { reached(); await blocked; } return write(value); };
  const pending = sa.sync(); await requested; sa.stop(); release();
  assert.equal(await pending, false); assert.equal(a.prefs.get("theme"), "auto"); assert.equal(a.config.records.theme.values.theme, "auto"); assert.equal(a.saved(), before);
});

test("stopping during credential initialization prevents directory requests and stale connection caching", async () => {
  const a = await client(A); let release, calls = 0;
  const transport = { root: "https://old.invalid/", namespace: "account", init: () => new Promise(resolve => { release = resolve; }), request: async () => { calls++; return { status: 201, text: "" }; } };
  const sync = new WebDAVSync({ prefs: a.prefs, layout: a.layout, config: a.config, transport });
  const pending = sync.sync(); await new Promise(resolve => setImmediate(resolve)); sync.stop(); release();
  assert.equal(await pending, false); assert.equal(calls, 0); assert.ok(!sync.configured);
});
test("a cancelled authentication response cannot pause the next configured sync", async () => {
  const a = await client(A); let release;
  const transport = { root: "https://dav.invalid/", namespace: "account", init: async () => {}, request: () => new Promise(resolve => { release = resolve; }) };
  const sync = new WebDAVSync({ prefs: a.prefs, layout: a.layout, config: a.config, transport });
  const pending = sync.sync(); await new Promise(resolve => setImmediate(resolve)); sync.stop(); release({ status: 403, text: "" });
  assert.equal(await pending, false); assert.ok(!sync.paused);
});

test("old eight-prefix and three-shortcut records migrate without changing their logical versions", async () => {
  const prefixes = { ...Object.fromEntries(Object.entries(LEGACY_PREFIXES).map(([type, value]) => [type + "Prefix", value])), authorPrefix: "~" };
  const shortcuts = { launcherShortcut: "Alt+'", tabsShortcut: "native", advancedShortcut: DEFAULTS.advancedShortcut };
  const version = { clock: 7, deviceID: B }, state = { schemaVersion: 1, deviceID: A, clock: 7, dirty: true, records: { prefixes: { values: prefixes, version }, shortcuts: { values: shortcuts, version } } };
  const migrated = parseConfig(JSON.stringify(state));
  assert.equal(migrated.clock, 7); assert.deepEqual(migrated.records.prefixes.version, version);
  assert.equal(migrated.records.prefixes.values.currentPrefix, ">"); assert.equal(migrated.records.prefixes.values.outlinePrefix, "'");
  assert.equal(migrated.records.prefixes.values.authorPrefix, "~"); assert.equal(migrated.records.shortcuts.values.launcherShortcut, "Alt+'");
  assert.equal(migrated.records.shortcuts.values.outlineShortcut, "Alt+Ctrl+'");
  assert.equal(Object.keys(prefixes).length, 8); assert.equal(Object.keys(shortcuts).length, 3);
  const c = await client(A, { ...prefixes, ...shortcuts, lastQuery: "'rock ~Roe ", lastQueryBindings: JSON.stringify([["author:Roe", { kind: "author", key: "roe" }]]) }, JSON.stringify(state));
  assert.equal(c.config.error, undefined); assert.equal(c.prefs.get("lastQuery"), ">rock ~Roe ");
  assert.equal(c.prefs.get("inputSchemaVersion"), 5); assert.equal(c.config.clock, 7);
  await c.config.reconcile(); assert.equal(c.config.clock, 7); assert.deepEqual(c.config.records.prefixes, migrated.records.prefixes);
  assert.equal(c.config.pending.size, 0);
});

test("legacy remote input groups upgrade on the receiving device without modifying the old device file", async () => {
  const remote = server(), c = await client(A), sync = syncFor(c, remote);
  const prefixes = Object.fromEntries(Object.entries(LEGACY_PREFIXES).map(([type, value]) => [type + "Prefix", value]));
  const shortcuts = { launcherShortcut: DEFAULTS.launcherShortcut, tabsShortcut: "native", advancedShortcut: DEFAULTS.advancedShortcut };
  const version = { clock: 12, deviceID: B }, text = JSON.stringify({ schemaVersion: 1, deviceID: B, clock: 12, records: { prefixes: { values: prefixes, version }, shortcuts: { values: shortcuts, version } } });
  remote.files.set(configURL(B), text); await sync.sync();
  assert.equal(c.prefs.get("currentPrefix"), ">"); assert.equal(c.prefs.get("outlinePrefix"), "'"); assert.equal(c.prefs.get("outlineShortcut"), "Alt+'");
  assert.deepEqual(c.config.records.prefixes.version, version); assert.deepEqual(c.config.records.shortcuts.version, version);
  assert.equal(remote.files.get(configURL(B)), text);
  const uploaded = JSON.parse(remote.files.get(configURL(A)));
  assert.equal(Object.keys(uploaded.records.prefixes.values).length, 9); assert.equal(Object.keys(uploaded.records.shortcuts.values).length, 6);
  assert.ok(!JSON.stringify(uploaded).includes("inputSchemaVersion")); assert.equal(c.config.pending.size, 0);
});

test("configuration migration still rejects incomplete groups, duplicates and extra fields", () => {
  const base = { schemaVersion: 1, deviceID: B, clock: 3, records: {} }, version = { clock: 3, deviceID: B };
  const prefixes = Object.fromEntries(Object.entries(LEGACY_PREFIXES).map(([type, value]) => [type + "Prefix", value]));
  assert.throws(() => parseConfig(JSON.stringify({ ...base, records: { prefixes: { values: { ...prefixes, authorPrefix: "#" }, version } } })), /重复/);
  const incomplete = { ...prefixes }; delete incomplete.yearPrefix;
  assert.throws(() => parseConfig(JSON.stringify({ ...base, records: { prefixes: { values: incomplete, version } } })), /无效/);
  assert.throws(() => parseConfig(JSON.stringify({ ...base, records: { theme: { values: { theme: "dark", extra: true }, version } } })), /无效/);
  assert.throws(() => parseConfig(JSON.stringify({ ...base, records: { shortcuts: { values: { launcherShortcut: "Alt+'", tabsShortcut: "native", advancedShortcut: "Alt+'" }, version } } })), /重复/);
});
