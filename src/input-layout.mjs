// SPDX-License-Identifier: AGPL-3.0-or-later

export function measureInputMarkers(prefixes, font, context) {
  const previousFont = context.font, widths = new Map(), padding = 8;
  context.font = font;
  try {
    for (const marker of new Set([...Object.values(prefixes), "@"])) {
      if (typeof marker !== "string" || !marker) continue;
      const width = context.measureText(marker).width;
      if (!Number.isFinite(width) || width < 0) throw new RangeError("Invalid input marker width");
      widths.set(marker, width);
    }
    return { width: Math.max(...widths.values()) + padding, padding, widths };
  } finally { context.font = previousFont; }
}

export function inputMarkerLayout(value, scopes, metrics) {
  const layout = [], used = new Set();
  for (const scope of scopes) {
    const start = scope.start;
    if (scope.type === "logic" || !Number.isInteger(start) || start < 0 || start >= value.length
      || used.has(start) || !Number.isInteger(scope.markerEnd) && !(scope.open > start)) continue;
    const marker = String.fromCodePoint(value.codePointAt(start)), end = start + marker.length;
    const naturalWidth = metrics.widths.get(marker);
    if (naturalWidth === undefined) continue;
    layout.push({ start, end, marker, naturalWidth, width: metrics.width, delta: metrics.width - naturalWidth });
    used.add(start);
  }
  return layout.sort((a, b) => a.start - b.start);
}

export function markerDeltaAt(layout, index) {
  return layout.reduce((delta, marker) => delta + (marker.end <= index ? marker.delta : 0), 0);
}

export function inputWordRange(value, index) {
  if (!Number.isInteger(index) || index < 0 || index > value.length) return null;
  if (!value.length) return { start: 0, end: 0 };
  // Boundaries select the block to their right; the input end selects its last block.
  const position = Math.min(index, value.length - 1);
  for (const match of value.matchAll(/[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu)) {
    const start = match.index, end = start + match[0].length;
    if (position < end) return { start, end };
  }
  return null;
}

export function sourceSpanAt(textRoot, index) {
  if (!Number.isInteger(index) || index < 0) return null;
  const walker = textRoot.ownerDocument.createTreeWalker(textRoot, 4);
  let node = textRoot.nodeType === 3 ? textRoot : walker.nextNode(), last = null, offset = index;
  while (node) {
    const length = node.textContent.length;
    // A boundary uses the next text node, so marker padding is behind the caret.
    if (offset < length) return { node, offset };
    offset -= length; last = node; node = walker.nextNode();
  }
  return last && offset === 0 ? { node: last, offset: last.textContent.length } : null;
}
