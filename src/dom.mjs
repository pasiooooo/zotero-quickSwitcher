// SPDX-License-Identifier: AGPL-3.0-or-later
import { matchRanges } from "./core.mjs";
import { localize, locale, itemTypeLabel } from "./i18n.mjs";

export const HTML = "http://www.w3.org/1999/xhtml";

const icons = {
  search: "M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM15.3 15.3 21 21",
  outline: "M4 4v16M4 6h5M4 12h5M4 18h5M12 6h9M12 12h9M12 18h9",
  recent: "M12 8v4l3 2M3 11a9 9 0 1 1 2.4 7M3 4v7h7",
  author: "M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM4 21v-2a8 8 0 0 1 16 0v2",
  tag: "M3 3h8l10 10-8 8L3 11ZM7.5 6a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z",
  year: "M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2ZM7 3v4M17 3v4M3 10h18M7 14h3M14 14h3M7 18h3",
  types: "M3 3h7v7H3V3ZM17.5 3a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7ZM6.5 14 2 22h9l-4.5-8ZM15 15h7v7h-7v-7Z",
  venue: "M5 3h13a2 2 0 0 1 2 2v16H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM7 3v18M10 7h7M10 11h7M10 15h4",
  publisher: "M3 21h18M5 21V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v16M16 9h3a2 2 0 0 1 2 2v10M8.5 7.5h4M8.5 11.5h4M8.5 15.5h4",
  filterSearch: "M9 3a6 6 0 1 0 0 12 6 6 0 0 0 0-12ZM13.5 13.5 21 21M16 4h5M18 7h3M18 10h3",
  folderSearch: "M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v2M3 7v12h7M16 12a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM19 19l3 3",
  tabs: "M8 4h11a2 2 0 0 1 2 2v11M5 8h11a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z",
  rss: "M4 4a16 16 0 0 1 16 16M4 11a9 9 0 0 1 9 9M6 19a1 1 0 1 0-2 0 1 1 0 0 0 2 0Z",
  folder: "M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z",
  library: "M4 3v18M9 3v18M15 4l4-1 4 17-4 1-4-17Z",
  fulltext: "M4 3h10l4 4v3M4 3v18h6M13 3v5h5M15 12a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM18 19l4 3M7 8h3M7 12h3",
  sources: "M3 5h7a2 2 0 0 1 2 2v14a3 3 0 0 0-3-3H3V5ZM21 5h-7a2 2 0 0 0-2 2v14a3 3 0 0 1 3-3h6V5Z",
  advanced: "M4 6h16M4 12h16M4 18h16M9 3v6M15 9v6M8 15v6",
  preview: "M3 4h18v16H3V4ZM14 4v16",
  all: "M8 6h13M8 12h13M8 18h13M3 6h1M3 12h1M3 18h1",
  selectAll: "M3 9h12v12H3V9ZM6 6h12v12M9 3h12v12",
  folderAdd: "M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7ZM8 13h8M12 9v8",
  save: "M6 3h12v18l-6-4-6 4V3Z",
  copy: "M9 9h12v12H9V9ZM15 9V3H3v12h6",
  citation: "M4 5h6v7H7c0 4-2 6-4 7M14 5h6v7h-3c0 4-2 6-4 7",
  settings: "m10 3-.7 3-2.1 1.2-2.9-.9-2 3.4 2.2 2.1v2.4l-2.2 2.1 2 3.4 2.9-.9 2.1 1.2.7 3h4l.7-3 2.1-1.2 2.9.9 2-3.4-2.2-2.1v-2.4l2.2-2.1-2-3.4-2.9.9L14.7 6 14 3h-4ZM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
  back: "m14 6-6 6 6 6",
  commands: "m4 6 5 6-5 6M12 18h8M12 6h8",
};

const nativeIcons = new Map();
export function itemTypeIcon(doc, type, theme = "auto") {
  if (!type || typeof Zotero === "undefined" || !Zotero.ItemTypes?.getImageSrc) return null;
  const scheme = theme === "auto" ? doc.defaultView?.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light" : theme;
  const key = `${type}:${scheme}`;
  if (!nativeIcons.has(key)) {
    let src = Zotero.ItemTypes.getImageSrc(type);
    if (src.startsWith("chrome://zotero/skin/item-type/16/")) src = src.replace(/\/(light|dark)\//u, `/${scheme}/`);
    nativeIcons.set(key, src);
  }
  return element(doc, "img", { class: "qs-item-type-icon", src: nativeIcons.get(key), alt: "", "aria-hidden": "true", title: itemTypeLabel(type.startsWith("attachment") ? "attachment" : type) });
}

export function icon(doc, name) {
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.6", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false", class: "qs-icon" })) svg.setAttribute(key, value);
  const path = doc.createElementNS(svg.namespaceURI, "path"); path.setAttribute("d", icons[name] || icons.search); svg.append(path);
  return svg;
}

export function element(doc, tag, attrs = {}, children = []) {
  const node = doc.createElementNS(HTML, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "l10n") localize(node, value);
    else if (key === "text") node.textContent = value ?? "";
    else if (key === "class") node.className = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (value !== false && value != null) node.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child != null) node.append(typeof child === "string" ? doc.createTextNode(child) : child);
  }
  return node;
}

export function appendMarked(node, text, ranges = []) {
  const doc = node.ownerDocument;
  const clean = mergeRanges(ranges, text.length);
  let cursor = 0;
  for (const { start, end } of clean) {
    node.append(doc.createTextNode(text.slice(cursor, start)));
    node.append(element(doc, "mark", { "data-qs-mark": "", text: text.slice(start, end) }));
    cursor = end;
  }
  node.append(doc.createTextNode(text.slice(cursor)));
}

export function mergeRanges(ranges, length = Infinity) {
  const sorted = ranges.filter(r => Number.isInteger(r.start) && Number.isInteger(r.end)
    && r.start >= 0 && r.end > r.start && r.end <= length).map(r => ({ ...r })).sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  for (const range of sorted) {
    const previous = out.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else out.push(range);
  }
  return out;
}

export function highlightTextNodes(node, needles) {
  for (const mark of node.querySelectorAll("mark[data-qs-mark]")) mark.replaceWith(...mark.childNodes);
  if (!needles?.length) return;
  const doc = node.ownerDocument;
  const walker = doc.createTreeWalker(node, 4);
  const nodes = [];
  let current;
  let text = "";
  while (current = walker.nextNode()) {
    if (current.parentElement?.closest("script,style,input,textarea,[contenteditable=true],.cell-icon")) continue;
    nodes.push({ node: current, start: text.length });
    text += current.nodeValue;
  }
  const ranges = mergeRanges(needles.flatMap(needle => matchRanges(text, needle)), text.length);
  for (const part of nodes.reverse()) {
    const content = part.node.nodeValue;
    const local = ranges.filter(r => r.end > part.start && r.start < part.start + content.length)
      .map(r => ({ start: Math.max(0, r.start - part.start), end: Math.min(content.length, r.end - part.start) }));
    if (!local.length) continue;
    const fragment = doc.createDocumentFragment();
    appendMarked(fragment, content, local);
    part.node.replaceWith(fragment);
  }
}

export function evidenceNode(doc, evidence) {
  const row = element(doc, "div", { class: "qs-evidence" });
  row.append(element(doc, "span", { class: "qs-evidence-label", l10n: { text: evidence.label || evidence.field } }));
  const text = element(doc, "span", { class: "qs-evidence-text" });
  const snippet = typeof evidence.snippet === "string"
    ? { text: evidence.snippet, ranges: [] } : evidence.snippet;
  appendMarked(text, snippet?.text ?? evidence.text ?? "", snippet?.ranges ?? evidence.ranges ?? []);
  row.append(text);
  return row;
}

const styleURL = `chrome://quickswitcher/content/style.css?runtime=${Date.now()}`;
export function installStyle(doc, prefs) {
  let link = doc.getElementById("qs-style");
  if (!link) {
    link = element(doc, "link", { id: "qs-style", rel: "stylesheet", href: styleURL });
    (doc.head || doc.documentElement).append(link);
  }
  if (link.href !== styleURL) link.href = styleURL;
  for (const node of doc.querySelectorAll(".qs-root,.qs-native-tools,.qs-native-details,.qs-prefs")) {
    node.setAttribute("lang", locale());
    node.style.setProperty("--qs-font-size", `${prefs.get("fontSize")}px`);
    node.style.setProperty("--qs-highlight", prefs.get("highlightColor"));
    const theme = prefs.get("theme"), inherited = doc.defaultView?.getComputedStyle(doc.documentElement).colorScheme;
    node.dataset.theme = theme === "auto" && ["light", "dark"].includes(inherited) ? inherited : theme;
    node.dataset.density = prefs.get("density");
  }
  return link;
}
