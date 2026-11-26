// SPDX-License-Identifier: AGPL-3.0-or-later
export const PRE_TAG_PREFIXES = Object.freeze({ author: "@", directory: "/", year: ":", venue: "!", type: "%", current: ">", outline: "'", fulltext: " ", tabs: ";" });
export const DEFAULT_PREFIXES = Object.freeze({ ...PRE_TAG_PREFIXES, tag: "#" });
export const PRIOR_PREFIXES = Object.freeze({ ...PRE_TAG_PREFIXES, directory: "#", tabs: "\t" });
export const LEGACY_PREFIXES = Object.freeze(Object.fromEntries(Object.entries(PRIOR_PREFIXES).filter(([type]) => type !== "outline").map(([type, value]) => [type, type === "current" ? "'" : value])));
export function parseSwitchInput(value, mode) { return { mode, kind: "switch", text: String(value) }; }
export function availablePrefix(preferred, used) {
  return [preferred, "›", "`", "~", "^", "&", ";", "=", "§", ",", "|", "+", "."].find(marker => !used.includes(marker));
}
const modes = { author: "authors", directory: "directories", year: "years", venue: "venues", type: "types", tag: "tags", outline: "outline", tabs: "tabs" };
function escapeAt(value, index, prefixes) {
  const char = value[index + 1];
  return value[index] === "\\" && (/[\\"()]/.test(char || "") || Object.values(DEFAULT_PREFIXES).includes(char)
    || Object.values(prefixes).includes(char) || prefixes.current === "'" && char === "‘") ? char : null;
}
function literalEscape(char, quoted) {
  return char === "\\" || char === '"' ? "\\" + char : quoted ? char : `"${char}"`;
}
function literalInput(value, prefixes, tokenInput = true) {
  let result = "", quoted = false;
  for (let index = 0; index < value.length; index++) {
    const escaped = escapeAt(value, index, prefixes);
    if (escaped !== null) { result += tokenInput ? literalEscape(escaped, quoted) : escaped; index++; }
    else { result += value[index]; if (value[index] === '"') quoted = !quoted; }
  }
  return result;
}
function hasUnescapedGuide(value, prefixes) {
  for (let index = 0; index < value.length; index++) {
    if (escapeAt(value, index, prefixes) !== null) { index++; continue; }
    if (value[index] !== " " && Object.values(prefixes).includes(value[index])) return true;
  }
  return false;
}
function syntax(prefixes) {
  const result = { ...PRE_TAG_PREFIXES, ...prefixes };
  if (!Object.hasOwn(prefixes, "outline")) result.outline = availablePrefix(DEFAULT_PREFIXES.outline, Object.entries(result).filter(([type]) => type !== "outline").map(([, value]) => value));
  return Object.values(result).some(value => typeof value !== "string" || value.length !== 1) || new Set(Object.values(result)).size !== Object.keys(result).length ? DEFAULT_PREFIXES : result;
}
function followsClosingGroup(value, index) {
  if (value[index - 1] !== ")") return false;
  let escapes = 0;
  for (let before = index - 2; value[before] === "\\"; before--) escapes++;
  return escapes % 2 === 0;
}
function markerType(value, index, prefixes) {
  const char = value[index];
  if (!char) return undefined;
  const type = Object.keys(modes).find(type => prefixes[type] === char);
  if (type && /[\p{L}\p{N}]/u.test(char)) return value[index + 1] === "(" ? type : undefined;
  if (type === "author" || type === "directory" && char !== "/") return type;
  const boundary = value[index + 1] === "(" || index === 0 || /[\s(]/u.test(value[index - 1]) || followsClosingGroup(value, index)
    || value[index - 1] === "-" && (index === 1 || /[\s(]/u.test(value[index - 2]) || followsClosingGroup(value, index - 1));
  return boundary ? type : undefined;
}
function readValue(value, start, quoted = false, prefixes = DEFAULT_PREFIXES) {
  let text = "", end = start;
  for (; end < value.length; end++) {
    const char = value[end];
    const escaped = escapeAt(value, end, prefixes);
    if (escaped !== null) { text += escaped; end++; continue; }
    if (quoted ? char === '"' : /\s/u.test(char) || markerType(value, end, prefixes) || char === "-" && markerType(value, end + 1, prefixes)) break;
    text += char;
  }
  return { text, end: quoted && value[end] === '"' ? end + 1 : end };
}

export function parseLauncherInput(value, mode = "items", caret = value.length, prefixes = DEFAULT_PREFIXES) {
  value = String(value);
  prefixes = syntax(prefixes);
  if (mode === "tabs") {
    if (structuredInput(value, prefixes)) return { ...parseStructuredInput(value, mode, caret, prefixes, { literalGuides: true }), mode, kind: "tabs" };
    return { mode, kind: "tabs", text: literalInput(value, prefixes).trim() };
  }
  const outline = mode === "outline" && !hasOutlineScope(value, prefixes);
  if (mode === "directories") return { mode, kind: "directories", text: literalInput(value.startsWith(prefixes.directory) ? value.slice(1) : value, prefixes).trim() };
  const current = !outline && (value.startsWith(prefixes.current) || prefixes.current === "'" && value.startsWith("‘"));
  const fulltext = !outline && !current && value.startsWith(prefixes.fulltext);
  if (structuredInput(value, prefixes)) return parseStructuredInput(value, mode, caret, prefixes, { outline, current, fulltext });
  const parts = [], filters = [];
  let index = outline && value.startsWith(prefixes.outline) || current || fulltext ? 1 : 0, buffer = "", start = index;
  const flush = () => { if (buffer) parts.push({ raw: buffer, start, end: index }); buffer = ""; };
  while (index < value.length) {
    const char = value[index];
    const escaped = escapeAt(value, index, prefixes);
    if (escaped !== null) {
      if (!buffer) start = index;
      // Keep one tokenizer escape layer for literal backslashes and double quotes.
      buffer += literalEscape(escaped, false); index += 2; continue;
    }
    if (char === '"') {
      if (!buffer) start = index;
      const quoted = readValue(value, index + 1, true, prefixes);
      buffer += literalInput(value.slice(index, quoted.end), prefixes); index = quoted.end; continue;
    }
    const negated = char === "-" && !!markerType(value, index + 1, prefixes);
    if (markerType(value, index, prefixes) || negated) {
      flush(); const begin = index, marker = negated ? ++index : index;
      const type = markerType(value, index++, prefixes);
      const quoted = value[index] === '"', bodyStart = quoted ? ++index : index;
      const body = readValue(value, index, quoted, prefixes); index = body.end;
      const filter = { type, value: body.text, negated, join: "and", start: begin, end: index, marker, bodyStart, quoted };
      filters.push(filter); parts.push({ filter }); continue;
    }
    if (/\s/u.test(char)) { flush(); index++; continue; }
    if (!buffer) start = index;
    buffer += char; index++;
  }
  flush();
  const words = [];
  for (const [i, part] of parts.entries()) {
    if (part.filter) continue;
    if (part.raw.toUpperCase() === "OR" && parts[i - 1]?.filter && parts[i + 1]?.filter) parts[i + 1].filter.join = "or";
    else words.push(part.raw);
  }
  const text = words.join(" ");
  let activeFilter = filters.find(filter => caret > filter.marker && caret <= filter.end);
  // An unfinished name may contain spaces while choosing a suggestion; Enter quotes the chosen name.
  if (!activeFilter && caret === value.length && value.trimEnd() === value && filters.length) {
    const last = filters.at(-1), tail = value.slice(last.end);
    if (last.type !== "year" && !last.quoted && !/[*?]/.test(last.value) && tail.trim() && !/\bOR\b/i.test(tail) && !hasUnescapedGuide(tail, prefixes)) {
      activeFilter = { ...last, end: value.length, value: literalInput(value.slice(last.bodyStart), prefixes, false).trim() };
    }
  }
  if (activeFilter && caret < activeFilter.end) activeFilter = { ...activeFilter, value: readValue(value.slice(0, caret), activeFilter.bodyStart, activeFilter.quoted, prefixes).text };
  const kind = outline ? "outline" : current ? "scoped" : fulltext ? "fulltext" : text || filters.length ? "global" : "recent";
  const result = { mode: outline ? "outline" : "items", kind, text, ...(filters.length ? { filters, ...(outline ? { outline: true } : {}) } : {}), ...(current ? { current: true } : {}) };
  if (filters.some(filter => filter.type === "outline")) result.scopedOutline = true;
  if (filters.some(filter => filter.type === "tabs")) result.scopedTabs = true;
  if (filters.some(filter => filter.quoted && value[filter.end - 1] !== '"')) Object.assign(result, { complete: false, error: "请补全双引号中的短语" });
  else if (filters.some(filter => !filter.value)) Object.assign(result, { complete: false, error: "请补全字段条件" });
  if (activeFilter) Object.assign(result, { mode: modes[activeFilter.type], ...(!outline ? { kind: modes[activeFilter.type] } : {}), activeFilter });
  return result;
}

export function replaceLauncherFilter(value, filter, label, prefixes = DEFAULT_PREFIXES) {
  const name = JSON.stringify(label);
  if (filter.replaceStart !== undefined) {
    const replacement = value.slice(0, filter.replaceStart) + name + value.slice(filter.replaceEnd);
    let caret = filter.replaceStart + name.length;
    while (replacement[caret] === ")") caret++;
    const space = !replacement[caret] || !/\s/u.test(replacement[caret]);
    return { value: replacement.slice(0, caret) + (space ? " " : "") + replacement.slice(caret), caret: caret + (space ? 1 : 0) };
  }
  const prefix = value.slice(0, filter.start), separator = prefix && !/\s$/u.test(prefix) ? " " : "";
  const replacement = `${filter.negated ? "-" : ""}${syntax(prefixes)[filter.type]}${name} `;
  const caret = prefix.length + separator.length + replacement.length;
  return { value: prefix + separator + replacement + value.slice(filter.end).trimStart(), caret };
}

function structuredInput(value, prefixes) {
  let quoted = false, guides = false, boolean = false;
  for (let index = 0; index < value.length; index++) {
    if (escapeAt(value, index, prefixes) !== null) { index++; continue; }
    if (value[index] === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    const guide = markerType(value, index, prefixes);
    if (guide) guides = true;
    if (value[index] === "(" && (!guide || value[index + 1] === "(")) return true;
    if (value[index] === ")" && !guide) return true;
    if ((index === 0 || /\s|[()]/u.test(value[index - 1])) && /^(?:AND|NOT)(?=\s|[()]|$)/iu.test(value.slice(index))) return true;
    if ((index === 0 || /\s/u.test(value[index - 1])) && /^OR(?=\s)/iu.test(value.slice(index)) && value.slice(0, index).trim() && value.slice(index + 2).trim()) boolean = true;
  }
  return boolean && !guides;
}

function hasOutlineScope(value, prefixes) {
  let quoted = false;
  for (let index = 0; index < value.length; index++) {
    if (escapeAt(value, index, prefixes) !== null) { index++; continue; }
    if (value[index] === '"') quoted = !quoted;
    else if (!quoted && value[index] === prefixes.outline && value[index + 1] === "(") return true;
  }
  return false;
}

function parseStructuredInput(value, mode, caret, prefixes, { outline, current, fulltext, literalGuides = false, offset }) {
  const filters = [], words = [], scopes = [];
  let index = offset ?? (outline && value.startsWith(prefixes.outline) || current || fulltext ? 1 : 0), error = "", depth = 0;
  const guideAt = index => literalGuides ? undefined : markerType(value, index, prefixes);
  const fail = message => { error ||= message; };
  const skip = () => { while (/\s/u.test(value[index] || "") && index < value.length) index++; };
  const operator = () => {
    const match = /^(AND|OR|NOT)(?=\s|[()]|$)/iu.exec(value.slice(index));
    return match?.[1].toUpperCase();
  };
  const group = (op, children, start, end) => children.length === 1 ? children[0] : { op, children, start, end };
  const quote = () => {
    const start = index++, bodyStart = index; let text = "";
    while (index < value.length && value[index] !== '"') {
      const escaped = escapeAt(value, index, prefixes);
      if (escaped !== null) { text += escaped; index += 2; }
      else text += value[index++];
    }
    const bodyEnd = index;
    if (value[index] === '"') index++; else fail("请补全双引号中的短语");
    return { text, start, end: index, bodyStart, bodyEnd };
  };
  const primary = (field, endAtParen) => {
    skip(); const start = index;
    if (index >= value.length || endAtParen && value[index] === ")") { if (field?.type !== "outline") fail("请补全括号中的条件"); return null; }
    if (["AND", "OR"].includes(operator())) { fail("请补全布尔运算符两侧的条件"); index += operator().length; return null; }
    if (operator() === "NOT") { index += 3; const child = primary(field, endAtParen); return child && { op: "NOT", children: [child], start, end: index }; }
    let negated = false, marker = index;
    if (value[index] === "-" && guideAt(index + 1)) { negated = true; marker = ++index; }
    const type = guideAt(index);
    let ownField = field;
    if (type) { index++; ownField = { type, marker, start, negated }; }
    if (value[index] === "(" && (!type || ownField)) {
      if (++depth > 32) { fail("检索式嵌套过深"); index = value.length; return null; }
      index++; const open = index - 1;
      let node = expression(ownField, true);
      skip();
      if (value[index] === ")") index++; else fail("请补全检索式中的括号");
      depth--;
      const close = index - 1;
      if (ownField) scopes.push({ type: ownField.type, marker: ownField.marker, open, close, start: ownField.start, end: index });
      if (!node && ownField) {
        const number = filters.length;
        filters.push({ ...ownField, value: "", join: "and", end: index, bodyStart: open + 1, bodyEnd: Math.max(open + 1, close), quoted: false, replaceStart: open + 1, replaceEnd: Math.max(open + 1, close) });
        node = { filterIndex: number, start, end: index };
      }
      if (!node) fail("请补全括号中的条件");
      return type && negated && node ? { op: "NOT", children: [node], start, end: index } : node;
    }
    if (ownField) {
      const bodyStart = index; let text = "", quoted = false, contentStart = index, contentEnd;
      if (value[index] === '"') { const part = quote(); text = part.text; quoted = true; contentStart = part.bodyStart; contentEnd = part.bodyEnd; }
      else {
        while (index < value.length && value[index] !== ")" && value[index] !== "(") {
          const escaped = escapeAt(value, index, prefixes);
          if (escaped !== null) { text += escaped; index += 2; continue; }
          if (markerType(value, index, prefixes) || value[index] === "-" && markerType(value, index + 1, prefixes)) break;
          if (/\s/u.test(value[index])) {
            if (!field) break;
            const saved = index; skip();
            if (operator() || value[index] === ")" || index >= value.length || markerType(value, index, prefixes)) { index = saved; break; }
            text += value.slice(saved, index); continue;
          }
          text += value[index++];
        }
        text = text.trim(); contentEnd = index;
      }
      const number = filters.length, inherited = !type;
      filters.push({ type: ownField.type, value: text, negated: type ? negated : false, join: "and", start: type ? start : bodyStart, end: index,
        marker: ownField.marker, bodyStart: contentStart, bodyEnd: contentEnd, quoted,
        ...((inherited || field) ? { replaceStart: bodyStart, replaceEnd: index } : {}) });
      if (!text) fail("请补全字段条件");
      return { filterIndex: number, start, end: index };
    }
    let text = "", quoted = false;
    if (value[index] === '"') { text = quote().text; quoted = true; }
    else while (index < value.length && !/\s|[()]/u.test(value[index])) {
      const escaped = escapeAt(value, index, prefixes);
      if (escaped !== null) { text += escaped; index += 2; continue; }
      if (guideAt(index)) break;
      text += value[index++];
    }
    if (!text) { fail("检索式结构无效"); if (index === start) index++; return null; }
    words.push(JSON.stringify(text)); return { text, quoted, start, end: index };
  };
  const conjunction = (field, endAtParen) => {
    const start = index, children = []; let node = primary(field, endAtParen); if (node) children.push(node);
    while (index < value.length) {
      skip();
      if (index >= value.length || endAtParen && value[index] === ")" || operator() === "OR") break;
      if (operator() === "AND") { index += 3; skip(); }
      const before = index; node = primary(field, endAtParen); if (node) children.push(node);
      if (index === before) { fail("检索式结构无效"); break; }
    }
    return children.length ? group("AND", children, start, index) : null;
  };
  const expression = (field, endAtParen) => {
    const start = index, children = []; let node = conjunction(field, endAtParen); if (node) children.push(node);
    skip();
    while (operator() === "OR") {
      index += 2; skip(); const firstFilter = filters.length;
      node = conjunction(field, endAtParen); if (node) children.push(node);
      if (filters[firstFilter]) filters[firstFilter].join = "or";
      skip();
    }
    return children.length ? group("OR", children, start, index) : null;
  };
  const tree = expression(null, false); skip();
  if (index < value.length || !tree) fail("检索式结构无效");
  let activeFilter = filters.find(filter => caret >= filter.bodyStart && caret <= (filter.bodyEnd ?? filter.end));
  if (!activeFilter && scopes.length) {
    const scope = scopes.filter(s => caret > s.open && caret <= s.close)
      .sort((a, b) => (b.open - a.open) || (a.close - b.close))[0];
    if (scope) {
      const scopeFilters = filters.filter(f => f.marker === scope.marker);
      if (scopeFilters.length) {
        const before = scopeFilters.filter(f => (f.bodyEnd ?? f.end) <= caret).at(-1);
        const after = scopeFilters.filter(f => f.bodyStart >= caret)[0];
        if (before && after) {
          activeFilter = (after.bodyStart - caret <= caret - (before.bodyEnd ?? before.end))
            ? { ...after, value: "" }
            : before;
        } else if (before) {
          activeFilter = before;
        } else if (after) {
          activeFilter = { ...after, value: "" };
        }
      }
    }
  }
  if (activeFilter && caret >= activeFilter.bodyStart && caret < activeFilter.bodyEnd) {
    const fragment = value.slice(activeFilter.bodyStart, caret);
    activeFilter = { ...activeFilter, value: literalInput(fragment, prefixes, false) };
  }
  const text = words.join(" "), kind = outline ? "outline" : current ? "scoped" : fulltext ? "fulltext" : "global";
  const result = { mode: outline ? "outline" : "items", kind, text, queryTree: tree, ...(scopes.length ? { scopes } : {}), ...(filters.length ? { filters, ...(outline ? { outline: true } : {}) } : {}),
    ...(current ? { current: true } : {}), ...(error ? { complete: false, error } : {}) };
  if (filters.some(filter => filter.type === "outline")) result.scopedOutline = true;
  if (filters.some(filter => filter.type === "tabs")) result.scopedTabs = true;
  if (activeFilter) Object.assign(result, { mode: modes[activeFilter.type], ...(!outline ? { kind: modes[activeFilter.type] } : {}), activeFilter });
  return result;
}

export function pairLauncherInput(value, caret, inputType, prefixes = DEFAULT_PREFIXES, data = value[caret - 1]) {
  if (inputType !== "insertText" || !Number.isInteger(caret) || caret < 1 || data !== value[caret - 1]) return null;
  prefixes = syntax(prefixes); const marker = caret - 1;
  const scope = value[marker] === prefixes.outline || marker === 0 && [prefixes.current, prefixes.fulltext, prefixes.tabs].includes(value[marker]);
  if ((!markerType(value, marker, prefixes) && !scope) || value[caret] === "(") return null;
  let quoted = false;
  for (let index = 0; index < marker; index++) {
    if (escapeAt(value, index, prefixes) !== null) { if (index + 1 === marker) return null; index++; }
    else if (value[index] === '"') quoted = !quoted;
  }
  return quoted ? null : { value: value.slice(0, caret) + "()" + value.slice(caret), caret: caret + 1 };
}

export function removeLauncherFilter(value, filter, prefixes = DEFAULT_PREFIXES) {
  const query = parseLauncherInput(value, "items", -1, prefixes);
  if (!query.queryTree) return null;
  const target = query.filters?.findIndex(entry => entry.start === filter.start);
  const literals = new Set(['\\', '"', "(", ")", ...Object.values(prefixes).filter(marker => !/\s/u.test(marker))]);
  const encode = (text, quoted) => quoted ? JSON.stringify(text) : [...text].map(char => literals.has(char) ? "\\" + char : char).join("");
  const serialize = node => {
    if (Object.hasOwn(node, "filterIndex")) {
      if (node.filterIndex === target) return "";
      const entry = query.filters[node.filterIndex];
      const text = encode(entry.value, entry.quoted);
      return `${entry.negated ? "-" : ""}${prefixes[entry.type] || DEFAULT_PREFIXES[entry.type]}(${text})`;
    }
    if (node.text !== undefined) return encode(node.text, node.quoted);
    const children = node.children.map(serialize).filter(Boolean);
    return !children.length ? "" : node.op === "NOT" ? `NOT (${children[0]})` : children.length === 1 ? children[0] : `(${children.join(` ${node.op} `)})`;
  };
  const text = query.queryTree ? serialize(query.queryTree) : "";
  const prefix = query.current || query.kind === "outline" && value.startsWith(prefixes.outline || DEFAULT_PREFIXES.outline) || query.kind === "fulltext" ? value[0] : "";
  return { value: prefix + text + (text ? " " : ""), caret: prefix.length + text.length + (text ? 1 : 0) };
}

export function migrateLauncherPrefixes(value, before, after) {
  const query = parseLauncherInput(value, "items", -1, before), replacements = [...new Map((query.filters || []).map(filter => [filter.marker, after[filter.type]])).entries()];
  if (query.current) replacements.push([0, after.current]);
  else if (query.kind === "outline" && value.startsWith(before.outline)) replacements.push([0, after.outline]);
  else if (value.startsWith(before.tabs)) replacements.push([0, after.tabs]);
  else if (value.startsWith(before.fulltext)) replacements.push([0, after.fulltext]);
  const newTag = !before.tag && !Object.values(before).includes(after.tag) && after.tag;
  let quoted = false;
  for (let index = 0; index < value.length; index++) {
    const escaped = escapeAt(value, index, before);
    if (escaped !== null) {
      if (escapeAt("\\" + escaped, 0, after) === null) replacements.push([index, ""]);
      index++;
    } else if (value[index] === '"') quoted = !quoted;
    else if (!quoted && value[index] === newTag && markerType(value, index, after) === "tag") replacements.push([index, "\\" + newTag]);
  }
  for (const [index, marker] of replacements.sort((a, b) => b[0] - a[0])) value = value.slice(0, index) + marker + value.slice(index + 1);
  return value;
}
