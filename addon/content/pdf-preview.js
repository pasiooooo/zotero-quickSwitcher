// SPDX-License-Identifier: AGPL-3.0-or-later
import { getDocument, GlobalWorkerOptions } from "resource://zotero/reader/pdf/build/pdf.mjs";
import { readPDFOutline } from "./pdf-outline-data.js";

GlobalWorkerOptions.workerSrc = "resource://zotero/reader/pdf/build/pdf.worker.mjs";
const canvas = document.getElementById("page"), number = document.getElementById("page-number");
const previous = document.getElementById("previous"), next = document.getElementById("next");
const session = new URL(location.href).searchParams.get("session");
let loading, pdf, rendering, revision = 0, page = 1, resizeTimer, lastWidth = 0, encrypted = false, outlineOnly = false, request;
let labels = { title: "PDF 预览", navigation: "PDF 翻页", previous: "上一页", next: "下一页", page: "PDF 第 {page} 页，共 {pages} 页" };
const notify = (type, values = {}) => parent.postMessage({ channel: "quickswitcher-pdf", session, request, type, ...values }, "*");
const height = () => notify("height", { height: Math.ceil(document.body.getBoundingClientRect().height) });
function updateLanguage(message) {
  if (!["zh-CN", "en-US"].includes(message.locale) || !message.labels
    || !Object.keys(labels).every(key => typeof message.labels[key] === "string" && message.labels[key].length < 256)) return;
  labels = message.labels; document.documentElement.lang = message.locale; document.title = labels.title;
  document.querySelector("nav").setAttribute("aria-label", labels.navigation);
  for (const [button, text] of [[previous, labels.previous], [next, labels.next]]) { button.title = text; button.setAttribute("aria-label", text); }
  if (pdf) canvas.setAttribute("aria-label", labels.page.replace("{page}", page).replace("{pages}", pdf.numPages));
}
async function render() {
  if (!pdf || outlineOnly) return;
  const current = ++revision;
  rendering?.cancel();
  previous.disabled = page <= 1; next.disabled = page >= pdf.numPages;
  number.textContent = `${page} / ${pdf.numPages}`;
  try {
    const sheet = await pdf.getPage(page);
    if (current !== revision) return;
    const natural = sheet.getViewport({ scale: 1 }), width = document.documentElement.clientWidth;
    if (!width) return;
    lastWidth = width;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const viewport = sheet.getViewport({ scale: width / natural.width * ratio });
    canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
    canvas.style.height = `${Math.ceil(viewport.height / ratio)}px`;
    canvas.setAttribute("aria-label", labels.page.replace("{page}", page).replace("{pages}", pdf.numPages));
    height();
    rendering = sheet.render({ canvasContext: canvas.getContext("2d"), viewport });
    await rendering.promise;
    if (current !== revision) return;
    notify("rendered", { page, pages: pdf.numPages }); height();
  } catch (error) {
    if (current === revision && error.name !== "RenderingCancelledException") notify("error", { message: "PDF 暂不可预览" });
  }
}
function destroy() {
  revision++; window.clearTimeout(resizeTimer); rendering?.cancel(); rendering = null;
  pdf = null; const task = loading; loading = null;
  task?.destroy().catch(() => {});
}
window.addEventListener("message", async event => {
  // Chrome callers can hide both source and origin; the parent-created session authenticates them.
  if (!session || event.data?.channel !== "quickswitcher-pdf" || event.data.session !== session
    || (event.source !== parent && event.source !== null)) return;
  if (event.data.type === "destroy") { destroy(); return; }
  if (event.data.type === "language") { updateLanguage(event.data); return; }
  if (!["load", "outline"].includes(event.data.type) || !(event.data.bytes instanceof Uint8Array)) return;
  updateLanguage(event.data);
  destroy(); encrypted = false;
  request = event.data.request;
  outlineOnly = event.data.type === "outline";
  page = Number.isSafeInteger(event.data.pageIndex) && event.data.pageIndex >= 0 ? event.data.pageIndex + 1 : 1;
  const task = loading = getDocument({ data: event.data.bytes,
    cMapUrl: "resource://zotero/reader/pdf/web/cmaps/", cMapPacked: true,
    standardFontDataUrl: "resource://zotero/reader/pdf/web/standard_fonts/", wasmUrl: "resource://zotero/reader/pdf/web/wasm/",
    isEvalSupported: false, enableXfa: false });
  task.onPassword = () => { encrypted = true; notify("error", { message: "PDF 已加密，请在阅读器中打开" }); destroy(); };
  try {
    const document = await task.promise;
    if (loading !== task) { await document.destroy(); return; }
    pdf = document;
    if (outlineOnly) {
      const rows = await readPDFOutline(pdf);
      if (loading === task) notify("outline", { rows });
      if (loading === task) destroy();
    } else { page = Math.min(page, pdf.numPages); await render(); }
  } catch { if (loading === task && !encrypted) notify("error", { message: "PDF 暂不可预览" }); }
});
previous.addEventListener("click", () => { if (pdf && page > 1) { page--; render(); } });
next.addEventListener("click", () => { if (pdf && page < pdf.numPages) { page++; render(); } });
window.addEventListener("keydown", event => {
  if (event.isComposing) return;
  if (event.key === "Escape") { event.preventDefault(); notify("close"); }
  else if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); (event.key === "ArrowLeft" ? previous : next).click(); }
  else if (["ArrowUp", "ArrowDown", "PageUp", "PageDown"].includes(event.key)) {
    event.preventDefault(); notify("scroll", { delta: (event.key.endsWith("Up") ? -1 : 1) * (event.key.startsWith("Page") ? innerHeight : 40) });
  }
});
window.addEventListener("wheel", event => { event.preventDefault(); notify("scroll", { delta: event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1) }); }, { passive: false });
const observer = new ResizeObserver(() => {
  if (!pdf || document.documentElement.clientWidth === lastWidth) return;
  window.clearTimeout(resizeTimer); resizeTimer = window.setTimeout(render, 100);
});
observer.observe(document.documentElement);
window.addEventListener("pagehide", () => { observer.disconnect(); destroy(); });
notify("ready");
