// SPDX-License-Identifier: AGPL-3.0-or-later
import { element, installStyle } from "./dom.mjs";
import { parseShortcut, findShortcutConflicts, shortcutFromEvent, shortcutLabel, shiftedKeys } from "./keys.mjs";
import { keyAttributes, nativeShortcut } from "./window-keys.mjs";
import { hotkeyFromShortcut } from "./global-hotkey.mjs";
import { DEFAULT_PREFIXES, PRE_TAG_PREFIXES, PRIOR_PREFIXES, LEGACY_PREFIXES, availablePrefix, migrateLauncherPrefixes } from "./launcher-query.mjs";
import { t, localize } from "./i18n.mjs";

// What each Enter chord runs per mode; "" leaves the chord unassigned.
export const ACTIONS = Object.freeze({ items: ["read", "locate", "window", "web", "pdf", "citation", "bibliography"], tabs: ["switch", "window", "web", "pdf", "citation", "bibliography"], outline: ["jump", "split"], directories: ["open", "parent"] });
export const ACTION_KEYS = Object.freeze(["enter", "shift", "ctrl", "alt"]);

export const DEFAULTS = Object.freeze({
  ...Object.fromEntries(Object.entries(DEFAULT_PREFIXES).map(([type, marker]) => [`${type}Prefix`, marker])),
  launcherShortcut: "Alt+O", tabsShortcut: "Alt+;", advancedShortcut: "Alt+F", outlineShortcut: "Alt+'", directoryShortcut: "Alt+/", commandShortcut: "Alt+P",
  globalShortcut: "Alt+Shift+O",
  defaultScope: "library", recursive: true,
  fields: ["title", "creator", "date", "DOI", "citationKey", "tag", "abstractNote"],
  sources: { notes: false, annotations: false, fulltext: false },
  citationStyle: "", citationLocale: "", citationRules: [],
  actions: {
    items: { enter: "read", shift: "window", ctrl: "locate", alt: "web" },
    tabs: { enter: "switch", shift: "window", ctrl: "", alt: "web" },
    outline: { enter: "jump", shift: "split", ctrl: "", alt: "" },
    directories: { enter: "open", shift: "parent", ctrl: "", alt: "" },
  },
  limit: 20, locationsVisible: 2, restoreQuery: false, preview: false,
  clipboardSearch: true, clipboardSeconds: 3,
  language: "auto", theme: "auto", density: "normal", fontSize: 14, width: 62, height: 80, highlightColor: "#f2d46c",
  syncEnabled: true, syncSettings: true, syncInterval: 60, davURL: "", davUsername: "",
  recentItems: [], lastQuery: "", lastQueryBindings: [], lastQueryScopes: [],
});

const numeric = { limit: [5, 200], locationsVisible: [1, 8], clipboardSeconds: [1, 60], fontSize: [12, 22], width: [30, 100], height: [40, 100], syncInterval: [15, 3600] };
const choices = { language: ["auto", "en-US", "zh-CN"], defaultScope: ["library", "all"], theme: ["auto", "light", "dark"], density: ["compact", "normal", "spacious"] };
const privateSettings = new Set(["deviceID", "clock", "davUsername", "recentItems", "lastQuery", "lastQueryBindings", "lastQueryScopes"]);
// A system-wide chord belongs to one machine, so files and sync never carry it.
const deviceSettings = new Set(["globalShortcut"]);
const shortcutNames = ["launcherShortcut", "tabsShortcut", "advancedShortcut", "outlineShortcut", "directoryShortcut", "commandShortcut"];
export const MODE_PREFIXES = Object.freeze({ tabsPrefix: "tabsShortcut", outlinePrefix: "outlineShortcut", directoryPrefix: "directoryShortcut" });
const prefixNames = Object.keys(DEFAULT_PREFIXES).map(type => `${type}Prefix`);
export const CONFIG_GROUPS = Object.freeze({ prefixes: prefixNames, shortcuts: shortcutNames,
  ...Object.fromEntries(Object.keys(DEFAULTS).filter(name => !privateSettings.has(name) && !name.startsWith("dav") && !name.startsWith("sync")
    && name !== "locationsVisible" && name !== "globalShortcut" && !prefixNames.includes(name) && !shortcutNames.includes(name)).map(name => [name, [name]])) });
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));

export function shortcutPrefix(value) {
  const chord = parseShortcut(value === "native" ? "Alt+;" : value, !!globalThis.Zotero?.isMac);
  const key = chord.shift ? Object.entries(shiftedKeys).find(([, key]) => key === chord.key)?.[0] || chord.key.toUpperCase() : chord.key;
  if (key.length !== 1 || /[\s\\"*?()+\-]/u.test(key)) throw new Error(t("切换快捷键需使用可输入字符"));
  return key;
}

export function linkModePrefixes(prefixes, shortcuts, repair = false, needsTag = false) {
  const result = { ...prefixes };
  for (const [name, shortcut] of Object.entries(MODE_PREFIXES)) if (shortcuts[shortcut]) result[name] = shortcutPrefix(shortcuts[shortcut]);
  if (repair) {
    const used = Object.keys(MODE_PREFIXES).map(name => result[name]);
    for (const [name, value] of Object.entries(result)) if (!Object.hasOwn(MODE_PREFIXES, name) && !(needsTag && name === "tagPrefix")) {
      result[name] = used.includes(value) ? availablePrefix(DEFAULTS[name], [...used, ...Object.values(result)]) : value;
      used.push(result[name]);
    }
    if (needsTag) result.tagPrefix = availablePrefix(DEFAULTS.tagPrefix, used);
  }
  return result;
}

function shortcutSignature(value) {
  const isMac = !!globalThis.Zotero?.isMac;
  const nativeKey = value === "native" && globalThis.Zotero?.getMainWindow?.()?.document?.getElementById?.("key_showTabsMenu");
  const shortcut = value === "native" ? nativeKey && nativeShortcut(nativeKey, isMac) || parseShortcut("Accel+;", isMac) : parseShortcut(value, isMac);
  return JSON.stringify(keyAttributes(shortcut));
}

export function migrateInputGroup(group, values) {
  if (!values || Array.isArray(values) || typeof values !== "object") throw new Error(t("同步配置记录无效"));
  const names = CONFIG_GROUPS[group];
  const added = group === "prefixes" ? "outlinePrefix" : group === "shortcuts" ? "outlineShortcut" : null;
  const legacy = added && !Object.hasOwn(values, added), expected = names?.filter(name => !(legacy && name === added) && !(name === "tagPrefix" && !Object.hasOwn(values, name)) && !(group === "shortcuts" && ["directoryShortcut", "commandShortcut"].includes(name) && !Object.hasOwn(values, name)));
  if (!expected || Object.keys(values).length !== expected.length || expected.some(name => !Object.hasOwn(values, name))) throw new Error(t("同步配置记录无效"));
  const result = Object.fromEntries(expected.map(name => [name, validatePreference(name, values[name], true)]));
  if (group === "prefixes") {
    if (new Set(Object.values(result)).size !== expected.length || result.currentPrefix === "'" && Object.entries(result).some(([name, marker]) => name !== "currentPrefix" && marker === "‘")) throw new Error(t("引导符重复，请为各模式选择不同字符"));
    if (legacy) {
      if (result.currentPrefix === LEGACY_PREFIXES.current) result.currentPrefix = availablePrefix(DEFAULT_PREFIXES.current, Object.entries(result).filter(([name]) => name !== "currentPrefix").map(([, marker]) => marker));
      result.outlinePrefix = availablePrefix(DEFAULT_PREFIXES.outline, Object.values(result));
    }
    result.tagPrefix ??= availablePrefix(DEFAULT_PREFIXES.tag, Object.values(result));
  } else if (group === "shortcuts") {
    if (Object.hasOwn(values, "commandShortcut")) {
      for (const name of names) validatePreference(name, result[name]);
      const signatures = names.map(name => shortcutSignature(result[name]));
      if (new Set(signatures).size !== names.length) throw new Error(t("快捷键重复，请选择其他组合"));
      if (signatures.includes(shortcutSignature("Alt+Shift+P"))) throw new Error(t("Alt+Shift+P 预留给命令面板"));
      return result;
    }
    const signatures = Object.values(result).map(shortcutSignature);
    if (new Set(signatures).size !== expected.length) throw new Error(t("快捷键重复，请选择其他组合"));
    if (legacy) result.outlineShortcut = [DEFAULTS.outlineShortcut, "Alt+Shift+'", "Alt+O", "Alt+Shift+O"].find(shortcut => !signatures.includes(shortcutSignature(shortcut)));
    if (["Accel+Shift+P", "Ctrl+Shift+P", "Cmd+Shift+P", "Alt+Shift+P", "Alt+Shift+O"].includes(result.launcherShortcut)) result.launcherShortcut = DEFAULTS.launcherShortcut;
    if (["Accel+Shift+F", "Ctrl+Shift+F", "Cmd+Shift+F", "Alt+Shift+F"].includes(result.advancedShortcut)) result.advancedShortcut = DEFAULTS.advancedShortcut;
    if (result.tabsShortcut === "native") result.tabsShortcut = DEFAULTS.tabsShortcut;
    if (!result.directoryShortcut) result.directoryShortcut = [DEFAULTS.directoryShortcut, "Alt+Shift+/"].find(shortcut => !Object.values(result).some(value => shortcutSignature(value) === shortcutSignature(shortcut)));
    if (!result.commandShortcut) result.commandShortcut = [DEFAULTS.commandShortcut, "Alt+Ctrl+P"].find(shortcut => !Object.values(result).some(value => shortcutSignature(value) === shortcutSignature(shortcut)));
    const used = new Set();
    for (const name of names) {
      if (Object.values(MODE_PREFIXES).includes(name)) {
        try { shortcutPrefix(result[name]); } catch { result[name] = DEFAULTS[name]; }
      }
      if (used.has(shortcutSignature(result[name])) || shortcutSignature(result[name]) === shortcutSignature("Alt+Shift+P")) {
        result[name] = [DEFAULTS[name], "Alt+Shift+" + ({ launcherShortcut: "O", tabsShortcut: ";", outlineShortcut: "'", directoryShortcut: "/", advancedShortcut: "F", commandShortcut: "P" })[name], "Alt+Ctrl+" + ({ launcherShortcut: "O", tabsShortcut: ";", outlineShortcut: "'", directoryShortcut: "/", advancedShortcut: "F", commandShortcut: "P" })[name]].find(value => {
          if (Object.values(MODE_PREFIXES).includes(name)) { try { shortcutPrefix(value); } catch { return false; } }
          return !used.has(shortcutSignature(value)) && shortcutSignature(value) !== shortcutSignature("Alt+Shift+P");
        });
      }
      used.add(shortcutSignature(result[name]));
    }
  }
  return Object.fromEntries(names.map(name => [name, result[name]]));
}

export function validatePreference(name, value, migrating = false) {
  if (name === "defaultScope" && value === "collection") value = "library";
  if (migrating && ["width", "height"].includes(name) && Number.isInteger(value) && value >= (name === "width" ? 520 : 360) && value <= (name === "width" ? 1400 : 1200)) value = DEFAULTS[name];
  if (!Object.hasOwn(DEFAULTS, name)) throw new Error(t("未知设置：{name}", { name }));
  if (numeric[name] && (!Number.isInteger(value) || value < numeric[name][0] || value > numeric[name][1])) throw new Error(t("设置 {name} 超出范围", { name }));
  if (choices[name] && !choices[name].includes(value)) throw new Error(t("设置 {name} 的值无效", { name }));
  if (name === "globalShortcut") { if (value !== "") hotkeyFromShortcut(value); }
  else if (name.endsWith("Shortcut") && !(name === "tabsShortcut" && value === "native")) keyAttributes(parseShortcut(value, !!globalThis.Zotero?.isMac));
  if (!migrating && Object.values(MODE_PREFIXES).includes(name)) shortcutPrefix(value);
  if (prefixNames.includes(name)) {
    if (value === "Space" || value === "空格") value = " ";
    if (value === "Tab") value = "\t";
    if (typeof value !== "string" || value.length !== 1 || (Object.hasOwn(MODE_PREFIXES, name) ? /[\\"*?()+\-]/u : /[\p{L}\p{N}\\"*?()+\-]/u).test(value)
      || /\s/u.test(value) && !(name === "fulltextPrefix" && value === " " || migrating && name === "tabsPrefix" && [" ", "\t"].includes(value))) throw new Error(t("引导符需为可输入字符；全部字段可用空格"));
  }
  if (name === "fields" && (!Array.isArray(value) || !value.length || value.some(f => !DEFAULTS.fields.includes(f)))) throw new Error(t("检索字段无效"));
  if (name === "sources" && (!value || ["notes", "annotations", "fulltext"].some(k => typeof value[k] !== "boolean") || Object.keys(value).some(k => !["notes", "annotations", "fulltext"].includes(k)))) throw new Error(t("正文选项无效"));
  if (name === "citationStyle" && (typeof value !== "string" || value.length > 2048)) throw new Error(t("引用格式无效"));
  if (name === "citationLocale" && (typeof value !== "string" || value !== "" && !/^[a-z]{2,3}(?:-[a-zA-Z0-9]{2,8}){0,2}$/u.test(value))) throw new Error(t("引用语言无效"));
  if (name === "citationRules") {
    if (!Array.isArray(value) || value.length > 64 || value.some(rule => !rule || typeof rule !== "object" || Array.isArray(rule)
      || Object.keys(rule).some(key => !["app", "styleID", "locale"].includes(key)) || typeof rule.app !== "string" || !rule.app.trim()
      || rule.app.length > 160 || /[\\/\u0000-\u001f]/u.test(rule.app) || typeof rule.styleID !== "string" || !rule.styleID || rule.styleID.length > 2048
      || rule.locale != null && (typeof rule.locale !== "string" || rule.locale !== "" && !/^[a-z]{2,3}(?:-[a-zA-Z0-9]{2,8}){0,2}$/u.test(rule.locale)))) throw new Error(t("应用引用规则无效"));
    value = value.map(rule => ({ app: rule.app.trim(), styleID: rule.styleID, ...(rule.locale ? { locale: rule.locale } : {}) }));
    if (new Set(value.map(rule => rule.app.toLowerCase())).size !== value.length) throw new Error(t("应用规则重复"));
  }
  if (name === "actions") {
    const exact = (object, names) => !!object && typeof object === "object" && !Array.isArray(object) && Object.keys(object).length === names.length && names.every(key => Object.hasOwn(object, key));
    const modes = Object.keys(ACTIONS);
    if (!exact(value, modes) || modes.some(mode => !exact(value[mode], ACTION_KEYS) || ACTION_KEYS.some(key => value[mode][key] !== "" && !ACTIONS[mode].includes(value[mode][key])))) throw new Error(t("回车动作无效"));
    // One key order on every device keeps synced records comparable as JSON.
    value = Object.fromEntries(modes.map(mode => [mode, Object.fromEntries(ACTION_KEYS.map(key => [key, value[mode][key]]))]));
  }
  if (name === "highlightColor" && !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(t("高亮颜色无效"));
  if (name === "recentItems" && (!Array.isArray(value) || value.length > 200 || value.some(id => !Number.isSafeInteger(id) || id <= 0))) throw new Error(t("阅读记录无效"));
  if (name === "lastQueryScopes" && (!Array.isArray(value) || value.length > 64 || value.some(scope => !Object.hasOwn(DEFAULT_PREFIXES, scope?.type)
    || ![scope.marker, scope.open, scope.close].every(index => Number.isSafeInteger(index) && index >= 0 && index <= 2048)
    || scope.open !== scope.marker + 1 || scope.close <= scope.open))) throw new Error(t("查询范围记录无效"));
  if (name === "lastQueryBindings" && (!Array.isArray(value) || value.length > 64 || value.some(entry => !Array.isArray(entry) || entry.length !== 2
    || typeof entry[0] !== "string" || entry[0].length > 2048 || !["author", "year", "venue", "type", "tag", "collection", "search", "library", "feed", "feeds", "outline", "tab"].includes(entry[1]?.kind)
    || !["author", "year", "venue", "type", "tag"].includes(entry[1].kind) && !Number.isSafeInteger(entry[1].libraryID)
    || entry[1].kind === "venue" && !["publicationTitle", "publisher"].includes(entry[1].field)
    || entry[1].kind === "outline" && !Number.isSafeInteger(entry[1].attachmentID)
    || entry[1].kind !== "library" && (typeof entry[1].key !== "string" || !entry[1].key || entry[1].key.length > 2048)))) throw new Error(t("查询筛选引用无效"));
  if (name === "davURL" && value) {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error(t("WebDAV 地址须为不含凭据和查询参数的 HTTP(S) URL"));
  }
  if (typeof DEFAULTS[name] === "boolean" && typeof value !== "boolean") throw new Error(t("设置 {name} 需要布尔值", { name }));
  if (typeof DEFAULTS[name] === "string" && typeof value !== "string") throw new Error(t("设置 {name} 需要文本", { name }));
  return clone(value);
}

export class Prefs {
  constructor(onChange = () => {}, onBatchChange = () => {}) { this.onChange = onChange; this.onBatchChange = onBatchChange; this.errors = new Map(); }
  get(name) {
    if (Object.hasOwn(MODE_PREFIXES, name)) {
      try { return shortcutPrefix(this.get(MODE_PREFIXES[name])); } catch { return DEFAULTS[name]; }
    }
    let value;
    try { value = Zotero.Prefs.get(`quickswitcher.${name}`); } catch { value = undefined; }
    if (value === undefined || value === null) return clone(DEFAULTS[name]);
    try {
      if (typeof DEFAULTS[name] === "object" || ["deviceID", "clock"].includes(name)) value = JSON.parse(value);
      const checked = Object.hasOwn(DEFAULTS, name) ? validatePreference(name, value, ["width", "height"].includes(name)) : value;
      this.errors.delete(name); return checked;
    } catch (error) { this.errors.set(name, error.message); return clone(DEFAULTS[name]); }
  }
  set(name, value) { this.apply([[name, value]]); }
  migrateInputSettings() {
    const read = name => { try { return Zotero.Prefs.get(`quickswitcher.${name}`); } catch { return undefined; } };
    const version = read("inputSchemaVersion");
    if (version >= 6) return false;
    try {
      const hasOutline = read("outlinePrefix") != null;
      const fresh = !Object.keys(DEFAULT_PREFIXES).some(type => read(type + "Prefix") != null) && version == null;
      const before = Object.fromEntries(Object.entries(fresh ? DEFAULT_PREFIXES : version === 5 ? PRE_TAG_PREFIXES : hasOutline ? PRIOR_PREFIXES : LEGACY_PREFIXES).map(([type, marker]) => [type, read(`${type}Prefix`) ?? marker]));
      let prefixes = migrateInputGroup("prefixes", Object.fromEntries(Object.entries(before).map(([type, marker]) => [`${type}Prefix`, marker])));
      const shortcutFields = shortcutNames.filter(name => !(read(name) == null && ["outlineShortcut", "directoryShortcut", "commandShortcut"].includes(name)));
      const shortcuts = migrateInputGroup("shortcuts", Object.fromEntries(shortcutFields.map(name => [name, read(name) ?? DEFAULTS[name]])));
      prefixes = linkModePrefixes(prefixes, shortcuts, true, !Object.hasOwn(before, "tag"));
      const after = Object.fromEntries(Object.entries(prefixes).map(([name, marker]) => [name.slice(0, -6), marker]));
      const entries = [...Object.entries(prefixes), ...Object.entries(shortcuts), ["width", this.get("width")], ["height", this.get("height")], ["inputSchemaVersion", 6]];
      const query = read("lastQuery");
      if (typeof query === "string" && query) entries.push(["lastQuery", migrateLauncherPrefixes(query, before, after)]);
      this.apply(entries); this.errors.delete("inputMigration"); return { prefixes, shortcuts };
    } catch (error) { this.errors.set("inputMigration", error.message); return false; }
  }
  validate(entries) {
    let checked = entries.filter(([name]) => name !== "openMode").map(([name, value]) => [name, Object.hasOwn(DEFAULTS, name) ? validatePreference(name, value) : value]);
    const edits = new Map(checked);
    for (const [name, shortcutName] of Object.entries(MODE_PREFIXES)) {
      if (edits.has(name) && !edits.has(shortcutName)) {
        const chord = parseShortcut(this.get(shortcutName) === "native" ? "Alt+;" : this.get(shortcutName), !!globalThis.Zotero?.isMac);
        const value = [chord.ctrl && "Control", chord.meta && "Meta", chord.alt && "Alt", /^[A-Z]$/u.test(edits.get(name)) && "Shift", edits.get(name)].filter(Boolean).join("+");
        edits.set(shortcutName, validatePreference(shortcutName, value));
      }
      if (edits.has(shortcutName)) edits.set(name, shortcutPrefix(edits.get(shortcutName)));
    }
    checked = [...edits];
    if (checked.some(([name]) => prefixNames.includes(name))) {
      const updates = new Map(checked), before = Object.fromEntries(Object.keys(DEFAULT_PREFIXES).map(type => [type, this.get(`${type}Prefix`)]));
      const after = Object.fromEntries(Object.keys(DEFAULT_PREFIXES).map(type => [type, updates.has(`${type}Prefix`) ? updates.get(`${type}Prefix`) : before[type]]));
      if (new Set(Object.values(after)).size !== prefixNames.length || after.current === "'" && Object.entries(after).some(([type, marker]) => type !== "current" && marker === "‘")) throw new Error(t("引导符重复，请为各模式选择不同字符"));
      if (!updates.has("lastQuery") && this.get("lastQuery")) checked.push(["lastQuery", migrateLauncherPrefixes(this.get("lastQuery"), before, after)]);
    }
    if (checked.some(([name]) => shortcutNames.includes(name))) {
      const updates = new Map(checked), seen = new Map();
      for (const name of shortcutNames) {
        const value = updates.has(name) ? updates.get(name) : this.get(name);
        const signature = shortcutSignature(value);
        if (signature === shortcutSignature("Alt+Shift+P")) throw new Error(t("Alt+Shift+P 预留给命令面板"));
        if (seen.has(signature)) throw new Error(t("与{name}重复，请选择其他组合", { name: t(descriptions[seen.get(signature)].replace(/（.*）/u, "")) }));
        seen.set(signature, name);
      }
    }
    return checked;
  }
  apply(entries) {
    const checked = this.validate(entries);
    for (const [name, value] of checked) {
      Zotero.Prefs.set(`quickswitcher.${name}`, typeof value === "object" || ["deviceID", "clock"].includes(name) ? JSON.stringify(value) : value);
      this.errors.delete(name);
    }
    this.onBatchChange(checked);
    for (const [name, value] of checked) this.onChange(name, clone(value));
  }
  exportConfig() {
    return { schemaVersion: 1, settings: Object.fromEntries(Object.keys(DEFAULTS).filter(k => !privateSettings.has(k) && !deviceSettings.has(k)).map(k => [k, this.get(k)])) };
  }
  importConfig(config) {
    if (config?.schemaVersion !== 1 || !config.settings || typeof config.settings !== "object" || Array.isArray(config.settings)) throw new Error(t("不支持的配置文件"));
    const settings = { ...config.settings };
    const legacyPrefixes = CONFIG_GROUPS.prefixes.filter(name => Object.hasOwn(settings, name)).length >= 8;
    for (const group of ["prefixes", "shortcuts"]) {
      const present = CONFIG_GROUPS[group].filter(name => Object.hasOwn(settings, name));
      if (group === "prefixes" ? legacyPrefixes : present.length === shortcutNames.length || legacyPrefixes && present.length >= 3) Object.assign(settings, migrateInputGroup(group, Object.fromEntries(present.map(name => [name, settings[name]]))));
    }
    if (legacyPrefixes) {
      const prefixes = Object.fromEntries(prefixNames.map(name => [name, settings[name] ?? this.get(name)]));
      const shortcuts = Object.fromEntries(shortcutNames.map(name => [name, settings[name] ?? this.get(name)]));
      Object.assign(settings, linkModePrefixes(prefixes, shortcuts, true, !Object.hasOwn(config.settings, "tagPrefix")));
    }
    const checked = Object.entries(settings).filter(([name]) => !["davMode", "outlineDepth", "openMode"].includes(name) && !privateSettings.has(name) && !deviceSettings.has(name)).map(([name, value]) => [name, validatePreference(name, value, ["width", "height"].includes(name))]);
    this.apply(checked);
  }
  reset() { this.apply(Object.entries(DEFAULTS).filter(([name]) => !privateSettings.has(name))); }
}

function credentialRealm(prefs) {
  return "Zotero Quick Switcher WebDAV " + new URL(prefs.get("davURL")).origin;
}

export async function readCustomCredential(prefs) {
  const username = prefs.get("davUsername");
  if (!prefs.get("davURL") || !username) return null;
  const entries = await Services.logins.searchLoginsAsync({ origin: "chrome://zotero", httpRealm: credentialRealm(prefs) });
  const entry = entries.find(e => e.username === username);
  if (!entry) return null;
  let secret = entry.password;
  if (Zotero.OSKeyStore?.isEncrypted(secret)) secret = await Zotero.OSKeyStore.decrypt(secret);
  return { username: entry.username, password: secret };
}

export async function writeCustomCredential(prefs, secret) {
  const realm = credentialRealm(prefs), username = prefs.get("davUsername");
  if (!username) throw new Error(t("请先填写 WebDAV 用户名"));
  const existing = await Services.logins.searchLoginsAsync({ origin: "chrome://zotero", httpRealm: realm });
  const encrypted = await Zotero.OSKeyStore.encrypt(secret);
  const login = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(Ci.nsILoginInfo);
  login.init("chrome://zotero", null, realm, username, encrypted, "", "");
  const old = existing.find(e => e.username === username);
  if (old) Services.logins.modifyLogin(old, login);
  else await Services.logins.addLoginAsync(login);
}

const descriptions = {
  authorPrefix: "作者引导符", tagPrefix: "标签引导符", directoryPrefix: "目录引导符", yearPrefix: "年份引导符", venuePrefix: "出版来源引导符", typePrefix: "条目类型引导符", currentPrefix: "当前目录引导符", outlinePrefix: "大纲引导符", fulltextPrefix: "全部字段引导符", tabsPrefix: "标签页引导符",
  launcherShortcut: "检索快捷键", globalShortcut: "全局快捷键", tabsShortcut: "标签页快捷键", advancedShortcut: "高级搜索快捷键", outlineShortcut: "大纲快捷键", directoryShortcut: "目录快捷键", commandShortcut: "命令快捷键",
  defaultScope: "默认搜索范围", recursive: "包含子文件夹", locationsVisible: "结果中显示的文件夹路径数量",
  restoreQuery: "恢复上次查询", preview: "默认展开预览", theme: "主题", density: "列表密度",
  clipboardSearch: "使用最近复制的文字", clipboardSeconds: "复制后有效时长（秒）",
  language: "语言", fontSize: "字号", width: "最大宽度（%）", height: "最大高度（%）", highlightColor: "高亮颜色",
  citationStyle: "默认 CSL", citationLocale: "引用语言",
  syncEnabled: "启用 WebDAV 自动同步", syncSettings: "同步插件配置", syncInterval: "后台检查间隔（秒）", davURL: "WebDAV 地址", davUsername: "用户名",
};
export const ACTION_LABELS = Object.freeze({ read: "打开 PDF", locate: "打开所在目录", window: "新窗口打开 PDF", web: "打开 DOI 或 URL", switch: "切换到标签页", jump: "跳转", split: "分屏打开", open: "进入目录", parent: "上级目录", pdf: "复制 PDF 文件", citation: "复制引文", bibliography: "复制参考文献" });

export function renderPreferences(win, app) {
  const doc = win.document;
  const root = doc.getElementById("qs-preferences-root");
  if (!root || root.dataset.ready) return;
  root.dataset.ready = "true";
  root.className = "qs-prefs";
  installStyle(doc, app.prefs);
  const status = element(doc, "p", { class: "qs-pref-status", role: "status", "aria-live": "polite" });
  const say = (text, error = false) => { localize(status, { text }); status.classList.toggle("error", error); };
  root.append(element(doc, "header", { class: "qs-pref-title" }, [element(doc, "img", { src: "chrome://quickswitcher/content/icon.svg", alt: "", width: 34, height: 34 }),
    element(doc, "div", {}, [element(doc, "h2", { text: "Zotero Quick Switcher" }), element(doc, "p", { class: "qs-pref-desc", l10n: { text: "快速找到文献，看清匹配原因与所属文件夹。" } })])]));
  const nav = element(doc, "div", { class: "qs-pref-nav", role: "tablist" });
  root.append(nav);
  const panels = [];
  const addPanel = (id, title) => {
    const panel = element(doc, "section", { id: `qs-pref-${id}`, role: "tabpanel", hidden: panels.length > 0 });
    const button = element(doc, "button", { type: "button", role: "tab", "aria-selected": String(!panels.length), "aria-controls": panel.id, l10n: { text: title },
      onclick: () => {
        for (const [p, b] of panels) { p.hidden = p !== panel; b.setAttribute("aria-selected", String(b === button)); }
      } });
    nav.append(button); root.append(panel); panels.push([panel, button]); return panel;
  };
  // Groups are divs: native checks resolve a control's tab panel with closest("section").
  const section = (panel, title, mode, description) => {
    const heading = element(doc, "h3", { id: `qs-pref-heading-${panel.id.slice(8)}-${panel.children.length}`, l10n: { text: title } });
    const group = element(doc, "div", { class: "qs-pref-section", role: "group", "aria-labelledby": heading.id, "data-qs-pref-mode": mode },
      [heading, description ? element(doc, "p", { class: "qs-pref-desc", l10n: { text: description } }) : null]);
    panel.append(group); return group;
  };
  const option = (parent, control, note) => parent.append(element(doc, "div", { class: "qs-pref-option" },
    [control, note ? element(doc, "p", { class: "qs-pref-help", l10n: { text: note } }) : null]));
  const field = (panel, name, note) => {
    const value = app.prefs.get(name), global = name === "globalShortcut";
    const mode = panel.getAttribute("data-qs-pref-mode");
    const caption = ["tabs", "outline", "directories", "commands"].includes(mode) ? name.endsWith("Shortcut") ? "快捷键" : name.endsWith("Prefix") ? "引导符" : descriptions[name]
      : ["fields", "scope"].includes(mode) ? descriptions[name].replace(/引导符$/u, "") : descriptions[name];
    const text = element(doc, "span", { l10n: { text: caption } });
    let input;
    if (choices[name]) {
      input = doc.createXULElement("menulist");
      input.setAttribute("data-pref", name); input.setAttribute("native", "true"); localize(input, { "aria-label": descriptions[name] });
      const popup = doc.createXULElement("menupopup"); input.append(popup);
      const labels = { "en-US": "English", "zh-CN": "简体中文", library: "当前文库全局", collection: "当前文件夹", all: "所有文库", reader: "打开阅读器", locate: "定位条目", auto: "跟随 Zotero", light: "浅色", dark: "深色", compact: "紧凑", normal: "标准", spacious: "宽松" };
      for (const option of choices[name]) {
        const item = doc.createXULElement("menuitem"); item.setAttribute("value", option);
        if (name === "language" && option !== "auto") item.setAttribute("label", labels[option]); else localize(item, { label: labels[option] });
        popup.append(item);
      }
      input.value = value;
    } else {
      input = element(doc, "input", { "data-pref": name, type: typeof value === "boolean" ? "checkbox" : numeric[name] ? "number" : name === "highlightColor" ? "color" : "text" });
      if (typeof value === "boolean") input.checked = value;
      else input.value = prefixNames.includes(name) ? value === " " ? "Space" : value === "\t" ? "Tab" : value : value;
      if (numeric[name]) { input.min = numeric[name][0]; input.max = numeric[name][1]; }
    }
    const save = next => {
      const conflicts = name.endsWith("Shortcut") && !global && next !== "native" ? findShortcutConflicts(Zotero.getMainWindow?.() || win, next)
        .filter(id => !(name === "advancedShortcut" && id === "key_advancedSearch")) : [];
      app.prefs.set(name, next); installStyle(doc, app.prefs);
      say(conflicts.length ? "此组合也被其他动作使用，Quick Switcher 会优先响应。" : global && !next ? "全局快捷键已停用" : "设置已保存");
    };
    input.qsRefresh = () => {
      const current = app.prefs.get(name);
      if (typeof current === "boolean") input.checked = current; else input.value = current;
    };
    const prefix = prefixNames.includes(name);
    if (name.endsWith("Shortcut") || prefix) {
      input.setAttribute("readonly", "true");
      localize(input, { "aria-label": descriptions[name], title: prefix ? "点击或按 Enter 后录入字符；Shift 可输入标点，Space 和 Tab 直接按键；Esc 取消"
        : global ? "点击后按下组合键；Backspace 或 Delete 停用；Esc 取消" : "点击后按下组合键；Esc 取消" });
      input.className = "qs-shortcut-input";
      // Platforms without a global hotkey backend keep the stored value visible but inert.
      if (global && !Zotero.isWin && !Zotero.isMac) input.disabled = true;
      const display = () => {
        delete input.dataset.recording;
        let current = app.prefs.get(name);
        if (prefix) input.value = current === " " ? "Space" : current === "\t" ? "Tab" : current;
        else if (global) input.value = current ? shortcutLabel(current, !!Zotero.isMac) : t("已停用");
        else if (current === "native") {
          const nativeKey = Zotero.getMainWindow?.()?.document.getElementById("key_showTabsMenu");
          const chord = nativeKey && nativeShortcut(nativeKey, !!Zotero.isMac);
          current = chord ? [chord.ctrl && "Control", chord.meta && "Meta", chord.alt && "Alt", chord.shift && "Shift", chord.key.toUpperCase()].filter(Boolean).join("+") : "Accel+;";
          input.value = shortcutLabel(current, !!Zotero.isMac);
        } else input.value = shortcutLabel(current, !!Zotero.isMac);
      };
      input.qsRefresh = display;
      const record = () => { input.dataset.recording = "true"; input.value = t(prefix ? "按键…" : "按下快捷键…"); say(prefix ? "按字符录入；Esc 取消" : "按组合键录入；Esc 取消"); };
      input.addEventListener("click", record);
      input.addEventListener("blur", display);
      input.addEventListener("keydown", event => {
        const unmodified = !event.ctrlKey && !event.metaKey && !event.altKey;
        if (!input.dataset.recording) {
          if (event.key === "Enter" && unmodified) { event.preventDefault(); event.stopPropagation(); record(); }
          return;
        }
        if (!prefix && event.key === "Tab" && unmodified) return;
        if (prefix && (event.repeat || event.isComposing || event.keyCode === 229 || ["Control", "Shift", "Alt", "Meta", "OS", "AltGraph", "Dead", "Process", "Unidentified"].includes(event.key))) return;
        event.preventDefault(); event.stopPropagation();
        if (event.key === "Escape" && unmodified) { display(); say("已取消修改"); return; }
        try {
          if (global && unmodified && !event.shiftKey && ["Backspace", "Delete"].includes(event.key)) { save(""); display(); return; }
          const altGraph = event.getModifierState?.("AltGraph");
          if (prefix && (event.metaKey || event.ctrlKey && !altGraph || event.altKey && !altGraph && !Zotero.isMac)) throw new Error(t("请按字符录入引导符，使用 Shift 输入标点"));
          const next = prefix ? validatePreference(name, event.key) : shortcutFromEvent(event, !!Zotero.isMac);
          if (next) { save(next); display(); }
        } catch (error) { say(error.message, true); }
      });
      display();
    } else input.addEventListener(choices[name] ? "command" : "change", () => {
      try { save(typeof value === "boolean" ? input.checked : numeric[name] ? Number(input.value) : input.value); }
      catch (error) { say(error.message, true); }
    });
    const toggle = typeof value === "boolean";
    option(panel, element(doc, "label", { class: toggle ? "qs-pref-check" : "qs-pref-field" }, toggle ? [input, text] : [text, input]), note);
    return input;
  };
  const actionFields = (group, mode) => {
    group.append(element(doc, "p", { class: "qs-pref-subhead", l10n: { text: "回车动作" } }));
    for (const key of ACTION_KEYS) {
      const caption = ({ enter: "Enter", shift: "Shift+Enter", ctrl: (Zotero.isMac ? "Cmd" : "Ctrl") + "+Enter", alt: "Alt+Enter" })[key];
      const menu = doc.createXULElement("menulist"), popup = doc.createXULElement("menupopup");
      menu.setAttribute("native", "true"); menu.setAttribute("data-qs-action", `${mode}.${key}`); menu.setAttribute("aria-label", caption); menu.append(popup);
      // "none" stands for the stored empty string, which a XUL menulist cannot select reliably.
      for (const action of ["", ...ACTIONS[mode]]) {
        const item = doc.createXULElement("menuitem"); item.setAttribute("value", action || "none");
        localize(item, { label: action ? ACTION_LABELS[action] : "无" }); popup.append(item);
      }
      menu.qsRefresh = () => { menu.value = app.prefs.get("actions")[mode][key] || "none"; };
      menu.addEventListener("command", () => {
        try {
          const actions = app.prefs.get("actions"); actions[mode][key] = menu.value === "none" ? "" : menu.value;
          app.prefs.set("actions", actions); say("设置已保存");
        } catch (error) { menu.qsRefresh(); say(error.message, true); }
      });
      menu.qsRefresh();
      option(group, element(doc, "label", { class: "qs-pref-field" }, [element(doc, "span", { text: caption }), menu]));
    }
    group.append(element(doc, "p", { class: "qs-pref-help", l10n: { text: "每个组合执行一个动作，可留空；多个组合可用同一动作。" } }));
  };
  const search = addPanel("search", "检索");
  const items = section(search, "条目检索", "items");
  field(items, "launcherShortcut");
  field(items, "globalShortcut", Zotero.isWin || Zotero.isMac ? "Zotero 不在前台时也能唤起条目检索。录入时按 Backspace 或 Delete 停用。" : "全局快捷键支持 Windows 和 macOS。");
  items.append(element(doc, "p", { class: "qs-hotkey-state", role: "status", text: app.hotkeyError || "" }));
  field(items, "advancedShortcut"); field(items, "defaultScope");
  field(items, "recursive", "限定当前目录时一并检索子文件夹。");
  field(items, "restoreQuery", "打开启动器时填入上次的查询。");
  const clipboard = element(doc, "div", { class: "qs-pref-clipboard" }); items.append(clipboard);
  field(clipboard, "clipboardSearch"); field(clipboard, "clipboardSeconds");
  items.append(element(doc, "p", { class: "qs-pref-help", l10n: { text: "打开检索时以灰色显示近期复制的文字；Enter 或空格确认，其他按键清除。未确认的文字不保存到查询历史。" } }));
  actionFields(items, "items");
  const filters = section(search, "筛选引导符", "fields", "点击后录入字符。Tab 跳出条件，Esc 取消。");
  for (const name of ["authorPrefix", "tagPrefix", "yearPrefix", "venuePrefix", "typePrefix"]) field(filters, name);
  const scopes = section(search, "范围引导符", "scope", "在查询开头输入，限定本次检索的范围。");
  field(scopes, "currentPrefix", "只检索当前目录。"); field(scopes, "fulltextPrefix", "本次检索启用下方全部来源。");
  const sources = section(search, "默认检索来源", "sources", "不带引导符时检索的内容。前七项至少保留一项。");
  const checks = element(doc, "div", { class: "qs-pref-checks" }), fieldBoxes = [], sourceBoxes = [];
  const checkbox = (boxes, attribute, key, text, checked, change) => {
    const input = element(doc, "input", { type: "checkbox", [attribute]: key }); input.checked = checked;
    input.addEventListener("change", () => {
      try { change(input); }
      catch (error) { input.checked = !input.checked; say(error.message, true); }
    });
    boxes.push(input); checks.append(element(doc, "label", { class: "qs-pref-check" }, [input, element(doc, "span", { l10n: { text } })]));
  };
  for (const [key, text] of Object.entries({ title: "题名", creator: "所有作者", date: "年份/日期", DOI: "DOI", citationKey: "引用键", tag: "标签", abstractNote: "完整摘要" })) {
    checkbox(fieldBoxes, "data-field", key, text, app.prefs.get("fields").includes(key),
      () => { app.prefs.set("fields", fieldBoxes.filter(box => box.checked).map(box => box.dataset.field)); say("检索字段已保存"); });
  }
  for (const [key, text] of Object.entries({ notes: "笔记", annotations: "批注", fulltext: "附件全文" })) {
    checkbox(sourceBoxes, "data-source", key, text, app.prefs.get("sources")[key],
      input => { app.prefs.set("sources", { ...app.prefs.get("sources"), [key]: input.checked }); say("设置已保存"); });
  }
  sources.append(checks);
  const citations = section(search, "引用复制", "citations", "Ctrl/Cmd+C 复制 PDF；Ctrl/Cmd+Shift+A 复制引文；Ctrl/Cmd+Shift+C 复制参考文献。支持多选。面板中可临时切换 CSL。");
  field(citations, "citationLocale", "留空跟随样式，例如 zh-CN 或 en-US。");
  const styleControls = new Set();
  const stylePicker = (value, changed, defaultChoice = false) => {
    const menu = doc.createXULElement("menulist"); menu.setAttribute("native", "true"); menu.setAttribute("aria-label", "CSL");
    menu.qsStyleValue = value; menu.qsDefaultChoice = defaultChoice;
    menu.addEventListener("command", () => { try { changed(menu.value); say("设置已保存"); } catch (error) { say(error.message, true); } });
    styleControls.add(menu); return menu;
  };
  const defaultStyle = stylePicker(app.prefs.get("citationStyle"), value => app.prefs.set("citationStyle", value === "native" ? "" : value), true);
  defaultStyle.setAttribute("data-pref", "citationStyle"); defaultStyle.qsRefresh = () => { defaultStyle.value = app.prefs.get("citationStyle") || "native"; };
  option(citations, element(doc, "label", { class: "qs-pref-field" }, [element(doc, "span", { l10n: { text: "默认 CSL" } }), defaultStyle]));
  const slideStyles = element(doc, "ul", { class: "qs-slide-styles" });
  for (const [label, url] of [
    ["Achuan-2：PPT Ref（题名和 DOI 有多种组合）", "https://www.achuan-2.top/post/zotero-gun-format-for-ppt-reference-literature-1usphn.html"],
    ["BIO-SPRING：第一作者、期刊、年份", "https://bio-spring.top/post/2016/10/25/2016-10-25-zotero-author-journal-year-style/"],
  ]) slideStyles.append(element(doc, "li", {}, [element(doc, "a", { href: url, l10n: { text: label }, onclick: event => { event.preventDefault(); Zotero.launchURL(url); } })]));
  citations.append(element(doc, "p", { class: "qs-pref-help", l10n: { text: "PowerPoint 推荐样式：在 Zotero 中安装后，可在应用规则里选用。" } }), slideStyles);
  const ruleList = element(doc, "div", { class: "qs-csl-rules" }); citations.append(ruleList);
  let visibleStyles = [];
  const populate = menu => {
    const popup = doc.createXULElement("menupopup");
    for (const style of [...(menu.qsDefaultChoice ? [{ styleID: "native", title: t("跟随 Zotero 快速复制") }] : []), ...visibleStyles]) {
      const item = doc.createXULElement("menuitem"); item.setAttribute("value", style.styleID); item.setAttribute("label", style.title); popup.append(item);
    }
    if (menu.qsStyleValue && !visibleStyles.some(style => style.styleID === menu.qsStyleValue)) {
      const item = doc.createXULElement("menuitem"); item.setAttribute("value", menu.qsStyleValue); item.setAttribute("label", t("未安装：{style}", { style: menu.qsStyleValue.split("/").at(-1) })); popup.append(item);
    }
    menu.replaceChildren(popup); menu.value = menu.qsStyleValue || "native";
  };
  const renderRules = () => {
    for (const menu of styleControls) if (menu !== defaultStyle) styleControls.delete(menu);
    ruleList.replaceChildren();
    const rules = app.prefs.get("citationRules");
    for (const [index, rule] of rules.entries()) {
      const name = element(doc, "input", { value: rule.app, "aria-label": t("应用"), placeholder: "powerpnt.exe / winword.exe" }); name.value = rule.app;
      const update = () => { const next = app.prefs.get("citationRules"); next[index] = { ...rule, app: name.value, styleID: menu.value }; app.prefs.set("citationRules", next); };
      name.addEventListener("change", () => { try { update(); say("设置已保存"); } catch (error) { name.value = rule.app; say(error.message, true); } });
      const menu = stylePicker(rule.styleID, () => update()); populate(menu);
      ruleList.append(element(doc, "div", { class: "qs-csl-rule" }, [name, menu, element(doc, "button", { type: "button", l10n: { text: "移除", "aria-label": "移除应用规则" }, onclick: () => {
        const next = app.prefs.get("citationRules"); next.splice(index, 1); app.prefs.set("citationRules", next); renderRules();
      } })]));
    }
  };
  citations.append(element(doc, "p", { class: "qs-pref-help", l10n: { text: "按唤起前的应用选择 CSL。Windows 填 powerpnt.exe 或 winword.exe；macOS 填 Microsoft PowerPoint 或 Microsoft Word。无法识别时用默认格式。" } }),
    element(doc, "button", { type: "button", l10n: { text: "添加应用规则" }, onclick: () => {
      if (!visibleStyles.length) { say("先在 Zotero 中安装 CSL 样式", true); return; }
      const rules = app.prefs.get("citationRules"); let index = 1; while (rules.some(rule => rule.app === `app-${index}`)) index++;
      app.prefs.set("citationRules", [...rules, { app: `app-${index}`, styleID: visibleStyles[0].styleID }]); renderRules();
    } }));
  populate(defaultStyle); renderRules();
  app.clipboard?.styles().then(styles => { if (!root.isConnected) return; visibleStyles = styles; populate(defaultStyle); renderRules(); }).catch(error => say(error.message, true));
  const switching = addPanel("switch", "切换");
  switching.append(element(doc, "p", { class: "qs-pref-desc", l10n: { text: "引导符与快捷键主键同步，仅用于文献检索条件。切换模式只匹配文字。" } }));
  for (const [mode, title, shortcut, marker] of [["tabs", "标签页", "tabsShortcut", "tabsPrefix"], ["outline", "大纲", "outlineShortcut", "outlinePrefix"], ["directories", "目录", "directoryShortcut", "directoryPrefix"]]) {
    const group = section(switching, title, mode);
    field(group, shortcut); field(group, marker); actionFields(group, mode);
  }
  field(section(addPanel("commands", "命令"), "命令面板", "commands"), "commandShortcut", "@：选择 Zotero 或插件 · Enter：执行命令 · Tab：跳出来源");
  const appearance = addPanel("appearance", "外观");
  const look = section(appearance, "界面", "look");
  for (const name of ["language", "theme", "density", "fontSize", "highlightColor"]) field(look, name);
  const size = section(appearance, "面板", "panel", "尺寸按当前窗口计算，默认宽 62%、高 80%。预览计入上限。");
  for (const name of ["width", "height", "preview"]) field(size, name);
  const sync = addPanel("sync", "WebDAV 同步");
  const automatic = section(sync, "自动同步", "sync");
  for (const name of ["syncEnabled", "syncSettings", "syncInterval"]) field(automatic, name);
  const connection = section(sync, "连接", "connection");
  const connectionFields = [field(connection, "davURL"), field(connection, "davUsername")];
  const credential = element(doc, "input", { type: "password", autocomplete: "new-password", l10n: { placeholder: "输入后自动保存", "aria-label": "WebDAV 凭据" } });
  option(connection, element(doc, "label", { class: "qs-pref-field" }, [element(doc, "span", { l10n: { text: "凭据" } }), credential]));
  let timer, draftRevision = 0, dirty = false, composing = false, credentialWork = Promise.resolve(true);
  const flushCredential = () => {
    win.clearTimeout(timer);
    if (composing) return Promise.resolve(false);
    if (!credential.value) { dirty = false; return credentialWork.then(() => true); }
    if (!dirty) return credentialWork;
    let target;
    try { target = Object.fromEntries(connectionFields.map(input => [input.dataset.pref, validatePreference(input.dataset.pref, input.value)])); }
    catch { say("请先填写有效的 WebDAV 地址和用户名", true); return Promise.resolve(false); }
    if (!target.davURL || !target.davUsername) { say("请先填写 WebDAV 地址和用户名", true); return Promise.resolve(false); }
    if (Object.entries(target).some(([name, value]) => app.prefs.get(name) !== value)) {
      app.prefs.apply(Object.entries(target)); draftRevision++;
    }
    const revision = draftRevision, secret = credential.value;
    dirty = false;
    credentialWork = credentialWork.then(async () => {
      if (revision !== draftRevision) return true;
      try {
        await writeCustomCredential({ get: name => target[name] }, secret);
        if (revision === draftRevision) {
          if (!app.stopped) app.restartSync();
          say("凭据已自动保存");
        }
        return true;
      } catch {
        if (revision === draftRevision) { dirty = true; say("凭据保存失败，请检查地址、用户名和系统安全存储", true); }
        return false;
      }
    });
    return credentialWork;
  };
  const scheduleCredential = () => {
    draftRevision++; dirty = true; win.clearTimeout(timer);
    if (!composing) timer = win.setTimeout(flushCredential, 500);
  };
  credential.addEventListener("input", scheduleCredential);
  credential.addEventListener("compositionstart", () => { composing = true; win.clearTimeout(timer); });
  credential.addEventListener("compositionend", () => { composing = false; scheduleCredential(); });
  for (const event of ["change", "blur"]) credential.addEventListener(event, flushCredential);
  for (const input of connectionFields) input.addEventListener("change", () => {
    draftRevision++;
    if (!dirty) credential.value = "";
    flushCredential();
  });
  root.qsFlushCredential = (dispose = false) => {
    const saving = flushCredential();
    if (dispose) {
      win.removeEventListener("pagehide", closePreferences);
      delete root.qsFlushCredential; delete root.qsRefreshSettings; delete root.dataset.ready; root.replaceChildren();
    }
    return saving;
  };
  const closePreferences = () => root.qsFlushCredential?.(true);
  win.addEventListener("pagehide", closePreferences, { once: true });
  root.qsRefreshSettings = () => {
    for (const input of root.querySelectorAll("[data-pref],[data-qs-action]")) if (!input.dataset.recording
      && !(doc.activeElement === input && input.localName === "input" && !input.readOnly && input.type !== "checkbox")) input.qsRefresh?.();
    for (const input of fieldBoxes) input.checked = app.prefs.get("fields").includes(input.dataset.field);
    for (const input of sourceBoxes) input.checked = app.prefs.get("sources")[input.dataset.source];
    if (!ruleList.contains(doc.activeElement)) renderRules();
  };
  const syncStatus = element(doc, "p", { class: "qs-sync-state", l10n: { text: app.sync?.status?.message || "布局首先保存在本机" } });
  connection.append(element(doc, "button", { type: "button", l10n: { text: "检查连接并同步" }, onclick: async () => {
    try {
      const connection = connectionFields.map(input => [input.dataset.pref, validatePreference(input.dataset.pref, input.value)]);
      if (connection.some(([name, value]) => app.prefs.get(name) !== value)) app.prefs.apply(connection);
      if (!await flushCredential()) return;
      await app.sync.testConnection(); await app.sync.sync(); localize(syncStatus, { text: app.sync.status.message || "同步完成" });
    }
    catch (error) { localize(syncStatus, { text: app.sync?.status?.message || "连接检查失败" }); say(error.message, true); }
  } }), syncStatus);
  connection.append(element(doc, "p", { class: "qs-pref-help", l10n: { text: "凭据保存在本机安全存储，留空保留已有凭据。配置同步包含快捷键、引导符、检索与外观；连接信息、全局快捷键和查询历史留在本机。" } }));
  const tools = element(doc, "div", { class: "qs-pref-actions" });
  for (const [text, handler] of [["导出配置", () => app.configFile(win, "export")], ["导入配置", () => app.configFile(win, "import")], ["恢复默认设置", () => app.prefs.reset()]]) {
    tools.append(element(doc, "button", { type: "button", l10n: { text }, onclick: async () => { try { await handler(); say("操作完成；重新进入此面板可查看更新后的值"); } catch (error) { say(error.message, true); } } }));
  }
  root.append(tools, status);
  if (app.prefs.errors.get("inputMigration")) say(t("输入配置需要修复：{error}", { error: app.prefs.errors.get("inputMigration") }), true);
  else if (app.prefs.errors.size) say("部分设置无法读取，正在使用默认值。重新保存相关设置即可修复。", true);
}
