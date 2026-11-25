// SPDX-License-Identifier: AGPL-3.0-or-later
export const ALL_FIELDS = Object.freeze({ fields: ["title", "creator", "date", "DOI", "citationKey", "tag", "abstractNote"], sources: { notes: true, annotations: true, fulltext: true } });

export function tokenize(text) {
  const tokens = [];
  let buffer = "", quoted = false;
  for (let i = 0; i < String(text).length; i++) {
    const char = String(text)[i];
    if (char === "\\" && ["\\", '"'].includes(String(text)[i + 1])) buffer += String(text)[++i];
    else if (char === '"') quoted = !quoted;
    else if (/\s/u.test(char) && !quoted) { if (buffer) tokens.push(buffer); buffer = ""; }
    else buffer += char;
  }
  if (quoted) throw new Error("请补全双引号中的短语");
  if (buffer) tokens.push(buffer);
  return tokens;
}

function fold(char) {
  return char.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replaceAll("ß", "ss")
    .replace(/[‘’′]/g, "'").replace(/[“”″]/g, '"').replace(/[‐‑‒–—−]/g, "-");
}

function normalizedMap(input, fulltext = false) {
  const text = String(input ?? "");
  let normalized = "", offset = 0;
  const map = [];
  for (const char of text) {
    let part = fold(char);
    if (fulltext && part === "-") part = " ";
    if (/^\s+$/u.test(part)) part = " ";
    const end = offset + char.length;
    if (!part && map.length) map.at(-1).end = end;
    else if (part === " " && normalized.endsWith(" ")) map.at(-1).end = end;
    else {
      normalized += part;
      for (let j = 0; j < part.length; j++) map.push({ start: offset, end });
    }
    offset = end;
  }
  return { text: normalized, map };
}

export function normalize(text) { return fold(String(text ?? "")).replace(/\s+/gu, " ").trim(); }

export function matchRanges(text, needle, { fulltext = false } = {}) {
  const haystack = normalizedMap(text, fulltext);
  const query = normalizedMap(needle, fulltext).text.trim();
  if (!query) return [];
  const ranges = [];
  let start = 0;
  while ((start = haystack.text.indexOf(query, start)) !== -1) {
    const first = haystack.map[start], last = haystack.map[start + query.length - 1];
    if (first && last) ranges.push({ start: first.start, end: last.end });
    start += Math.max(1, query.length);
  }
  return ranges;
}

export function makeSnippet(text, ranges = [], max = 180) {
  text = String(text ?? "");
  if (text.length <= max) return { text, ranges: ranges.map(r => ({ ...r })) };
  const hit = ranges[0]?.start ?? 0;
  let start = Math.max(0, Math.min(hit - Math.floor(max / 3), text.length - max));
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start])) start--;
  let end = Math.min(text.length, start + max);
  if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end])) end++;
  const prefix = start > 0 ? "…" : "";
  return {
    text: prefix + text.slice(start, end) + (end < text.length ? "…" : ""),
    ranges: ranges.filter(r => r.end > start && r.start < end).map(r => ({
      start: Math.max(r.start, start) - start + prefix.length,
      end: Math.min(r.end, end) - start + prefix.length,
    })),
  };
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Z0-9]{8}$/;

export function validateLayoutRecord(record) {
  if (!record || !/^(u|g\d+)$/.test(record.libraryKey) || !KEY.test(record.searchKey)
    || !Number.isSafeInteger(record.version?.clock) || record.version.clock < 0 || !UUID.test(record.version.deviceID)) return false;
  const p = record.placement;
  return p === null || !!(p && (p.parentCollectionKey === null || KEY.test(p.parentCollectionKey))
    && (p.anchorCollectionKey === null || KEY.test(p.anchorCollectionKey))
    && ["before", "after"].includes(p.anchorSide) && Number.isFinite(p.order));
}

export function compareVersions(a, b) {
  return (a?.clock ?? -1) - (b?.clock ?? -1) || String(a?.deviceID ?? "").localeCompare(String(b?.deviceID ?? ""), "en");
}

export function mergeLayoutRecords(...maps) {
  const merged = {};
  for (const map of maps) {
    if (!map || typeof map !== "object" || Array.isArray(map)) throw new Error("布局记录格式无效");
    for (const [key, record] of Object.entries(map)) {
      if (!validateLayoutRecord(record) || key !== `${record.libraryKey}:${record.searchKey}`) throw new Error("布局记录或稳定标识无效");
      if (!merged[key] || compareVersions(record.version, merged[key].version) > 0) merged[key] = structuredClone(record);
    }
  }
  return merged;
}

export function plainText(value) {
  const text = String(value ?? "");
  if (!/[<&]/.test(text)) return text;
  if (typeof DOMParser !== "undefined") {
    const doc = new DOMParser().parseFromString(text, "text/html");
    doc.querySelectorAll("script,style").forEach(n => n.remove());
    return doc.body?.textContent || "";
  }
  return text.replace(/<[^>]*>/g, " ").replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, v => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " " })[v]);
}

export function libraryKey(libraryID) {
  const lib = Zotero.Libraries.get(libraryID);
  return lib.libraryType === "group" ? `g${Zotero.Groups.getByLibraryID(libraryID).groupID}` : lib.libraryType === "feed" ? `f${libraryID}` : "u";
}

export const switchTerms = value => normalize(value).trim().split(/\s+/u).filter(Boolean);
export const switchMatches = (value, query) => switchTerms(query).every(term => normalize(value).includes(term));

export async function loadedItems(ids, types = ["itemData", "creators", "tags"]) {
  const items = (await Zotero.Items.getAsync(ids)).filter(Boolean);
  if (Zotero.Items.loadDataTypes && items.length) await Zotero.Items.loadDataTypes(items, types);
  return items;
}

export async function topItem(item) {
  if (typeof item === "number") item = await Zotero.Items.getAsync(item);
  const visited = new Set();
  while (item?.parentID) {
    if (visited.has(item.id)) throw new Error("条目父链循环");
    visited.add(item.id);
    const parent = await Zotero.Items.getAsync(item.parentID);
    if (!parent) throw new Error("父条目尚未加载");
    item = parent;
  }
  if (!item) throw new Error("条目不存在");
  return item;
}
