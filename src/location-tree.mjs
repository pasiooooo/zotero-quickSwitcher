// SPDX-License-Identifier: AGPL-3.0-or-later
import { matchRanges } from "./core.mjs";

export function locationMatchRanges(node, spec) {
  const ranges = [];
  let filters = spec?.resolvedFilters || spec?.filters || [];
  if (spec?.queryTree) {
    const leaves = [];
    const visit = (tree, negated = false) => {
      if (tree.op === "NOT") visit(tree.children[0], !negated);
      else if (tree.op) tree.children.forEach(child => visit(child, negated));
      else if (tree.filterIndex !== undefined && filters[tree.filterIndex]) leaves.push({ ...filters[tree.filterIndex], negated: !!filters[tree.filterIndex].negated !== negated });
    };
    visit(spec.queryTree); filters = leaves;
  }
  for (const filter of filters) {
    if (filter.type !== "directory" || filter.negated) continue;
    const matches = filter.matches || (filter.ref ? [filter.ref] : []);
    if (!matches.some(match => match.libraryID === node.libraryID && match.kind === node.kind && (node.kind === "library" || match.key === node.key))) continue;
    const partial = /[*?]/u.test(filter.value) ? [] : filter.value.split("›").flatMap(part => matchRanges(node.label, part.trim()));
    ranges.push(...(partial.length ? partial : [{ start: 0, end: node.label.length }]));
  }
  return ranges;
}

export function buildLocationTree(locations) {
  const roots = new Map();
  for (const location of locations) {
    const segments = location.pathSegments || [location.path];
    let children = roots, node;
    for (const [index, label] of segments.entries()) {
      const key = location.pathKeys?.[index] ?? (index ? label : `${location.libraryID}:${label}`);
      if (!children.has(key)) children.set(key, { label, key, libraryID: key === "rss" ? 0 : location.libraryID, kind: key === "rss" ? "feeds" : index === segments.length - 1 && location.kind === "feed" ? "feed" : index ? "collection" : "library", path: segments.slice(0, index + 1).join(" › "), children: new Map(), entries: [] });
      node = children.get(key); children = node.children;
    }
    if (node) node.entries.push(location);
  }
  return roots;
}
