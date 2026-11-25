// SPDX-License-Identifier: AGPL-3.0-or-later
import { topItem } from "./core.mjs";
import { localPDF } from "./pdf-preview.mjs";
import { t } from "./i18n.mjs";

const WORKER_URL = "chrome://quickswitcher/content/clipboard-worker.js";
const MAX_CLIPBOARD_BYTES = 16 * 1024 * 1024;
const basename = value => String(value || "").split(/[\\/]/u).at(-1).toLowerCase();

// DROPFILES has a 20-byte header followed by UTF-16 paths and an empty final path.
export function dropFilesBytes(paths) {
  if (!Array.isArray(paths) || !paths.length || paths.some(path => typeof path !== "string" || !path || path.includes("\0"))) throw new Error("Invalid clipboard files");
  const text = paths.join("\0") + "\0\0";
  if (20 + text.length * 2 > MAX_CLIPBOARD_BYTES) throw new Error("Clipboard file list is too large");
  const bytes = new Uint8Array(20 + text.length * 2);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 20, true); view.setUint32(16, 1, true);
  for (let i = 0; i < text.length; i++) view.setUint16(20 + i * 2, text.charCodeAt(i), true);
  return bytes;
}

// CF_HTML offsets count UTF-8 bytes; CF_UNICODETEXT counts UTF-16 code units and ends with NUL.
export function referenceClipboardBytes(text, html) {
  if (typeof text !== "string" || typeof html !== "string" || text.includes("\0") || html.includes("\0")) throw new Error("Invalid reference clipboard text");
  text = text.replace(/\r\n|\r|\n/gu, "\r\n");
  if ((text.length + 1) * 2 > MAX_CLIPBOARD_BYTES || html.length > MAX_CLIPBOARD_BYTES) throw new Error("Reference clipboard data is too large");
  const unicode = new Uint8Array((text.length + 1) * 2), view = new DataView(unicode.buffer);
  for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), true);
  const encoder = new TextEncoder(), prefix = encoder.encode('<html><head><meta charset="utf-8"></head><body><!--StartFragment-->');
  const fragment = encoder.encode(html), suffix = encoder.encode("<!--EndFragment--></body></html>");
  const header = offsets => "Version:1.0\r\n" + ["StartHTML", "EndHTML", "StartFragment", "EndFragment"].map((key, i) => `${key}:${String(offsets[i]).padStart(10, "0")}\r\n`).join("");
  const start = header([0, 0, 0, 0]).length, first = start + prefix.length, last = first + fragment.length, end = last + suffix.length;
  if (unicode.length + end + 1 > MAX_CLIPBOARD_BYTES) throw new Error("Reference clipboard data is too large");
  const rich = new Uint8Array(end + 1);
  rich.set(encoder.encode(header([start, end, first, last]))); rich.set(prefix, start); rich.set(fragment, first); rich.set(suffix, last);
  return { textBytes: unicode.buffer, htmlBytes: rich.buffer };
}

function transferable() {
  const value = Cc["@mozilla.org/widget/transferable;1"].createInstance(Ci.nsITransferable);
  value.init(null); return value;
}

function setString(value, flavor, text) {
  const string = Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString);
  string.data = text; value.addDataFlavor(flavor); value.setTransferData(flavor, string);
}

async function copyNative(payload, win) {
  const Worker = typeof ChromeWorker !== "undefined" ? ChromeWorker : win?.ChromeWorker;
  if (!Worker) throw new Error(t("文件剪贴板不可用"));
  const references = payload.kind === "references";
  let owner = "";
  if (Zotero.isWin) {
    owner = win?.docShell?.treeOwner?.QueryInterface(Ci.nsIInterfaceRequestor)?.getInterface(Ci.nsIBaseWindow)?.nativeHandle;
    if (!owner || !/^(?:0x[0-9a-f]+|[0-9]+)$/iu.test(owner) || BigInt(owner) === 0n || BigInt(owner) > 0xffffffffffffffffn) throw new Error(t("复制文件需要有效窗口"));
  }
  await new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_URL);
    let finished = false;
    const finish = error => {
      if (finished) return; finished = true;
      clearTimeout(timer); worker.onmessage = worker.onerror = null; worker.terminate();
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error(t(references ? "复制失败" : "复制文件超时"))), 10000);
    worker.onmessage = ({ data }) => {
      if (data.type === "copied") finish();
      else if (data.type === "error") finish(new Error(references ? `${t("复制失败")}: ${data.message}` : t("文件复制失败：{message}", { message: data.message })));
    };
    worker.onerror = event => { event.preventDefault?.(); finish(new Error(event.message || t(references ? "复制失败" : "文件复制失败"))); };
    try { worker.postMessage({ platform: Zotero.isWin ? "win" : "mac", owner: String(owner), ...payload }); }
    catch (error) { finish(error); }
  });
}

async function copyFiles(paths, win) {
  if (Zotero.isWin || Zotero.isMac) {
    await copyNative({ kind: "files", paths, bytes: Zotero.isWin ? dropFilesBytes(paths).buffer : undefined }, win);
    return;
  }
  const value = transferable();
  if (paths.length === 1) {
    value.addDataFlavor("application/x-moz-file"); value.setTransferData("application/x-moz-file", Zotero.File.pathToFile(paths[0]));
  }
  const urls = paths.map(path => Services.io.newFileURI(Zotero.File.pathToFile(path)).spec);
  setString(value, "text/uri-list", urls.join("\r\n") + "\r\n");
  setString(value, "x-special/gnome-copied-files", "copy\n" + urls.join("\n"));
  Services.clipboard.setData(value, null, Ci.nsIClipboard.kGlobalClipboard);
}

export class ClipboardService {
  constructor(prefs) { this.prefs = prefs; }

  start() {
    this.destroy();
    if (!this.prefs.get("clipboardSearch")) return;
    this.updateClipboard();
    if (this.snapshot) this.timer = setInterval(() => this.updateClipboard(), 100);
  }

  updateClipboard() {
    try {
      const now = performance.now();
      if (!this.snapshot?.valid) {
        const changed = !!this.snapshot;
        this.snapshot = Services.clipboard.getDataSnapshotSync(["text/plain"], Ci.nsIClipboard.kGlobalClipboard);
        // shortcut: copy age uses the previous 100 ms observation; use native timestamps if exact timing is required.
        this.clipboardChangedAt = changed ? this.clipboardCheckedAt : null;
      }
      this.clipboardCheckedAt = now;
    } catch (error) { this.destroy(); Zotero.logError(error); }
  }

  recentText() {
    if (!this.prefs.get("clipboardSearch") || !this.snapshot) return "";
    this.updateClipboard();
    const snapshot = this.snapshot;
    if (!snapshot?.valid || this.clipboardChangedAt == null || performance.now() - this.clipboardChangedAt > this.prefs.get("clipboardSeconds") * 1000
      || !snapshot.flavorList.includes("text/plain")) return "";
    try {
      const value = transferable(), data = {};
      value.addDataFlavor("text/plain"); Services.clipboard.getData(value, Ci.nsIClipboard.kGlobalClipboard);
      value.getTransferData("text/plain", data);
      const text = data.value.QueryInterface(Ci.nsISupportsString).data;
      if (!snapshot.valid || typeof text !== "string" || text.length > 2048 || text.includes("\0")) return "";
      return text.replace(/[\r\n]+/gu, " ").trim();
    } catch (error) { Zotero.logError(error); return ""; }
  }

  destroy() {
    clearInterval(this.timer); this.timer = null; this.snapshot = null;
    this.clipboardChangedAt = this.clipboardCheckedAt = null;
  }

  async styles() {
    await Zotero.Styles.init();
    return [...Zotero.Styles.getVisible()].sort((a, b) => a.title.localeCompare(b.title)).map(style => ({ styleID: style.styleID, title: style.title }));
  }

  async formatForApp(app, override) {
    await Zotero.Styles.init();
    const name = basename(app?.name || app?.path);
    const rule = name && (this.prefs.get("citationRules") || []).find(rule => basename(rule.app) === name);
    const native = Zotero.QuickCopy.unserializeSetting(Zotero.Prefs.get("export.quickCopy.setting")) || {};
    let styleID = override || rule?.styleID || this.prefs.get("citationStyle") || (native.mode === "bibliography" ? native.id : "");
    if (!styleID) styleID = (await this.styles())[0]?.styleID;
    if (!styleID || !Zotero.Styles.get(styleID)) throw new Error(t("引用格式未安装：{style}", { style: styleID || t("无") }));
    const locale = (!override || override === rule?.styleID) && rule?.locale || this.prefs.get("citationLocale")
      || (styleID === native.id && (native.locale || Zotero.Prefs.get("export.quickCopy.locale"))) || undefined;
    return { styleID, locale };
  }

  async styleForApp(app) { return (await this.formatForApp(app)).styleID; }

  async copy(kind, rows, { win, styleID, app, current = () => true } = {}) {
    if (!["pdf", "citation", "bibliography"].includes(kind) || !Array.isArray(rows)) throw new Error(t("复制动作无效"));
    const cancelled = () => ({ count: 0, failed: rows, cancelled: true });
    const failed = [], items = new Map(), files = new Map();
    for (const row of rows) {
      if (!current()) return cancelled();
      try {
        if (!Number.isSafeInteger(row?.itemID) || row.itemID <= 0) throw new Error("Invalid item");
        if (kind === "pdf") {
          const pdf = await localPDF(row.itemID, row.attachmentID);
          if (!current()) return cancelled();
          if (!pdf.path) throw new Error(pdf.unavailable);
          // Validate before writing anything; a stale attachment must not appear copied.
          if (typeof pdf.path !== "string" || pdf.path.includes("\0") || !await IOUtils.exists(pdf.path)) throw new Error("PDF unavailable");
          if (!current()) return cancelled();
          const key = Zotero.isWin ? pdf.path.toLowerCase() : pdf.path;
          files.set(key, pdf.path);
        } else {
          const item = await topItem(row.itemID);
          if (!current()) return cancelled();
          if (item.deleted || !item.isRegularItem()) throw new Error("Not a reference");
          items.set(item.id, item);
        }
      } catch { failed.push(row); }
    }
    if (!current()) return cancelled();
    const count = kind === "pdf" ? files.size : items.size;
    if (!count) return { count: 0, failed };
    if (kind === "pdf") await copyFiles([...files.values()], win);
    else {
      const format = await this.formatForApp(app, styleID);
      if (!current()) return cancelled();
      const owner = win?.Zotero_File_Interface ? win : Zotero.getMainWindow?.();
      if (!Zotero.isWin && owner?.Zotero_File_Interface) owner.Zotero_File_Interface.copyItemsToClipboard([...items.values()], format.styleID, format.locale, false, kind === "citation");
      else await this.copyReferences([...items.values()], format, kind === "citation", win || owner);
    }
    return { count, failed };
  }

  // Use native citeproc output; Windows writes directly because Gecko hides OleSetClipboard failures.
  async copyReferences(items, { styleID, locale }, asCitations, win) {
    const engine = Zotero.Styles.get(styleID).getCiteProc(locale, "html", { cache: true }), content = {};
    try {
      const citation = { citationItems: items.map(item => ({ id: item.id })), properties: {} };
      if (asCitations) engine.updateItems(items.map(item => item.id));
      for (const format of ["html", "text"]) content[format] = asCitations ? engine.previewCitationCluster(citation, [], [], format) : Zotero.Cite.makeFormattedBibliographyOrCitationList(engine, items, format);
    } finally { engine.free(); }
    if (Zotero.isWin) return copyNative({ kind: "references", ...referenceClipboardBytes(content.text, content.html) }, win);
    const value = transferable(); setString(value, "text/html", content.html); setString(value, "text/plain", content.text);
    Services.clipboard.setData(value, null, Ci.nsIClipboard.kGlobalClipboard);
  }
}
