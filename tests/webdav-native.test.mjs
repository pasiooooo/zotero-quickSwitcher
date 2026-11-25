import test from "node:test";
import assert from "node:assert/strict";
import { NativeDavTransport } from "../src/webdav.mjs";
import { writeCustomCredential } from "../src/prefs.mjs";
import { preferenceFixture } from "./fixtures/preferences.mjs";

test("manual WebDAV uses entered connection and secure credentials even when an old inherited mode remains", async t => {
  const f = preferenceFixture(t, { davMode: "inherit", davURL: "https://dav.invalid/storage/", davUsername: "fixture" });
  globalThis.Zotero.Sync = { Storage: { Mode: { WebDAV: class {} } }, Runner: { getStorageController: () => { throw new Error("Inherited connections have been removed"); } } };
  globalThis.Zotero.Users = { getCurrentUserID: () => 42 };
  globalThis.Services.io = { newURI: spec => ({ spec }) };
  await writeCustomCredential(f.app.prefs, "manual fixture secret");
  const transport = new NativeDavTransport(f.app.prefs);
  await transport.init();
  assert.equal(transport.root.href, "https://dav.invalid/storage/");
  assert.equal(transport.root.username, "");
  assert.equal(transport.root.password, "");
  assert.equal(transport.namespace, "user-42");
  assert.deepEqual(transport.credential, { username: "fixture", password: "manual fixture secret" });
  assert.equal(new URL(transport.auth._rootURI.spec).pathname, "/storage/");
});

test("missing manual connection fields do not fall back to the Zotero account", async t => {
  const f = preferenceFixture(t, { davMode: "inherit" });
  const transport = new NativeDavTransport(f.app.prefs);
  await assert.rejects(transport.init(), /WebDAV 未配置/);
  assert.equal(transport.root, undefined);
});

test("WebDAV responses are text even for empty XML-typed directory creation, while PROPFIND keeps its XML body", async t => {
  const f = preferenceFixture(t), seen = [], cached = [];
  const transport = new NativeDavTransport(f.app.prefs);
  transport.root = new URL("https://dav.invalid/storage/");
  transport.credential = { username: "fixture", password: "test secret" };
  transport.auth = { _getAuthorizationHeaders: () => ({ Authorization: "fixture" }), _cacheAuthorization: value => cached.push(value) };
  globalThis.Services.io = { newURI: spec => ({ spec }) };
  globalThis.Zotero.HTTP = { request: async (method, uri, options) => {
    const xhr = { overrideMimeType: value => seen.push(value), abort() {} };
    options.requestObserver(xhr);
    assert.equal(options.responseType, "text"); assert.equal(options.followRedirects, false);
    assert.equal(options.headers.Authorization, "fixture");
    options.onAuthorizationHeader("cached");
    if (method === "MKCOL") return { status: 201, responseText: "" };
    assert.equal(options.body, "<propfind/>"); assert.equal(options.headers.Depth, "1");
    return { status: 207, responseText: "<multistatus/>" };
  } };
  assert.deepEqual(await transport.request("MKCOL", "https://dav.invalid/storage/layout/"), { status: 201, text: "" });
  assert.deepEqual(await transport.request("PROPFIND", "https://dav.invalid/storage/layout/", { headers: { Depth: "1" }, body: "<propfind/>" }), { status: 207, text: "<multistatus/>" });
  assert.deepEqual(seen, ["text/plain", "text/plain"]); assert.deepEqual(cached, ["cached", "cached"]);
  await assert.rejects(transport.request("GET", "https://other.invalid/"), /指定目录/u);
});
