// SPDX-License-Identifier: AGPL-3.0-or-later
import { t } from "./i18n.mjs";
import { mergeLayoutRecords, UUID, validateLayoutRecord } from "./core.mjs";
import { mergeSavedQueryRecords } from "./saved-queries.mjs";

export const MAX_LAYOUT_BYTES = 2 * 1024 * 1024;
export function profileJSONStore(filename, limit = MAX_LAYOUT_BYTES) {
  const file = PathUtils.join(Zotero.Profile.dir, filename);
  return {
    read: async () => {
      if (!await IOUtils.exists(file)) return null;
      if ((await IOUtils.stat(file)).size > limit) throw new Error(t("本地同步文件过大"));
      return IOUtils.readUTF8(file);
    },
    write: async text => {
      for (let attempt = 0; ; attempt++) {
        try { return await IOUtils.writeUTF8(file, text, { tmpPath: file + ".tmp" }); }
        catch (error) {
          if (attempt >= 7 || !String(error).includes("NS_ERROR_FILE_ACCESS_DENIED")) throw error;
          await Zotero.Promise.delay(30 * (attempt + 1));
        }
      }
    },
    backup: async () => { if (await IOUtils.exists(file)) await IOUtils.copy(file, file + ".rejected-" + Date.now()); },
  };
}
export function parseLayout(text) {
  if (new TextEncoder().encode(text).length > MAX_LAYOUT_BYTES) throw new Error(t("布局文件超过 2 MB"));
  const value = JSON.parse(text);
  if (value?.schemaVersion !== 1 || !UUID.test(value.deviceID) || !Number.isSafeInteger(value.clock) || value.clock < 0) throw new Error(t("布局文件格式或版本不支持"));
  value.records = mergeLayoutRecords(value.records);
  value.queries = mergeSavedQueryRecords(value.queries || {});
  if ([...Object.values(value.records), ...Object.values(value.queries)].some(r => r.version.clock > value.clock)) throw new Error(t("布局逻辑版本无效"));
  return value;
}

export class LayoutStore {
  constructor({ prefs, onChange = () => {}, io, uuid = () => crypto.randomUUID() }) {
    this.prefs = prefs; this.onChange = onChange; this.uuid = uuid;
    this.records = {}; this.queries = {}; this.clock = 0; this.dirty = false; this.work = Promise.resolve();
    this.io = io || profileJSONStore("quickswitcher-layout.json");
  }
  async init() {
    this.deviceID = this.prefs.get("deviceID");
    if (!UUID.test(this.deviceID)) { this.deviceID = this.uuid(); this.prefs.set("deviceID", this.deviceID); }
    this.clock = Math.max(0, Number(this.prefs.get("clock")) || 0);
    try {
      const text = await this.io.read();
      if (text) { const state = parseLayout(text); this.records = state.records; this.queries = state.queries; this.clock = Math.max(this.clock, state.clock); this.dirty = !!state.dirty; }
    } catch (error) { await this.io.backup?.(); this.error = error.message; }
    this.prefs.set("clock", this.clock); return this;
  }
  get(libraryKey, searchKey) { return this.records[`${libraryKey}:${searchKey}`]?.placement || null; }
  getQuery(libraryKey, searchKey) { return this.queries[`${libraryKey}:${searchKey}`]?.spec || null; }
  snapshot() { return { schemaVersion: 1, deviceID: this.deviceID, clock: this.clock, records: structuredClone(this.records), ...(Object.keys(this.queries).length ? { queries: structuredClone(this.queries) } : {}), dirty: this.dirty }; }
  transact(operation) {
    this.work = this.work.catch(() => {}).then(operation); return this.work;
  }
  place(libraryKey, searchKey, placement) {
    return this.placeMany(libraryKey, [[searchKey, placement]]).then(records => records[0]);
  }
  placeMany(libraryKey, placements) {
    return this.transact(async () => {
      const clock = this.clock + 1;
      const changes = placements.map(([searchKey, placement]) => ({ libraryKey, searchKey, placement, version: { clock, deviceID: this.deviceID } }));
      if (!changes.every(validateLayoutRecord)) throw new Error(t("搜索位置或逻辑版本无效"));
      const records = { ...this.records, ...Object.fromEntries(changes.map(record => [`${libraryKey}:${record.searchKey}`, structuredClone(record)])) };
      await this.io.write(JSON.stringify({ ...this.snapshot(), records, clock, dirty: true }));
      this.records = records; this.clock = clock; this.dirty = true; this.prefs.set("clock", clock); this.onChange();
      return changes;
    });
  }
  saveQuery(libraryKey, searchKey, spec) {
    return this.transact(async () => {
      const clock = this.clock + 1;
      const queries = mergeSavedQueryRecords(this.queries, { [`${libraryKey}:${searchKey}`]: { libraryKey, searchKey, spec, version: { clock, deviceID: this.deviceID } } });
      await this.io.write(JSON.stringify({ ...this.snapshot(), queries, clock, dirty: true }));
      this.queries = queries; this.clock = clock; this.dirty = true; this.prefs.set("clock", clock); this.onChange();
    });
  }
  merge(records, isCurrent = () => true, queryRecords = {}) {
    return this.transact(async () => {
      if (!isCurrent()) return false;
      const merged = mergeLayoutRecords(this.records, records);
      const queries = mergeSavedQueryRecords(this.queries, queryRecords);
      const clock = Math.max(this.clock, ...[...Object.values(merged), ...Object.values(queries)].map(record => record.version.clock));
      if (JSON.stringify(merged) === JSON.stringify(this.records) && JSON.stringify(queries) === JSON.stringify(this.queries)) return false;
      const previous = this.snapshot();
      await this.io.write(JSON.stringify({ ...previous, records: merged, queries, clock, dirty: true }));
      if (!isCurrent()) { await this.io.write(JSON.stringify(previous)); return false; }
      this.records = merged; this.queries = queries; this.clock = clock; this.dirty = true; this.prefs.set("clock", clock); this.onChange(); return true;
    });
  }
  markSynced(clock) {
    return this.transact(async () => {
      if (this.clock !== clock) return;
      await this.io.write(JSON.stringify({ ...this.snapshot(), dirty: false })); this.dirty = false;
    });
  }
  destroy() { return this.work.catch(() => {}); }
}
