import test from "node:test";
import assert from "node:assert/strict";
import { locale, t as text, itemTypeLabel, refreshTranslations } from "../src/i18n.mjs";
import { preferenceFixture } from "./fixtures/preferences.mjs";

test("language follows Zotero and supports explicit English/Chinese overrides", t => {
  const f = preferenceFixture(t); globalThis.Zotero.locale = "en-GB";
  assert.equal(locale(), "en-US"); assert.equal(text("设置"), "Settings");
  f.app.prefs.set("language", "zh-CN"); assert.equal(locale(), "zh-CN"); assert.equal(text("设置"), "设置");
  globalThis.Zotero.locale = "zh-CN"; f.app.prefs.set("language", "en-US"); assert.equal(text("设置"), "Settings");
  f.app.prefs.set("language", "auto"); assert.equal(locale(), "zh-CN");
  delete globalThis.Zotero.locale; globalThis.Services.locale = { appLocaleAsBCP47: "en-US" }; assert.equal(locale(), "en-US");
});

test("translated templates preserve original names and can be refreshed in either language", t => {
  const f = preferenceFixture(t, { language: "en-US" }), name = '项目 A "quote" <raw>';
  const translated = text("选择「{name}」所在文件夹…", { name });
  assert.equal(translated, `Choose a collection for “${name}”…`);
  assert.equal(text("同步完成；保留并跳过 2 个损坏或未知版本文件"), "Sync complete; preserved and skipped 2 corrupt or unknown-version files");
  assert.equal(text("{count} 条", { count: 1 }), "1 item"); assert.equal(text("{count} 条", { count: 2 }), "2 items");
  f.app.prefs.set("language", "zh-CN"); assert.equal(text(translated), `选择「${name}」所在文件夹…`);
  assert.equal(text("Settings"), "设置"); assert.equal(text("an unknown native error"), "an unknown native error");
  f.app.prefs.set("language", "en-US"); assert.equal(text("constructor"), "constructor"); assert.equal(text("__proto__"), "__proto__");
});

test("language refresh changes only marked UI without losing drafts, controls or secure-storage work", async t => {
  const f = preferenceFixture(t, { davURL: "https://fixture.invalid/dav", davUsername: "fixture" }), credential = f.credential, prefix = f.field("authorPrefix");
  credential.value = "fixture-only-secret"; f.fire(credential, "input");
  const count = f.all().length, queryControl = f.field("defaultScope");
  f.app.prefs.set("language", "en-US"); refreshTranslations(f.win.document);
  assert.equal(f.all().length, count); assert.equal(f.credential, credential); assert.equal(credential.value, "fixture-only-secret");
  assert.equal(prefix.value, "@"); assert.equal(prefix.getAttribute("aria-label"), "Author prefix");
  assert.equal(queryControl.getAttribute("aria-label"), "Default search scope");
  assert.equal(f.field("tabsShortcut").value, "Alt+;");
  await f.timers(); await f.root.qsFlushCredential(); assert.equal(f.logins.length, 1);
  f.app.prefs.set("language", "zh-CN"); refreshTranslations(f.win.document);
  assert.equal(prefix.getAttribute("aria-label"), "作者引导符"); assert.equal(credential.value, "fixture-only-secret");
});

test("language configuration validates atomically, exports and retains bad stored values for repair", t => {
  const f = preferenceFixture(t), prefs = f.app.prefs;
  assert.throws(() => prefs.importConfig({ schemaVersion: 1, settings: { fontSize: 18, language: "invalid" } }));
  assert.equal(prefs.get("fontSize"), 14); assert.equal(prefs.get("language"), "auto");
  prefs.set("language", "en-US"); assert.equal(prefs.exportConfig().settings.language, "en-US");
  f.values.set("quickswitcher.language", "invalid"); assert.equal(prefs.get("language"), "auto"); assert.equal(f.values.get("quickswitcher.language"), "invalid");
});

test("item type names use Zotero's bilingual labels while native IDs remain unchanged", t => {
  const f = preferenceFixture(t, { language: "en-US" });
  assert.equal(itemTypeLabel("book"), "Book"); assert.equal(itemTypeLabel("computerProgram"), "Software");
  f.app.prefs.set("language", "zh-CN"); assert.equal(itemTypeLabel("book"), "图书"); assert.equal(itemTypeLabel("journalArticle"), "期刊文章");
});
