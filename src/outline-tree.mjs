// SPDX-License-Identifier: AGPL-3.0-or-later
const rowKey = row => `${row.attachmentID}:${row.outlineKey}`;
const validRow = row => row && Number.isSafeInteger(row.attachmentID) && row.attachmentID > 0
  && typeof row.title === "string" && row.title.trim() && typeof row.outlineKey === "string" && /^\d+(?:\.\d+)*$/u.test(row.outlineKey);

function compareOutlineKeys(a, b) {
  const left = a.outlineKey.split(".").map(Number), right = b.outlineKey.split(".").map(Number);
  for (let i = 0; i < Math.min(left.length, right.length); i++) if (left[i] !== right[i]) return left[i] - right[i];
  return left.length - right.length || a.outlineKey.localeCompare(b.outlineKey);
}

function parentKey(row, source) {
  if (row.parentKey === null) return null;
  if (typeof row.parentKey === "string") {
    return row.outlineKey.startsWith(row.parentKey + ".") && source.has(`${row.attachmentID}:${row.parentKey}`)
      ? `${row.attachmentID}:${row.parentKey}` : null;
  }
  const parts = row.outlineKey.split(".");
  while (parts.length > 1) {
    parts.pop();
    const key = `${row.attachmentID}:${parts.join(".")}`;
    if (source.has(key)) return key;
  }
  return null;
}

export function currentOutlineRow(rows, reader) {
  const state = reader?._internalReader?._state, stats = state?.[state.primary === false ? "secondaryViewStats" : "primaryViewStats"];
  if (Array.isArray(stats?.outlinePath) && stats.outlinePath.every(index => Number.isSafeInteger(index) && index >= 0)) {
    const path = [...stats.outlinePath];
    while (path.length) {
      const row = rows.find(row => row.outlineKey === path.join("."));
      if (row) return row;
      path.pop();
    }
  }
  if (!Number.isSafeInteger(stats?.pageIndex) || stats.pageIndex < 0) return null;
  return rows.reduce((current, row) => row.location && Number.isSafeInteger(row.pageIndex) && row.pageIndex <= stats.pageIndex
    && (!current || row.pageIndex > current.pageIndex) ? row : current, null);
}

export function buildOutlineTree(matches, { allRows = matches, groupDocuments = false } = {}) {
  const matchedRows = matches.filter(validRow);
  if (!matchedRows.length) return [];
  const matchedKeys = new Set(matchedRows.map(rowKey));
  const attachmentIDs = new Set(matchedRows.map(row => row.attachmentID));
  const source = new Map(allRows.filter(row => validRow(row) && attachmentIDs.has(row.attachmentID)).map(row => [rowKey(row), row]));
  for (const row of matchedRows) if (!source.has(rowKey(row))) source.set(rowKey(row), row);
  const documentOrder = new Map();
  for (const row of source.values()) if (!documentOrder.has(row.attachmentID)) documentOrder.set(row.attachmentID, documentOrder.size);
  const included = new Set();
  for (const row of matchedRows) {
    let key = rowKey(row);
    while (key && !included.has(key)) { included.add(key); key = parentKey(source.get(key), source); }
  }
  const nodes = new Map([...included].map(key => {
    const row = source.get(key);
    return [key, { ...row, key, children: [], isDocument: false, matched: matchedKeys.has(key), depth: Number.isSafeInteger(row.depth) && row.depth >= 0 ? row.depth : row.parents?.length || 0 }];
  }));
  const roots = [];
  for (const node of nodes.values()) {
    const parent = nodes.get(parentKey(node, source));
    if (parent) parent.children.push(node); else roots.push(node);
  }
  for (const node of nodes.values()) node.children.sort(compareOutlineKeys);
  roots.sort((a, b) => documentOrder.get(a.attachmentID) - documentOrder.get(b.attachmentID) || compareOutlineKeys(a, b));
  if (!groupDocuments) return roots;
  const documents = new Map();
  for (const root of roots) {
    if (!documents.has(root.attachmentID)) documents.set(root.attachmentID, { ...root, key: `${root.attachmentID}:document`, kind: "outline", outlineKey: "document",
      title: root.documentTitle || "", parents: [], parentKey: null, location: undefined, pageIndex: undefined, depth: -1, isDocument: true, matched: false, children: [] });
    documents.get(root.attachmentID).children.push(root);
  }
  return [...documents.values()];
}
