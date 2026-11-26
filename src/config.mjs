// SPDX-License-Identifier: AGPL-3.0-or-later
import { t } from "./i18n.mjs";
import { UUID, compareVersions } from "./core.mjs";
import { CONFIG_GROUPS, migrateInputGroup, validatePreference, linkModePrefixes } from "./prefs.mjs";
import { profileJSONStore } from "./layout.mjs";

export const MAX_CONFIG_BYTES = 256 * 1024;
function mergeRecords(...maps) {
  const merged = {}; let needsTag = false;
  for (const records of maps) {
    if (!records || typeof records !== "object" || Array.isArray(records)) throw new Error(t("同步配置记录无效"));
    for (const [group, record] of Object.entries(records)) {
      if (["outlineDepth", "openMode"].includes(group)) continue;
      const names = Object.hasOwn(CONFIG_GROUPS, group) && CONFIG_GROUPS[group];
      if (!names || !record?.values || Array.isArray(record.values) || typeof record.values !== "object"
        || !Number.isSafeInteger(record.version?.clock) || record.version.clock < 0 || !UUID.test(record.version.deviceID)) throw new Error(t("同步配置记录无效"));
      if (!["prefixes", "shortcuts"].includes(group) && (Object.keys(record.values).length !== names.length || names.some(name => !Object.hasOwn(record.values, name)))) throw new Error(t("同步配置记录无效"));
      const values = ["prefixes", "shortcuts"].includes(group) ? migrateInputGroup(group, record.values) : Object.fromEntries(names.map(name => [name, validatePreference(name, record.values[name], ["width", "height"].includes(name))]));
      if (Object.keys(values).length !== names.length || names.some(name => !Object.hasOwn(values, name))) throw new Error(t("同步配置记录无效"));
      if (!merged[group] || compareVersions(record.version, merged[group].version) > 0) {
        merged[group] = { values, version: { clock: record.version.clock, deviceID: record.version.deviceID } };
        if (group === "prefixes") needsTag = !Object.hasOwn(record.values, "tagPrefix");
      }
    }
  }
  if (merged.prefixes && merged.shortcuts) merged.prefixes.values = linkModePrefixes(merged.prefixes.values, merged.shortcuts.values, true, needsTag);
  return merged;
}
export function parseConfig(text) {
  if (new TextEncoder().encode(text).length > MAX_CONFIG_BYTES) throw new Error(t("配置文件超过 256 KB"));
  const value = JSON.parse(text);
  if (value?.schemaVersion !== 1 || !UUID.test(value.deviceID) || !Number.isSafeInteger(value.clock) || value.clock < 0) throw new Error(t("同步配置格式或版本不支持"));
  const records = mergeRecords(value.records);
  if (Object.values(records).some(record => record.version.clock > value.clock)) throw new Error(t("同步配置逻辑版本无效"));
  return { schemaVersion: 1, deviceID: value.deviceID, clock: value.clock, records, dirty: !!value.dirty };
}

export class ConfigStore {
  constructor({ prefs, deviceID, onChange = () => {}, onApplied = () => {}, io }) {
    this.prefs = prefs; this.deviceID = deviceID; this.onChange = onChange; this.onApplied = onApplied;
    this.io = io || profileJSONStore("quickswitcher-settings-state.json", MAX_CONFIG_BYTES);
    this.clock = 0; this.records = {}; this.pending = new Map(); this.dirty = false; this.work = Promise.resolve();
  }
  async init() {
    if (!UUID.test(this.deviceID)) throw new Error(t("同步配置设备身份无效"));
    this.prefs.migrateInputSettings?.();
    try {
      const text = await this.io.read();
      if (text) {
        const state = parseConfig(text);
        this.prefs.validate(Object.values(state.records).flatMap(record => Object.entries(record.values)));
        this.clock = state.clock; this.records = state.records; this.dirty = state.dirty;
      }
    } catch (error) { await this.io.backup?.(); this.error = error.message; }
    return this;
  }
  snapshot() { return { schemaVersion: 1, deviceID: this.deviceID, clock: this.clock, records: structuredClone(this.records), dirty: this.dirty }; }
  transact(operation) { this.work = this.work.catch(() => {}).then(operation); return this.work; }
  changed(entries) {
    if (this.applying || !this.prefs.get("syncSettings")) return Promise.resolve();
    const changed = new Set(entries.map(([name]) => name));
    for (const [group, names] of Object.entries(CONFIG_GROUPS)) if (names.some(name => changed.has(name))) {
      this.pending.set(group, Object.fromEntries(names.map(name => [name, this.prefs.get(name)])));
    }
    return this.flush();
  }
  reconcile() {
    for (const [group, record] of Object.entries(this.records)) {
      const values = Object.fromEntries(CONFIG_GROUPS[group].map(name => [name, this.prefs.get(name)]));
      if (!this.pending.has(group) && JSON.stringify(values) !== JSON.stringify(record.values)) this.pending.set(group, values);
    }
    return this.flush();
  }
  flush() {
    return this.transact(async () => {
      for (const [group, values] of this.pending) if (JSON.stringify(this.records[group]?.values) === JSON.stringify(values)) this.pending.delete(group);
      const changes = [...this.pending];
      if (!changes.length) return false;
      const clock = this.clock + 1;
      if (!Number.isSafeInteger(clock)) throw new Error(t("同步配置逻辑版本无效"));
      const records = mergeRecords(this.records, Object.fromEntries(changes.map(([group, values]) => [group, { values, version: { clock, deviceID: this.deviceID } }])));
      await this.io.write(JSON.stringify({ ...this.snapshot(), records, clock, dirty: true }));
      this.records = records; this.clock = clock; this.dirty = true;
      for (const [group, values] of changes) if (this.pending.get(group) === values) this.pending.delete(group);
      this.onChange(); return true;
    });
  }
  initializeMissing() {
    for (const [group, names] of Object.entries(CONFIG_GROUPS)) if (!Object.hasOwn(this.records, group) && !this.pending.has(group)) {
      this.pending.set(group, Object.fromEntries(names.map(name => [name, this.prefs.get(name)])));
    }
    return this.flush();
  }
  validate(records) {
    this.prefs.validate(Object.values(mergeRecords(this.records, records)).flatMap(record => Object.entries(record.values)));
  }
  merge(records, isCurrent = () => true) {
    return this.transact(async () => {
      if (!isCurrent()) return false;
      const merged = mergeRecords(this.records, records);
      const changed = Object.entries(merged).filter(([group, record]) => JSON.stringify(record) !== JSON.stringify(this.records[group]));
      if (!changed.length) return false;
      const entries = Object.values(merged).flatMap(record => Object.entries(record.values));
      this.prefs.validate(entries);
      const clock = Math.max(this.clock, ...Object.values(merged).map(record => record.version.clock));
      const previous = this.snapshot();
      await this.io.write(JSON.stringify({ ...previous, records: merged, clock, dirty: true }));
      if (!isCurrent()) { await this.io.write(JSON.stringify(previous)); return false; }
      this.applying = true;
      // A local edit made during disk IO takes priority until its queued version is saved.
      const applied = { ...merged, ...Object.fromEntries([...this.pending].map(([group, values]) => [group, { values }])) };
      try { this.prefs.apply(Object.values(applied).flatMap(record => Object.entries(record.values))); } finally { this.applying = false; }
      this.records = merged; this.clock = clock; this.dirty = true; this.onApplied(); this.onChange(); return true;
    });
  }
  markSynced(clock) {
    return this.transact(async () => {
      if (this.clock !== clock || this.pending.size) return;
      await this.io.write(JSON.stringify({ ...this.snapshot(), dirty: false })); this.dirty = false;
    });
  }
  destroy() { return this.work.catch(() => {}); }
}
