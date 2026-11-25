// SPDX-License-Identifier: AGPL-3.0-or-later
import { element as h } from "./dom.mjs";
import { t, locale, localize } from "./i18n.mjs";

export async function localPDF(itemID, attachmentID) {
  const item = await Zotero.Items.getAsync(itemID);
  const preferred = attachmentID && await Zotero.Items.getAsync(attachmentID);
  const attachments = item.isRegularItem() ? await item.getBestAttachments() : item.isPDFAttachment() ? [item] : [];
  if (preferred && preferred.isPDFAttachment()) attachments.unshift(preferred);
  let hasPDF = false;
  for (const attachment of [...new Map(attachments.map(value => [value.id, value])).values()]) {
    if (!attachment.isPDFAttachment()) continue;
    hasPDF = true;
    const path = await attachment.getFilePathAsync();
    if (path) return { attachmentID: attachment.id, path };
  }
  return { unavailable: hasPDF ? "PDF 不在本机" : "无 PDF 附件" };
}

export async function initialPDFPage(row, attachmentID) {
  if (row.kind === "outline" && row.attachmentID === attachmentID && Number.isSafeInteger(row.pageIndex) && row.pageIndex >= 0) return row.pageIndex;
  if (!["tab", "reader"].includes(row.kind) || row.attachmentID !== attachmentID) return 0;
  let pageIndex;
  try {
    const reader = row.kind === "reader" ? row.reader : Zotero.Reader?.getByTabID(row.tabID);
    if (reader?.itemID === attachmentID && !row.win?.closed) {
      const state = reader._internalReader?._state;
      pageIndex = (state?.primary === false ? state.secondaryViewStats : state?.primaryViewStats)?.pageIndex;
    }
  } catch { /* Unloaded readers can still have a stored reading position. */ }
  if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) {
    try { pageIndex = (await Zotero.Items.getAsync(attachmentID)).getAttachmentLastPageIndex?.(); }
    catch { return 0; }
  }
  return Number.isSafeInteger(pageIndex) && pageIndex >= 0 ? pageIndex : 0;
}

export class PDFOutlineLoader {
  constructor(win) { this.win = win; this.revision = 0; }
  async read(path) {
    this.finish(new Error("Outline loading cancelled"));
    const revision = ++this.revision, win = this.win, bytes = await IOUtils.read(path);
    if (revision !== this.revision) throw new Error("Outline loading cancelled");
    if (win.closed) throw new Error(t("主窗口已关闭，请重试"));
    return new Promise((resolve, reject) => {
      this.pending = { revision, bytes, resolve, reject };
      this.timeout = win.setTimeout(() => this.finish(new Error(t("PDF 大纲读取超时"))), 60000);
      if (!this.frame) {
        const session = this.session = win.crypto.randomUUID(), frame = this.frame = h(win.document, "iframe", { hidden: true, src: `chrome://quickswitcher/content/pdf-preview.html?session=${session}` });
        this.message = event => {
          if (event.data?.channel !== "quickswitcher-pdf" || event.data.session !== session
            || (event.source !== frame.contentWindow && !(event.source === null && event.origin === "chrome://quickswitcher"))) return;
          if (event.data.type === "ready") { this.ready = true; this.send(); }
          else if (event.data.request === this.pending?.revision) {
            if (event.data.type === "outline" && Array.isArray(event.data.rows)) this.finish(null, event.data.rows);
            else if (event.data.type === "error") this.finish(new Error(t(event.data.message)));
          }
        };
        win.addEventListener("message", this.message); win.document.documentElement.append(frame);
      }
      this.send();
    });
  }
  send() {
    if (!this.ready || !this.pending?.bytes) return;
    this.frame.contentWindow.postMessage({ channel: "quickswitcher-pdf", session: this.session, request: this.pending.revision, type: "outline", bytes: this.pending.bytes }, "*");
    this.pending.bytes = null;
  }
  finish(error, value) {
    if (!this.pending) return;
    const pending = this.pending; this.pending = null; this.win.clearTimeout(this.timeout);
    if (error) pending.reject(error); else pending.resolve(value);
  }
  destroy() {
    this.revision++;
    this.finish(new Error("Outline loading cancelled"));
    this.win.clearTimeout(this.timeout);
    if (this.message) this.win.removeEventListener("message", this.message);
    this.frame?.contentWindow?.postMessage({ channel: "quickswitcher-pdf", session: this.session, type: "destroy" }, "*");
    this.frame?.remove(); this.frame = null; this.message = null; this.ready = false;
  }
}

export class PDFPreview {
  constructor(win, { onClose, onScroll } = {}) {
    this.win = win; this.revision = 0; this.session = win.crypto.randomUUID();
    this.root = h(win.document, "section", { class: "qs-pdf-preview", l10n: { "aria-label": "PDF 预览" } });
    this.status = h(win.document, "p", { class: "qs-pdf-status", role: "status", l10n: { text: "读取 PDF…" } });
    this.root.append(this.status);
    this.onMessage = event => {
      // Gecko hides source for chrome messages; origin and the per-frame session still identify ours.
      if (!this.frame || event.data?.channel !== "quickswitcher-pdf" || event.data.session !== this.session
        || (event.source !== this.frame.contentWindow && !(event.source === null && event.origin === "chrome://quickswitcher"))) return;
      const message = event.data;
      if (message.type === "ready") { this.win.clearTimeout(this.frameWait); this.frameReady = true; this.send(); }
      else if (message.type === "height" && Number.isFinite(message.height)) this.frame.style.height = `${Math.max(80, Math.min(3000, message.height))}px`;
      else if (message.type === "rendered") { this.status.hidden = true; this.root.dataset.page = String(message.page); this.root.dataset.state = "ready"; }
      else if (message.type === "error") { this.status.hidden = false; localize(this.status, { text: message.message }); this.root.dataset.state = "error"; }
      else if (message.type === "close") onClose?.();
      else if (message.type === "scroll" && Number.isFinite(message.delta)) onScroll?.(message.delta);
    };
    win.addEventListener("message", this.onMessage);
  }
  async load(row) {
    const revision = ++this.revision;
    this.root.dataset.state = "loading";
    try {
      const file = await localPDF(row.itemID, row.attachmentID);
      if (revision !== this.revision) return;
      if (file.unavailable) { localize(this.status, { text: file.unavailable }); this.root.dataset.state = "unavailable"; return; }
      const bytes = await IOUtils.read(file.path);
      if (revision !== this.revision) return;
      this.pageIndex = await initialPDFPage(row, file.attachmentID);
      if (revision !== this.revision) return;
      this.bytes = bytes;
      this.frame = h(this.win.document, "iframe", { class: "qs-pdf-frame", l10n: { title: "PDF 页面预览" }, src: `chrome://quickswitcher/content/pdf-preview.html?session=${this.session}` });
      this.root.append(this.frame);
      this.frameWait = this.win.setTimeout(() => {
        if (revision !== this.revision || this.frameReady) return;
        localize(this.status, { text: "PDF 组件未能加载" }); this.root.dataset.state = "error";
      }, 10000);
      this.send();
    } catch (error) {
      if (revision !== this.revision) return;
      localize(this.status, { text: "PDF 暂不可预览" }); this.status.title = error.message || String(error); this.root.dataset.state = "error";
    }
  }
  send() {
    if (!this.frameReady || !this.bytes) return;
    this.frame.contentWindow.postMessage({ channel: "quickswitcher-pdf", session: this.session, type: "load", bytes: this.bytes, pageIndex: this.pageIndex, ...this.language() }, "*");
    this.bytes = null;
  }
  language() {
    return { locale: locale(), labels: { title: t("PDF 预览"), navigation: t("PDF 翻页"), previous: t("上一页"), next: t("下一页"), page: t("PDF 第 {page} 页，共 {pages} 页") } };
  }
  refreshLanguage() {
    if (this.frameReady) this.frame.contentWindow.postMessage({ channel: "quickswitcher-pdf", session: this.session, type: "language", ...this.language() }, "*");
  }
  destroy() {
    this.revision++; this.bytes = null; this.win.clearTimeout(this.frameWait);
    this.win.removeEventListener("message", this.onMessage);
    this.frame?.contentWindow?.postMessage({ channel: "quickswitcher-pdf", session: this.session, type: "destroy" }, "*");
    this.frame?.remove(); this.frame = null; this.root.remove();
  }
}
