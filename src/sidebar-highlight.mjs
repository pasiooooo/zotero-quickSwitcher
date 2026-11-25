// SPDX-License-Identifier: AGPL-3.0-or-later
import { matchRanges } from "./core.mjs";
import { element, appendMarked } from "./dom.mjs";

export function sidebarRanges(value, field, data, entries) {
  const creatorField = /^creator-(\d+)-(firstName|lastName)$/u.exec(field);
  if (creatorField) {
    const creator = data.creatorDetails?.[Number(creatorField[1])];
    if (!creator) return [];
    const offset = creator.start + (creatorField[2] === "lastName" && creator.firstName ? creator.firstName.length + 1 : 0);
    return entries.filter(entry => entry.field === "creator").flatMap(entry => (entry.ranges || []).filter(range => range.end > offset && range.start < offset + value.length)
      .map(range => ({ start: Math.max(0, range.start - offset), end: Math.min(value.length, range.end - offset) })));
  }
  return entries.filter(entry => entry.field === field).flatMap(entry => (entry.ranges || [])
    .flatMap(range => matchRanges(value, entry.text.slice(range.start, range.end))));
}

export class SidebarHighlights {
  constructor(win, root, prefs) {
    this.win = win; this.root = root; this.prefs = prefs; this.hosts = new Set(); this.typeMenus = new Set();
    this.observer = new win.MutationObserver(records => {
      if (records.some(record => !record.target.closest?.(".qs-sidebar-overlay") && (record.type !== "childList"
        || [...record.addedNodes, ...record.removedNodes].some(node => !node.classList?.contains("qs-sidebar-overlay"))))) this.schedule();
    });
    this.observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["value", "fieldname"] });
  }
  set(data, entries = []) { this.data = data; this.entries = entries; this.render(); }
  clear() {
    for (const host of this.hosts) { host.querySelector(":scope > .qs-sidebar-overlay")?.remove(); host.classList.remove("qs-sidebar-field"); }
    this.hosts.clear();
    for (const menu of this.typeMenus) { menu.classList.remove("qs-sidebar-type-match"); menu.style.removeProperty("--qs-highlight"); }
    this.typeMenus.clear();
  }
  schedule() {
    if (this.frame || !this.data) return;
    this.frame = this.win.requestAnimationFrame(() => { this.frame = null; this.render(); });
  }
  render() {
    this.clear();
    if (!this.data || this.root.querySelector("info-box,item-box")?.item?.id !== this.data.itemID) return;
    if (this.entries.some(entry => entry.field === "itemType" && entry.ranges?.length)) {
      const menu = this.root.querySelector("#item-type-menu");
      if (menu) { menu.classList.add("qs-sidebar-type-match"); menu.style.setProperty("--qs-highlight", this.prefs.get("highlightColor")); this.typeMenus.add(menu); }
    }
    for (const host of this.root.querySelectorAll("editable-text")) {
      const input = host.querySelector("input, textarea");
      if (!input || !input.value) continue;
      let field = host.getAttribute("fieldname");
      if (!field) field = host.closest("abstract-box") ? "abstractNote" : host.closest("tags-box") ? "tag" : host.closest("item-pane-header") ? "title" : null;
      if (!field) continue;
      const fieldID = !field.startsWith("creator-") && Zotero.ItemFields.getID(field);
      const baseID = fieldID && Zotero.ItemFields.getBaseIDFromTypeAndField(this.data.itemTypeID, fieldID);
      if (baseID) field = Zotero.ItemFields.getName(baseID);
      const ranges = sidebarRanges(input.value, field, this.data, this.entries);
      if (!ranges.length) continue;
      const style = this.win.getComputedStyle(input);
      const overlay = element(this.win.document, "div", { class: "qs-sidebar-overlay", "aria-hidden": "true" });
      for (const property of ["font", "lineHeight", "letterSpacing", "textAlign", "direction", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "textIndent"]) overlay.style[property] = style[property];
      overlay.style.color = style.color; overlay.style.setProperty("--qs-highlight", this.prefs.get("highlightColor"));
      overlay.style.whiteSpace = input.localName === "input" || input.wrap === "off" ? "pre" : "pre-wrap";
      appendMarked(overlay, input.value, ranges); host.classList.add("qs-sidebar-field"); host.append(overlay); this.hosts.add(host);
    }
  }
  destroy() { this.observer.disconnect(); this.win.cancelAnimationFrame(this.frame); this.clear(); this.data = null; }
}
