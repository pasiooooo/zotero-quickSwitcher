import test from "node:test";
import assert from "node:assert/strict";
import { Launcher } from "../src/launcher.mjs";
import { DEFAULT_PREFIXES, pairLauncherInput, parseLauncherInput } from "../src/launcher-query.mjs";
import { InputScopes } from "../src/input-scopes.mjs";
import { readFileSync } from "node:fs";

class Node {
  constructor() { this.children = []; this.dataset = {}; this.style = {}; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this[name] = value; }
  get textContent() { return this.text || this.children.map(child => child.textContent).join(""); }
  set textContent(value) { this.text = value; this.children = []; }
}
const descendants = node => [node, ...node.children.flatMap(descendants)];
function viewFor(value, caret = value.length) {
  const view = Object.create(Launcher.prototype);
  const doc = { createElementNS: () => new Node(), createTextNode: text => { const node = new Node(); node.textContent = text; return node; } };
  Object.assign(view, { doc, input: { value, selectionEnd: caret, scrollLeft: 0 }, inputMode: "items", scopeText: new Node(), inputShell: new Node(), inputScopes: new InputScopes(value), prefixes: () => DEFAULT_PREFIXES });
  return view;
}
const markers = view => descendants(view.scopeText).filter(node => node.className === "qs-scope-marker");

test("actual input scope rendering separates all four grouped or bare field guides and retains them on scroll", () => {
  const value = "plain @(Native) :1900 !journal %journalArticle", view = viewFor(value);
  view.renderInputScopes(parseLauncherInput(value, "items", value.length));
  assert.deepEqual(markers(view).map(node => node.textContent), ["@", ":", "!", "%"]);
  assert.equal(view.scopeText.textContent, value);
  assert.equal(view.inputShell.dataset.scoped, "true");
  view.input.scrollLeft = 23; view.renderInputScopes();
  assert.deepEqual(markers(view).map(node => node.textContent), ["@", ":", "!", "%"]);
  assert.equal(view.scopeText.style.transform, "translateX(-23px)");
  assert.equal(view.input.value, value); assert.equal(view.input.selectionEnd, value.length);
});

test("scope rendering preserves nested automatic boundaries and does not color quoted or escaped guides", () => {
  const value = '(@(Alice OR (Bob AND Carol)) AND :"1900")', view = viewFor(value);
  view.inputScopes.add(value.indexOf("@")); view.renderInputScopes();
  assert.equal(view.scopeText.textContent, value);
  assert.deepEqual(markers(view).map(node => node.textContent), ["@", ":"]);
  assert.equal(descendants(view.scopeText).filter(node => node.className === "qs-virtual-boundary").length, 2);
  assert.ok(descendants(view.scopeText).some(node => node.className === "qs-query-scope" && descendants(node).filter(child => child.className === "qs-query-scope").length > 1));
  const literal = String.raw`"@quoted :1900 !journal %book" \@literal \:2000 \!publisher \%book`, quoted = viewFor(literal);
  quoted.renderInputScopes(); assert.equal(markers(quoted).length, 0); assert.equal(quoted.scopeText.textContent, literal);
  assert.equal(quoted.inputShell.dataset.scoped, "false");
});

test("directly adjacent scope guides keep their independent markers and complete display text", () => {
  const typed = "@(A):", paired = pairLauncherInput(typed, typed.length, "insertText");
  const view = viewFor(paired.value, paired.caret);
  view.inputScopes.add(0); view.inputScopes.add(4); view.renderInputScopes();
  assert.deepEqual(markers(view).map(node => node.textContent), ["@", ":"]);
  assert.equal(view.scopeText.textContent, "@(A):()");
  assert.equal(descendants(view.scopeText).filter(node => node.className === "qs-virtual-boundary").length, 4);
  const complete = viewFor("@(A):(2024)!(Nature)%(journalArticle)/(Core)"); complete.renderInputScopes();
  assert.deepEqual(markers(complete).map(node => node.textContent), ["@", ":", "!", "%", "/"]);
  assert.equal(complete.scopeText.textContent, complete.input.value);
});

test("input and overlay share fonts and measured marker slots with reserved comfortable space", () => {
  const css = readFileSync(new URL("../addon/content/style.css", import.meta.url), "utf8");
  const rule = selector => css.match(new RegExp("^" + selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&") + " \\{([^}]*)\\}", "mu"))?.[1];
  assert.match(rule(".qs-searchline"), /--qs-input-font:[^;]*monospace/u);
  for (const selector of [".qs-root .qs-input", ".qs-input-scope-layer"]) assert.match(rule(selector), /font-family: var\(--qs-input-font\)/u);
  assert.match(rule(".qs-input-scope-layer"), /pointer-events: none/u);
  const marker = rule('.qs-input-shell[data-scoped="true"] .qs-scope-marker');
  assert.match(marker, /width: var\(--qs-marker-width/u); assert.match(marker, /padding: 0 4px/u); assert.match(marker, /vertical-align: baseline/u);
  assert.match(rule('.qs-input-shell[data-scoped="true"] .qs-input::selection'), /background: transparent/u);
  assert.match(rule('.qs-input-selection-layer'), /pointer-events: none/u);
});

test("launcher hiding preserves native visible menuitems with hidden=false", () => {
  const css = readFileSync(new URL("../addon/content/style.css", import.meta.url), "utf8");
  const hiding = css.split("\n").find(line => line.includes("[hidden]") && line.includes("display: none !important"));
  const selectors = hiding.slice(0, hiding.indexOf("{")).split(",");
  for (const selector of selectors) assert.match(selector, /\[hidden\]:not\(\[hidden="false"\]\)/u);
});

test("standalone native search declares its localization resources before loading elements", () => {
  const source = readFileSync(new URL("../addon/content/global.xhtml", import.meta.url), "utf8");
  for (const resource of ["branding/brand.ftl", "zotero.ftl"]) {
    assert.ok(source.includes(`rel="localization" href="${resource}"`));
    assert.ok(source.indexOf(resource) < source.indexOf("customElements.js"));
  }
});

test("standalone native search keeps resize borders instead of blanket chrome hiding", () => {
  const document = readFileSync(new URL("../addon/content/global.xhtml", import.meta.url), "utf8");
  assert.doesNotMatch(document, /hidechrome="true"/u);
  const source = readFileSync(new URL("../src/index.mjs", import.meta.url), "utf8");
  const creation = source.match(/createTopLevelWindow\([\s\S]*?, 1, 1\)/u)[0];
  assert.match(creation, /CHROME_WINDOW_RESIZE/u); assert.doesNotMatch(creation, /CHROME_TITLEBAR/u);
});

test("advanced height follows the configured ratio only inside Zotero, leaving global windows resizable", () => {
  const css = readFileSync(new URL("../addon/content/style.css", import.meta.url), "utf8");
  const conditions = css.match(/^\.qs-advanced \{([^}]*)\}/mu)[1];
  assert.match(conditions, /flex: 0 1 auto/u);
  assert.match(conditions, /overflow: auto/u);
  assert.doesNotMatch(conditions, /(?:^|;\s*)height:/u);
  assert.match(conditions, /max-height: var\(--qs-advanced-height, none\)/u);
  const heightRule = css.split("\n").find(line => line.includes(":has(> .qs-advanced") && line.includes("height: min(var(--qs-height"));
  assert.ok(heightRule.startsWith(".qs-root:not(.qs-global) "));
  assert.match(css, /\.qs-global \.qs-dialog \{[^}]*height: 100%/u);
});
