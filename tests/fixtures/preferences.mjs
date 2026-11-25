import { Prefs, renderPreferences } from "../../src/prefs.mjs";

// Models settings DOM events and storage boundaries; native Gecko is checked separately.
class Element extends EventTarget {
  constructor(tag, namespaceURI = "http://www.w3.org/1999/xhtml") {
    super(); this.localName = tag; this.namespaceURI = namespaceURI; this.children = []; this.attributes = new Map(); this.dataset = {}; this.value = "";
    this.style = { setProperty() {} };
    this.classList = { toggle: (name, enabled) => { const names = new Set((this.className || "").split(" ").filter(Boolean)); enabled ? names.add(name) : names.delete(name); this.className = [...names].join(" "); } };
  }
  get id() { return this.getAttribute("id") || ""; }
  get textContent() { return this.text || this.children.map(child => child.textContent || "").join(""); }
  set textContent(value) { this.text = String(value); this.children = []; }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); if (name.startsWith("data-")) this.dataset[name.slice(5)] = String(value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  append(...nodes) { this.children.push(...nodes); }
  querySelectorAll(selector) {
    return descendants(this).filter(node => selector.split(",").some(part => part === "[data-qs-l10n]" ? node.hasAttribute("data-qs-l10n") : part.startsWith(".") ? (node.className || "").split(" ").includes(part.slice(1)) : node.localName === part.replace(":checked", "") && (!part.includes(":checked") || node.checked)));
  }
}
function descendants(node) { return node.children.flatMap(child => [child, ...descendants(child)]); }

export function preferenceFixture(t, settings = {}) {
  const previous = Object.fromEntries(["Zotero", "Services", "Cc", "Ci"].map(name => [name, globalThis[name]]));
  t.after(() => { for (const [name, value] of Object.entries(previous)) if (value === undefined) delete globalThis[name]; else globalThis[name] = value; });
  const values = new Map(Object.entries(settings).map(([name, value]) => ["quickswitcher." + name, value])), logins = [], pending = new Map();
  const win = new EventTarget(); win.closed = false;
  let timerID = 0;
  win.setTimeout = fn => { pending.set(++timerID, fn); return timerID; }; win.clearTimeout = id => pending.delete(id);
  const documentElement = new Element("html"), head = new Element("head"), root = new Element("div"); root.setAttribute("id", "qs-preferences-root"); documentElement.append(head, root);
  const doc = { documentElement, head, defaultView: { getComputedStyle: () => ({ colorScheme: "light" }) },
    createElementNS: (namespaceURI, tag) => new Element(tag, namespaceURI), createXULElement: tag => new Element(tag, "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul"),
    createTextNode: value => { const node = new Element("#text"); node.textContent = value; return node; },
    getElementById: id => [documentElement, ...descendants(documentElement)].find(node => node.id === id),
    querySelectorAll: selector => documentElement.querySelectorAll(selector) };
  win.document = doc;
  const app = { stopped: false, restarts: 0, prefs: new Prefs(), restartSync() { this.restarts++; }, sync: { status: {},
    testConnection: async () => { app.connectionChecks++; }, sync: async () => {} }, connectionChecks: 0 };
  const encryption = { fail: false, encrypt: async value => { if (encryption.fail) throw new Error("keystore unavailable"); return "encrypted:" + value; } };
  globalThis.Zotero = { isMac: false, Prefs: { get: name => values.get(name), set: (name, value) => values.set(name, value) },
    OSKeyStore: { encrypt: value => encryption.encrypt(value), isEncrypted: value => value.startsWith("encrypted:"), decrypt: async value => value.slice(10) } };
  globalThis.Services = { logins: { searchLoginsAsync: async ({ origin, httpRealm }) => logins.filter(login => login.origin === origin && login.httpRealm === httpRealm),
    addLoginAsync: async login => { logins.push(login); }, modifyLogin: (old, next) => { logins[logins.indexOf(old)] = next; } } };
  globalThis.Ci = { nsILoginInfo: {} };
  globalThis.Cc = { "@mozilla.org/login-manager/loginInfo;1": { createInstance: () => ({ init(origin, formSubmitURL, httpRealm, username, password) { Object.assign(this, { origin, formSubmitURL, httpRealm, username, password }); } }) } };
  renderPreferences(win, app);
  const all = () => descendants(root), field = name => all().find(node => node.dataset.pref === name);
  const credential = all().find(node => node.getAttribute("type") === "password");
  return { win, root, app, values, logins, encryption, credential, all, field,
    fire: (node, type) => node.dispatchEvent(new Event(type)),
    press: (node, properties) => { const event = new Event("keydown", { cancelable: true }); Object.assign(event, properties); node.dispatchEvent(event); return event; },
    timers: async () => { const callbacks = [...pending.values()]; pending.clear(); for (const fn of callbacks) fn(); await Promise.resolve(); } };
}
