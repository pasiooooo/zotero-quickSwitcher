// SPDX-License-Identifier: AGPL-3.0-or-later
import { tokenize } from "./core.mjs";
import { t } from "./i18n.mjs";

const unique = values => [...new Set(values.filter(Boolean))];
const valueText = value => /\s|[()"=]|^(AND|OR|NOT|NEAR|SAME)$/iu.test(value) ? `"${value.replace(/[\r\n]+/gu, " ")}"` : value;
const clause = (tag, values, extra = {}) => ({ tag, values: unique(values.map(String)), unsafeQuote: values.some(value => String(value).includes('"')), ...extra });
const group = (op, children) => children.length === 1 ? children[0] : { op, children };

function filterNode(filter, resolved) {
  const matches = resolved?.matches || [], title = filter.ref?.title || filter.value;
  if (filter.type === "outline") return clause("ZOTERO_OUTLINE_TEXT", [title || "*"], { local: true, filter, negated: filter.negated });
  if (filter.type === "tabs") return clause("ZOTERO_TABS", [title || t("已打开标签页")], { local: true, filter, negated: filter.negated });
  if (filter.type === "directory") return clause("ZOTERO_DIR", [title], { local: true, filter, negated: filter.negated });
  if (filter.type === "type") return clause("ZOTERO_TYPE", [title], { local: true, filter, negated: filter.negated });
  if (filter.type === "tag") return clause("ZOTERO_TAG", [title], { local: true, filter, negated: filter.negated });
  if (filter.type === "year") {
    const years = /^\d{4}$/u.test(title) ? [title] : unique(matches.map(match => match.value).filter(value => /^\d{4}$/u.test(value)));
    return clause("PY", years.length ? years : [title], { valid: !!years.length, filter, negated: filter.negated });
  }
  if (filter.type === "author") {
    if (resolved?.allAuthors) return clause("ZOTERO_AUTHOR", [t("存在作者")], { local: true, filter, negated: filter.negated });
    const names = matches.length && matches.length <= 30 ? unique(matches.map(match => match.fieldMode === 0 && match.lastName ? [match.lastName, match.firstName].filter(Boolean).join(" ") : match.name)) : [title];
    return clause("AU", names, { filter, negated: filter.negated });
  }
  const field = filter.ref?.field;
  const nodes = (field ? [field] : ["publicationTitle", "publisher"]).map(field => clause(field === "publisher" ? "PUBL" : "SO", [title], { filter }));
  const result = group("OR", nodes); return { ...result, filter, negated: filter.negated };
}

export function expressionText(node, withNegation = true) {
  if (!node) return "";
  let text;
  if (node.tag) text = `${node.tag}=(${node.raw ? node.values.join(" AND ") : node.values.map(value => node.exact ? `"${value}"` : valueText(value)).join(" OR ")})`;
  else if (node.op === "NOT") text = `NOT (${expressionText(node.children[0], false)})`;
  else if (node.op === "AND") {
    const positive = node.children.filter(child => !child.negated), negative = node.children.filter(child => child.negated);
    text = positive.map(child => expressionText(child)).join(" AND ");
    for (const child of negative) text += `${text ? " NOT " : "NOT "}${expressionText(child, false)}`;
  } else text = node.children.map(child => expressionText(child)).join(" OR ");
  if (node.op && node.children.length > 1) text = `(${text})`;
  return withNegation && node.negated ? `NOT ${text}` : text;
}

export function localExpressionText(node, withNegation = true) {
  if (!node) return "";
  if (node.tag && !node.local) return expressionText(node, withNegation);
  if (node.tag) {
    const values = node.values.join(" OR "), names = { ZOTERO_OUTLINE: "PDF", ZOTERO_OUTLINE_TEXT: "大纲", ZOTERO_TYPE: "条目类型", ZOTERO_TABS: "标签页", ZOTERO_AUTHOR: "作者", ZOTERO_CITEKEY: "引用键", ZOTERO_TAG: "标签", ZOTERO_NOTE: "笔记" };
    const text = node.tag === "ZOTERO_DIR" || node.tag === "ZOTERO_SCOPE" || node.tag === "ZOTERO_RECENT" || node.tag === "ZOTERO_TEXT" || node.tag === "ZOTERO_FULLTEXT" ? values : `${t(names[node.tag] || "本地条件")} · ${values}`;
    return withNegation && node.negated ? `NOT ${text}` : text;
  }
  const text = node.op === "NOT" ? `NOT ${localExpressionText(node.children[0], false)}` : node.children.map(child => localExpressionText(child)).join(` ${node.op} `);
  return node.children.length > 1 ? `(${text})` : text;
}

function portable(node) {
  if (!node) return null;
  if (node.tag) return node.local ? null : node;
  const children = node.children.map(portable).filter(Boolean);
  if (!children.length) return null;
  if (node.op === "NOT") return { op: "NOT", children };
  return node.negated ? { ...group(node.op, children), negated: true } : group(node.op, children);
}
function portableNegation(tree) {
  const startsNegative = node => !!node.negated || node.op === "NOT" || !node.tag
    && (node.op === "AND" ? node.children.every(startsNegative) : node.children.some(startsNegative));
  const needsBranches = node => !node.tag && (node.op === "OR" && node.children.some(startsNegative)
    || node.op === "AND" && node.children.every(startsNegative) || node.children.some(needsBranches));
  if (!tree || !needsBranches(tree)) return tree;
  // WoS NOT needs a positive left operand; distribute only groups that would start with NOT.
  const branches = (node, inverse = false) => {
    inverse = !!node.negated !== inverse;
    if (node.tag) return [[{ ...node, negated: inverse }]];
    if (node.op === "NOT") return branches(node.children[0], !inverse);
    const op = inverse ? node.op === "AND" ? "OR" : "AND" : node.op;
    let result = op === "AND" ? [[]] : [];
    for (const child of node.children) {
      const next = branches(child, inverse);
      if ((op === "AND" ? result.length * next.length : result.length + next.length) > 128) throw new Error("检索式组合过多，无法安全复制 WoS 条件");
      result = op === "AND" ? result.flatMap(left => next.map(right => [...left, ...right])) : [...result, ...next];
    }
    return result;
  };
  return group("OR", branches(tree).map(values => group("AND", values)));
}
function validate(node, parentPositive = false, parentNonYear = false) {
  if (!node) return "没有可复制的 WoS 条件";
  if (node.tag) {
    if (!node.values.length || node.values.some(value => !value.trim()) || node.valid === false) return "请先完成字段条件";
    if (node.unsafeQuote) return "WoS 不支持安全复制包含双引号的字面值";
    if (!["TS", "TI", "AU", "ED", "PY", "SO", "PUBL", "AB", "DO"].includes(node.tag)) return "此字段没有 WoS 高级检索标签";
    for (const value of node.values) {
      if (node.tag === "PY" && !/^\d{4}(?:-\d{4})?$/u.test(value)) return "WoS 年份必须为四位年份或年份范围";
      if (node.exact && /[*?$]/u.test(value)) return "WoS 无法按字面值检索通配符";
      if (/[*?$]/u.test(value)) {
        if (!/[a-z0-9]/iu.test(value)) return "请先完成字段条件";
        if (/[^\x20-\x7e]/u.test(value) || /[/@#.,:;!][*?$]/u.test(value)) return "该通配符位置不符合 WoS 规范";
        if (["AU", "ED"].includes(node.tag) && /^[*?$]/u.test(value)) return "WoS 作者不支持左侧通配符";
        if (["AU", "ED"].includes(node.tag) && !/^[^*?$]{2}/u.test(value)) return "WoS 作者通配符需要至少两个字符";
        if (["TS", "TI", "AB"].includes(node.tag) && value.split(/\s+/u).some(word => /[*?$]/u.test(word) && !/[a-z0-9]{3}/iu.test(word))) return "WoS 主题通配符需要至少三个连续字符";
      }
    }
    if (node.negated && !parentPositive) return "WoS 排除条件需要搭配肯定查询";
    if (node.tag === "PY" && !parentNonYear) return "WoS 年份条件需要搭配主题、作者或出版来源";
    return "";
  }
  const positive = node.op === "AND" && node.children.some(child => child.op !== "NOT" && !child.negated);
  const nonYear = node.op === "AND" && node.children.some(function nonYear(child) { return child.tag ? child.tag !== "PY" : child.children.some(nonYear); });
  if (node.negated && !parentPositive) return "WoS 排除条件需要搭配肯定查询";
  if (node.op === "NOT" && !parentPositive) return "WoS 排除条件需要搭配肯定查询";
  for (const child of node.children) {
    const error = validate(child, parentPositive || positive, parentNonYear || nonYear);
    if (error) return error;
  }
  return "";
}

function queryNode(node, filters, outline = false, negated = false, textTag = "TS") {
  if (node.filterIndex !== undefined) {
    const filter = filters[node.filterIndex];
    return filter ? filterNode({ ...filter, negated: !!filter.negated !== negated }, filter.resolved) : null;
  }
  if (typeof node.text === "string") return clause(outline ? "ZOTERO_OUTLINE_TEXT" : textTag, [node.text], {
    exact: !!node.quoted, unsafeQuote: node.text.includes('"'), local: outline || textTag.startsWith("ZOTERO_"), negated,
  });
  if (node.op === "NOT") return queryNode(node.children?.[0], filters, outline, !negated, textTag);
  if (node.op === "AND" || node.op === "OR") {
    const children = (node.children || []).map(child => queryNode(child, filters, outline, false, textTag)).filter(Boolean);
    return children.length ? { ...group(node.op, children), ...(negated ? { negated: true } : {}) } : null;
  }
  return null;
}

function topicTree(text, tag = "TS") {
  const quoted = new Set([...String(text).matchAll(/"((?:\\.|[^"\\])*)"/gu)].map(match => match[1].replace(/\\(["\\])/gu, "$1")));
  return group("AND", tokenize(text).map(value => clause(tag, [value], { exact: quoted.has(value), unsafeQuote: value.includes('"'), local: tag.startsWith("ZOTERO_") })));
}

export function buildWosExpression(query, spec = {}, { scopeLabel = t("当前目录"), fulltext = false } = {}) {
  const common = [], filters = query.filters || [], branches = [[]];
  const textFields = { title: "TI", creator: "AU", date: "PY", DOI: "DO", abstractNote: "AB", citationKey: "ZOTERO_CITEKEY", tag: "ZOTERO_TAG" };
  const textTag = spec.fields?.length === 1 ? textFields[spec.fields[0]] || "ZOTERO_TEXT" : spec.fields?.length && !spec.fields.some(field => ["title", "creator", "date", "DOI", "abstractNote"].includes(field)) ? "ZOTERO_TEXT" : "TS";
  const outline = !query.scopedOutline && (query.mode === "outline" || query.kind === "outline"), outlineScope = spec.outlineSource || spec.outlineScope || query.outlineScope || { type: "all" };
  let words, incomplete = "";
  try { words = tokenize(query.text || ""); } catch (error) { words = []; incomplete = error.message; }
  if (outline || query.scopedOutline) {
    common.push(clause("ZOTERO_OUTLINE", [outlineScope.type === "pdf" ? outlineScope.title || t("当前 PDF") : t("所有 PDF")], { local: true }));
    if (outline && !query.queryTree && query.text?.trim()) common.push(incomplete ? clause("ZOTERO_OUTLINE_TEXT", [query.text.trim()], { local: true })
      : { tag: "ZOTERO_OUTLINE_TEXT", values: [words.map(valueText).join(" AND ")], raw: true, local: true });
  }
  if (!query.queryTree && !outline && words.length && query.mode !== "directories") common.push(topicTree(query.text, textTag));
  if (!outline && incomplete) common.push(clause("ZOTERO_TEXT", [query.text], { local: true }));
  if (query.mode === "directories" && !filters.length) common.push(clause("ZOTERO_DIR", [query.text || t("全部目录")], { local: true }));
  if (query.kind === "tabs") common.push(clause("ZOTERO_TABS", [t("已打开")], { local: true }));
  if (query.current) common.push(clause("ZOTERO_SCOPE", [scopeLabel], { local: true }));
  if (fulltext || query.kind === "fulltext") common.push(clause("ZOTERO_FULLTEXT", [t(query.kind === "fulltext" ? "全部字段" : "附件全文")], { local: true }));
  if (query.kind === "recent" && !words.length && !filters.length && !spec.nativeConditions?.length) common.push(clause("ZOTERO_RECENT", [t("最近阅读")], { local: true }));
  for (const filter of filters) {
    if (filter.join === "or" && branches.at(-1).length) branches.push([]);
    const resolved = spec.resolvedFilters?.find(entry => entry.type === filter.type && entry.value === filter.value);
    const ref = filter.ref || resolved?.ref || spec.filters?.find(entry => entry.type === filter.type && entry.value === filter.value)?.ref;
    branches.at(-1).push(filterNode({ ...filter, ref }, resolved));
  }
  const astFilters = filters.map((filter, index) => {
    const resolved = spec.resolvedFilters?.[index] || spec.resolvedFilters?.find(entry => entry.type === filter.type && entry.value === filter.value);
    const ref = filter.ref || resolved?.ref || spec.filters?.[index]?.ref
      || spec.filters?.find(entry => entry.type === filter.type && entry.value === filter.value)?.ref;
    return { ...filter, ref, resolved };
  });
  const native = [{ op: "AND", children: [] }];
  let nativeError = "";
  for (const condition of spec.nativeConditions || []) {
    if (condition.condition === "groupStart") { native.push({ op: "AND", children: [] }); continue; }
    if (condition.condition === "groupEnd") {
      if (native.length > 1) { const current = native.pop(); if (current.children.length) native.at(-1).children.push(group(current.op, current.children)); }
      else nativeError = "高级条件分组尚未完成";
      continue;
    }
    if (condition.condition === "joinMode") { native.at(-1).op = condition.operator === "any" ? "OR" : "AND"; continue; }
    if (["resultLevel", "recursive", "noChildren", "includeParents", "includeChildren", "includeParentsAndChildren", "deleted"].includes(condition.condition)) continue;
    const tag = { title: "TI", author: "AU", creator: "AU", editor: "ED", bookAuthor: "AU", year: "PY", DOI: "DO", publicationTitle: "SO", publisher: "PUBL", abstractNote: "AB", fulltextContent: "TS" }[condition.condition];
    const supported = tag && String(condition.value ?? "").trim() && ["contains", "is", "isNot", "doesNotContain", "beginsWith"].includes(condition.operator);
    const value = supported && condition.operator === "beginsWith" ? `${condition.value}*` : condition.value;
    const localTag = { citationKey: "ZOTERO_CITEKEY", tag: "ZOTERO_TAG", note: "ZOTERO_NOTE" }[condition.condition] || "ZOTERO_CONDITION";
    native.at(-1).children.push(clause(supported ? tag : localTag, [supported || localTag !== "ZOTERO_CONDITION" ? value : `${condition.condition} ${condition.operator} ${condition.value || ""}`], { local: !supported, exact: supported && tag !== "PY" && ["is", "isNot"].includes(condition.operator), negated: ["isNot", "doesNotContain"].includes(condition.operator) }));
  }
  if (native.length > 1) {
    nativeError = "高级条件分组尚未完成";
    while (native.length > 1) {
      const current = native.pop();
      if (current.children.length) native.at(-1).children.push(group(current.op, current.children));
    }
  }
  if (native[0].children.length) common.push(group(native[0].op, native[0].children));
  if (query.complete === false && query.text?.trim()) common.push(clause("ZOTERO_TEXT", [query.text], { local: true }));
  const tree = query.queryTree
    ? group("AND", [queryNode(query.queryTree, astFilters, outline, false, textTag), ...common].filter(Boolean))
    : group("OR", branches.map(branch => group("AND", [...common, ...branch])));
  let copyTree, copyError = "";
  try { copyTree = portableNegation(portable(tree)); } catch (error) { copyError = error.message; }
  const error = query.complete === false ? query.error || "检索式尚未完成" : nativeError || incomplete || copyError || validate(copyTree);
  const copyText = error ? "" : expressionText(copyTree);
  const hasLocal = node => !!node?.local || !!node?.children?.some(hasLocal);
  return { tree, copyText, error, text: expressionText(tree), hasLocal: hasLocal(tree) };
}
