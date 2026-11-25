import test from "node:test";
import assert from "node:assert/strict";
import { readCustomCredential, writeCustomCredential } from "../src/prefs.mjs";
import { preferenceFixture } from "./fixtures/preferences.mjs";

const connection = { davURL: "https://dav.invalid/layout/", davUsername: "fixture" };

test("every choice field has a native popup and commands save a valid choice", t => {
  const f = preferenceFixture(t);
  const choices = { defaultScope: ["library", "all"], theme: ["auto", "light", "dark"], density: ["compact", "normal", "spacious"] };
  assert.equal(f.field("openMode"), undefined);
  for (const [name, expected] of Object.entries(choices)) {
    const menu = f.field(name);
    assert.equal(menu.localName, "menulist");
    assert.equal(menu.namespaceURI, "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul");
    const popup = menu.children[0];
    assert.equal(popup.localName, "menupopup");
    assert.deepEqual(popup.children.map(item => item.getAttribute("value")), expected);
    assert.ok(popup.children.every(item => item.localName === "menuitem" && item.getAttribute("label")));
    assert.equal(menu.value, f.app.prefs.get(name));
    menu.value = expected.at(-1); f.fire(menu, "command");
    assert.equal(f.app.prefs.get(name), expected.at(-1));
    assert.equal(f.app.prefs.exportConfig().settings[name], expected.at(-1));
  }
});

test("removed outline depth has no setting control and old exports do not reactivate it", t => {
  const f = preferenceFixture(t, { outlineDepth: 3 });
  assert.equal(f.field("outlineDepth"), undefined); assert.equal(Object.hasOwn(f.app.prefs.exportConfig().settings, "outlineDepth"), false);
  f.app.prefs.importConfig({ schemaVersion: 1, settings: { outlineDepth: 1, fontSize: 16 } });
  assert.equal(f.app.prefs.get("fontSize"), 16); assert.equal(f.field("outlineDepth"), undefined);
});

test("manual WebDAV settings omit the old mode and accept old config without re-enabling it", t => {
  const f = preferenceFixture(t, { ...connection, davMode: "inherit" });
  assert.equal(f.field("davMode"), undefined);
  assert.equal(Object.hasOwn(f.app.prefs.exportConfig().settings, "davMode"), false);
  f.app.prefs.importConfig({ schemaVersion: 1, settings: { davMode: "inherit", fontSize: 16 } });
  assert.equal(f.app.prefs.get("fontSize"), 16);
  assert.equal(f.values.get("quickswitcher.davMode"), "inherit");
  assert.ok(f.field("davURL") && f.field("davUsername"));
  assert.ok(!f.all().some(node => node.localName === "button" && node.textContent === "保存凭据"));
});

test("typing a credential saves encrypted storage automatically and empty input preserves it", async t => {
  const f = preferenceFixture(t, connection);
  f.credential.value = "fixture first secret"; f.fire(f.credential, "input");
  assert.equal(f.logins.length, 0);
  await f.timers(); await f.root.qsFlushCredential();
  assert.deepEqual(await readCustomCredential(f.app.prefs), { username: "fixture", password: "fixture first secret" });
  assert.equal(f.logins[0].password, "encrypted:fixture first secret");
  assert.equal(f.values.has("quickswitcher.password"), false);
  assert.equal(f.credential.value, "fixture first secret");
  f.credential.value = ""; f.fire(f.credential, "input"); f.fire(f.credential, "blur"); await f.root.qsFlushCredential();
  assert.equal((await readCustomCredential(f.app.prefs)).password, "fixture first secret");
});

test("blur and connection checks flush pending input without needing a save button", async t => {
  const f = preferenceFixture(t, connection);
  f.credential.value = "blur secret"; f.fire(f.credential, "input"); f.fire(f.credential, "blur"); await f.root.qsFlushCredential();
  assert.equal((await readCustomCredential(f.app.prefs)).password, "blur secret");
  f.credential.value = "check secret"; f.fire(f.credential, "input");
  const button = f.all().find(node => node.textContent === "检查连接并同步"); f.fire(button, "click");
  await f.root.qsFlushCredential(); await Promise.resolve();
  assert.equal((await readCustomCredential(f.app.prefs)).password, "check secret");
  assert.equal(f.app.connectionChecks, 1);
});

test("an older asynchronous credential write cannot replace a newer draft or leak to another username", async t => {
  const f = preferenceFixture(t, connection);
  assert.equal(typeof f.root.qsFlushCredential, "function");
  let release, started;
  const pending = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { started = resolve; });
  f.encryption.encrypt = async value => { if (value === "old secret") { started(); await pending; } return "encrypted:" + value; };
  f.credential.value = "old secret"; f.fire(f.credential, "input"); await f.timers(); await entered;
  f.field("davUsername").value = "second"; f.fire(f.field("davUsername"), "change");
  f.credential.value = "new secret"; f.fire(f.credential, "input"); await f.timers(); release(); await f.root.qsFlushCredential();
  assert.equal(f.logins.find(login => login.username === "fixture")?.password, "encrypted:old secret");
  assert.equal(f.logins.find(login => login.username === "second")?.password, "encrypted:new secret");
  assert.equal(f.credential.value, "new secret");
  assert.equal(f.app.restarts, 1);
});

test("saving failures preserve the draft and prevent connection checks until retry succeeds", async t => {
  const f = preferenceFixture(t, connection); f.encryption.fail = true;
  f.credential.value = "retry secret"; f.fire(f.credential, "input"); await f.timers(); await f.root.qsFlushCredential();
  assert.equal(f.logins.length, 0); assert.equal(f.credential.value, "retry secret");
  f.fire(f.all().find(node => node.textContent === "检查连接并同步"), "click"); await f.root.qsFlushCredential();
  assert.equal(f.app.connectionChecks, 0);
  f.encryption.fail = false; f.fire(f.credential, "blur"); await f.root.qsFlushCredential();
  assert.equal((await readCustomCredential(f.app.prefs)).password, "retry secret");
});

test("credentials entered before connection fields save when fields become valid and pagehide flushes", async t => {
  const f = preferenceFixture(t);
  f.credential.value = "typed first"; f.fire(f.credential, "input"); await f.timers(); await f.root.qsFlushCredential();
  assert.equal(f.logins.length, 0);
  f.field("davURL").value = connection.davURL; f.fire(f.field("davURL"), "change");
  f.field("davUsername").value = connection.davUsername; f.fire(f.field("davUsername"), "change"); await f.root.qsFlushCredential();
  assert.equal((await readCustomCredential(f.app.prefs)).password, "typed first");
  const flush = f.root.qsFlushCredential;
  f.credential.value = "close secret"; f.fire(f.credential, "input"); f.fire(f.win, "pagehide"); await flush();
  assert.equal((await readCustomCredential(f.app.prefs)).password, "close secret");
  assert.equal(f.root.qsFlushCredential, undefined);
  assert.equal(f.root.dataset.ready, undefined);
  assert.equal(f.root.children.length, 0);
});

test("the credential helper captures its account before asynchronous storage reads", async t => {
  const f = preferenceFixture(t, connection);
  let release;
  const original = globalThis.Services.logins.searchLoginsAsync;
  globalThis.Services.logins.searchLoginsAsync = async options => { await new Promise(resolve => { release = resolve; }); return original(options); };
  const save = writeCustomCredential(f.app.prefs, "original account secret");
  f.app.prefs.set("davUsername", "other"); release(); await save;
  assert.equal(f.logins[0].username, "fixture");
});

test("disposing settings flushes the last draft and removes the closing listener", async t => {
  const f = preferenceFixture(t, connection);
  f.credential.value = "last draft"; f.fire(f.credential, "input"); await f.root.qsFlushCredential(true);
  assert.equal((await readCustomCredential(f.app.prefs)).password, "last draft");
  assert.equal(f.root.qsFlushCredential, undefined);
  f.credential.value = "retired draft"; f.fire(f.credential, "input"); f.win.dispatchEvent(new Event("pagehide"));
  assert.equal((await readCustomCredential(f.app.prefs)).password, "last draft");
});

test("clearing a failed replacement keeps the saved credential usable for connection checks", async t => {
  const f = preferenceFixture(t, connection);
  f.credential.value = "saved secret"; f.fire(f.credential, "input"); await f.root.qsFlushCredential();
  f.encryption.fail = true; f.credential.value = "failed replacement"; f.fire(f.credential, "input"); await f.root.qsFlushCredential();
  f.credential.value = ""; f.fire(f.credential, "input");
  f.fire(f.all().find(node => node.textContent === "检查连接并同步"), "click"); await f.root.qsFlushCredential(); await Promise.resolve();
  assert.equal((await readCustomCredential(f.app.prefs)).password, "saved secret");
  assert.equal(f.app.connectionChecks, 1);
});

test("invalid visible connection fields cannot save a draft under the previously stored connection", async t => {
  const f = preferenceFixture(t, connection);
  f.field("davURL").value = "invalid://changed"; f.fire(f.field("davURL"), "change");
  f.credential.value = "new connection secret"; f.fire(f.credential, "input"); await f.root.qsFlushCredential();
  assert.equal(f.logins.length, 0);
  assert.equal(f.credential.value, "new connection secret");
  f.field("davURL").value = "https://other.invalid/layout/"; f.fire(f.field("davURL"), "change"); await f.root.qsFlushCredential();
  assert.equal(f.logins[0].httpRealm, "Zotero Quick Switcher WebDAV https://other.invalid");
});

test("connection checks reject invalid visible addresses instead of using a previously saved address", async t => {
  const f = preferenceFixture(t, connection);
  f.field("davURL").value = "invalid://changed"; f.fire(f.field("davURL"), "change");
  f.fire(f.all().find(node => node.textContent === "检查连接并同步"), "click"); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.app.connectionChecks, 0);
});
