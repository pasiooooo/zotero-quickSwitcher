// SPDX-License-Identifier: AGPL-3.0-or-later
import { DEFAULT_PREFIXES } from "./launcher-query.mjs";

function closingParenthesis(value, open) {
  let depth = 0, quoted = false;
  for (let index = open; index < value.length; index++) {
    if (value[index] === "\\") { index++; continue; }
    if (value[index] === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (value[index] === "(") depth++;
    if (value[index] === ")" && !--depth) return index;
  }
  return -1;
}

function literalGuide(value, marker) {
  let quoted = false;
  for (let index = 0; index < marker; index++) {
    if (value[index] === "\\") { if (index + 1 === marker) return true; index++; }
    else if (value[index] === '"') quoted = !quoted;
  }
  return quoted;
}

export function inputScopeBlocks(value, records = [], query = {}) {
  const blocks = [], stack = []; let quoted = false;
  for (let index = 0; index < value.length; index++) {
    if (value[index] === "\\") { index++; continue; }
    if (value[index] === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (value[index] === "(") stack.push(index);
    else if (value[index] === ")" && stack.length) {
      const open = stack.pop(), record = records.find(record => record.open === open && record.close === index), scope = record || query.scopes?.find(scope => scope.open === open && scope.close === index);
      blocks.push({ type: scope?.type || "logic", start: scope?.marker ?? open, end: index + 1, open, close: index, automatic: !!record });
    }
  }
  for (const record of records) if (!blocks.some(block => block.open === record.open)) blocks.push({ ...record, start: record.marker, end: record.close + 1, automatic: true });
  for (const filter of query.filters || []) {
    const start = filter.marker, end = Math.min(value.length, filter.end);
    if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start || literalGuide(value, start)
      || blocks.some(block => block.start === start && block.type === filter.type)) continue;
    blocks.push({ type: filter.type, start, end, markerEnd: start + 1 });
  }
  const addGroups = node => {
    if (!node?.op) return;
    const start = node.start, end = Math.min(value.length, node.end ?? value.length);
    if (node.children.length > 1 && Number.isInteger(start) && end > start && !blocks.some(block => block.start === start && block.end === end)) blocks.push({ type: "logic", start, end });
    for (const child of node.children) addGroups(child);
  };
  addGroups(query.queryTree);
  return blocks.sort((a, b) => a.start - b.start || b.end - a.end);
}

export class InputScopes {
  constructor(value = "", records = []) { this.reset(value, records); }
  reset(value, records = []) {
    this.edit = null;
    this.value = value; this.records = records.filter(record => Object.hasOwn(DEFAULT_PREFIXES, record?.type)
      && Number.isInteger(record.marker) && record.open === record.marker + 1 && !literalGuide(value, record.marker)
      && value[record.open] === "(" && value[record.close] === ")").map(record => ({ ...record }));
  }
  sync(value, prefixes = DEFAULT_PREFIXES) {
    if (value === this.value) return;
    const before = this.value;
    let start = 0, end = before.length, nextEnd = value.length;
    while (start < end && start < nextEnd && before[start] === value[start]) start++;
    while (end > start && nextEnd > start && before[end - 1] === value[nextEnd - 1]) { end--; nextEnd--; }
    const edit = this.edit; this.edit = null;
    if (edit && edit.before === before && value.slice(0, edit.start) === before.slice(0, edit.start)
      && value.slice(edit.end + value.length - before.length) === before.slice(edit.end)) {
      start = edit.start; end = edit.end; nextEnd = end + value.length - before.length;
    }
    const delta = nextEnd - end, mapped = index => index < start ? index : index >= end ? index + delta : start;
    const used = new Set(), scopes = [];
    for (const record of this.records) {
      let marker = mapped(record.marker), open = marker + 1, close = mapped(record.close);
      if (value[close] !== ")") close = value[open] === "(" ? closingParenthesis(value, open) : -1;
      if (!edit) { const balanced = closingParenthesis(value, open); if (balanced >= 0) close = balanced; }
      const body = before.slice(record.open + 1, record.close);
      if (value[marker] !== prefixes[record.type] || close < 0 || used.has(marker) || literalGuide(value, marker)) {
        marker = -1;
        for (let index = 0; index < value.length; index++) {
          if (value[index] !== prefixes[record.type] || value[index + 1] !== "(" || used.has(index) || literalGuide(value, index)) continue;
          const candidateEnd = closingParenthesis(value, index + 1);
          if (candidateEnd >= 0 && value.slice(index + 2, candidateEnd) === body) { marker = index; open = index + 1; close = candidateEnd; break; }
        }
      }
      if (marker >= 0 && close >= 0) { scopes.push({ type: record.type, marker, open, close }); used.add(marker); }
    }
    this.records = scopes.sort((a, b) => a.marker - b.marker); this.value = value;
  }
  beforeEdit(inputType, start, end) {
    if (start === end && inputType === "deleteContentBackward") start = Math.max(0, start - 1);
    if (start === end && inputType === "deleteContentForward") end = Math.min(this.value.length, end + 1);
    this.edit = { before: this.value, start, end };
  }
  add(marker, prefixes = DEFAULT_PREFIXES) {
    const type = Object.keys(prefixes).find(type => prefixes[type] === this.value[marker]);
    const open = marker + 1, close = this.value[open] === "(" ? closingParenthesis(this.value, open) : -1;
    if (!type || close < 0 || literalGuide(this.value, marker)) return;
    this.records = this.records.filter(record => record.marker !== marker);
    this.records.push({ type, marker, open, close }); this.records.sort((a, b) => a.marker - b.marker);
  }
  skipClosing(caret) { return this.records.some(scope => scope.close === caret && closingParenthesis(this.value, scope.open) === caret); }
  leave(caret, query = {}) {
    const block = inputScopeBlocks(this.value, this.records, query)
      .filter(block => Number.isInteger(block.close) && caret > block.open && caret <= block.close)
      .sort((a, b) => a.end - a.start - (b.end - b.start))[0];
    if (!block) return null;
    const space = /\s/u.test(this.value[block.end] || "") ? "" : " ";
    return { value: this.value.slice(0, block.end) + space + this.value.slice(block.end), caret: block.end + 1 };
  }
  guard(inputType, start, end, data = "") {
    const backward = inputType.startsWith("delete") && /Backward/u.test(inputType);
    const forward = inputType.startsWith("delete") && /Forward/u.test(inputType);
    if (start === end) {
      if (!backward && !forward) return null;
      const position = backward ? start - 1 : start;
      const boundary = this.records.find(record => record.open === position || record.close === position);
      if (boundary) return { caret: backward ? position : position + 1 };
      const guide = this.records.find(record => record.marker === position);
      if (guide) {
        this.records = this.records.filter(record => record.marker < guide.marker || record.close > guide.close);
        return { value: this.value.slice(0, guide.marker) + this.value.slice(guide.close + 1), caret: guide.marker };
      }
      const scope = this.records.find(record => start > record.open && start <= record.close);
      if (scope && /Word|Line/u.test(inputType)) {
        const content = backward ? this.value.slice(scope.open + 1, start) : this.value.slice(start, scope.close);
        const size = /Line/u.test(inputType) ? content.length : (backward ? /\s*\S+\s*$/u.exec(content)?.[0].length : /^\s*\S+\s*/u.exec(content)?.[0].length) || 0;
        const begin = backward ? start - size : start, finish = backward ? start : start + size;
        return { value: this.value.slice(0, begin) + this.value.slice(finish), caret: begin };
      }
      if (/Word|Line/u.test(inputType)) {
        const content = backward ? this.value.slice(0, start) : this.value.slice(start);
        const size = /Line/u.test(inputType) ? content.length : (backward ? /\s*\S+\s*$/u.exec(content)?.[0].length : /^\s*\S+\s*/u.exec(content)?.[0].length) || 0;
        if (!size) return null;
        return this.guard(inputType, backward ? start - size : start, backward ? start : start + size, data);
      }
      return null;
    }
    const touched = this.records.filter(record => record.marker < end && record.close >= start);
    if (!touched.some(record => record.open >= start && record.open < end || record.close >= start && record.close < end || record.marker >= start)) return null;
    const removed = new Set(Array.from({ length: end - start }, (_, index) => start + index));
    let insertion = start;
    for (const record of touched) {
      if (record.marker >= start && record.marker < end) {
        for (let index = record.marker; index <= record.close; index++) removed.add(index);
      } else {
        removed.delete(record.open); removed.delete(record.close);
        if (insertion === record.open) insertion++;
      }
    }
    this.records = this.records.filter(record => !(record.marker >= start && record.marker < end));
    const keptBefore = Array.from({ length: insertion }, (_, index) => index).filter(index => !removed.has(index)).length;
    const text = Array.from({ length: this.value.length }, (_, index) => removed.has(index) ? "" : this.value[index]).join("");
    const inserted = inputType.startsWith("insert") && typeof data === "string" ? data : "";
    return { value: text.slice(0, keptBefore) + inserted + text.slice(keptBefore), caret: keptBefore + inserted.length };
  }
}
