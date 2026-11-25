import test from "node:test";
import assert from "node:assert/strict";
import { WebDAVSync, discoveredFiles } from "../src/webdav.mjs";
import { A, B, memoryStore, placement } from "./fixtures/layout.mjs";

globalThis.DOMParser = class {
  parseFromString(text) { return { querySelector: () => null, getElementsByTagNameNS: () => [...text.matchAll(/<d:href>([^<]+)<\/d:href>/g)].map(match => ({ textContent: match[1] })) }; }
};
function server() {
  const files = new Map(), puts = []; let offline = false, auth = false;
  const transport = {
    root: "https://dav.invalid/", namespace: "test-account", init: async () => {},
    request: async (method, url, options = {}) => {
      if (offline) throw new Error("offline");
      if (auth) return { status: 401, text: "" };
      const name = new URL(url).pathname.split("/").at(-1);
      if (method === "MKCOL") return { status: 201, text: "" };
      if (method === "PROPFIND") return { status: 207, text: '<d:multistatus xmlns:d="DAV:">' + [...files.keys()].reverse().map(key => `<d:response><d:href>${url}${key}</d:href></d:response>`).join("") + "</d:multistatus>" };
      if (method === "GET") return { status: files.has(name) ? 200 : 404, text: files.get(name) || "" };
      if (method === "PUT") { files.set(name, options.body); puts.push(name); return { status: 201, text: "" }; }
      throw new Error("Unexpected method");
    },
  };
  return { files, puts, transport, offline: value => { offline = value; }, auth: value => { auth = value; } };
}
const syncFor = (store, transport) => new WebDAVSync({ layout: store, transport, prefs: { get: key => ({ syncEnabled: false, syncInterval: 60 })[key] } });
test("A-B-A and offline conflicting layouts converge while each client only writes itself", async () => {
  const remote = server(), a = await memoryStore(A), b = await memoryStore(B);
  const sa = syncFor(a.store, remote.transport), sb = syncFor(b.store, remote.transport);
  await a.store.place("u", "AAAA2222", placement("BBBB2222")); await sa.sync();
  await sb.sync(); assert.equal(b.store.get("u", "AAAA2222").parentCollectionKey, "BBBB2222");
  await b.store.place("u", "CCCC2222", placement("DDDD2222")); await sb.sync(); await sa.sync();
  assert.deepEqual(a.store.records, b.store.records);
  remote.offline(true);
  await a.store.place("u", "AAAA2222", placement("EEEE2222"));
  await b.store.place("u", "AAAA2222", placement("FFFF2222"));
  await assert.rejects(sa.sync()); assert.equal(a.store.dirty, true);
  remote.offline(false); await sa.sync(); await sb.sync(); await sa.sync();
  assert.deepEqual(a.store.records, b.store.records);
  assert.deepEqual(new Set(remote.puts), new Set([A + ".json", B + ".json"]));
});
test("corrupt/unknown remote files are retained, own corrupt files never overwritten and auth pauses", async () => {
  const remote = server(), a = await memoryStore(A), sync = syncFor(a.store, remote.transport);
  remote.files.set(B + ".json", '{"schemaVersion":99}'); await sync.sync();
  assert.equal(sync.status.state, "warning"); assert.equal(remote.files.get(B + ".json"), '{"schemaVersion":99}');
  remote.files.set(A + ".json", "broken"); await a.store.place("u", "AAAA2222", null);
  await assert.rejects(sync.sync()); assert.equal(remote.files.get(A + ".json"), "broken"); assert.equal(a.store.dirty, true);
  remote.auth(true); await assert.rejects(sync.sync()); assert.equal(sync.paused, true);
  const puts = remote.puts.length; assert.equal(await sync.sync(), false); assert.equal(remote.puts.length, puts);
});
test("directory discovery excludes escaping paths, other origins and unrelated files", () => {
  const root = "https://dav.invalid/quickswitcher-layout/test-account/";
  const names = [root + A + ".json", "https://evil.invalid/" + B + ".json", root + "../" + B + ".json", root + "unrelated.json", root + "%2e%2e%2f" + B + ".json"];
  const xml = names.map(name => `<d:href>${name}</d:href>`).join("");
  assert.deepEqual(discoveredFiles(xml, root), [A + ".json"]);
  assert.throws(() => discoveredFiles("<!DOCTYPE malicious>" + xml, root));
});
