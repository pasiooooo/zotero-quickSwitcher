// SPDX-License-Identifier: AGPL-3.0-or-later
import { t } from "./i18n.mjs";
import { libraryKey, topItem, loadedItems } from "./core.mjs";

export class LocationService {
  constructor({ onInvalidate = () => {} } = {}) {
    this.cache = new Map(); this.paths = new Map(); this.onInvalidate = onInvalidate; this.epoch = 0;
    this.observer = Zotero.Notifier.registerObserver({ notify: () => this.invalidate() }, ["item", "collection", "collection-item", "group", "feed", "feedItem"]);
  }
  invalidate() { this.epoch++; this.cache.clear(); this.paths.clear(); this.onInvalidate(); }
  destroy() { Zotero.Notifier.unregisterObserver(this.observer); this.cache.clear(); this.paths.clear(); }
  async collectionPath(collectionID) {
    const epoch = this.epoch;
    if (this.paths.has(collectionID)) return this.paths.get(collectionID);
    let collection = await Zotero.Collections.getAsync(collectionID);
    if (!collection || collection.deleted) throw new Error(t("文件夹已删除或尚未同步"));
    const leaf = collection;
    const segments = [], keys = [], visited = new Set();
    while (collection) {
      if (visited.has(collection.id)) throw new Error(t("文件夹父链循环"));
      visited.add(collection.id); segments.unshift(collection.name); keys.unshift(collection.key);
      if (!collection.parentID) break;
      collection = await Zotero.Collections.getAsync(collection.parentID);
      if (!collection) throw new Error(t("父文件夹尚未同步"));
    }
    const lib = Zotero.Libraries.get(leaf.libraryID);
    const stableLibrary = libraryKey(leaf.libraryID);
    const location = { libraryID: leaf.libraryID, libraryKey: stableLibrary, collectionID: leaf.id, collectionKey: leaf.key,
      label: lib.name, pathKeys: [stableLibrary, ...keys], pathSegments: [lib.name, ...segments], path: [lib.name, ...segments].join(" › ") };
    if (epoch === this.epoch) this.paths.set(collectionID, location);
    return location;
  }
  async get(itemOrID) {
    try {
      const epoch = this.epoch;
      const top = await topItem(itemOrID);
      if (this.cache.has(top.id)) return this.cache.get(top.id);
      const library = Zotero.Libraries.get(top.libraryID);
      if (library?.libraryType === "feed") {
        const key = libraryKey(top.libraryID), location = { kind: "feed", libraryID: top.libraryID, key, collectionKey: null, path: `RSS › ${library.name}`, pathSegments: ["RSS", library.name], pathKeys: ["rss", key] };
        const result = { status: "ready", locations: [location], itemID: top.id, libraryID: top.libraryID, libraryName: library.name };
        this.cache.set(top.id, result); return result;
      }
      await loadedItems([top.id], ["collections"]);
      const ids = [...new Set(top.getCollections(false))];
      const locations = await Promise.all(ids.map(id => this.collectionPath(id)));
      locations.sort((a, b) => a.path.localeCompare(b.path, "zh-CN"));
      if (epoch !== this.epoch) return this.get(itemOrID);
      const result = { status: "ready", locations, itemID: top.id, libraryID: top.libraryID, libraryName: Zotero.Libraries.get(top.libraryID).name };
      this.cache.set(top.id, result);
      return result;
    } catch (error) { return { status: "error", locations: [], error: error.message }; }
  }
}
