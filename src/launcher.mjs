// SPDX-License-Identifier: AGPL-3.0-or-later
import { element as h, appendMarked, evidenceNode, icon, itemTypeIcon, installStyle } from "./dom.mjs";
import { tokenize, matchRanges, plainText, normalize, switchMatches, switchTerms, ALL_FIELDS } from "./core.mjs";
import { DEFAULT_PREFIXES, migrateLauncherPrefixes, pairLauncherInput, parseLauncherInput, parseSwitchInput, removeLauncherFilter, replaceLauncherFilter } from "./launcher-query.mjs";
import { InputScopes, inputScopeBlocks } from "./input-scopes.mjs";
import { measureInputMarkers, markerDeltaAt, sourceSpanAt, inputWordRange } from "./input-layout.mjs";
import { buildLocationTree, locationMatchRanges } from "./location-tree.mjs";
import { authorMatches, groupAuthors } from "./authors.mjs";
import { filterMatches } from "./filter-match.mjs";
import { PDFPreview } from "./pdf-preview.mjs";
import { buildOutlineTree, currentOutlineRow } from "./outline-tree.mjs";
import { scrollOutlineRow } from "./outline-scroll.mjs";
import { buildWosExpression, expressionText, localExpressionText } from "./wos-query.mjs";
import { parseCommandInput } from "./commands.mjs";
import { t, localize } from "./i18n.mjs";
import { queryEvidenceSpec } from "./search.mjs";

const sameRef = (row, ref) => row.kind === ref.kind && row.libraryID === ref.libraryID && (row.kind === "library" || row.key === ref.key);
const selectionKey = row => row.reader || (row.kind === "outline" ? `outline:${row.attachmentID}:${row.outlineKey}` : row.tabID ? `tab:${row.tabID}` : row.itemID ? `item:${row.itemID}` : `${row.kind}:${row.libraryID}:${row.key}`);
const sameResult = (a, b) => a && b && a.kind === b.kind && (a.kind === "outline" ? a.attachmentID === b.attachmentID && a.outlineKey === b.outlineKey : a.kind === "tab" ? a.tabID === b.tabID && a.win === b.win : a.kind === "reader" ? a.reader === b.reader : a.itemID ? a.itemID === b.itemID : a.key === b.key && a.libraryID === b.libraryID);
const outlineState = branches => branches.map(({ children, win, ...row }) => [row, outlineState(children)]);
const pickers = ["directories", "authors", "years", "venues", "types"];
const enterActions = { read: {}, switch: {}, jump: {}, open: {}, locate: { locate: true }, window: { shifted: true }, split: { shifted: true }, parent: { shifted: true }, web: { web: true }, pdf: { copy: "pdf" }, citation: { copy: "citation" }, bibliography: { copy: "bibliography" } };
const enterNames = { read: "PDF", locate: "目录", window: "新窗口", web: "DOI/URL", switch: "切换", jump: "跳转", split: "分屏", open: "切换", parent: "上级目录", pdf: "复制 PDF", citation: "引文", bibliography: "参考文献" };
const filterTypes = { directory: { name: "目录", icon: "folder" }, author: { name: "作者", icon: "author" }, year: { name: "年份", icon: "year" }, venue: { name: "出版来源", icon: "venue" }, type: { name: "条目类型", icon: "types" }, outline: { name: "大纲", icon: "outline" }, tabs: { name: "标签页", icon: "tabs" } };
const matchesQueryTree = (node, text, filters = []) => node.op === "NOT" ? !matchesQueryTree(node.children[0], text, filters)
  : node.op === "AND" ? node.children.every(child => matchesQueryTree(child, text, filters))
    : node.op === "OR" ? node.children.some(child => matchesQueryTree(child, text, filters))
      : Object.hasOwn(node, "filterIndex") ? filters[node.filterIndex] : node.quoted ? normalize(text).includes(normalize(node.text)) : filterMatches(text, node.text);

export class Launcher {
  constructor(win, app) {
    this.win = win; this.doc = win.document; this.app = app;
    this.rows = []; this.rowNodes = []; this.selected = 0; this.revision = 0; this.isOpen = false; this.running = false; this.queued = false;
    this.mode = this.inputMode = "items"; this.ready = false; this.nativeConditions = null; this.filterBindings = new Map(); this.scopePathRevision = 0; this.openRevision = 0;
    this.inputScopes = new InputScopes();
    this.picked = new Map(); this.selectionRevision = 0;
    this.build();
  }
  build() {
    const doc = this.doc;
    this.root = h(doc, "div", { class: "qs-root", id: "qs-launcher", hidden: true });
    this.dialog = h(doc, "section", { class: "qs-dialog", role: "dialog", "aria-modal": "true", "aria-label": "Quick Switcher for Zotero" });
    const searchline = h(doc, "div", { class: "qs-searchline" });
    this.modeIcon = h(doc, "span", { class: "qs-mode-icon", "aria-hidden": "true" });
    this.scopeChip = h(doc, "button", { class: "qs-scope-chip", type: "button", hidden: true, onclick: () => this.clearDirectory() });
    this.input = h(doc, "input", { class: "qs-input", type: "text", maxlength: 2048, role: "combobox", l10n: { "aria-label": "搜索文献", placeholder: "搜索文献…" }, "aria-describedby": "qs-applied-filters", "aria-autocomplete": "list", "aria-haspopup": "grid", "aria-expanded": "true", "aria-controls": "qs-results" });
    this.scopeLayer = h(doc, "div", { class: "qs-input-scope-layer", "aria-hidden": "true" });
    this.selectionLayer = h(doc, "div", { class: "qs-input-selection-layer" });
    this.scopeText = h(doc, "span", { class: "qs-input-scope-text" }); this.scopeLayer.append(this.scopeText, this.selectionLayer);
    const shell = h(doc, "div", { class: "qs-input-shell" }, [this.scopeLayer, this.input]); this.inputShell = shell;
    const editPrefixes = () => this.switchMode === "commands" ? { author: "@" } : this.prefixes();
    this.input.addEventListener("paste", event => { this.pastedText = event.clipboardData?.getData("text/plain") || ""; });
    this.input.addEventListener("beforeinput", event => {
      if (this.clipboardDraft) {
        const accept = event.inputType === "insertText" && event.data === " ";
        this.finishClipboardDraft(accept);
        if (accept) { event.preventDefault(); this.schedule(0); return; }
      }
      this.inputScopes.sync(this.input.value, editPrefixes());
      this.inputScopes.beforeEdit(event.inputType, this.input.selectionStart, this.input.selectionEnd);
      const data = event.data ?? event.dataTransfer?.getData("text/plain") ?? (event.inputType === "insertFromPaste" ? this.pastedText : "");
      this.pastedText = null;
      const guarded = !this.composing && this.inputScopes.guard(event.inputType, this.input.selectionStart, this.input.selectionEnd, data);
      if (!guarded) return;
      event.preventDefault();
      if (guarded.value !== undefined) { this.input.value = guarded.value; this.inputScopes.sync(guarded.value, editPrefixes()); }
      this.input.setSelectionRange(guarded.caret, guarded.caret);
      if (guarded.value !== undefined) inputChanged(event); else this.schedule(0);
    });
    const inputChanged = event => {
      this.inputScopes.sync(this.input.value, editPrefixes());
      if (this.composing) { this.renderInputScopes(); return; }
      const paired = !this.switchMode && pairLauncherInput(this.input.value, this.input.selectionEnd, event.inputType, this.prefixes(), event.data ?? "");
      if (paired && paired.value.length <= 2048) {
        const marker = this.input.selectionEnd - 1;
        this.input.value = paired.value; this.inputScopes.sync(paired.value, this.prefixes()); this.inputScopes.add(marker, this.prefixes());
        this.input.setSelectionRange(paired.caret, paired.caret);
      }
      if (this.switchMode === "commands" && event.inputType === "insertText" && event.data === "@" && this.input.value === "@") {
        this.input.value = "@()"; this.inputScopes.sync(this.input.value); this.inputScopes.add(0); this.input.setSelectionRange(2, 2);
      }
      if (this.advancedSpec) {
        this.stopAdvancedHeight();
        this.advancedSpec = null; this.nativeConditions = null; this.widget = null; this.advanced.hidden = true; this.advanced.replaceChildren();
      }
      this.schedule();
    };
    this.input.addEventListener("input", inputChanged);
    this.input.addEventListener("click", () => { if (!this.composing) this.schedule(0); });
    this.input.addEventListener("scroll", () => this.renderInputScopes());
    this.input.addEventListener("select", () => this.renderInputSelection());
    this.input.addEventListener("pointerdown", event => this.inputPointer(event));
    this.input.addEventListener("pointermove", event => { if (this.inputDrag?.id === event.pointerId) this.inputPointer(event); });
    const endDrag = event => {
      if (this.inputDrag?.id !== event.pointerId) return;
      this.inputDrag = null;
      if (this.input.hasPointerCapture(event.pointerId)) this.input.releasePointerCapture(event.pointerId);
      if (!this.composing) this.schedule(0);
    };
    this.input.addEventListener("pointerup", endDrag); this.input.addEventListener("pointercancel", endDrag);
    this.input.addEventListener("dblclick", event => {
      if (!this.markerLayout?.length || this.composing) return;
      event.preventDefault();
      const position = this.inputPosition(event.clientX);
      const range = position === null ? null : inputWordRange(this.input.value, position);
      if (range) { this.input.setSelectionRange(range.start, range.end); this.renderInputSelection(); this.schedule(0); }
    });
    this.input.addEventListener("keyup", event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) && !this.composing) this.schedule(0); });
    this.input.addEventListener("compositionstart", () => { this.finishClipboardDraft(); this.composing = true; this.ready = false; });
    this.input.addEventListener("compositionend", () => { this.composing = false; this.schedule(); });
    searchline.append(this.modeIcon, shell);
    this.filterSummary = h(doc, "div", { class: "qs-filter-summary", id: "qs-applied-filters", role: "group", hidden: true, l10n: { "aria-label": "已应用条件" } });
    const button = (name, label, onclick) => h(doc, "button", { type: "button", class: "qs-icon-button", l10n: { "aria-label": label, title: label }, onclick }, [icon(doc, name)]);
    this.collectionBackButton = button("back", "返回检索", () => this.finishCollectionPicker(null));
    this.collectionBackButton.hidden = true; searchline.prepend(this.collectionBackButton);
    this.copyButton = button("copy", "复制完整 WoS 检索式", () => this.copyExpression());
    this.copyButton.setAttribute("data-qs-copy-expression", "true");
    this.expressionAdvanced = button("advanced", "切换高级搜索", () => this.toggleAdvanced());
    this.expressionAdvanced.setAttribute("data-qs-expression-advanced", "true");
    this.sourceButton = button("sources", "正文来源", () => {
      this.sources.hidden = !this.sources.hidden; this.sourceButton.setAttribute("aria-expanded", String(!this.sources.hidden));
    });
    this.advancedButton = this.expressionAdvanced;
    this.previewButton = button("preview", "文献、PDF 与匹配详情", () => this.togglePreview());
    for (const control of [this.sourceButton, this.advancedButton, this.previewButton]) control.setAttribute("aria-expanded", "false");
    this.sources = h(doc, "fieldset", { class: "qs-sources", hidden: true, l10n: { "aria-label": "正文来源" } });
    for (const [key, text] of Object.entries({ notes: "笔记", annotations: "批注", fulltext: "附件全文" })) {
      const checkbox = h(doc, "input", { type: "checkbox", "data-source": key });
      checkbox.addEventListener("change", () => {
        this.app.prefs.set("sources", { ...this.app.prefs.get("sources"), [key]: checkbox.checked }); this.schedule();
      });
      this.sources.append(h(doc, "label", {}, [checkbox, h(doc, "span", { l10n: { text } })]));
    }
    this.advanced = h(doc, "div", { class: "qs-advanced", hidden: true });
    this.status = h(doc, "div", { class: "qs-status", role: "status", "aria-live": "polite" });
    this.feedback = h(doc, "div", { class: "qs-feedback", role: "status", "aria-live": "polite", hidden: true });
    this.tooltip = h(doc, "div", { class: "qs-tooltip", role: "tooltip", hidden: true });
    this.list = h(doc, "div", { class: "qs-results", id: "qs-results", role: "grid", l10n: { "aria-label": "检索结果" }, "aria-colcount": "3" });
    const continueOutline = () => { if (this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight <= Math.max(120, this.list.clientHeight * .35)) this.more(); };
    this.list.addEventListener("scroll", () => { if (this.list.scrollHeight > this.list.clientHeight) continueOutline(); });
    this.list.addEventListener("wheel", event => this.scrollResults(event), { passive: false });
    this.preview = h(doc, "aside", { class: "qs-preview", hidden: true, l10n: { "aria-label": "文献与匹配详情" } });
    this.body = h(doc, "div", { class: "qs-body" }, [this.list, this.preview]);
    const footer = h(doc, "div", { class: "qs-footer" });
    const footnote = h(doc, "div", { class: "qs-footnote" });
    this.hint = h(doc, "span", { class: "qs-key-hint" });
    footnote.append(this.hint);
    this.showAll = button("all", "在 Zotero 显示全部结果", () => this.applyAll());
    this.save = button("save", "保存搜索", () => this.saveCurrentSearch());
    this.selectionCount = h(doc, "span", { class: "qs-selection-count" });
    this.selectAllButton = button("selectAll", "全选结果", () => this.toggleAllResults());
    this.selectAllButton.setAttribute("aria-pressed", "false");
    this.selectionBar = h(doc, "div", { class: "qs-selection-bar", hidden: true }, [this.selectionCount, this.selectAllButton]);
    this.createCollectionButton = button("folderAdd", "将所选文献加入目录", () => this.collectionPicker ? this.chooseNewCollection() : this.createCollection());
    this.createCollectionButton.hidden = true;
    this.styleMenu = doc.createXULElement("menulist"); this.styleMenu.className = "qs-csl-menu";
    this.styleMenu.setAttribute("native", "true"); this.styleMenu.setAttribute("aria-label", "CSL");
    this.styleMenu.addEventListener("command", () => {
      this.manualStyleID = this.styleMenu.value;
      this.notify(t("CSL：{style}", { style: this.styleMenu.selectedItem?.getAttribute("label") || this.manualStyleID }));
    });
    this.copyControls = h(doc, "div", { class: "qs-copy-controls", hidden: true }, [
      button("fulltext", "复制 PDF 文件", () => this.copySelection("pdf")),
      button("citation", "复制引文", () => this.copySelection("citation")),
      button("sources", "复制参考文献", () => this.copySelection("bibliography")), this.styleMenu]);
    const actions = h(doc, "div", { class: "qs-actions" }, [this.sourceButton, this.previewButton, this.showAll, this.save,
      button("settings", "设置", () => this.app.openPreferences(this.win))]);
    const footerTools = h(doc, "div", { class: "qs-footer-tools" }, [this.selectionBar, this.createCollectionButton, this.copyControls, actions]);
    footer.append(footnote, footerTools);
    this.dialog.append(searchline, this.filterSummary, this.sources, this.advanced, this.status, this.body, footer, this.feedback);
    this.root.append(this.dialog, this.tooltip); doc.documentElement.append(this.root);
    this.root.addEventListener("mouseover", event => this.showTooltip(event.target));
    this.root.addEventListener("mouseout", () => { this.tooltip.hidden = true; });
    this.root.addEventListener("focusin", event => this.showTooltip(event.target));
    this.root.addEventListener("focusout", () => { this.tooltip.hidden = true; });
    this.root.addEventListener("pointerdown", () => { this.tooltip.hidden = true; });
    this.root.addEventListener("pointerdown", event => { if (event.target === this.root) this.hide(); });
    this.root.addEventListener("keydown", event => this.keydown(event));
    this.onResize = () => { this.resizeToContent(); this.renderInputScopes(); this.queueAdvancedHeight(); this.fillOutlineViewport(); };
    this.win.addEventListener("resize", this.onResize);
    this.onFocusIn = event => {
      if (!this.isOpen || this.allowOutsideFocus || this.root.contains(event.target) || event.target.closest?.("menupopup,panel") || !this.doc.hasFocus()) return;
      if ([...this.root.querySelectorAll("menupopup,panel")].some(popup => ["showing", "open"].includes(popup.state))) return;
      (this.advanced.hidden ? this.input : this.widget?.querySelector("input,textarea,menulist") || this.input).focus();
    };
    this.win.addEventListener("focusin", this.onFocusIn, true);
    installStyle(doc, this.app.prefs);
  }
  message(text, error = false) { localize(this.status, { text }); this.status.classList.toggle("error", error); if (error) this.notify(text, true); }
  notify(text, error = false) {
    if (!this.feedback) { localize(this.status, { text }); this.status.classList.toggle("error", error); return; }
    localize(this.feedback, { text }); this.feedback.classList.toggle("error", error); this.feedback.hidden = false;
    this.win.clearTimeout(this.feedbackTimer);
    this.feedbackTimer = this.win.setTimeout(() => { this.feedback.hidden = true; }, error ? 5000 : 2500);
  }
  showTooltip(target) {
    const control = target.closest?.("button,menulist,input[type=checkbox]");
    const text = control?.getAttribute("title") || control?.getAttribute("aria-label");
    if (["author", "year", "directory"].includes(control?.getAttribute("data-qs-filter")) || !text || control.disabled) { this.tooltip.hidden = true; return; }
    this.tooltip.textContent = text; this.tooltip.hidden = false;
    const rect = control.getBoundingClientRect(), tip = this.tooltip.getBoundingClientRect();
    this.tooltip.style.left = `${Math.max(10, Math.min(this.win.innerWidth - tip.width - 10, rect.left + (rect.width - tip.width) / 2))}px`;
    this.tooltip.style.top = `${rect.bottom + tip.height + 12 < this.win.innerHeight ? rect.bottom + 6 : Math.max(6, rect.top - tip.height - 6)}px`;
  }
  show(mode = "items", advanced = false, sourceApp = this.app.hotkey?.sourceApp || null, useClipboard = true) {
    if (this.switchMode) { this.hide({ restoreFocus: false, keepWindow: true }); this.switchMode = null; }
    if (advanced && this.isOpen) { this.toggleAdvanced(); return; }
    if (!this.isOpen) {
      this.stopAdvancedHeight();
      this.openRevision++;
      this.picked?.clear(); this.selectionAnchor = null; this.itemIDs = []; this.manualStyleID = null;
      this.originalFocus = this.doc.activeElement;
      while (this.originalFocus?.shadowRoot?.activeElement) this.originalFocus = this.originalFocus.shadowRoot.activeElement;
      this.isOpen = true; this.root.hidden = false;
      const clipboard = useClipboard && !advanced && mode === "items" ? this.app.clipboard?.recentText?.() || "" : "";
      this.clipboardDraft = !!clipboard; this.inputShell.dataset.clipboardDraft = String(!!clipboard);
      this.input.setAttribute("aria-description", clipboard ? t("剪贴板建议：Enter 或空格确认，其他按键清除") : "");
      this.input.value = clipboard || (this.app.prefs.get("restoreQuery") ? this.app.prefs.get("lastQuery") || "" : "");
      this.inputScopes.reset(this.input.value, !clipboard && this.app.prefs.get("restoreQuery") ? this.app.prefs.get("lastQueryScopes") || [] : []);
      this.filterBindings = new Map(!clipboard && this.app.prefs.get("restoreQuery") ? this.app.prefs.get("lastQueryBindings") || [] : []);
      this.directoryChoice = null; this.context = this.app.context(this.win);
      this.outlineContext = null;
      this.outlineTree = [];
      this.outlineSize = null;
      this.pickerSize = null;
      this.outlineProgress = null; this.outlineVisible = 0; this.outlineQuerySignature = null;
      this.nativeConditions = null; this.advancedSpec = null; this.input.readOnly = false; this.advanced.hidden = true; this.advanced.replaceChildren(); this.widget = null;
      this.rows = []; this.rowNodes = []; this.list.replaceChildren(); this.preview.replaceChildren();
      this.outlineResultSignature = null;
      this.togglePreview(!!this.app.prefs.get("preview"));
    }
    if (sourceApp?.name !== this.sourceApp?.name || sourceApp?.path !== this.sourceApp?.path) this.manualStyleID = null;
    this.sourceApp = sourceApp;
    this.refreshStyles();
    this.dialog.style.setProperty("--qs-width", `${this.frame().width * this.app.prefs.get("width") / 100}px`);
    this.dialog.style.setProperty("--qs-height", `${this.frame().height * this.app.prefs.get("height") / 100}px`);
    for (const checkbox of this.sources.querySelectorAll("input")) checkbox.checked = !!this.app.prefs.get("sources")[checkbox.dataset.source];
    installStyle(this.doc, this.app.prefs);
    this.setMode(mode);
    if (advanced) this.toggleAdvanced(true);
    if (!advanced) { this.input.focus(); this.input.select(); }
  }
  showSwitch(mode) {
    if (this.composing) return false;
    const originalFocus = this.isOpen ? this.originalFocus : this.doc.activeElement;
    this.hide({ restoreFocus: false, keepWindow: true }); this.show("items", false, undefined, false); this.originalFocus = originalFocus;
    this.switchMode = mode; this.inputMode = mode; this.input.value = ""; this.inputScopes.reset(""); this.filterBindings.clear();
    this.outlineContext = mode === "outline" ? this.app.outline.context(this.win) : null;
    this.directoryStart = mode === "directories" ? this.app.directoryStart(this.win) : null;
    this.commandSource = null;
    this.commandIndex = mode === "commands" ? this.app.commands.index(this.win, { focus: originalFocus }) : null;
    this.commandIndex?.catch(error => this.app.logError(error));
    this.directoryStart?.catch(error => this.app.logError(error));
    this.togglePreview(mode === "directories" || mode !== "commands" && !!this.app.prefs.get("preview")); this.input.focus(); this.schedule(0); return true;
  }
  hide({ restoreFocus = true, keepCommands = false, keepWindow = false } = {}) {
    if (this.collectionPicker) this.finishCollectionPicker(null, false);
    this.stopAdvancedHeight();
    if (!this.isOpen) return;
    try { if (!this.switchMode && !this.clipboardDraft) {
      this.app.prefs.set("lastQuery", this.input.value);
      this.inputScopes?.sync(this.input.value, this.prefixes());
      this.app.prefs.set("lastQueryScopes", this.inputScopes?.records || []);
      const filters = parseLauncherInput(this.input.value, "items", -1, this.prefixes()).filters || [];
      const bindings = [...new Map(filters.map(filter => `${filter.type}:${filter.value}`).filter(key => this.filterBindings.has(key)).map(key => [key, this.filterBindings.get(key)]))];
      this.app.prefs.set("lastQueryBindings", bindings.slice(0, 64));
    } } catch (error) { this.app.logError(error); }
    this.finishClipboardDraft();
    this.isOpen = false; this.root.hidden = true; this.revision++; this.ready = false; this.disposePDF();
    this.pagedItemIDs = this.recentItemIDs = null;
    this.win.clearTimeout(this.feedbackTimer); if (this.feedback) this.feedback.hidden = true; if (this.tooltip) this.tooltip.hidden = true;
    if (this.inputDrag && this.input.hasPointerCapture?.(this.inputDrag.id)) this.input.releasePointerCapture(this.inputDrag.id);
    this.inputDrag = null;
    this.app.outline?.release(this); this.outlineContext = null; this.outlineSize = null; this.pickerSize = null;
    this.app.releaseOutlineSearch?.();
    this.directoryChoice = null; this.win.clearTimeout(this.timer);
    if (this.switchMode === "commands" && !keepCommands) this.app.commands?.dispose(this.win);
    if (restoreFocus && this.originalFocus?.isConnected) this.originalFocus.focus();
    if (!keepWindow && !keepCommands) this.onHide?.();
  }
  frame() { return { width: this.win.innerWidth, height: this.win.innerHeight }; }
  finishClipboardDraft(keep = false) {
    if (!this.clipboardDraft) return;
    this.clipboardDraft = false; delete this.inputShell.dataset.clipboardDraft; this.input.removeAttribute("aria-description");
    if (!keep) { this.input.value = ""; this.inputScopes.reset(""); this.filterBindings.clear(); this.clearSelection(); }
    else this.input.setSelectionRange(this.input.value.length, this.input.value.length);
  }
  destroy() { this.hide(); this.win.removeEventListener("resize", this.onResize); this.win.removeEventListener("focusin", this.onFocusIn, true); this.root.remove(); }
  readPrefixes() { return Object.fromEntries(Object.entries(DEFAULT_PREFIXES).map(([type, marker]) => [type, this.app.prefs.get(`${type}Prefix`) || marker])); }
  prefixes() { return this.queryPrefixes ||= this.readPrefixes(); }
  updatePrefixes() {
    const next = this.readPrefixes();
    if (JSON.stringify(next) === JSON.stringify(this.queryPrefixes)) return;
    const selection = [this.input.selectionStart, this.input.selectionEnd];
    if (this.queryPrefixes && !this.switchMode && this.inputMode !== "tabs") this.input.value = migrateLauncherPrefixes(this.input.value, this.queryPrefixes, next);
    this.queryPrefixes = next;
    this.inputScopes?.sync(this.input.value, next); this.input.setSelectionRange(...selection);
    if (this.isOpen) this.schedule(0);
  }
  query() {
    if (this.switchMode === "commands") {
      const query = { ...parseCommandInput(this.input.value, this.input.selectionEnd), mode: "commands", kind: "commands" };
      if (this.commandSource?.title === query.source) query.sourceID = this.commandSource.source;
      this.renderInputScopes(this.input.value.startsWith("@(") && this.input.value[query.end] === ")" ? { scopes: [{ type: "author", marker: 0, open: 1, close: query.end }] } : {});
      return query;
    }
    if (this.switchMode) { this.renderInputScopes({}); return parseSwitchInput(this.input.value, this.switchMode); }
    this.inputScopes?.sync(this.input.value, this.prefixes());
    let query = parseLauncherInput(this.input.value, this.inputMode, this.input.selectionEnd ?? this.input.value.length, this.prefixes());
    if (query.scopedOutline && this.inputMode === "outline") {
      this.inputMode = "items"; query = parseLauncherInput(this.input.value, "items", this.input.selectionEnd ?? this.input.value.length, this.prefixes());
    }
    const used = new Set((query.filters || []).map(filter => `${filter.type}:${filter.value}`));
    for (const key of this.filterBindings.keys()) if (!used.has(key)) this.filterBindings.delete(key);
    this.renderInputScopes(query); return query;
  }
  renderInputScopes(query = this.switchMode ? {} : parseLauncherInput(this.input.value, this.inputMode, this.input.selectionEnd ?? this.input.value.length, this.prefixes())) {
    if (!this.scopeText) return;
    const value = this.input.value, doc = this.doc;
    const scopes = this.switchMode && this.switchMode !== "commands" ? [] : inputScopeBlocks(value, this.inputScopes.records, query);
    this.inputShell.dataset.scoped = String(scopes.length > 0);
    const markerSpans = [], appendMarker = (parent, start, end) => {
      const node = h(doc, "span", { class: "qs-scope-marker", text: value.slice(start, end) });
      parent.append(node); markerSpans.push({ node, start, end });
    };
    const append = (parent, start, end, enclosing) => {
      let offset = start;
      for (const scope of scopes) {
        if (scope === enclosing || scope.start < offset || scope.end > end) continue;
        parent.append(doc.createTextNode(value.slice(offset, scope.start)));
        const span = h(doc, "span", { class: "qs-query-scope", "data-qs-input-scope": scope.type,
          "data-active": String(this.input.selectionEnd > (scope.open ?? scope.start) && this.input.selectionEnd <= (scope.close ?? scope.end)) });
        if (Number.isInteger(scope.open)) {
          if (scope.open > scope.start) appendMarker(span, scope.start, scope.open);
          span.append(h(doc, "span", { class: scope.automatic ? "qs-virtual-boundary" : "qs-manual-boundary", text: "(" }));
          append(span, scope.open + 1, scope.close);
          span.append(h(doc, "span", { class: scope.automatic ? "qs-virtual-boundary" : "qs-manual-boundary", text: ")" }));
        } else {
          if (Number.isInteger(scope.markerEnd)) appendMarker(span, scope.start, scope.markerEnd);
          append(span, scope.markerEnd ?? scope.start, scope.end, scope);
        }
        parent.append(span); offset = scope.end;
      }
      parent.append(doc.createTextNode(value.slice(offset, end)));
    };
    this.scopeText.replaceChildren(); append(this.scopeText, 0, value.length);
    this.markerLayout = [];
    if (markerSpans.length && this.win?.getComputedStyle) {
      const style = this.win.getComputedStyle(this.input), font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const prefixes = { ...this.prefixes(), command: "@" }, signature = font + JSON.stringify(prefixes);
      this.inputMeasure ||= doc.createElementNS("http://www.w3.org/1999/xhtml", "canvas").getContext("2d");
      if (this.inputMeasure) {
        if (this.markerMetrics?.signature !== signature) this.markerMetrics = { signature, ...measureInputMarkers(prefixes, font, this.inputMeasure) };
        this.inputShell.style.setProperty("--qs-marker-width", `${this.markerMetrics.width}px`);
        this.markerLayout = markerSpans.map(marker => ({ ...marker, delta: this.markerMetrics.width - this.markerMetrics.widths.get(value.slice(marker.start, marker.end)) }));
      }
    }
    this.alignInputCaret();
    this.scopeText.style.transform = `translateX(${-this.input.scrollLeft || 0}px)`;
    this.renderInputSelection();
  }
  alignInputCaret() {
    if (!this.input.style) return;
    const focus = this.input.selectionDirection === "backward" ? this.input.selectionStart : this.input.selectionEnd;
    const indent = `${markerDeltaAt(this.markerLayout || [], focus ?? 0)}px`;
    // Keep the native caret and IME anchor at the padded display position without editing the query.
    if (this.input.style.textIndent !== indent) this.input.style.textIndent = indent;
  }
  renderInputSelection() {
    if (!this.selectionLayer || !this.doc.createRange) return;
    this.alignInputCaret();
    this.selectionLayer.replaceChildren();
    const start = this.input.selectionStart, end = this.input.selectionEnd;
    if (this.inputShell.dataset.scoped !== "true" || start === end || start == null || end == null) return;
    const first = sourceSpanAt(this.scopeText, start), last = sourceSpanAt(this.scopeText, end);
    if (!first || !last) return;
    const range = this.doc.createRange(); range.setStart(first.node, first.offset); range.setEnd(last.node, last.offset);
    const bounds = this.scopeLayer.getBoundingClientRect();
    for (const rect of range.getClientRects()) {
      if (!rect.width || !rect.height) continue;
      const mark = h(this.doc, "span", { class: "qs-input-selection" });
      mark.style.cssText = `left:${rect.left - bounds.left}px;top:${rect.top - bounds.top}px;width:${rect.width}px;height:${rect.height}px`;
      this.selectionLayer.append(mark);
    }
  }
  inputPosition(x) {
    if (!this.markerLayout?.length || !this.doc.caretPositionFromPoint) return null;
    const bounds = this.input.getBoundingClientRect(), inputStyle = this.input.style, layerStyle = this.scopeLayer.style;
    const previous = [inputStyle.pointerEvents, layerStyle.pointerEvents, layerStyle.zIndex];
    try {
      inputStyle.pointerEvents = "none"; layerStyle.pointerEvents = "auto"; layerStyle.zIndex = "3";
      const point = this.doc.caretPositionFromPoint(Math.max(bounds.left + 1, Math.min(bounds.right - 1, x)), bounds.top + bounds.height / 2);
      if (!point || !this.scopeText.contains(point.offsetNode)) return x <= bounds.left ? 0 : this.input.value.length;
      const range = this.doc.createRange(); range.setStart(this.scopeText, 0); range.setEnd(point.offsetNode, point.offset);
      return Math.min(this.input.value.length, range.toString().length);
    } finally { [inputStyle.pointerEvents, layerStyle.pointerEvents, layerStyle.zIndex] = previous; }
  }
  inputPointer(event) {
    if (!this.markerLayout?.length || this.composing || event.type === "pointerdown" && event.button !== 0) return;
    event.preventDefault();
    if (event.type === "pointermove") {
      const bounds = this.input.getBoundingClientRect(), direction = event.clientX < bounds.left ? -1 : event.clientX > bounds.right ? 1 : 0;
      if (direction) { this.input.scrollLeft += direction * 20; this.renderInputScopes(); }
    }
    const position = this.inputPosition(event.clientX);
    if (position === null) return;
    if (event.type === "pointerdown") {
      const anchor = event.shiftKey ? this.input.selectionDirection === "backward" ? this.input.selectionEnd : this.input.selectionStart : position;
      this.inputDrag = { id: event.pointerId, anchor }; this.input.focus(); this.input.setPointerCapture(event.pointerId);
    }
    if (!this.inputDrag || this.inputDrag.id !== event.pointerId) return;
    const anchor = this.inputDrag.anchor;
    this.input.setSelectionRange(Math.min(anchor, position), Math.max(anchor, position), position < anchor ? "backward" : "forward");
    this.renderInputSelection();
  }
  spec() {
    if (this.switchMode) return this.app.makeSpec(this.win, { text: this.input.value, rawText: this.input.value, fields: [], sources: { notes: false, annotations: false, fulltext: false }, scope: { type: "library", libraryID: this.context.libraryID } });
    if (this.advancedSpec) return { ...this.advancedSpec, nativeConditions: this.nativeConditions };
    const query = this.query(), context = query.current ? this.app.directoryContext?.(this.win) || this.app.plainContext(this.win) : this.context;
    const filters = (query.filters || []).map(({ type, value, negated, join, quoted }) => ({ type, value, negated, join, ...(quoted ? { quoted: true } : {}),
      ...(this.filterBindings.has(`${type}:${value}`) ? { ref: this.filterBindings.get(`${type}:${value}`) } : {}) }));
    const libraries = [...new Set(filters.filter(filter => filter.type === "directory" && filter.ref && !filter.negated && filter.ref.libraryID > 0).map(filter => filter.ref.libraryID))];
    let scope = query.current && context.collectionKey ? { type: "collection", libraryID: context.libraryID, collectionKey: context.collectionKey, recursive: this.app.prefs.get("recursive") }
      : query.current && context.searchKey ? { type: "search", libraryID: context.libraryID, searchKey: context.searchKey }
      : !query.current && (libraries.length > 1 || filters.some(filter => filter.ref?.kind === "feeds") || !libraries.length && this.app.prefs.get("defaultScope") === "all") ? { type: "all" }
      : { type: "library", libraryID: query.current ? context.libraryID : libraries[0] || context.libraryID };
    const outlineContext = query.kind === "outline" || query.scopedOutline ? this.outlineContext || this.app.outline?.context(this.win) || { type: "all" } : null;
    const outlineScope = outlineContext && { type: outlineContext.type, ...(outlineContext.type === "pdf" ? { attachmentID: outlineContext.attachmentID, title: outlineContext.title } : {}) };
    if (outlineScope && !query.scopedOutline) scope = outlineScope.type === "all" ? { type: "all" } : { type: "library", libraryID: Zotero.Items.get(outlineScope.attachmentID)?.libraryID || context.libraryID };
    return this.app.makeSpec(this.win, { text: query.text, rawText: this.input.value, scope, ...(outlineScope ? query.scopedOutline ? { outlineSource: outlineScope } : { outlineScope } : {}), ...(filters.length ? { filters } : {}), ...(query.queryTree ? { queryTree: query.queryTree } : {}), ...(query.complete === false ? { queryError: query.error || "检索式尚未完成" } : {}), nativeConditions: query.kind === "outline" && !query.scopedOutline ? undefined : this.nativeConditions || undefined,
      ...(query.kind !== "outline" && this.inputMode === "items" && !query.current && this.input.value.startsWith(this.prefixes().fulltext) ? ALL_FIELDS : {}) });
  }
  enterActions() {
    const mode = this.switchMode || (this.mode === "items" ? "items" : ""), actions = mode !== "commands" && this.app.prefs.get("actions")?.[mode];
    return actions || ({ items: { enter: "read", ctrl: "locate", shift: "window", alt: "web" }, tabs: { enter: "switch", shift: "window", alt: "web" }, outline: { enter: "jump", shift: "split" }, directories: { enter: "open", shift: "parent" } })[mode];
  }
  setMode(mode) {
    if (mode !== "items" && mode !== "outline") this.input.value = this.query().text;
    if (mode !== "directories") this.directoryChoice = null;
    this.inputMode = mode; this.sources.hidden = true;
    if (mode !== "items") { this.advanced.hidden = true; this.stopAdvancedHeight(); }
    this.schedule(0);
  }
  updateMode() {
    const query = this.query();
    if ((this.switchMode === "outline" || query.kind === "outline" || query.scopedOutline) && !this.outlineContext) this.outlineContext = this.app.outline.context(this.win);
    else if (this.switchMode !== "outline" && query.kind !== "outline" && !query.scopedOutline && this.outlineContext) { this.app.outline.release(this); this.outlineContext = null; this.outlineTree = []; this.outlineSize = null; this.app.releaseOutlineSearch?.(); }
    this.mode = query.mode;
    const pathRevision = ++this.scopePathRevision;
    const itemMode = query.mode === "items", recent = query.kind === "recent" && this.advanced.hidden && !this.advancedSpec;
    const modeIcon = this.collectionPicker ? "folderAdd" : this.switchMode ? ({ tabs: "tabs", outline: "outline", directories: "folder", commands: "commands" })[this.switchMode] : this.advancedSpec ? "advanced" : "search";
    this.modeIcon.replaceChildren(icon(this.doc, modeIcon));
    this.modeIcon.title = t(this.collectionPicker ? "将所选文献加入目录" : this.switchMode ? ({ tabs: "标签页切换", outline: "大纲切换", directories: "目录切换", commands: "命令面板" })[this.switchMode] : this.advancedSpec ? "高级搜索" : "文献检索");
    if (this.collectionBackButton) this.collectionBackButton.hidden = !this.collectionPicker;
    this.scopeChip.hidden = !query.current || !!this.switchMode;
    if (query.current) {
      const context = this.app.directoryContext?.(this.win) || this.app.plainContext(this.win), title = context.collectionName || context.searchName || context.libraryName;
      this.scopeChip.replaceChildren(icon(this.doc, "folder"), h(this.doc, "span", { text: title }), icon(this.doc, "back"));
      this.scopeChip.title = [context.libraryName, context.collectionName || context.searchName].filter(Boolean).join(" › ") || title;
      this.scopeChip.setAttribute("aria-label", t("移除当前目录范围：{title}", { title }));
      const path = context.collectionKey && this.app.locations?.collectionPath && typeof Zotero !== "undefined" && Zotero.Collections?.getIDFromLibraryAndKey
        ? this.app.locations.collectionPath(Zotero.Collections.getIDFromLibraryAndKey(context.libraryID, context.collectionKey))
        : context.searchKey && this.app.directoryRows ? this.app.directoryRows(this.win).then(rows => rows.find(row => row.kind === "search" && row.libraryID === context.libraryID && row.key === context.searchKey)) : null;
      path?.then(location => { if (location?.path && this.isOpen && pathRevision === this.scopePathRevision) this.scopeChip.title = location.path; }).catch(() => {});
    }
    const placeholder = this.collectionPicker ? "筛选目录，或输入新目录名称…" : this.switchMode ? ({ tabs: "筛选已打开的标签页…", outline: "筛选当前 PDF 大纲…", directories: "筛选目录…", commands: query.choosingSource ? "筛选 Zotero 或插件…" : "搜索命令…" })[this.switchMode] : this.advancedSpec ? "使用下方 Zotero 高级条件编辑搜索" : query.activeFilter ? `筛选${filterTypes[query.activeFilter.type].name}…` : query.mode === "outline" ? this.outlineContext.type === "pdf" ? "筛选当前 PDF 大纲…" : "搜索全局 PDF 大纲…" : query.mode === "tabs" ? "筛选已打开的标签页…" : query.kind === "fulltext" ? "检索全部字段…" : query.current ? "筛选当前目录的文献…" : "搜索文献…";
    localize(this.input, { placeholder, "aria-label": placeholder });
    this.list.setAttribute("aria-colcount", pickers.includes(query.mode) || query.mode === "outline" ? "1" : "3");
    this.list.setAttribute("role", query.mode === "outline" ? "tree" : "grid");
    this.input.setAttribute("aria-haspopup", query.mode === "outline" ? "tree" : "grid");
    localize(this.list, { "aria-label": this.collectionPicker ? "选择加入的目录" : query.mode === "outline" ? "PDF 大纲树" : "检索结果" });
    this.sourceButton.hidden = !!this.switchMode || !itemMode || query.kind === "fulltext";
    this.previewButton.hidden = this.switchMode === "commands";
    if (this.copyControls) this.copyControls.hidden = !this.canCopy();
    this.updateSelection();
    this.advancedButton.hidden = !!this.collectionPicker || query.kind === "tabs" || query.kind === "outline" || !!query.scopedOutline;
    this.showAll.hidden = this.save.hidden = !!this.switchMode || !itemMode || recent;
    if (!itemMode) { this.advanced.hidden = true; this.stopAdvancedHeight(); }
    if (!itemMode || query.kind === "fulltext") this.sources.hidden = true;
    this.sourceButton.setAttribute("aria-expanded", String(!this.sources.hidden));
    this.advancedButton.setAttribute("aria-expanded", String(!this.advanced.hidden));
    const prefixes = this.prefixes();
    const actions = this.enterActions(), keys = { enter: "Enter", ctrl: globalThis.Zotero?.isMac ? "Cmd+Enter" : "Ctrl+Enter", shift: "Shift+Enter", alt: "Alt+Enter" };
    this.hint.textContent = this.collectionPicker ? t("Enter 加入目录 · {shortcut} 新建目录 · Esc 返回检索", { shortcut: keys.ctrl }) : actions ? [...Object.keys(keys).filter(key => actions[key]).map(key => `${keys[key]} ${t(enterNames[actions[key]])}`), ...(this.switchMode ? [] : [t("Tab 跳出条件")])].join(" · ")
      : this.switchMode === "commands" ? t("@ 来源 · Enter 执行 · Tab 跳出来源") : t("Enter 选定 · Tab 跳出条件");
    this.renderFilterSummary(query);
    return query;
  }
  filterTooltip(filter) {
    const ref = this.filterBindings.get(`${filter.type}:${filter.value}`);
    const resolved = this.currentSpec?.rawText === this.input.value && this.currentSpec.resolvedFilters?.find(entry => entry.type === filter.type
      && entry.value === filter.value && entry.negated === filter.negated && entry.ref?.kind === ref?.kind && entry.ref?.key === ref?.key && entry.ref?.libraryID === ref?.libraryID);
    const paths = [...new Set((resolved?.matches || []).map(match => match.path).filter(Boolean))];
    return paths.length ? paths.slice(0, 4).join("\n") + (paths.length > 4 ? "\n" + t("另 {count} 个目录", { count: paths.length - 4 }) : "") : ref?.path || filter.value;
  }
  renderFilterSummary(query = this.query()) {
    if (this.switchMode) { this.filterSummary.hidden = true; this.filterSummary.replaceChildren(); this.expression = null; return; }
    if (this.advancedSpec) query = { mode: "items", kind: "global", text: "" };
    const doc = this.doc, spec = this.advancedSpec ? this.spec() : this.currentSpec?.rawText === this.input.value ? this.currentSpec : this.spec();
    this.expression = buildWosExpression(query, spec, { scopeLabel: this.scopeChip.title || t("当前目录"), fulltext: !!this.advancedSpec?.fulltext || query.kind !== "outline" && this.inputMode === "items" && !query.current && this.input.value.startsWith(this.prefixes().fulltext) });
    this.filterSummary.replaceChildren(); this.filterSummary.hidden = false;
    localize(this.filterSummary, { "aria-label": "检索式；点击复制 WoS 内容，本地条件使用不同背景" });
    const draw = (parent, node, withNegation = true) => {
      if (node.tag || node.filter) {
        const filter = node.filter, local = node.local || node.tag?.startsWith("ZOTERO_");
        const chip = h(doc, "span", { class: `qs-filter-chip${local ? " qs-local-condition" : ""}`, "data-query-scope": local ? "zotero" : "wos", "data-local-type": local ? filter?.type || node.tag : null });
        const label = filter && `${filter.negated ? t("排除 ") : ""}${filter.value}`;
        const display = local ? localExpressionText(node, withNegation) : expressionText(node, withNegation);
        const title = `${filter ? this.filterTooltip(filter) + "\n" : node.tag === "ZOTERO_OUTLINE" ? expressionText(node) + "\n" : ""}${t("点击复制 WoS 检索式")}${filter ? t("；Alt+点击编辑条件") : ""}${local ? t("；此本地条件不会复制") : ""}`;
        const edit = h(doc, "button", { type: "button", class: "qs-filter-edit", title, "aria-label": filter ? t("编辑{field}条件：{value}", { field: t(filterTypes[filter.type].name), value: label }) : t("复制 WoS 检索式"), onclick: event => {
          if (event?.altKey && filter) this.editFilter(filter); else this.copyExpression();
        } }, [filter ? icon(doc, filterTypes[filter.type].icon) : null, h(doc, "span", { class: "qs-expression-text", text: display })]);
        edit.addEventListener("keydown", event => {
          if (event.isComposing) return;
          if (["Delete", "Backspace"].includes(event.key) && filter) { event.preventDefault(); event.stopPropagation(); this.removeFilter(filter); }
          else if (["Enter", " "].includes(event.key)) { event.preventDefault(); event.stopPropagation(); if (event.altKey && filter) this.editFilter(filter); else this.copyExpression(); }
        });
        chip.append(edit);
        if (filter || node.tag === "ZOTERO_SCOPE") {
          const minus = icon(doc, "back"); minus.firstChild.setAttribute("d", "M6 12h12");
          chip.append(h(doc, "button", { type: "button", class: "qs-filter-remove", l10n: { title: "移除条件" }, "aria-label": filter ? t("移除{field}条件：{value}", { field: t(filterTypes[filter.type].name), value: label }) : t("移除当前目录范围"), onclick: () => filter ? this.removeFilter(filter) : this.clearDirectory() }, [minus]));
        }
        parent.append(chip); return;
      }
      const groupNode = h(doc, "span", { class: "qs-filter-group" });
      if (node.children.length > 1) groupNode.append(h(doc, "span", { class: "qs-filter-join", text: "(" }));
      const children = node.op === "AND" ? [...node.children.filter(child => !child.negated), ...node.children.filter(child => child.negated)] : node.children;
      for (const [index, child] of children.entries()) {
        if (index || node.op === "AND" && child.negated) groupNode.append(h(doc, "span", { class: "qs-filter-join", text: node.op === "AND" && child.negated ? "NOT" : node.op }));
        draw(groupNode, child, !child.negated || node.op !== "AND");
      }
      if (node.children.length > 1) groupNode.append(h(doc, "span", { class: "qs-filter-join", text: ")" }));
      parent.append(groupNode);
    };
    draw(this.filterSummary, this.expression.tree);
    this.copyButton.disabled = !this.expression.copyText;
    this.copyButton.title = t(this.expression.error || "复制完整 WoS 检索式；自动排除本地条件");
    this.expressionAdvanced.disabled = query.complete === false || query.kind === "tabs" || query.kind === "outline" || query.scopedOutline || query.scopedTabs;
    this.expressionAdvanced.setAttribute("aria-expanded", String(!this.advanced.hidden));
    this.filterSummary.append(h(doc, "span", { class: "qs-expression-actions" }, [this.copyButton, this.expressionAdvanced]));
  }
  async copyExpression() {
    if (this.switchMode) return false;
    this.renderFilterSummary();
    if (!this.expression?.copyText) { this.message(this.expression?.error || "没有可复制的 WoS 条件"); return false; }
    try {
      await Zotero.Utilities.Internal.copyTextToClipboard(this.expression.copyText);
      this.notify(this.expression.hasLocal ? "WoS 检索式已复制，已去除本地条件" : "WoS 检索式已复制"); return true;
    } catch (error) { this.message(error.message || "复制失败", true); return false; }
  }
  resizeToContent() {
    if (!this.dialog?.style || !this.isOpen || !this.doc.createElementNS) return;
    if (this.root?.classList?.contains("qs-global")) return;
    const maximum = this.frame().width * Number(this.app.prefs.get("width")) / 100;
    this.dialog.style.setProperty("--qs-width", `${maximum}px`);
    this.dialog.style.setProperty("--qs-height", `${this.frame().height * this.app.prefs.get("height") / 100}px`);
    if (this.switchMode === "commands" || this.advanced?.hidden === false) {
      this.dialog.style.setProperty("--qs-content-width", `${Math.min(maximum, Math.max(0, this.win.innerWidth - 32))}px`);
      return;
    }
    const outline = this.switchMode === "outline" || this.query().kind === "outline", available = Math.max(0, this.win.innerWidth - 32);
    if (!outline) this.outlineSize = null;
    const picker = pickers.includes(this.mode);
    if (!picker || this.pickerSize?.mode !== this.mode) this.pickerSize = null;
    const fixed = outline ? this.outlineSize : picker ? this.pickerSize : null;
    if (fixed) {
      this.dialog.style.setProperty("--qs-content-width", `${Math.min(maximum, available, fixed.base + (this.preview.hidden ? 0 : fixed.preview))}px`);
      return;
    }
    this.measureCanvas ||= this.doc.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    const context = this.measureCanvas.getContext?.("2d");
    if (!context) return;
    const fontSize = Number(this.app.prefs.get("fontSize")), family = this.win.getComputedStyle(this.root).fontFamily;
    const measure = (text, size = fontSize + 1) => { context.font = `${size}px ${family}`; return context.measureText(plainText(text || "")).width; };
    const metadataSize = Math.max(12, fontSize - 2), labelWidth = 26 * measure("0", metadataSize);
    const branchWidth = branches => Math.max(0, ...[...branches.values()].map(branch => Math.min(labelWidth, measure(branch.label, metadataSize))
      + (branch.kind === "library" ? 22 : 0) + (branch.children.size ? 20 + Math.max(220, branchWidth(branch.children)) : 0)));
    const widths = this.rows.slice(0, 20).flatMap(row => [measure(row.title), measure(row.authors, 12) + measure(row.year, 12) + 12, measure(row.publicationTitle, 12) + 22, measure(row.publisher, 12) + 70,
      branchWidth(buildLocationTree(row.locationResult?.locations || [])), row.path ? measure(row.path, metadataSize) : 0]);
    const base = Math.max(this.advancedSpec ? 760 : 520, measure(this.input.value, 20) + 70, ...widths.map(width => width + 70));
    const row = this.rows[this.selected], previewWidth = row ? Math.max(320, Math.min(480, measure(row.title, 16) + 40)) : outline || picker ? 320 : 0;
    if (outline && this.ready) this.outlineSize = { base, preview: previewWidth };
    if (picker && this.ready) this.pickerSize = { mode: this.mode, base, preview: previewWidth };
    this.dialog.style.setProperty("--qs-content-width", `${Math.min(maximum, available, base + (this.preview.hidden ? 0 : previewWidth))}px`);
  }
  useFilter(type, row, filter) {
    if (this.composing || this.switchMode) return;
    const ref = type === "tabs" ? { kind: "tab", key: String(row.attachmentID), attachmentID: row.attachmentID, libraryID: row.libraryID, title: row.title }
      : type === "outline" ? { kind: "outline", key: row.outlineKey, attachmentID: row.attachmentID, libraryID: row.libraryID, title: row.title }
      : type === "author" ? { kind: "author", key: row.key } : ["year", "venue", "type"].includes(type)
      ? { kind: row.kind, key: row.key, field: row.field, title: row.title } : { kind: row.kind, libraryID: row.libraryID, key: row.key, title: row.title, path: row.path };
    if (this.advancedSpec) {
      this.addAdvancedFilter(type, row.title, ref).catch(error => this.message(error.message, true)); return;
    }
    const current = this.query(), value = !filter && current.kind === "tabs" ? tokenize(current.text).map(word => JSON.stringify(word)).join(" ") : this.input.value;
    const query = parseLauncherInput(value, current.kind === "outline" ? "outline" : "items", -1, this.prefixes());
    const duplicate = !filter && query.filters?.some(entry => {
      const bound = this.filterBindings.get(`${type}:${entry.value}`);
      return !entry.negated && entry.type === type && bound && (type === "directory" ? sameRef(bound, ref) : bound.key === ref.key);
    });
    if (!duplicate) {
      filter ||= { type, start: value.length, end: value.length, negated: false };
      const used = new Set((query.filters || []).filter(entry => entry.start !== filter.start).map(entry => `${entry.type}:${entry.value}`));
      let label = row.title, suffix = 1;
      while (used.has(`${type}:${label}`)) label = `${row.title} · ${++suffix}`;
      const replacement = replaceLauncherFilter(value, filter, label, this.prefixes());
      if (replacement.value.length > 2048) throw new Error(t("检索式过长，请先移除部分条件"));
      this.filterBindings.set(`${type}:${label}`, ref); this.input.value = replacement.value;
      this.input.setSelectionRange(replacement.caret, replacement.caret);
    }
    this.inputMode = current.kind === "outline" ? "outline" : "items"; this.directoryChoice = null; this.input.focus(); this.schedule(0);
  }
  renderAuthors(container, row, ranges = []) {
    container.replaceChildren();
    if (this.switchMode) { appendMarked(container, row.authors || "", ranges); return; }
    if (!row.creatorDetails?.length) { appendMarked(container, row.authors || "", ranges); return; }
    let offset = 0;
    for (const creator of row.creatorDetails) {
      appendMarked(container, (row.authors || "").slice(offset, creator.start), []);
      const name = creator.name ? h(this.doc, "button", { type: "button", class: "qs-inline-filter", "data-qs-filter": "author",
        "aria-label": t("添加作者筛选：{name}", { name: creator.name }), onclick: event => {
          event.stopPropagation(); if (this.composing) return;
          try { this.useFilter("author", { ...groupAuthors([creator])[0], title: creator.name }); } catch (error) { this.message(error.message, true); }
        } }) : h(this.doc, "span");
      appendMarked(name, creator.name, ranges.filter(range => range.end > creator.start && range.start < creator.end)
        .map(range => ({ start: Math.max(range.start, creator.start) - creator.start, end: Math.min(range.end, creator.end) - creator.start })));
      container.append(name); offset = creator.end;
    }
  }
  yearNode(row, ranges = []) {
    const valid = !this.switchMode && /^[1-9]\d{3}$/u.test(row.year || "");
    const node = h(this.doc, valid ? "button" : "span", { class: `qs-result-year${valid ? " qs-inline-filter" : ""}`, ...(valid ? {
      type: "button", "data-qs-filter": "year", "aria-label": t("添加年份筛选：{year}", { year: row.year }), onclick: event => {
        event.stopPropagation(); try { this.useFilter("year", { kind: "year", key: row.year, field: "year", title: row.year }); } catch (error) { this.message(error.message, true); }
      },
    } : {}) });
    appendMarked(node, row.year || "", ranges); return node;
  }
  sourceNodes(row, evidence = row.evidence || []) {
    if (!row.publicationTitle && !row.publisher) return null;
    const sources = h(this.doc, "div", { class: "qs-result-sources" });
    for (const field of ["publicationTitle", "publisher"]) {
      if (!row[field]) continue;
      const label = field === "publicationTitle" ? "出版物" : "出版者";
      const button = h(this.doc, this.switchMode ? "span" : "button", { type: "button", class: "qs-inline-filter qs-source-filter", "data-qs-filter": "venue", "data-qs-field": field,
        title: t("添加{field}筛选：{value}", { field: t(label), value: row[field] }), "aria-label": t("添加{field}筛选：{value}", { field: t(label), value: row[field] }), onclick: event => {
          event.stopPropagation();
          try { this.useFilter("venue", { kind: "venue", key: `${field}:${normalize(row[field])}`, field, title: row[field] }); } catch (error) { this.message(error.message, true); }
        } });
      const ranges = evidence.filter(entry => entry.field === field && (!entry.sourceItemID || entry.sourceItemID === row.itemID)).flatMap(entry => entry.ranges || []);
      appendMarked(button, row[field], ranges);
      sources.append(h(this.doc, "span", { class: "qs-source", title: t(label) }, [icon(this.doc, field === "publisher" ? "publisher" : "venue"), button]));
    }
    return sources;
  }
  editFilter(filter) {
    if (this.composing) return;
    const end = filter.bodyEnd ?? filter.end - (filter.quoted && this.input.value[filter.end - 1] === '"' ? 1 : 0);
    this.inputMode = this.query().kind === "outline" ? "outline" : "items"; this.directoryChoice = null; this.input.focus(); this.input.setSelectionRange(filter.bodyStart, end); this.schedule(0);
  }
  removeFilter(filter) {
    if (this.composing) return;
    const current = this.query(), value = this.input.value, filters = parseLauncherInput(value, current.kind === "outline" ? "outline" : "items", -1, this.prefixes()).filters || [], index = filters.findIndex(entry => entry.start === filter.start);
    if (index < 0) return;
    const structured = removeLauncherFilter(value, filter, this.prefixes());
    if (structured) {
      if (this.inputScopes && !filters.some((entry, other) => other !== index && entry.marker === filters[index].marker)) this.inputScopes.records = this.inputScopes.records.filter(record => record.marker !== filters[index].marker);
      this.input.value = structured.value; this.input.setSelectionRange(structured.caret, structured.caret);
      this.input.focus(); this.schedule(0); return;
    }
    const previous = filters[index - 1], next = filters[index + 1];
    let start = filter.start, end = filter.end;
    // Remove the adjacent OR with its member so it cannot become an ordinary search word.
    if (next?.join === "or") end = next.start; else if (filter.join === "or" && previous) start = previous.end;
    const caret = this.input.selectionEnd ?? value.length;
    this.input.value = value.slice(0, start) + value.slice(end);
    if (!parseLauncherInput(this.input.value, current.kind === "outline" ? "outline" : "items", -1, this.prefixes()).filters?.some(entry => entry.type === filter.type && entry.value === filter.value)) this.filterBindings.delete(`${filter.type}:${filter.value}`);
    this.inputMode = current.kind === "outline" ? "outline" : "items"; this.directoryChoice = null; this.input.focus();
    const position = caret >= end ? caret - (end - start) : Math.min(caret, start);
    this.input.setSelectionRange(position, position); this.schedule(0);
  }
  clearDirectory() {
    const query = this.query();
    if (this.inputScopes) this.inputScopes.records = this.inputScopes.records.filter(record => record.type !== (query.current ? "current" : "directory"));
    let value = this.input.value;
    if (!query.current) {
      if (query.queryTree) {
        while (true) {
          const entry = parseLauncherInput(value, "items", -1, this.prefixes()).filters?.find(filter => filter.type === "directory");
          if (!entry) break;
          const removed = removeLauncherFilter(value, entry, this.prefixes());
          value = removed ? removed.value : value.slice(0, entry.start) + value.slice(entry.end);
        }
      } else
      for (const filter of [...(query.filters || [])].reverse()) if (filter.type === "directory") value = value.slice(0, filter.start) + value.slice(filter.end);
      for (const key of this.filterBindings.keys()) if (key.startsWith("directory:")) this.filterBindings.delete(key);
    }
    this.inputMode = query.kind === "outline" ? "outline" : "items"; this.input.value = query.current ? value.slice(1).trimStart() : value;
    this.input.focus(); this.schedule(0);
  }
  schedule(delay = 90, refresh = false) {
    if (!this.isOpen || this.composing) return;
    const query = this.updateMode();
    this.app.outline?.cancel(this);
    this.revision++;
    if (!refresh || query.mode !== "outline") {
      this.ready = false; this.list.classList.add("pending");
      this.message("检索中…");
    }
    this.win.clearTimeout(this.timer);
    this.timer = this.win.setTimeout(() => this.run(), delay);
  }
  async run() {
    if (!this.isOpen || this.composing) return;
    if (this.running) { this.queued = true; return; }
    this.running = true; const revision = this.revision;
    try {
      const query = this.query(); let spec = this.spec();
      if (query.complete === false && !query.activeFilter) {
        this.currentSpec = spec; this.rows = []; this.rowNodes = []; this.list.replaceChildren(); this.list.classList.remove("pending"); this.ready = false;
        this.disposePDF(); this.preview.replaceChildren(); this.message(query.error || "检索式尚未完成"); return;
      }
      if (query.complete === false && query.activeFilter) this.message(query.error || "检索式尚未完成");
      const signature = JSON.stringify([query.mode, spec, this.app.prefs.get("limit")]);
      if (signature !== this.pickerSignature) { this.pickerVisible = this.app.prefs.get("limit"); this.pickerSignature = signature; }
      if (query.mode === "items") spec = await this.app.search.prepare(spec);
      if (!this.isOpen || this.revision !== revision) return;
      this.currentSpec = spec;
      let result, preferred;
      if (this.switchMode === "commands") {
        await this.commandIndex;
        if (!this.isOpen || revision !== this.revision) return;
        const rows = await this.app.commands.rows(this.win, query);
        result = { results: rows, total: rows.length, warnings: [] };
      } else if (this.switchMode === "outline") {
        if (signature !== this.outlineQuerySignature) { this.outlineVisible = this.app.prefs.get("limit"); this.outlineQuerySignature = signature; this.list.scrollTop = 0; }
        const progress = this.outlineContext.type === "pdf" ? await this.app.outline.search("", this.outlineContext, { owner: this, win: this.win }) : { rows: [], allRows: [], total: 0, completed: 0, documents: 0, pending: false };
        const rows = progress.rows.filter(row => switchMatches(row.title, query.text));
        if (!query.text.trim() && signature !== this.resultSignature) {
          preferred = currentOutlineRow(rows, this.outlineContext.reader);
          const limit = this.app.prefs.get("limit"), index = rows.indexOf(preferred);
          this.outlineVisible = Math.min(rows.length, Math.max(this.outlineVisible, Math.ceil((index + 1) / limit) * limit));
        }
        result = { results: rows.slice(0, this.outlineVisible), allRows: progress.allRows, total: rows.length, warnings: [], progress: { ...progress, rows, total: rows.length } };
      } else if (this.switchMode === "directories") {
        const all = await this.app.directoryRows(this.win);
        const rows = all.filter(row => (!this.collectionPicker || row.kind === "collection" && row.libraryID === this.collectionPicker.libraryID) && switchMatches(row.path, query.text));
        const start = !query.text.trim() && await this.directoryStart;
        preferred = start && rows.find(row => row.kind === start.kind && row.libraryID === start.libraryID && (!start.key || row.key === start.key));
        result = { results: rows, total: rows.length, warnings: [] };
      } else if (query.mode === "outline") {
        if (signature !== this.outlineQuerySignature) { this.outlineVisible = this.app.prefs.get("limit"); this.outlineQuerySignature = signature; this.list.scrollTop = 0; }
        let itemIDs, filterIDs;
        if (query.scopedOutline) {
          const progress = await this.app.outline.search("", this.outlineContext, { owner: this, win: this.win,
            onUpdate: () => { if (this.isOpen && this.mode === "outline") this.schedule(0, true); } });
          const filter = query.activeFilter, pattern = filter.quoted ? JSON.stringify(filter.value) : filter.value;
          const terms = tokenize(pattern);
          const rows = progress.rows.filter(row => terms.every(term => filterMatches([...row.parents, row.title].join(" › "), term)));
          result = { results: rows.slice(0, this.outlineVisible || this.app.prefs.get("limit")), allRows: progress.allRows, total: rows.length, warnings: [], progress: { ...progress, rows, total: rows.length } };
        } else if (spec.queryTree) {
          spec = await this.app.search.prepare(spec); this.currentSpec = spec;
          if (spec.filters?.length) {
            filterIDs = await Promise.all(spec.filters.map(async filter => new Set((await this.app.search.search({ ...spec, text: "", queryTree: undefined, filters: [filter], resolvedFilters: undefined,
              scope: { type: "all" }, fields: [], sources: { notes: false, annotations: false, fulltext: false } }, { limit: 0 })).itemIDs)));
          }
        } else if (spec.filters?.length) {
          const metadata = await this.app.search.search({ ...spec, text: "", scope: { type: "all" }, fields: [], sources: { notes: false, annotations: false, fulltext: false } }, { limit: 0 });
          itemIDs = new Set(metadata.itemIDs);
          spec = await this.app.search.prepare(spec); this.currentSpec = spec;
        }
        if (!this.isOpen || this.revision !== revision) return;
        if (!query.scopedOutline) {
        let progress = await this.app.outline.search(spec.queryTree ? "" : query.text, this.outlineContext, { owner: this, win: this.win,
          itemIDs, onUpdate: () => { if (this.isOpen && this.mode === "outline") this.schedule(0, true); } });
        if (!this.isOpen || this.revision !== revision) return;
        if (spec.queryTree) {
          const rows = progress.rows.filter(row => matchesQueryTree(spec.queryTree, [...row.parents, row.title].join(" › "), filterIDs?.map(ids => ids.has(row.itemID))));
          progress = { ...progress, rows, total: rows.length };
        }
        result = { results: progress.rows.slice(0, this.outlineVisible).map(row => ({ ...row, win: this.win })), allRows: progress.allRows, total: progress.total, warnings: [], progress };
        }
      } else if (query.mode === "tabs") {
        let rows = await this.app.tabRows(this.win, this.switchMode ? query.text : query.activeFilter?.value || "", { literal: !!this.switchMode });
        result = { results: rows.slice(0, this.pickerVisible), all: rows, total: rows.length, warnings: [] };
      } else if (query.mode === "directories") {
        const fragment = query.filters?.find(filter => filter.start === query.activeFilter?.start), bound = fragment && this.filterBindings.get(`directory:${fragment.value}`);
        const fragmentText = query.activeFilter?.value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
        const rows = await this.app.directoryRows(this.win, bound ? "" : fragmentText ?? query.text);
        preferred = bound && rows.find(row => sameRef(row, bound));
        const name = preferred?.title || bound?.title || query.activeFilter?.value.replace(/ · \d+$/u, "");
        const matches = bound ? rows.filter(row => filterMatches(row.title, name) || filterMatches(row.path, name)) : rows;
        const ordered = preferred ? [preferred, ...matches.filter(row => row !== preferred)] : matches;
        result = { results: ordered.slice(0, this.pickerVisible), all: ordered, total: matches.length, warnings: [] };
      } else if (query.mode === "authors") {
        const fragment = query.filters.find(filter => filter.start === query.activeFilter.start), bound = this.filterBindings.get(`author:${fragment.value}`);
        const rows = await this.app.search.authorRows(bound ? "" : query.activeFilter.value), original = bound && rows.find(row => sameRef(row, bound));
        const name = original?.title || query.activeFilter.value.replace(/ · \d+$/u, "");
        const matches = rows.filter(row => (!bound || authorMatches(row, name)) && (spec.scope.type === "all" || row.records.some(record => record.libraryID === spec.scope.libraryID)));
        preferred = bound && matches.find(row => sameRef(row, bound));
        const ordered = preferred ? [preferred, ...matches.filter(row => row !== preferred)] : matches;
        result = { results: ordered.slice(0, this.pickerVisible), all: ordered, total: matches.length, warnings: [] };
      } else if (["years", "venues", "types"].includes(query.mode)) {
        const filter = query.activeFilter, bound = this.filterBindings.get(`${filter.type}:${filter.value}`);
        const rows = (await this.app.search.fieldRows(filter.type, bound ? "" : filter.value)).map(row => {
          const records = row.records.filter(record => spec.scope.type === "all" || record.libraryID === spec.scope.libraryID);
          return { ...row, records, count: records.reduce((count, record) => count + Number(record.count), 0) };
        }).filter(row => row.records.length);
        const original = bound && rows.find(row => row.kind === bound.kind && row.key === bound.key), pattern = original?.title || filter.value.replace(/ · \d+$/u, "");
        const matches = bound ? rows.filter(row => row === original || filterMatches(row.title, pattern) || filter.type === "type" && filterMatches(row.key, pattern)) : rows;
        preferred = original;
        const ordered = original ? [original, ...matches.filter(row => row !== original)] : matches;
        result = { results: ordered.slice(0, this.pickerVisible), all: ordered, total: matches.length, warnings: [] };
      } else if (query.kind === "fulltext" && !query.text.trim()) result = { results: [], total: 0, warnings: [] };
      else if (query.kind === "recent" && !this.nativeConditions && this.advanced.hidden) result = await this.app.recentRows(this.win, this.pickerVisible);
      else result = await this.app.search.search(spec, { limit: this.pickerVisible, recent: this.app.prefs.get("recentItems") });
      if (!this.isOpen || this.revision !== revision) return;
      const previous = signature === this.resultSignature ? this.rows[this.selected] : null, displayedRows = this.rows, displayedSelection = this.selected, scroll = this.list.scrollTop;
      if (signature !== this.resultSignature) { this.picked?.clear(); this.selectionAnchor = null; }
      this.itemIDs = result.itemIDs || result.results.map(row => row.itemID).filter(Boolean);
      this.recentItemIDs = !this.switchMode && query.kind === "recent" && !this.nativeConditions && this.advanced.hidden ? this.itemIDs : null;
      this.pagedItemIDs = !this.switchMode && query.mode === "items" ? this.itemIDs : null;
      if (query.mode === "items" && this.picked?.size) {
        const valid = new Set(this.itemIDs);
        for (const [key, row] of this.picked) if (!valid.has(row.itemID)) this.picked.delete(key);
      }
      this.rows = result.results; this.selected = Math.max(0, this.rows.findIndex(row => sameResult(row, previous))); this.ready = true; this.resultSignature = signature;
      this.pickerRows = result.all || null;
      if (query.mode === "outline") {
        this.outlineTree = buildOutlineTree(result.results, { allRows: result.allRows || result.results, groupDocuments: this.outlineContext.type !== "pdf" });
        this.outlineProgress = result.progress;
      }
      this.renderFilterSummary(query);
      const outlineSignature = query.mode === "outline" && JSON.stringify([signature, outlineState(this.outlineTree)]);
      const rowsChanged = !outlineSignature || outlineSignature !== this.outlineResultSignature;
      if (rowsChanged) {
        this.renderRows(revision, previous); this.outlineResultSignature = outlineSignature;
        if (query.mode === "outline" && previous) this.list.scrollTop = scroll;
      } else { this.rows = displayedRows; this.selected = displayedSelection; }
      this.list.classList.remove("pending");
      if (preferred && !previous) this.select(Math.max(0, this.rows.findIndex(row => query.mode === "outline" ? sameResult(row, preferred) : row.kind === preferred.kind && row.libraryID === preferred.libraryID && row.key === preferred.key)), ["directories", "outline"].includes(this.switchMode));
      if (this.selectionAnchor == null) this.selectionAnchor = this.selected;
      const label = query.mode === "outline" ? t(this.outlineContext.type === "pdf" ? "当前 PDF 大纲" : "全局 PDF 大纲") : query.mode === "tabs" ? t("标签页") : pickers.includes(query.mode) ? t(query.activeFilter ? filterTypes[query.activeFilter.type].name : "目录") : query.kind === "recent" && this.advanced.hidden ? t("最近阅读") : query.kind === "fulltext" ? t("全部字段") : query.current ? t("当前目录") : spec.scope.type === "all" ? t("所有文库") : Zotero.Libraries.get(spec.scope.libraryID)?.name || this.context.libraryName;
      this.countLabel = this.switchMode === "commands" ? t("命令") : label;
      this.message(`${this.countLabel} · ${result.total}${result.total > this.rows.length ? ` / ${this.rows.length}` : ""}`);
      if (result.outlineProgress?.pending) this.message(t("大纲索引 {completed}/{documents} · {count} 个匹配", { ...result.outlineProgress, count: result.total }));
      if (query.mode === "outline") this.updateOutlineStatus();
      if (this.switchMode === "outline" && this.outlineContext.type !== "pdf") this.message("先打开一个 PDF，再切换当前大纲");
      this.status.title = result.warnings?.map(warning => t(warning)).join("; ") || "";
      if (query.mode === "outline") this.status.title = this.outlineContext.type === "pdf" ? this.outlineContext.title : t("仅检索本机 PDF，不下载附件");
      this.save.disabled = spec.scope.type === "all";
      this.save.title = t(this.save.disabled ? "切换到单一文库后保存" : query.scopedOutline || query.scopedTabs ? "保存动态条件（需插件）" : "保存当前搜索");
      this.fillOutlineViewport();
    } catch (error) {
      if (revision === this.revision && this.isOpen) { this.rows = []; this.ready = false; this.list.replaceChildren(); this.rowNodes = []; this.list.classList.remove("pending"); this.disposePDF(); this.preview.replaceChildren(); this.message(error.message || "检索失败", true); }
    } finally {
      this.running = false;
      if (this.queued || revision !== this.revision) { this.queued = false; if (this.isOpen) this.run(); }
    }
  }
  renderRows(revision, preferred, from = 0) {
    this.resizeToContent();
    const doc = this.doc, spec = this.currentSpec;
    if (!from) { this.list.replaceChildren(); this.rowNodes = []; this.input.removeAttribute("aria-activedescendant"); }
    if (!this.rows.length) {
      const query = this.query();
      this.list.append(h(doc, "p", { class: "qs-empty", l10n: { text: this.collectionPicker ? "未找到目录；输入名称后新建" : query.mode === "outline" ? "暂无可跳转的大纲" : query.kind === "recent" ? "暂无最近阅读" : query.mode === "tabs" ? "没有匹配的标签页" : query.mode === "directories" ? "没有匹配的目录" : query.mode === "authors" ? "没有匹配的作者" : query.kind === "fulltext" && !query.text.trim() ? "输入关键词" : "没有匹配结果" } }));
      this.disposePDF(); this.preview.replaceChildren(); return;
    }
    let terms = []; try { terms = this.switchMode ? switchTerms(this.query().text) : tokenize(this.query().activeFilter?.value || this.query().text); } catch { /* Query errors are shown by run(). */ }
    if (this.switchMode === "commands") {
      for (const [index, row] of this.rows.entries()) {
        const node = h(doc, "div", { id: `qs-option-${index}`, class: "qs-result qs-command-result", role: "row", "aria-selected": "false", "data-index": index,
          onclick: () => { this.select(index, false); this.activate(); } });
        const title = h(doc, "div", { class: "qs-result-title" }, [row.iconURL ? h(doc, "img", { class: "qs-command-icon", src: row.iconURL, alt: "", "aria-hidden": "true" }) : icon(doc, row.kind === "command-source" ? "types" : "commands")]);
        const text = h(doc, "span"); appendMarked(text, row.title, terms.flatMap(term => matchRanges(row.title, term))); title.append(text);
        node.append(title, h(doc, "p", { class: "qs-muted", text: row.kind === "command-source" ? t("{count} 条命令", { count: row.count })
          : [row.sourceTitle, row.reason || (row.dependency ? t(({ items: "依据所选条目", collection: "依据所选目录", reader: "依据当前阅读器", field: "依据所选信息字段", tab: "依据当前标签页" })[row.dependency]) : "")].filter(Boolean).join(" · ") }));
        this.list.append(node); this.rowNodes[index] = node;
      }
      this.select(this.selected, false, false); return;
    }
    if (this.mode === "directories") {
      const tree = buildLocationTree(this.rows.map(row => ({ ...row }))), ordered = [];
      const append = (parent, branches) => {
        for (const branch of branches.values()) {
          const group = h(doc, "div", { class: "qs-directory-branch", role: "presentation" });
          for (const row of branch.entries) {
            row.index = ordered.length; ordered.push(row);
            const node = h(doc, "div", { class: "qs-result qs-directory-result", role: "row", "aria-selected": "false", "data-index": row.index });
            const main = h(doc, "div", { class: "qs-result-main qs-directory-name", role: "gridcell", "aria-label": row.path, id: `qs-option-${row.index}`, tabindex: -1, onclick: event => this.clickResult(event, row.index) });
            main.append(icon(doc, row.kind === "library" ? "library" : ["feed", "feeds"].includes(row.kind) ? "rss" : row.kind === "search" ? "save" : "folder"));
            const name = h(doc, "span", { class: "qs-result-title" }); appendMarked(name, row.title, terms.flatMap(term => matchRanges(row.title, term))); main.append(name);
            const count = h(doc, "span", { class: "qs-directory-count", text: "…", title: t("正在统计条目…") }); main.append(count);
            this.app.directoryCounts?.count(row, { recursive: !!this.app.prefs.get("recursive") }).then(value => {
              if (!this.isOpen || revision !== this.revision || !count.isConnected) return;
              count.textContent = String(value); count.title = t(row.kind === "collection" && this.app.prefs.get("recursive") ? "{count} 条，包含子目录并去重" : "{count} 条", { count: value });
              count.setAttribute("aria-label", count.title);
            }).catch(error => { if (revision === this.revision) { count.textContent = "?"; count.title = error.message; } });
            node.append(main); node.addEventListener("pointermove", event => { if ((event.movementX || event.movementY) && this.selected !== row.index) this.select(row.index, false); });
            this.rowNodes[row.index] = node; group.append(node);
          }
          if (!branch.entries.length) group.append(h(doc, "div", { class: "qs-directory-ancestor", text: branch.label }));
          if (branch.children.size) { const children = h(doc, "div", { class: "qs-directory-children", role: "presentation" }); append(children, branch.children); group.append(children); }
          parent.append(group);
        }
      };
      const previous = this.rows[this.selected]; append(this.list, tree); this.rows = ordered; this.select(Math.max(0, this.rows.findIndex(row => sameResult(row, previous))), false); return;
    }
    if (this.mode === "authors") {
      const active = this.query().activeFilter, bound = active && this.filterBindings.get(`author:${active.value}`);
      const compactName = name => normalize(name).replace(/[\s.,，·'’-]/gu, "");
      for (const [index, row] of this.rows.entries()) {
        if (index < from) continue;
        const node = h(doc, "div", { class: "qs-result qs-author-result", role: "row", "aria-selected": "false", "data-index": index });
        const main = h(doc, "div", { class: "qs-result-main", role: "gridcell", id: `qs-option-${index}`, tabindex: -1, onclick: () => { this.select(index); this.activate(); } });
        const title = h(doc, "div", { class: "qs-result-title" }), name = h(doc, "span", { class: "qs-author-name" });
        const ranges = terms.flatMap(term => matchRanges(row.title, term));
        if (!ranges.length && active?.value.trim() && /[^*?\s]/u.test(active.value) && (bound?.key === row.key || authorMatches(row, active.value))) ranges.push({ start: 0, end: row.title.length });
        title.append(icon(doc, "author")); appendMarked(name, row.title, ranges); title.append(name); main.append(title);
        const variants = [...new Set((row.authors || "").split(" · ").filter(label => label && compactName(label) !== compactName(row.title)
          && compactName(label.split(/[\s,，]+/u).reverse().join("")) !== compactName(row.title)))];
        if (variants.length) main.append(h(doc, "div", { class: "qs-result-meta" }, [h(doc, "span", { text: variants.join(" · ") })]));
        node.append(main); node.addEventListener("pointermove", event => { if ((event.movementX || event.movementY) && this.selected !== index) this.select(index, false); });
        this.rowNodes.push(node); this.list.append(node);
      }
      this.select(this.selected, false, !from); return;
    }
    if (["years", "venues", "types"].includes(this.mode)) {
      for (const [index, row] of this.rows.entries()) {
        if (index < from) continue;
        const node = h(doc, "div", { class: "qs-result qs-facet-result", role: "row", "aria-selected": "false", "data-index": index });
        const main = h(doc, "div", { class: "qs-result-main qs-directory-name", role: "gridcell", id: `qs-option-${index}`, tabindex: -1, onclick: () => { this.select(index); this.activate(); } });
        const name = h(doc, "span", { class: "qs-result-title" }); appendMarked(name, row.title, terms.flatMap(term => matchRanges(row.title, term)));
        main.append(row.kind === "type" ? itemTypeIcon(doc, row.key, this.root?.dataset.theme) || icon(doc, "types") : icon(doc, filterTypes[row.kind].icon), name);
        const source = row.field === "publicationTitle" ? "Publication" : row.field === "publisher" ? "Publisher" : t(filterTypes[row.kind].name);
        node.append(main, h(doc, "div", { class: "qs-result-meta", text: `${source} · ${t("{count} 条", { count: row.count })}` }));
        node.addEventListener("pointermove", event => { if ((event.movementX || event.movementY) && this.selected !== index) this.select(index, false); });
        this.rowNodes.push(node); this.list.append(node);
      }
      this.select(this.selected, false, !from); return;
    }
    if (this.mode === "outline") {
      this.renderOutlineRows(revision, preferred); return;
    }
    for (const [index, row] of this.rows.entries()) {
      if (index < from) continue;
      const node = h(doc, "div", { class: "qs-result", role: "row", "aria-selected": String(index === this.selected), "data-index": index });
      const main = h(doc, "div", { class: "qs-result-main", role: "gridcell", id: `qs-option-${index}`, tabindex: -1, onclick: event => this.clickResult(event, index) });
      const title = h(doc, "div", { class: "qs-result-title" });
      const titleText = h(doc, "span", { class: "qs-title-text", title: row.title });
      const titleRanges = row.evidence?.filter(e => e.field === "title").flatMap(e => e.ranges) || [];
      appendMarked(titleText, plainText(row.title), this.mode === "items" ? titleRanges : terms.flatMap(t => matchRanges(plainText(row.title), t)));
      const nativeIcon = itemTypeIcon(doc, row.itemIconType || row.itemType, this.root?.dataset.theme);
      if (nativeIcon) title.append(nativeIcon);
      title.append(titleText);
      const tail = h(doc, "span", { class: "qs-result-tail" });
      if (row.year) tail.append(this.yearNode(row, row.evidence?.filter(e => e.field === "date").flatMap(e => e.ranges) || []));
      title.append(tail);
      const meta = h(doc, "div", { class: "qs-result-meta" });
      const author = h(doc, "span", { class: "qs-result-authors" });
      this.renderAuthors(author, row, this.mode === "tabs" ? terms.flatMap(t => matchRanges(row.authors || "", t)) : row.evidence?.filter(e => e.field === "creator").flatMap(e => e.ranges) || []);
      if (row.authors) meta.append(icon(doc, "author")); meta.append(author);
      main.append(title, meta);
      const sources = this.sourceNodes(row); if (sources) main.append(sources);
      const locations = h(doc, "div", { class: "qs-row-locations", role: "gridcell", l10n: { "aria-label": "所属文件夹" } });
      const evidence = h(doc, "div", { class: "qs-row-evidence", role: "gridcell" });
      const reason = row.evidence?.find(e => !["title", "creator", "date", "publicationTitle", "publisher"].includes(e.field)) || row.evidence?.find(e => e.field === "creator");
      if (reason) evidence.append(evidenceNode(doc, reason));
      node.append(main, locations, evidence); this.rowNodes[index] = node;
      node.addEventListener("pointermove", event => { if ((event.movementX || event.movementY) && this.selected !== index) this.select(index, false); }); this.list.append(node);
      if (row.itemID && this.mode === "items" && (spec.text.trim() || spec.nativeConditions?.length || spec.filters?.length)) {
        Zotero.Items.getAsync(row.itemID).then(item => this.app.search.evidenceForItem(item, spec)).then(entries => {
          if (!this.isOpen || revision !== this.revision || !node.isConnected) return;
          row.evidence = entries;
          if (sources) sources.replaceWith(this.sourceNodes(row, entries));
          const hit = entries.find(e => !["title", "creator", "date", "publicationTitle", "publisher"].includes(e.field)) || entries.find(e => e.field === "creator");
          if (hit) evidence.replaceChildren(evidenceNode(doc, hit));
        }).catch(() => {});
      }
      if (row.itemID) {
        locations.append(h(doc, "span", { class: "qs-location-loading", l10n: { text: "读取位置…" } }));
        this.app.locations.get(row.itemID).then(result => {
          if (!this.isOpen || revision !== this.revision || !node.isConnected) return;
          row.locationResult = result; this.renderLocations(locations, row, result, spec); this.resizeToContent();
          if (this.selected === index && !this.preview.hidden) this.updatePreview(revision);
        }).catch(() => { if (node.isConnected && revision === this.revision) localize(locations, { text: "位置暂不可用" }); });
      }
    }
    this.select(this.selected, false, !from);
  }
  renderLocations(container, row, result, spec = this.currentSpec) {
    const doc = this.doc; container.replaceChildren();
    if (result.status !== "ready") { container.append(h(doc, "span", { class: "qs-location-error", l10n: { text: "位置暂不可用" }, title: t(result.error || "正在读取") })); return; }
    const click = (event, branch, location) => {
      event.stopPropagation();
      if (this.composing) return;
      if (this.switchMode || event.ctrlKey || event.metaKey) {
        this.activate(location ? { locate: true, location, row } : { directory: branch, row }); return;
      }
      try { this.useFilter("directory", { ...branch, title: branch.label }); }
      catch (error) { this.message(error.message, true); }
    };
    if (!result.locations.length) {
      const unfiled = h(doc, "span", { class: "qs-unfiled" });
      if (result.libraryName) {
        const branch = { kind: "library", libraryID: result.libraryID, label: result.libraryName, path: result.libraryName };
        const library = h(doc, "button", { type: "button", class: "qs-path qs-location-name",
          "data-qs-filter": "directory", "aria-label": t(this.switchMode ? "打开目录：{path}" : "添加目录筛选：{path}", { path: result.libraryName }), onclick: event => click(event, branch) });
        appendMarked(library, result.libraryName, locationMatchRanges({ label: result.libraryName, kind: "library", libraryID: result.libraryID }, spec));
        unfiled.append(library, h(doc, "span", { text: " · " }));
      }
      unfiled.append(h(doc, "span", { l10n: { text: "未归入文件夹" } })); container.append(unfiled); return;
    }
    const tree = h(doc, "div", { class: "qs-location-tree" });
    const append = (parent, branches, root = false) => {
      for (const branch of branches.values()) {
        const group = h(doc, "span", { class: "qs-location-branch" });
        if (root) group.append(icon(doc, "library"));
        const location = branch.kind === "collection" && branch.entries[0];
        const name = h(doc, "button", { type: "button", class: `qs-path qs-location-name${branch.children.size ? " qs-location-parent" : ""}`,
          "data-qs-location-key": branch.key, "data-qs-location-kind": branch.kind,
          "data-qs-location-member": String(branch.entries.length > 0), "data-qs-filter": "directory",
          "aria-label": t(this.switchMode ? location ? "在文件夹中定位：{path}" : "打开目录：{path}"
            : location ? "添加目录筛选：{path}；Ctrl/Cmd+点击定位文献" : "添加目录筛选：{path}", { path: branch.path }),
          onclick: event => click(event, branch, location) });
        appendMarked(name, branch.label, locationMatchRanges(branch, spec)); group.append(name);
        if (branch.children.size) { const children = h(doc, "span", { class: "qs-location-children" }); append(children, branch.children); group.append(children); }
        parent.append(group);
      }
    };
    append(tree, buildLocationTree(result.locations), true); container.append(tree);
  }
  renderOutlineRows(revision, preferred, preservePreview = false) {
    const previous = preferred || this.rows[this.selected], doc = this.doc, query = this.query(), terms = this.switchMode ? switchTerms(query.text) : tokenize(query.scopedOutline ? query.activeFilter?.quoted ? JSON.stringify(query.activeFilter.value) : query.activeFilter?.value || "" : query.text);
    this.rows = []; this.rowNodes = []; this.list.replaceChildren(); this.input.removeAttribute("aria-activedescendant");
    const append = (parent, branches, level = 1) => {
      for (const branch of branches) {
        const index = this.rows.length, row = { ...branch, win: this.win, contextOnly: this.switchMode === "outline" && terms.length > 0 && !branch.matched }; this.rows.push(row);
        const group = h(doc, "div", { class: "qs-outline-branch", role: "treeitem",
          id: `qs-option-${index}`, tabindex: -1, "aria-level": level,
          "aria-selected": "false", ...(row.contextOnly ? { "aria-disabled": "true" } : {}), ...(branch.children.length ? { "aria-expanded": "true" } : {}), "data-index": index, "data-outline-key": row.key });
        const node = h(doc, "div", { class: `qs-result qs-outline-result${row.isDocument ? " qs-outline-document" : ""}`, role: "presentation" });
        const main = h(doc, "div", { class: "qs-result-main qs-outline-main", role: "presentation", ...(!row.contextOnly ? { onclick: event => this.clickResult(event, index) } : {}) });
        const title = h(doc, "span", { class: "qs-title-text", title: [...(row.parents || []), row.title].join(" › ") });
        if (row.isDocument) main.append(itemTypeIcon(doc, "attachmentPDF", this.root?.dataset.theme) || icon(doc, "outline"));
        appendMarked(title, row.title, terms.flatMap(term => matchRanges(row.title, term))); main.append(title);
        if (Number.isSafeInteger(row.pageIndex)) main.append(h(doc, "span", { class: "qs-outline-page", text: t("第 {page} 页", { page: row.pageIndex + 1 }) }));
        node.append(main);
        if (!row.contextOnly) node.addEventListener("pointermove", event => { if ((event.movementX || event.movementY) && this.selected !== index) this.select(index, false); });
        this.rowNodes[index] = group; group.append(node);
        if (branch.children.length) { const children = h(doc, "div", { class: "qs-outline-children", role: "group" }); append(children, branch.children, level + 1); group.append(children); }
        parent.append(group);
      }
    };
    append(this.list, this.outlineTree || []);
    let selected = this.rows.findIndex(row => !row.contextOnly && (row.key === previous?.key || sameResult(row, previous)));
    if (selected < 0) selected = this.rows.findIndex(row => !row.contextOnly && !row.isDocument && row.location);
    if (selected < 0) selected = this.rows.findIndex(row => !row.contextOnly);
    this.select(Math.max(0, selected), false, !preservePreview);
    this.resizeToContent();
  }
  more() { return this.mode === "outline" ? this.moreOutline() : this.pagedItemIDs ? this.moreItems() : this.morePicker(); }
  async moreItems() {
    const ids = this.pagedItemIDs;
    if (!this.isOpen || !this.ready || this.composing || this.itemPaging || !ids || this.rows.length >= ids.length) return false;
    const session = this.openRevision, revision = this.revision, offset = this.rows.length;
    this.itemPaging = true;
    try {
      const next = ids.slice(offset, offset + this.app.prefs.get("limit"));
      const spec = this.currentSpec, evidenceSpec = queryEvidenceSpec(spec), recent = !!this.recentItemIDs;
      const rows = await Promise.all(next.map(async itemID => {
        const row = await this.app.search.result(await Zotero.Items.getAsync(itemID), spec);
        if (!recent) row.evidence = this.app.search.metadataEvidence(this.app.search.metadataCache.get(itemID), itemID, evidenceSpec);
        return row;
      }));
      if (!this.isOpen || session !== this.openRevision || revision !== this.revision || ids !== this.pagedItemIDs) return false;
      const previous = this.rows[this.selected], scroll = this.list.scrollTop;
      this.rows.push(...rows); this.pickerVisible = this.rows.length;
      this.renderRows(revision, previous, offset); this.select(this.selected, false, false); this.list.scrollTop = scroll;
      this.message(`${this.countLabel} · ${ids.length}${ids.length > this.rows.length ? ` / ${this.rows.length}` : ""}`);
      return true;
    } catch (error) { if (this.isOpen && session === this.openRevision && revision === this.revision) this.message(error?.message || "检索失败", true); return false; }
    finally { this.itemPaging = false; }
  }
  scrollResults(event) {
    if (!event.deltaY || event.ctrlKey || event.metaKey) return;
    const hasMore = this.mode === "outline" ? this.outlineVisible < (this.outlineProgress?.rows.length || 0) : this.rows.length < (this.pagedItemIDs?.length || this.pickerRows?.length || 0);
    if (this.list.scrollHeight <= this.list.clientHeight && !(hasMore && event.deltaY > 0)) return;
    event.preventDefault(); event.stopPropagation();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.list.clientHeight : 1;
    this.list.scrollTop += event.deltaY * unit;
    if (event.deltaY > 0 && this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight <= Math.max(120, this.list.clientHeight * .35)) this.more();
  }
  morePicker() {
    const all = this.pickerRows;
    if (!this.isOpen || !this.ready || this.composing || !all || ![...pickers, "tabs"].includes(this.mode) || this.rows.length >= all.length) return false;
    const previous = this.rows[this.selected], scroll = this.list.scrollTop, focused = this.doc.activeElement === this.rowNodes[this.selected], offset = this.rows.length;
    this.pickerVisible = Math.min(all.length, this.rows.length + this.app.prefs.get("limit"));
    this.rows = all.slice(0, this.pickerVisible); this.renderRows(this.revision, previous, this.mode === "directories" ? 0 : offset);
    this.select(Math.max(0, this.rows.findIndex(row => sameResult(row, previous))), false, false); this.list.scrollTop = scroll;
    if (focused) this.rowNodes[this.selected]?.focus();
    this.message(`${this.countLabel} · ${all.length}${all.length > this.rows.length ? ` / ${this.rows.length}` : ""}`);
    return true;
  }
  moreOutline() {
    const progress = this.outlineProgress;
    if (!this.isOpen || !this.ready || this.composing || this.mode !== "outline" || !progress?.rows || this.outlinePaging) return false;
    const visible = this.outlineVisible || this.app.prefs.get("limit");
    if (visible >= progress.rows.length) return false;
    this.outlinePaging = true;
    try {
      const previous = this.rows[this.selected], scroll = this.list.scrollTop, focused = this.doc.activeElement === this.rowNodes[this.selected];
      this.outlineVisible = Math.min(progress.rows.length, visible + this.app.prefs.get("limit"));
      this.outlineTree = buildOutlineTree(progress.rows.slice(0, this.outlineVisible), { allRows: progress.allRows, groupDocuments: this.outlineContext.type !== "pdf" });
      this.renderOutlineRows(this.revision, previous, true); this.list.scrollTop = scroll;
      if (focused) this.rowNodes[this.selected]?.focus();
      this.outlineResultSignature = JSON.stringify([this.resultSignature, outlineState(this.outlineTree)]);
      this.updateOutlineStatus(); return true;
    } finally { this.outlinePaging = false; }
  }
  fillOutlineViewport() {
    if (this.mode !== "outline") return;
    while (this.list.clientHeight > 0 && this.list.scrollHeight <= this.list.clientHeight && this.moreOutline()) {}
  }
  updateOutlineStatus() {
    if (!this.outlineProgress) return;
    const progress = this.outlineProgress;
    const scope = t(this.outlineContext?.type === "pdf" ? "当前 PDF 大纲" : "全局 PDF 大纲");
    const count = this.outlineVisible && this.outlineVisible < progress.total ? `${this.outlineVisible}/${progress.total}` : progress.total;
    if (progress.pending) this.message(t("大纲索引 {completed}/{documents} · {count} 个匹配", { ...progress, count }));
    else this.message(t("{scope} · {count} 个匹配", { scope, count }));
  }
  canCopy() { return this.switchMode === "tabs" || !this.switchMode && this.mode === "items"; }
  canSelectMany() { return !this.collectionPicker && this.switchMode !== "commands" && (this.canCopy() || ["outline", "directories"].includes(this.switchMode)); }
  updateSelection() {
    const picked = this.picked?.size || 0;
    this.list?.setAttribute("aria-multiselectable", String(this.canSelectMany()));
    for (const [index, node] of (this.rowNodes || []).entries()) {
      const chosen = this.rows[index] && this.picked?.has(selectionKey(this.rows[index]));
      node?.setAttribute("aria-selected", String(picked ? !!chosen : index === this.selected));
      node?.setAttribute("data-qs-picked", String(!!chosen));
      node?.setAttribute("data-qs-current", String(index === this.selected));
      const cell = node?.querySelector?.(":scope > .qs-result-main > .qs-result-title > .qs-result-tail") || node?.querySelector?.(":scope > .qs-outline-result") || node;
      let checkbox = cell?.querySelector?.(":scope > .qs-result-check");
      if (this.canSelectMany() && !this.rows[index]?.contextOnly && cell && !checkbox) {
        checkbox = h(this.doc, "input", { class: "qs-result-check", type: "checkbox", l10n: { "aria-label": "选择条目", title: "选择条目；Shift 选择范围" } });
        checkbox.addEventListener("click", event => { event.stopPropagation(); if (event.shiftKey) this.selectRange(index); else this.toggleSelection(index); });
        cell.append(checkbox);
      }
      if (checkbox) { checkbox.hidden = !this.canSelectMany(); checkbox.checked = !!chosen; }
    }
    if (this.selectionBar) this.selectionBar.hidden = !this.collectionPicker && !this.canSelectMany();
    if (this.createCollectionButton) {
      this.createCollectionButton.hidden = !this.collectionPicker && (!!this.switchMode || this.mode !== "items" || !picked);
      this.createCollectionButton.disabled = this.collectionPicker ? !this.input.value.trim() : !this.ready || !!this.creatingCollection;
      localize(this.createCollectionButton, { title: this.collectionPicker ? "新建目录并加入文献" : "将所选文献加入目录", "aria-label": this.collectionPicker ? "新建目录并加入文献" : "将所选文献加入目录" });
    }
    if (this.selectionCount) this.selectionCount.textContent = t("已选 {count} 条", { count: this.collectionPicker ? this.collectionPicker.state.picked.size : picked });
    if (this.selectAllButton) {
      this.selectAllButton.hidden = !!this.collectionPicker;
      const selectedAll = this.allResultsSelected();
      localize(this.selectAllButton, { title: selectedAll ? "取消全选" : "全选结果", "aria-label": selectedAll ? "取消全选" : "全选结果" });
      this.selectAllButton.setAttribute("aria-pressed", String(selectedAll));
      this.selectAllButton.disabled = !this.ready || !this.rows.length;
    }
  }
  clearSelection() { this.picked?.clear(); this.selectionAnchor = this.selected; this.selectionRevision = (this.selectionRevision || 0) + 1; this.updateSelection(); }
  toggleSelection(index = this.selected) {
    if (!this.canSelectMany() || !this.rows[index] || this.rows[index].contextOnly) return;
    this.selectionRevision = (this.selectionRevision || 0) + 1;
    this.picked ||= new Map(); const row = this.rows[index], key = selectionKey(row);
    if (this.picked.has(key)) this.picked.delete(key); else this.picked.set(key, row);
    this.selectionAnchor = index; this.select(index, false);
  }
  selectRange(index) {
    if (!this.canSelectMany()) return;
    this.selectionRevision = (this.selectionRevision || 0) + 1;
    this.picked ||= new Map(); const anchor = this.selectionAnchor ?? this.selected;
    this.selectionAnchor = anchor;
    this.picked.clear();
    for (let cursor = Math.min(anchor, index); cursor <= Math.max(anchor, index); cursor++) {
      const row = this.rows[cursor]; if (row && !row.contextOnly) this.picked.set(selectionKey(row), row);
    }
    this.select(index);
  }
  selectAllResults() {
    if (!this.ready || !this.canSelectMany()) return;
    this.selectionRevision = (this.selectionRevision || 0) + 1;
    this.picked ||= new Map(); this.picked.clear();
    const visible = new Map(this.rows.filter(row => row.itemID).map(row => [row.itemID, row]));
    const all = !this.switchMode && this.mode === "items" ? (this.itemIDs || []).map(itemID => visible.get(itemID) || { kind: "item", itemID })
      : this.mode === "outline" ? this.outlineProgress?.rows || this.rows : this.pickerRows || this.rows;
    for (const row of all.length ? all : this.rows) this.picked.set(selectionKey(row), row);
    this.updateSelection();
  }
  allResultsSelected() {
    if (!this.picked?.size) return false;
    if (!this.switchMode && this.mode === "items" && this.itemIDs?.length) return this.picked.size === this.itemIDs.length && this.itemIDs.every(itemID => this.picked.has(`item:${itemID}`));
    const all = this.mode === "outline" ? this.outlineProgress?.rows || this.rows : this.pickerRows || this.rows;
    const keys = new Set((all.length ? all : this.rows).map(selectionKey));
    return !!keys.size && this.picked.size === keys.size && [...keys].every(key => this.picked.has(key));
  }
  toggleAllResults() { if (this.allResultsSelected()) this.clearSelection(); else this.selectAllResults(); }
  clickResult(event, index) {
    if (this.canSelectMany() && (event.ctrlKey || event.metaKey)) { event.preventDefault(); this.toggleSelection(index); return; }
    if (this.canSelectMany() && event.shiftKey) { event.preventDefault(); this.selectRange(index); return; }
    this.clearSelection(); this.selectionAnchor = index; this.select(index); this.activate();
  }
  chosenRows() { return this.picked?.size ? [...this.picked.values()] : this.rows[this.selected] ? [this.rows[this.selected]] : []; }
  actionCurrent({ navigate = false } = {}) {
    const spec = this.spec();
    // A locate action changes the live sidebar; keep its original current-directory scope.
    const scope = navigate && !this.switchMode && !this.advancedSpec && spec.rawText?.startsWith(this.prefixes().current) ? spec.scope : null;
    const signature = spec => JSON.stringify([this.switchMode, this.input.value, scope ? { ...spec, scope } : spec]);
    const session = this.openRevision, query = signature(spec), picked = this.picked, count = picked?.size;
    const selection = this.selectionRevision, single = !count && this.rows[this.selected];
    return () => this.isOpen && session === this.openRevision && query === signature(this.spec())
      && picked === this.picked && count === this.picked?.size && selection === this.selectionRevision && (!single || sameResult(this.rows[this.selected], single));
  }
  async refreshStyles() {
    if (!this.styleMenu || !this.app.clipboard) return;
    const session = this.openRevision, request = this.styleRevision = (this.styleRevision || 0) + 1, sourceApp = this.sourceApp;
    const current = () => this.isOpen && session === this.openRevision && request === this.styleRevision;
    try {
      const styles = await this.app.clipboard.styles(); if (!current()) return;
      const popup = this.doc.createXULElement("menupopup");
      for (const style of styles) { const option = this.doc.createXULElement("menuitem"); option.setAttribute("value", style.styleID); option.setAttribute("label", style.title); popup.append(option); }
      this.styleMenu.replaceChildren(popup); this.styleMenu.value = this.manualStyleID || "";
      const styleID = this.manualStyleID || await this.app.clipboard.styleForApp(sourceApp); if (!current()) return;
      this.styleMenu.value = this.manualStyleID || styleID;
    } catch (error) { if (current()) this.message(error?.message || "引用格式读取失败", true); }
  }
  async createCollection() {
    if (!this.ready || this.switchMode || this.mode !== "items" || !this.picked?.size || this.creatingCollection) return false;
    const rows = this.chosenRows(), original = this.actionCurrent(), session = this.openRevision;
    const current = () => this.collectionPicker ? this.isOpen && session === this.openRevision : original();
    this.creatingCollection = true; this.updateSelection();
    try {
      const result = await this.app.createCollection(rows, this.win, current);
      if (result && current()) this.notify(t("已将 {count} 条加入「{name}」", result));
      return !!result;
    } catch (error) { if (current()) this.notify(error?.message || t("加入目录失败"), true); return false; }
    finally { this.creatingCollection = false; this.updateSelection(); }
  }
  chooseCollection(libraryID) {
    return new Promise(resolve => {
      this.win.clearTimeout(this.feedbackTimer); if (this.feedback) this.feedback.hidden = true; if (this.tooltip) this.tooltip.hidden = true;
      const state = Object.fromEntries(["switchMode", "inputMode", "mode", "context", "rows", "rowNodes", "selected", "ready", "itemIDs", "recentItemIDs", "pagedItemIDs",
        "picked", "selectionAnchor", "selectionRevision", "filterBindings", "currentSpec", "resultSignature", "pickerRows", "pickerSignature", "pickerVisible", "pickerSize",
        "directoryStart", "advancedSpec", "nativeConditions"].map(key => [key, this[key]]));
      this.collectionPicker = { libraryID, resolve, state, value: this.input.value, caret: [this.input.selectionStart, this.input.selectionEnd],
        scopes: this.inputScopes.records, preview: !this.preview.hidden, advancedHidden: this.advanced.hidden, sourcesHidden: this.sources.hidden,
        readOnly: this.input.readOnly, scroll: this.list.scrollTop };
      this.switchMode = this.inputMode = this.mode = "directories"; this.context = { ...this.context, libraryID };
      this.input.value = ""; this.input.readOnly = false; this.inputScopes.reset("");
      this.filterBindings = new Map(); this.picked = new Map(); this.rows = []; this.rowNodes = []; this.itemIDs = [];
      this.selected = 0; this.selectionAnchor = null; this.ready = false; this.resultSignature = null;
      this.advancedSpec = this.nativeConditions = null; this.advanced.hidden = this.sources.hidden = true; this.stopAdvancedHeight();
      this.directoryStart = this.app.directoryStart(this.win); this.directoryStart?.catch(error => this.app.logError(error));
      this.list.replaceChildren(); this.preview.replaceChildren(); this.disposePDF(); this.togglePreview(true);
      this.input.focus(); this.schedule(0);
    });
  }
  finishCollectionPicker(target, refresh = true) {
    const picker = this.collectionPicker; if (!picker) return false;
    this.collectionPicker = null; this.disposePDF(); Object.assign(this, picker.state);
    this.input.value = picker.value; this.inputScopes.reset(picker.value, picker.scopes); this.input.setSelectionRange(...picker.caret);
    this.input.readOnly = picker.readOnly; this.advanced.hidden = picker.advancedHidden; this.sources.hidden = picker.sourcesHidden;
    this.list.replaceChildren(...this.rowNodes); this.list.scrollTop = picker.scroll; this.preview.replaceChildren(); this.preview.hidden = !picker.preview;
    if (refresh && this.isOpen) {
      this.togglePreview(picker.preview); if (!this.advanced.hidden) this.watchAdvancedHeight();
      this.input.focus(); this.schedule(0);
    }
    picker.resolve(target); return !!target;
  }
  chooseNewCollection() {
    if (!this.collectionPicker) return false;
    const name = this.input.value.trim();
    if (!name) { this.notify(t("请输入目录名称"), true); this.input.focus(); return false; }
    return this.finishCollectionPicker({ name });
  }
  async copySelection(kind) {
    if (!this.ready || !this.canCopy() || !this.app.clipboard || this.copying) return false;
    const rows = this.chosenRows(), current = this.actionCurrent();
    if (!rows.length) return false;
    this.copying = true; this.notify("正在复制…");
    try {
      const result = await this.app.clipboard.copy(kind, rows, { win: this.win, styleID: this.manualStyleID || undefined, app: this.sourceApp, current });
      if (current()) {
        this.notify(t(result.failed?.length ? "已复制 {count} 条，{failed} 条未能复制" : "已复制 {count} 条", { count: result.count, failed: result.failed?.length || 0 }), !result.count);
        if (result.failed?.length) { this.picked = new Map(result.failed.map(row => [selectionKey(row), row])); this.updateSelection(); }
      }
      return !!result.count;
    } catch (error) { if (current()) this.message(error?.message || "复制失败", true); return false; }
    finally { this.copying = false; }
  }
  async activateBatch(options) {
    if (this.actionRunning) return;
    this.actionRunning = true; this.allowOutsideFocus = true;
    const rows = this.chosenRows(), failed = [], current = this.actionCurrent({ navigate: true });
    try {
      if (options.locate && this.mode === "items" && this.app.locateItems) {
        const result = await this.app.locateItems(rows, current);
        failed.push(...(result.failed || []));
      } else for (const [index, row] of rows.entries()) {
        if (!current()) return;
        this.notify(t("正在处理 {current}/{count}", { current: index + 1, count: rows.length }));
        if (!await this.activate({ ...options, row, batch: true })) failed.push(row);
      }
      if (!current()) return;
      if (failed.length) {
        this.picked = new Map(failed.map(row => [selectionKey(row), row])); this.updateSelection();
        this.message(t("已完成 {count} 条，{failed} 条未完成；保留选择以重试", { count: rows.length - failed.length, failed: failed.length }), true);
      } else this.hide({ restoreFocus: false });
    } catch (error) {
      if (current()) this.message(error?.message || "操作失败；保留选择以重试", true);
    } finally { this.actionRunning = false; this.allowOutsideFocus = false; }
  }
  navigationIndex(offset) {
    const indices = this.rows.map((row, index) => row.contextOnly ? -1 : index).filter(index => index >= 0);
    const current = Math.max(0, indices.indexOf(this.selected));
    return indices[Math.max(0, Math.min(indices.length - 1, current + offset))] ?? 0;
  }
  select(index, scroll = true, preview = true) {
    if (!this.rows.length) return;
    index = Math.max(0, Math.min(index, this.rows.length - 1));
    if (this.rows[index].contextOnly) return;
    this.selected = index;
    this.updateSelection();
    this.input.setAttribute("aria-activedescendant", `qs-option-${this.selected}`);
    if (scroll) {
      const node = this.rowNodes[this.selected];
      if (this.mode === "outline") scrollOutlineRow(this.list, node?.querySelector?.(":scope > .qs-outline-result") || node);
      else node?.scrollIntoView({ block: "nearest" });
    }
    if (preview && !this.preview.hidden) this.updatePreview(this.revision).catch(error => { if (this.isOpen) this.message(error?.message || "预览暂不可用", true); });
  }
  async activate({ locate = false, shifted = false, web = false, copy, location, directory, row, batch = false } = {}) {
    row ||= this.picked?.size === 1 ? this.picked.values().next().value : this.rows[this.selected];
    if (!this.ready || this.composing || !row || row.contextOnly) return;
    if (this.collectionPicker) {
      if (row.kind !== "collection" || row.libraryID !== this.collectionPicker.libraryID) return false;
      return this.finishCollectionPicker({ collectionID: row.collectionID });
    }
    if (copy) return this.copySelection(copy);
    if (!batch && !location && !directory && this.canSelectMany() && this.picked?.size > 1) return this.activateBatch({ locate, shifted, web });
    const current = this.actionCurrent({ navigate: true });
    try {
      let success;
      if (this.switchMode === "commands") {
        if (row.kind === "command-source") { this.chooseCommandSource(row); return; }
        const revision = this.revision, openRevision = this.openRevision;
        const refreshed = (await this.app.commands.index(this.win, { focus: this.originalFocus })).find(command => command.key === row.key);
        if (!this.isOpen || this.revision !== revision || this.openRevision !== openRevision) return;
        if (!refreshed) throw new Error(t("当前上下文不可用"));
        const draft = this.input.value, source = this.commandSource;
        this.hide({ restoreFocus: true, keepCommands: true });
        try { await this.app.commands.execute(refreshed); }
        catch (error) {
          this.app.commands.dispose(this.win); this.showSwitch("commands");
          this.input.value = draft; this.commandSource = source; this.inputScopes.reset(draft); this.schedule(0);
          this.message(error?.message || "打开失败", true); return false;
        }
        finally { if (!this.isOpen || this.switchMode !== "commands") this.app.commands.dispose(this.win); if (!this.isOpen) this.onHide?.(); }
        return;
      } else if (web && (this.switchMode === "tabs" || !this.switchMode && this.mode === "items")) success = await this.app.openItemURL(row);
      else if (this.switchMode === "tabs") success = shifted ? await this.app.openPDFWindow(row) : await this.app.openTab(row);
      else if (this.switchMode === "outline") {
        if (!row.location) return;
        if (this.outlineContext.type !== "pdf" || row.attachmentID !== this.outlineContext.attachmentID) throw new Error(t("当前 PDF 已改变，请重新打开大纲切换"));
        success = await this.app.outline.open(row, { split: shifted, reader: this.outlineContext.reader });
      } else if (this.switchMode === "directories") success = await this.app.selectDirectory(shifted ? await this.app.parentDirectory({ ...row, win: this.win }) : { ...row, win: this.win }, current);
      else if (directory) success = await this.app.selectDirectory({ ...directory, itemID: row.itemID, win: row.win }, current);
      else if (location) success = await this.app.openItem(row, { locate: true, location, current });
      else if (pickers.includes(this.mode)) {
        if (this.directoryChoice) success = await this.directoryChoice(row);
        else {
          const filter = this.query().activeFilter; if (!filter) return;
          this.useFilter(filter.type, row, filter); return;
        }
      } else if (this.mode === "outline" && this.query().activeFilter?.type === "outline" && !locate) {
        if (!row.isDocument) this.useFilter("outline", row, this.query().activeFilter); return;
      } else if (this.mode === "outline" && !locate) {
        if (!row.location) return;
        if (!this.app.outline.reader(row.attachmentID)) await this.app.ensureMainWindow(this.win);
        success = await this.app.outline.open(row);
      } else if (this.mode === "tabs" && this.query().activeFilter?.type === "tabs" && !locate) { this.useFilter("tabs", row, this.query().activeFilter); return; }
      else if ((this.mode === "tabs" || row.kind === "reader") && !locate) success = await this.app.openTab(row);
      else if (shifted && !locate && !location) success = await this.app.openPDFWindow(row);
      else success = await this.app.openItem(row, { locate, location, current });
      if (success !== false) { if (!batch && current()) this.hide({ restoreFocus: false }); return true; }
      if (current()) this.message("定位已取消"); return false;
    } catch (error) { if (current()) this.message(error?.message || "打开失败", true); return false; }
  }
  async applyAll() {
    if (!this.ready || this.switchMode) return;
    const revision = this.revision, openRevision = this.openRevision, mode = this.mode;
    let signature;
    const current = () => {
      if (!this.isOpen || openRevision !== this.openRevision || mode !== this.mode) return false;
      if (signature === undefined) return revision === this.revision;
      try { return signature === JSON.stringify(this.spec()); } catch { return false; }
    };
    try {
      const spec = this.spec();
      signature = JSON.stringify(spec);
      const main = await this.app.ensureMainWindow(this.win);
      if (!current()) return false;
      const success = await this.app.nativeFor(main).applyQuery(spec);
      if (!current() || success === false) return false;
      if (main.closed) throw new Error(t("主窗口已关闭，请重试"));
      main.focus(); this.hide({ restoreFocus: false }); return true;
    } catch (error) { if (current()) this.message(error.message, true); return false; }
  }
  chooseCommandSource(row) {
    const query = this.query();
    const prefix = `@(${row.title.replace(/[\\()]/gu, "\\$&")}) `;
    this.commandSource = { title: row.title, source: row.source };
    this.input.value = prefix + this.input.value.slice(query.finish || this.input.value.length).trimStart();
    this.inputScopes.reset(this.input.value); this.inputScopes.add(0);
    this.input.focus(); this.input.setSelectionRange(prefix.length, prefix.length); this.schedule(0);
  }
  togglePreview(force) {
    this.preview.hidden = typeof force === "boolean" ? !force : !this.preview.hidden;
    this.body.classList.toggle("with-preview", !this.preview.hidden); this.dialog.classList.toggle("with-preview", !this.preview.hidden);
    this.previewButton.setAttribute("aria-expanded", String(!this.preview.hidden));
    if (!this.preview.hidden) this.updatePreview(this.revision); else this.disposePDF();
    this.resizeToContent();
    this.fillOutlineViewport();
  }
  disposePDF() {
    this.pdfPreview?.destroy(); this.pdfPreview = null; this.pdfPreviewKey = null; this.pdfPreviewSource = null;
  }
  async updatePreview(revision) {
    if (this.preview.hidden || !this.rows[this.selected]) return;
    const index = this.selected, row = this.rows[index], doc = this.doc, spec = this.currentSpec;
    const request = this.previewRevision = (this.previewRevision || 0) + 1;
    if (pickers.includes(this.mode)) {
      const facet = ["author", "year", "venue", "type"].includes(row.kind);
      const detail = !facet ? "" : row.kind === "author" ? row.authors : row.field === "publicationTitle" ? "Publication" : row.field === "publisher" ? "Publisher" : t(filterTypes[row.kind].name);
      const mark = facet ? row.kind === "type" ? itemTypeIcon(doc, row.key, this.root?.dataset.theme) || icon(doc, "types") : icon(doc, row.field === "publisher" ? "publisher" : filterTypes[row.kind].icon)
        : icon(doc, row.kind === "library" ? "library" : ["feed", "feeds"].includes(row.kind) ? "rss" : row.kind === "search" ? "save" : "folder");
      this.disposePDF(); this.preview.replaceChildren(h(doc, "h3", { class: "qs-preview-title" }, [mark, h(doc, "span", { class: "qs-title-text", text: row.title })]));
      if (detail && detail !== row.title) this.preview.append(h(doc, "p", { class: "qs-muted", text: detail }));
      const list = h(doc, "div", { class: "qs-directory-preview", text: t("正在读取条目…") }); this.preview.append(list);
      try {
        const limit = this.app.prefs.get("limit");
        const result = await (facet ? this.app.search.search(this.app.makeSpec(this.win, { text: "", scope: spec.scope, filters: [{ type: row.kind, value: row.title,
          ref: row.kind === "author" ? { kind: "author", key: row.key } : { kind: row.kind, key: row.key, field: row.field, title: row.title } }] }), { limit }) : this.app.directoryItems(row, limit));
        if (revision !== this.revision || index !== this.selected || request !== this.previewRevision || !this.isOpen) return;
        list.replaceChildren(h(doc, "p", { class: "qs-muted", text: t("{count} 条", { count: result.total }) + (result.total > result.results.length ? ` / ${result.results.length}` : "") }));
        const locations = facet ? await Promise.all(result.results.map(item => this.app.locations.get(item.itemID))) : [];
        if (revision !== this.revision || index !== this.selected || request !== this.previewRevision || !this.isOpen) return;
        for (const [index, item] of result.results.entries()) {
          const path = facet ? h(doc, "div", { class: "qs-preview-locations" }) : null;
          if (path) this.renderLocations(path, item, locations[index], spec);
          list.append(h(doc, "div", { class: "qs-directory-preview-item" }, [h(doc, "div", { class: "qs-result-title" }, [itemTypeIcon(doc, item.itemIconType || item.itemType, this.root.dataset.theme), h(doc, "span", { class: "qs-title-text", text: item.title })]), h(doc, "p", { class: "qs-muted", text: [item.authors, item.year].filter(Boolean).join(" · ") }), this.sourceNodes(item), path]));
        }
      } catch (error) { if (revision === this.revision && request === this.previewRevision) list.textContent = error.message; }
      this.resizeToContent(); return;
    }
    const headingText = h(doc, "span", { class: "qs-title-text" });
    const query = this.query(), outlineText = query.scopedOutline ? query.activeFilter?.quoted ? JSON.stringify(query.activeFilter.value) : query.activeFilter?.value || "" : query.text;
    appendMarked(headingText, plainText(row.title), this.mode === "outline" ? (this.switchMode ? switchTerms(outlineText) : tokenize(outlineText)).flatMap(term => matchRanges(plainText(row.title), term)) : []);
    const heading = h(doc, "h3", { class: "qs-preview-title" }, [itemTypeIcon(doc, row.itemIconType || row.itemType, this.root?.dataset.theme), headingText]);
    const authorText = row.authors ? h(doc, "span", { class: "qs-result-authors" }) : null, yearText = row.year ? this.yearNode(row) : null;
    if (authorText) this.renderAuthors(authorText, row);
    const byline = row.authors || row.year ? h(doc, "p", { class: "qs-muted qs-byline" }, [authorText && icon(doc, "author"), authorText, authorText && yearText ? " · " : null, yearText]) : null;
    const sources = this.sourceNodes(row);
    const abstract = row.abstract ? h(doc, "p", { class: "qs-abstract", text: row.abstract }) : null;
    const pdfKey = row.itemID ? `${row.itemID}:${row.attachmentID || ""}` : null;
    const pdfSource = row.kind === "outline" ? row.outlineKey : row.kind === "tab" ? row.tabID : row.kind === "reader" ? row.reader : null;
    if (pdfKey !== this.pdfPreviewKey || pdfSource !== this.pdfPreviewSource) {
      this.disposePDF();
      this.preview.scrollTop = 0;
      if (pdfKey) {
        this.pdfPreviewKey = pdfKey;
        this.pdfPreviewSource = pdfSource;
        this.pdfPreview = new PDFPreview(this.win, { onClose: () => this.hide(), onScroll: delta => this.preview.scrollBy(0, delta) });
        this.pdfPreview.load(row);
      }
    }
    if (this.pdfPreview?.root.parentNode === this.preview) {
      for (const child of [...this.preview.childNodes]) if (child !== this.pdfPreview.root) child.remove();
      this.preview.insertBefore(heading, this.pdfPreview.root);
      if (byline) this.preview.insertBefore(byline, this.pdfPreview.root);
      if (sources) this.preview.insertBefore(sources, this.pdfPreview.root);
    } else {
      this.preview.replaceChildren(heading);
      if (byline) this.preview.append(byline);
      if (sources) this.preview.append(sources);
      if (this.pdfPreview) this.preview.append(this.pdfPreview.root);
    }
    const locations = h(doc, "div", { class: "qs-preview-locations" }); this.preview.append(locations);
    if (row.itemID) {
      const result = row.locationResult || await this.app.locations.get(row.itemID);
      if (revision !== this.revision || index !== this.selected || request !== this.previewRevision || !this.isOpen) return;
      this.renderLocations(locations, row, result, spec);
    } else locations.textContent = row.path || "";
    if (row.itemID && this.mode === "items" && (spec?.text.trim() || spec?.nativeConditions?.length || spec?.filters?.length)) {
      const evidence = h(doc, "div", { class: "qs-preview-evidence", l10n: { "aria-label": "匹配依据" } }); this.preview.append(evidence);
      try {
        const entries = await this.app.search.evidenceForItem(await Zotero.Items.getAsync(row.itemID), spec);
        if (revision !== this.revision || index !== this.selected || request !== this.previewRevision || !this.isOpen) return;
        const inline = { title: headingText, creator: authorText, date: yearText, abstractNote: abstract }, extra = [];
        for (const entry of entries) {
          if (["publicationTitle", "publisher"].includes(entry.field) && sources && entry.sourceItemID === row.itemID && entry.ranges?.length) continue;
          const target = entry.sourceItemID === row.itemID && entry.ranges?.length ? inline[entry.field] : null;
          if (target) {
            if (target === authorText) this.renderAuthors(target, row, entry.ranges);
            else { const text = target.textContent; target.replaceChildren(); appendMarked(target, text, entry.ranges); }
          } else extra.push(entry);
        }
        if (sources) sources.replaceWith(this.sourceNodes(row, entries));
        evidence.replaceChildren(...extra.map(e => evidenceNode(doc, e)));
        if (!entries.length) evidence.remove();
        else if (!extra.length) evidence.remove();
      } catch { localize(evidence, { text: "匹配详情暂不可用" }); }
    }
    if (revision !== this.revision || index !== this.selected || request !== this.previewRevision || !this.isOpen) return;
    if (abstract) this.preview.append(h(doc, "h4", { l10n: { text: "摘要" } }), abstract);
    this.resizeToContent();
  }
  async saveCurrentSearch() {
    if (this.switchMode) return false;
    try {
      const session = this.openRevision;
      await this.advancedFilterPending;
      if (!this.isOpen || this.openRevision !== session) return false;
      if (this.widget) { this.widget.updateSearch(); this.nativeConditions = this.widget.search.toJSON().conditions; }
      const saved = await this.app.saveSearch(this.spec(), this.win); this.message(saved ? "已保存" : "已取消"); return saved;
    } catch (error) { this.message(error.message, true); return false; }
  }
  addAdvancedFilter(type, value, ref) {
    const widget = this.widget, session = this.openRevision;
    this.advancedFilterPending = (this.advancedFilterPending || Promise.resolve()).catch(() => {}).then(async () => {
      if (!this.isOpen || this.openRevision !== session || this.widget !== widget) return;
      const prepared = await this.app.search.prepare({ ...this.spec(), filters: [{ type, value, ref }] });
      if (!this.isOpen || this.openRevision !== session || this.widget !== widget) return;
      widget.updateSearch();
      widget.search = this.app.search.buildSearch({ ...this.spec(), filters: prepared.filters, resolvedFilters: prepared.resolvedFilters });
      this.nativeConditions = widget.search.toJSON().conditions; this.schedule(0);
    });
    return this.advancedFilterPending;
  }
  stopAdvancedHeight() {
    this.advancedMutation?.disconnect(); this.advancedResize?.disconnect();
    this.advancedMutation = this.advancedResize = null;
    if (this.advancedHeightFrame != null) this.win.cancelAnimationFrame(this.advancedHeightFrame);
    this.advancedHeightFrame = null;
    this.advanced?.style?.removeProperty("--qs-advanced-height");
  }
  watchAdvancedHeight() {
    this.stopAdvancedHeight();
    if (!this.isOpen || this.advanced.hidden || !this.widget) return;
    const queue = () => this.queueAdvancedHeight();
    if (this.win?.MutationObserver) {
      this.advancedMutation = new this.win.MutationObserver(queue);
      this.advancedMutation.observe(this.widget, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"], characterData: true });
    }
    if (this.win?.ResizeObserver) {
      this.advancedResize = new this.win.ResizeObserver(queue); this.advancedResize.observe(this.widget);
    }
    this.queueAdvancedHeight();
  }
  queueAdvancedHeight() {
    if (!this.isOpen || this.advanced?.hidden || !this.widget || this.advancedHeightFrame != null || !this.win?.requestAnimationFrame) return;
    this.advancedHeightFrame = this.win.requestAnimationFrame(() => { this.advancedHeightFrame = null; this.measureAdvancedHeight(); });
  }
  measureAdvancedHeight() {
    if (!this.isOpen || this.advanced.hidden || !this.widget) return;
    const rows = [...this.widget.querySelectorAll("zoterosearchcondition")].filter(row => row.getClientRects().length);
    if (rows.length <= 5) { this.advanced.style.removeProperty("--qs-advanced-height"); return; }
    const style = this.win.getComputedStyle(this.advanced);
    const height = rows[4].getBoundingClientRect().bottom - this.advanced.getBoundingClientRect().top + this.advanced.scrollTop
      + (parseFloat(style.borderBottomWidth) || 0);
    this.advanced.style.setProperty("--qs-advanced-height", `${Math.ceil(height)}px`);
  }
  async toggleAdvanced(force) {
    if (this.composing || this.switchMode) return;
    this.finishClipboardDraft(true);
    const open = typeof force === "boolean" ? force : this.advanced.hidden;
    if (!open) { this.stopAdvancedHeight(); this.advanced.hidden = true; this.input.readOnly = false; this.advancedButton.setAttribute("aria-expanded", "false"); this.notify("收起高级搜索"); this.schedule(0); this.input.focus(); return; }
    if (this.widget && this.advancedSpec) { this.advanced.hidden = false; this.watchAdvancedHeight(); this.input.readOnly = true; this.advancedButton.setAttribute("aria-expanded", "true"); this.notify("显示高级搜索"); this.schedule(0); return; }
    const query = this.query(), revision = this.revision;
    if (query.complete === false) { this.message(query.error || "检索式尚未完成", true); return; }
    if (query.kind === "outline" || query.scopedOutline) { this.message("PDF 大纲条件无法迁移到原生高级搜索", true); return; }
    if (query.kind === "tabs" || query.scopedTabs) { this.message("已打开标签页条件无法迁移到原生高级搜索", true); return; }
    try {
      tokenize(query.text);
      let spec = this.spec();
      if (spec.scope.type === "all" && spec.filters?.some(filter => filter.type === "directory")) {
        const libraries = this.app.search.libraries(), selected = { value: 0 };
        if (!Services.prompt.select(this.win, t("选择高级搜索文库"), t("含目录条件的原生高级搜索需要选择一个文库"), libraries.map(library => library.name), selected)) return;
        spec = { ...spec, scope: { type: "library", libraryID: libraries[selected.value].libraryID } };
      }
      spec = await this.app.search.prepare(spec);
      if (!this.isOpen || revision !== this.revision) return;
      const search = this.app.search.buildSearch(spec);
      this.stopAdvancedHeight(); this.advanced.replaceChildren();
      const scope = this.doc.createXULElement("menulist"), menu = this.doc.createXULElement("menupopup"); scope.append(menu);
      const scoped = spec.scope.type === "all", libraries = this.app.search.libraries();
      const directoryBound = search.toJSON().conditions.some(condition => ["collection", "savedSearch"].includes(condition.condition))
        || spec.filters?.some(filter => filter.type === "directory") || ["collection", "search"].includes(spec.scope.type);
      const options = directoryBound ? libraries.filter(library => library.libraryID === search.libraryID)
        : [...(scoped ? [{ libraryID: null, name: t("所有文库") }] : []), ...libraries];
      for (const library of options) {
        const option = this.doc.createXULElement("menuitem"); option.setAttribute("value", String(library.libraryID)); option.setAttribute("label", library.name); menu.append(option);
      }
      scope.value = String(search.libraryID); scope.setAttribute("data-qs-advanced-scope", "true");
      localize(scope, { "aria-label": "高级搜索文库" });
      this.advanced.append(scope);
      const widget = this.doc.createXULElement("zoterosearch"); this.advanced.append(widget); this.widget = widget;
      widget.scopeLibraryIDs = scoped ? libraries.map(library => library.libraryID) : [search.libraryID]; widget.search = search;
      this.nativeConditions = search.toJSON().conditions;
      this.advancedSpec = this.app.makeSpec(this.win, { text: "", rawText: "", scope: { type: scoped ? "all" : "library", ...(scoped ? {} : { libraryID: search.libraryID }) }, fields: [], sources: { notes: false, annotations: false, fulltext: false }, nativeConditions: this.nativeConditions,
        ...(query.kind === "fulltext" || spec.sources?.fulltext ? { fulltext: true } : {}) });
      this.input.value = ""; this.input.readOnly = true; this.inputMode = "items"; this.filterBindings.clear(); this.directoryChoice = null;
      const updateSearch = widget.updateSearch;
      widget.updateSearch = (...args) => {
        const result = updateSearch.apply(widget, args);
        if (!widget._rendering && this.isOpen && this.widget === widget) { this.nativeConditions = widget.search.toJSON().conditions; this.queueAdvancedHeight(); this.schedule(); }
        return result;
      };
      const changed = () => {
        try { widget.updateSearch(); }
        catch (error) { this.message(error.message, true); }
      };
      widget.addEventListener("input", changed); widget.addEventListener("command", changed);
      scope.addEventListener("command", () => {
        widget.updateSearch(); const libraryID = scope.value === "null" ? null : Number(scope.value);
        if (widget.search.toJSON().conditions.some(condition => ["collection", "savedSearch"].includes(condition.condition)) && libraryID !== widget.search.libraryID) {
          scope.value = String(widget.search.libraryID); this.message("先移除目录或保存搜索条件，再切换文库", true); return;
        }
        const search = new Zotero.Search(); if (libraryID !== null) search.libraryID = libraryID;
        search.fromJSON({ conditions: widget.search.toJSON().conditions });
        widget.scopeLibraryIDs = libraryID === null ? libraries.map(library => library.libraryID) : [libraryID];
        this.advancedSpec.scope = libraryID === null ? { type: "all" } : { type: "library", libraryID };
        widget.search = search; changed();
      });
      this.advanced.append(h(this.doc, "button", { type: "button", l10n: { text: "清除条件" }, onclick: () => {
        this.stopAdvancedHeight();
        this.nativeConditions = null; this.advancedSpec = null; this.input.readOnly = false; this.widget = null; this.advanced.replaceChildren(); this.advanced.hidden = true;
        this.advancedButton.setAttribute("aria-expanded", "false"); this.schedule();
      } }));
      this.advanced.hidden = false; this.advancedButton.setAttribute("aria-expanded", "true");
      this.watchAdvancedHeight();
      this.schedule(0);
      widget.querySelector("input,textarea,menulist")?.focus();
    } catch (error) { this.stopAdvancedHeight(); this.widget = null; this.message(t("高级条件加载失败：{error}", { error: error.message }), true); }
  }
  keydown(event) {
    if (event.defaultPrevented || event.isComposing || this.composing) return;
    if (this.clipboardDraft && event.target === this.input) {
      const accept = event.key === "Enter" || event.key === " " && !event.ctrlKey && !event.metaKey && !event.altKey;
      this.finishClipboardDraft(accept);
      if (event.key !== "Enter") {
        this.schedule(0);
        if (accept || ["ArrowUp", "ArrowDown", "PageUp", "PageDown"].includes(event.key)) { event.preventDefault(); return; }
      }
    }
    if (event.target.closest?.("menuitem,menupopup,panel") || this.root?.querySelectorAll && ["Escape", "Tab", "Enter", "ArrowUp", "ArrowDown"].includes(event.key)
      && [...this.root.querySelectorAll("menupopup,panel")].some(popup => ["showing", "open"].includes(popup.state))) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (this.collectionPicker) this.finishCollectionPicker(null); else this.hide(); return; }
    const accel = (globalThis.Zotero?.isMac ? event.metaKey || event.ctrlKey : event.ctrlKey) && !event.altKey;
    if (accel && event.key.toLowerCase() === "a" && !event.shiftKey && event.target === this.input) {
      event.preventDefault(); this.input.setSelectionRange(0, this.input.value.length); this.renderInputSelection(); return;
    }
    if (!event.target.closest?.(".qs-advanced") && this.canSelectMany() && accel) {
      const key = event.key.toLowerCase();
      if (key === "a" && !event.shiftKey) { event.preventDefault(); this.selectAllResults(); return; }
      if (key === " " && !event.shiftKey) { event.preventDefault(); this.toggleSelection(); return; }
      if (this.canCopy() && (key === "c" || key === "a" && event.shiftKey)) {
        // Preserve normal text copying when the query itself is selected.
        if (!event.shiftKey && !this.picked?.size && event.target === this.input && this.input.selectionStart !== this.input.selectionEnd) return;
        event.preventDefault(); this.copySelection(event.shiftKey ? key === "a" ? "citation" : "bibliography" : "pdf"); return;
      }
    }
    if (event.key === "Tab" && event.target === this.input && this.switchMode === "commands" && !event.shiftKey && this.query().choosingSource) {
      event.preventDefault();
      const row = this.rows[this.selected]; if (row?.kind === "command-source") this.chooseCommandSource(row); else this.message("未找到命令来源", true);
      return;
    }
    if (event.target === this.input && event.key === ")" && this.input.selectionStart === this.input.selectionEnd
      && this.inputScopes?.skipClosing(this.input.selectionEnd)) {
      event.preventDefault(); this.input.setSelectionRange(this.input.selectionEnd + 1, this.input.selectionEnd + 1); this.schedule(0); return;
    }
    if (event.key === "Tab" && event.target === this.input && !this.switchMode && !this.advancedSpec && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const leave = this.inputScopes?.leave(this.input.selectionEnd, this.query());
      if (leave) {
        event.preventDefault(); this.input.value = leave.value; this.inputScopes.sync(leave.value, this.prefixes());
        this.input.setSelectionRange(leave.caret, leave.caret); this.schedule(0); return;
      }
    }
    if (event.key === "Tab") {
      const nodes = [...this.root.querySelectorAll("button,input,select,textarea,menulist,checkbox,[tabindex]")].filter(n => !n.disabled && n.getAttribute("tabindex") !== "-1" && n.getClientRects().length);
      if (!nodes.length) return;
      const first = nodes[0], last = nodes.at(-1);
      if (event.shiftKey && this.doc.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && this.doc.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    if (event.target.closest?.(".qs-advanced")) return;
    if (event.target !== this.input && (event.target.closest?.("button") || !event.target.closest?.(".qs-result-main,.qs-outline-branch"))) return;
    if (event.key === "Backspace" && event.target === this.input && !this.switchMode && this.inputMode === "tabs" && !this.input.value) { event.preventDefault(); this.setMode("items"); }
    else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (event.key === "ArrowDown" && this.selected === this.rows.length - 1) this.more();
      const next = this.navigationIndex(event.key === "ArrowDown" ? 1 : -1);
      if (event.shiftKey && this.canSelectMany()) this.selectRange(next);
      else { if (!accel) { this.clearSelection(); this.selectionAnchor = next; } this.select(next); }
    }
    else if (this.mode === "outline" && ["PageDown", "PageUp"].includes(event.key)) {
      event.preventDefault();
      const node = this.rowNodes[this.selected]?.querySelector?.(":scope > .qs-outline-result"), step = Math.max(1, Math.floor(this.list.clientHeight / (node?.getBoundingClientRect().height || 32)));
      if (event.key === "PageDown" && this.navigationIndex(step) === this.rows.length - 1) this.moreOutline();
      this.select(this.navigationIndex(event.key === "PageDown" ? step : -step));
    }
    else if (event.key === "Enter") {
      event.preventDefault();
      if (this.collectionPicker) { if (accel) this.chooseNewCollection(); else this.activate(); return; }
      const actions = this.enterActions(), key = (Zotero.isMac ? event.metaKey || event.ctrlKey : event.ctrlKey) ? "ctrl" : event.altKey ? "alt" : event.shiftKey ? "shift" : "enter";
      if (!actions) this.activate({ locate: key === "ctrl" });
      else if (enterActions[actions[key]]) this.activate(enterActions[actions[key]]);
    }
  }
}
