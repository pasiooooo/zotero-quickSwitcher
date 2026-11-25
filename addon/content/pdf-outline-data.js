// SPDX-License-Identifier: AGPL-3.0-or-later
export function flattenOutline(tree, parents = [], indexes = [], result = [], parentKey = null) {
  for (const [index, entry] of (tree || []).entries()) {
    if (!entry || typeof entry.title !== "string" || parents.length > 64 || result.length >= 20000) continue;
    const title = entry.title.replace(/[\x00-\x1F]/g, char => char === "\x00" ? "" : " ").trim(), path = [...indexes, index];
    const outlineKey = path.join(".");
    if (title) result.push({ title, parents, outlineKey, parentKey, depth: parents.length,
      ...(entry.location && Number.isSafeInteger(entry.pageIndex) && entry.pageIndex >= 0 ? { location: entry.location, pageIndex: entry.pageIndex } : {}) });
    flattenOutline(entry.items, title ? [...parents, title] : parents, path, result, title ? outlineKey : parentKey);
  }
  return result;
}

export async function readPDFOutline(pdf) {
  let tree = await pdf.getOutline() || [];
  if (!tree.length && typeof pdf.getOutline2 === "function") tree = await pdf.getOutline2() || [];
  const resolve = async (entries, depth = 0) => {
    const result = [];
    if (depth > 64) return result;
    for (const entry of entries || []) {
      const node = { title: entry.title, items: await resolve(entry.items, depth + 1) };
      try {
        if (entry.dest) {
          const destination = typeof entry.dest === "string" ? await pdf.getDestination(entry.dest) : entry.dest;
          const ref = destination?.[0];
          const pageIndex = Number.isInteger(ref) ? ref : ref && await pdf.getPageIndex(ref);
          if (Number.isSafeInteger(pageIndex) && pageIndex >= 0 && pageIndex < pdf.numPages) {
            node.location = { dest: entry.dest }; node.pageIndex = pageIndex;
          }
        } else if (entry.location) {
          const pageIndex = entry.location.position?.pageIndex ?? entry.location.pageIndex;
          if (Number.isSafeInteger(pageIndex) && pageIndex >= 0 && pageIndex < pdf.numPages) {
            node.location = entry.location; node.pageIndex = pageIndex;
          }
        }
      } catch { /* One invalid destination must not hide the remaining outline. */ }
      result.push(node);
    }
    return result;
  };
  return flattenOutline(await resolve(tree));
}
