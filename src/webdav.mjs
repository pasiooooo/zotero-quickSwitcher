// SPDX-License-Identifier: AGPL-3.0-or-later
import { t } from "./i18n.mjs";
import { readCustomCredential } from "./prefs.mjs";
import { UUID } from "./core.mjs";
import { parseLayout, MAX_LAYOUT_BYTES } from "./layout.mjs";
import { parseConfig } from "./config.mjs";

function validRoot(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error(t("WebDAV 根地址无效"));
  url.pathname = url.pathname.replace(/\/*$/, "/"); return url;
}
export function discoveredFiles(xml, root) {
  if (xml.length > MAX_LAYOUT_BYTES || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error(t("WebDAV 目录响应无效或过大"));
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error(t("WebDAV 目录响应格式无效"));
  const files = new Set(), parent = validRoot(root);
  for (const node of doc.getElementsByTagNameNS("DAV:", "href")) {
    const url = new URL(node.textContent, parent);
    if (url.origin !== parent.origin || url.search || url.hash) continue;
    const path = decodeURIComponent(url.pathname), base = decodeURIComponent(parent.pathname);
    if (!path.startsWith(base)) continue;
    const name = path.slice(base.length);
    if (name.endsWith(".json") && UUID.test(name.slice(0, -5))) files.add(name);
  }
  if (files.size > 500) throw new Error(t("WebDAV 设备文件数量超过限制"));
  return [...files].sort();
}

export class NativeDavTransport {
  constructor(prefs) { this.prefs = prefs; }
  async init() {
    const root = this.prefs.get("davURL"), credential = await readCustomCredential(this.prefs);
    if (!root || !credential?.username || !credential.password) throw new Error(t("WebDAV 未配置；布局已保存在本机"));
    this.root = validRoot(root);
    const account = Zotero.Users.getCurrentUserID();
    this.namespace = account ? `user-${account}` : `local-${Zotero.Utilities.Internal.md5(credential.username)}`;
    const authURL = new URL(this.root); authURL.username = credential.username; authURL.password = credential.password;
    this.auth = new Zotero.Sync.Storage.Mode.WebDAV({});
    this.auth._rootURI = Services.io.newURI(authURL.href);
    this.credential = credential;
  }
  abort() { this.xhr?.abort(); }
  async request(method, url, { headers = {}, body } = {}) {
    const target = validRoot(this.root.href), destination = new URL(url);
    if (destination.origin !== target.origin || !destination.pathname.startsWith(target.pathname)) throw new Error(t("WebDAV 请求超出指定目录"));
    const uri = Services.io.newURI(destination.href);
    const authenticated = new URL(destination); authenticated.username = this.credential.username; authenticated.password = this.credential.password;
    const response = await Zotero.HTTP.request(method, Services.io.newURI(authenticated.href), {
      body, headers: { ...this.auth._getAuthorizationHeaders(method, uri), ...headers },
      followRedirects: false, successCodes: false, timeout: 20000, responseType: "text",
      onAuthorizationHeader: header => this.auth._cacheAuthorization(header),
      requestObserver: xhr => { this.xhr = xhr; xhr.overrideMimeType("text/plain"); },
      notificationCallbacks: { onProgress: (progress, max) => { if (progress > MAX_LAYOUT_BYTES || max > MAX_LAYOUT_BYTES) this.xhr?.abort(); } },
    });
    const text = response.responseText || "";
    if (new TextEncoder().encode(text).length > MAX_LAYOUT_BYTES) throw new Error(t("WebDAV 响应超过 2 MB"));
    return { status: response.status, text };
  }
}

export class WebDAVSync {
  constructor({ prefs, layout, config, onStatus = () => {}, transport, timers = globalThis }) {
    this.prefs = prefs; this.layout = layout; this.config = config; this.onStatus = onStatus; this.transport = transport; this.timers = timers;
    this.status = { state: "local", message: "布局已保存在本机" }; this.generation = 0;
  }
  say(state, message) { this.status = { state, message }; this.onStatus(this.status); }
  start() {
    this.stop(); this.enabled = this.prefs.get("syncEnabled");
    this.paused = false; this.configured = false;
    if (!this.enabled) { this.say("local", "自动同步已关闭；布局已保存在本机"); return Promise.resolve(); }
    this.say("pending", "等待同步搜索布局");
    this.interval = this.timers.setInterval(() => this.schedule(0), this.prefs.get("syncInterval") * 1000);
    this.schedule(0); return Promise.resolve();
  }
  stop() {
    this.enabled = false; this.generation++; this.transport?.abort?.();
    this.timers.clearTimeout(this.timer); this.timers.clearInterval(this.interval);
  }
  schedule(delay = 2000) {
    if (!this.enabled || this.paused) return;
    this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(() => this.sync().catch(() => {}), delay);
  }
  async configure() {
    if (this.configured) return;
    const generation = this.generation;
    if (!this.transport) this.transport = new NativeDavTransport(this.prefs);
    await this.transport.init();
    if (generation !== this.generation) return false;
    const base = validRoot(this.transport.root.href || this.transport.root);
    this.directory = new URL(`quickswitcher-layout/${encodeURIComponent(this.transport.namespace)}/`, base).href;
    this.pluginDirectory = new URL("quickswitcher-layout/", base).href;
    this.configDirectory = new URL(`quickswitcher-config/${encodeURIComponent(this.transport.namespace)}/`, base).href;
    this.pluginConfigDirectory = new URL("quickswitcher-config/", base).href;
    this.configured = true;
  }
  async request(method, url, options) {
    const generation = this.generation;
    const response = await this.transport.request(method, url, options);
    if ([401, 403].includes(response.status) && generation === this.generation) { this.paused = true; throw new Error(t("WebDAV 认证失败；更新连接设置后重试")); }
    return response;
  }
  async testConnection() {
    const generation = this.generation;
    if (await this.configure() === false || generation !== this.generation) return [];
    return this.discover(this.pluginDirectory, this.directory);
  }
  async discover(pluginDirectory, directory) {
    const generation = this.generation;
    for (const path of [pluginDirectory, directory]) {
      if (generation !== this.generation) return [];
      const response = await this.request("MKCOL", path);
      if (generation !== this.generation) return [];
      if (![201, 204, 301, 405].includes(response.status)) throw new Error(t("WebDAV 无法创建专属目录（{status}）", { status: response.status }));
    }
    const response = await this.request("PROPFIND", directory, { headers: { Depth: "1", "Content-Type": "application/xml" }, body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>' });
    if (generation !== this.generation) return [];
    if (response.status !== 207) throw new Error(t("WebDAV 目录发现失败（{status}）", { status: response.status }));
    return discoveredFiles(response.text, directory);
  }
  async syncStore(store, directory, files, parse, generation, warnings) {
    const own = store.deviceID + ".json";
    for (const file of files) {
      if (generation !== this.generation) return false;
      const response = await this.request("GET", new URL(file, directory).href);
      if (generation !== this.generation) return false;
      if (response.status === 404) continue;
      if (response.status !== 200) throw new Error(t("设备文件读取失败（{status}）", { status: response.status }));
      let parsed;
      try {
        parsed = parse(response.text);
        if (parsed.deviceID + ".json" !== file) throw new Error(t("设备文件身份不一致"));
        store.validate?.(parsed.records);
      } catch (error) {
        if (file === own) throw new Error(t("本设备远端文件损坏或版本未知，已保留文件与本地待同步数据"));
        warnings.push(file); continue;
      }
      await store.merge(parsed.records, () => generation === this.generation, parsed.queries);
    }
    if (generation !== this.generation) return false;
    await store.initializeMissing?.();
    await store.work;
    if (generation !== this.generation) return false;
    if (store.dirty || !files.includes(own)) {
      const state = store.snapshot(); delete state.dirty;
      const response = await this.request("PUT", new URL(own, directory).href, { headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(state) });
      if (generation !== this.generation) return false;
      if (![200, 201, 204].includes(response.status)) throw new Error(t("WebDAV 数据写入失败（{status}）", { status: response.status }));
      await store.markSynced(state.clock);
    }
    return generation === this.generation;
  }
  sync() {
    if (this.paused) return Promise.resolve(false);
    if (this.running) { this.queued = true; return this.running; }
    const generation = this.generation;
    this.running = (async () => {
      const settings = this.config && this.prefs.get("syncSettings");
      this.say("syncing", settings ? "正在同步搜索布局与配置…" : "正在同步搜索布局…");
      try {
        if (settings) await this.config.reconcile();
        const files = await this.testConnection(), warnings = [];
        if (!await this.syncStore(this.layout, this.directory, files, parseLayout, generation, warnings)) return false;
        if (settings) {
          const configFiles = await this.discover(this.pluginConfigDirectory, this.configDirectory);
          if (!await this.syncStore(this.config, this.configDirectory, configFiles, parseConfig, generation, warnings)) return false;
        }
        if (generation !== this.generation) return false;
        this.say(warnings.length ? "warning" : "synced", warnings.length ? `同步完成；保留并跳过 ${warnings.length} 个损坏或未知版本文件` : settings ? "搜索布局与配置已同步" : "搜索布局已同步"); return true;
      } catch (error) {
        if (generation !== this.generation) return false;
        if (generation === this.generation) this.say(this.paused ? "auth" : "offline", this.paused ? "认证失败，自动重试已暂停；请更新设置" : error.message || "离线；待同步布局已保存在本机");
        throw error;
      } finally {
        this.running = null;
        if (this.queued && this.enabled && !this.paused) { this.queued = false; this.schedule(0); }
      }
    })();
    return this.running;
  }
}
