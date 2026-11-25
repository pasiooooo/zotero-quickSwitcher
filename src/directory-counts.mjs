// SPDX-License-Identifier: AGPL-3.0-or-later
import { t } from "./i18n.mjs";

export class DirectoryCounts {
  constructor({ onInvalidate = () => {} } = {}) {
    this.libraries = new Map(); this.searches = new Map(); this.epoch = 0;
    this.observer = Zotero.Notifier.registerObserver({ notify: () => {
      this.epoch++; this.libraries.clear(); this.searches.clear(); onInvalidate();
    } }, ["item", "collection", "collection-item", "search", "group", "feed", "feedItem"]);
  }
  async library(id) {
    if (this.libraries.has(id)) return this.libraries.get(id);
    const epoch = this.epoch;
    const pending = (async () => {
      const library = Zotero.Libraries.get(id);
      if (!library || !["user", "group", "feed"].includes(library.libraryType)) throw new Error(t("文库暂不可用"));
      const rows = await Zotero.DB.queryAsync(`SELECT I.itemID,
        COALESCE(A.parentItemID, N.parentItemID, AN.parentItemID) AS parentItemID, CI.collectionID
        FROM items I LEFT JOIN itemAttachments A ON A.itemID = I.itemID
        LEFT JOIN itemNotes N ON N.itemID = I.itemID LEFT JOIN itemAnnotations AN ON AN.itemID = I.itemID
        LEFT JOIN collectionItems CI ON CI.itemID = I.itemID
        WHERE I.libraryID = ? AND I.itemID NOT IN (SELECT itemID FROM deletedItems)`, [id]);
      const parents = new Map(rows.map(row => [Number(row.itemID), row.parentItemID ? Number(row.parentItemID) : null]));
      const normalized = new Map();
      const top = itemID => {
        if (normalized.has(itemID)) return normalized.get(itemID);
        const visited = new Set(); let current = itemID;
        while (parents.has(current) && parents.get(current) && !visited.has(current)) { visited.add(current); current = parents.get(current); }
        const value = parents.has(current) && !parents.get(current) ? current : null;
        normalized.set(itemID, value); return value;
      };
      const tops = new Set(), members = new Map(), children = new Map();
      for (const row of rows) {
        const itemID = top(Number(row.itemID)); if (!itemID) continue;
        tops.add(itemID);
        if (row.collectionID) {
          const collection = Number(row.collectionID);
          if (!members.has(collection)) members.set(collection, new Set());
          members.get(collection).add(itemID);
        }
      }
      for (const collection of library.libraryType === "feed" ? [] : Zotero.Collections.getByLibrary(id, true)) {
        if (collection.deleted || !collection.parentID) continue;
        if (!children.has(collection.parentID)) children.set(collection.parentID, []);
        children.get(collection.parentID).push(collection.id);
      }
      return { tops, members, children, top };
    })();
    this.libraries.set(id, pending);
    try { return await pending; }
    catch (error) { if (epoch === this.epoch) this.libraries.delete(id); throw error; }
  }
  async count(row, { recursive = true } = {}) {
    if (row.kind === "feeds") return (await Promise.all(Zotero.Libraries.getAll().filter(library => library.libraryType === "feed").map(library => this.count({ kind: "feed", libraryID: library.libraryID })))).reduce((total, count) => total + count, 0);
    const epoch = this.epoch, data = await this.library(row.libraryID);
    if (epoch !== this.epoch) return this.count(row, { recursive });
    if (["library", "feed"].includes(row.kind)) return data.tops.size;
    if (row.kind === "collection") {
      const ids = new Set(), visited = new Set(), pending = [row.collectionID];
      while (pending.length) {
        const id = pending.pop(); if (visited.has(id)) continue;
        visited.add(id); for (const itemID of data.members.get(id) || []) ids.add(itemID);
        if (recursive) pending.push(...data.children.get(id) || []);
      }
      return ids.size;
    }
    if (row.kind === "search") {
      const id = row.searchID || Zotero.Searches.getIDFromLibraryAndKey(row.libraryID, row.key), key = `${row.libraryID}:${id}`;
      if (!this.searches.has(key)) this.searches.set(key, (async () => {
        const search = await Zotero.Searches.getAsync(id);
        if (!search) throw new Error(t("保存搜索暂不可用"));
        const ids = await search.search() || [];
        return new Set(ids.map(id => data.top(Number(id))).filter(Boolean)).size;
      })());
      try {
        const value = await this.searches.get(key);
        return epoch === this.epoch ? value : this.count(row, { recursive });
      } catch (error) { if (epoch === this.epoch) this.searches.delete(key); throw error; }
    }
    throw new Error(t("目录类型暂不可用"));
  }
  destroy() { this.epoch++; Zotero.Notifier.unregisterObserver(this.observer); this.libraries.clear(); this.searches.clear(); }
}
