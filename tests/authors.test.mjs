import test from "node:test";
import assert from "node:assert/strict";
import { authorAliases, authorMatches, groupAuthors } from "../src/authors.mjs";
import { filterMatches } from "../src/filter-match.mjs";

test("author forms match the requested Chinese, English, full-pinyin and Xiaohe spellings", () => {
  const english = { firstName: "Xiaohe", lastName: "Lin" };
  const chinese = { firstName: "", lastName: "林晓禾", fieldMode: 1 };
  const queries = ["Xiaohe Lin", "Lin Xiaohe", "林晓禾", "晓禾 林", "linxiaohe", "lbxnhe"];
  for (const query of queries) {
    assert.equal(authorMatches(english, query), true, query);
    assert.equal(authorMatches(chinese, query), true, query);
  }
  assert.ok(authorAliases(english).includes("lbxnhe"));
  assert.equal(authorMatches(english, "Xiaohe Wrong"), false);
  assert.equal(authorMatches({ firstName: "Zhe", lastName: "Lin" }, "Xiaohe Lin"), false);
});

test("equivalent records group across scripts and libraries without merging double-pinyin collisions", () => {
  const records = [
    { firstName: "Xiaohe", lastName: "Lin", libraryID: 1, count: 2 },
    { lastName: "林晓禾", fieldMode: 1, libraryID: 2, count: 3 },
    { firstName: "Jiang", lastName: "Qing", count: 1 },
    { firstName: "Liang", lastName: "Qing", count: 1 },
  ];
  const rows = groupAuthors(records);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].records.length, 2);
  assert.equal(rows[0].count, 5);
  assert.equal(rows[0].title, "林晓禾");
  assert.equal(authorMatches(rows[0], "lbxnhe"), true);
  assert.equal(groupAuthors([{ lastName: "晓禾 林", fieldMode: 1 }])[0].title, "林晓禾");
  assert.equal(authorMatches(rows.find(row => row.records[0].firstName === "Jiang"), "Qing Liang"), false);
});

test("compound and polyphonic surnames, initials, accents and Western names keep original matching", () => {
  assert.equal(authorMatches({ firstName: "修", lastName: "欧阳" }, "Ouyang Xiu"), true);
  assert.equal(authorMatches({ lastName: "欧阳修", fieldMode: 1 }, "Xiu Ouyang"), true);
  assert.equal(authorMatches({ firstName: "伟", lastName: "单" }, "Shan Wei"), true);
  assert.equal(authorMatches({ firstName: "Xiaohe", lastName: "Lin" }, "Lin, X."), true);
  assert.equal(authorMatches({ firstName: "René", lastName: "Descartes" }, "rene descartes"), true);
  assert.equal(authorMatches({ firstName: "Sarah", lastName: "O'Neill" }, "oneill sarah"), true);
  assert.equal(authorMatches({ lastName: "National Research Council", fieldMode: 1 }, "research council"), true);
  assert.equal(authorMatches({ firstName: "Wei", lastName: "Lü" }, "吕伟"), true);
  assert.equal(authorMatches({ firstName: "Wei", lastName: "Lü" }, "luwei"), true);
  assert.equal(authorMatches({ firstName: "Wei", lastName: "Lyu" }, "吕伟"), true);
  assert.equal(groupAuthors([{ firstName: "Wei", lastName: "Lü" }, { lastName: "吕伟", fieldMode: 1 }]).length, 1);
});

test("wildcards work in names and directory paths while other punctuation remains literal", () => {
  const author = { firstName: "Xiaohe", lastName: "Lin" };
  assert.equal(authorMatches(author, "Lin*he"), true);
  assert.equal(authorMatches(author, "l?xnhe"), true);
  assert.equal(authorMatches(author, "林*禾"), true);
  assert.equal(authorMatches(author, "林?禾"), true);
  assert.equal(authorMatches({ firstName: "Xiaominghe", lastName: "Lin" }, "林?禾"), false);
  assert.equal(authorMatches({ firstName: "Xiaominghe", lastName: "Lin" }, "林*禾"), true);
  assert.equal(filterMatches("我的文库 › 项目 A › 核心文献", "项目 ?*核心"), true);
  assert.equal(filterMatches("Café [A]_10%", "cafe [a]_10%"), true);
  assert.equal(filterMatches("Café A_10%", "[a]"), false);
  assert.equal(filterMatches("Alice 100percent", "100%"), false);
  assert.equal(filterMatches("AliceX", "Alice_"), false);
  assert.equal(filterMatches("𠮷家", "?家"), true);
  assert.equal(filterMatches("directory", ""), true);
  assert.equal(filterMatches("a*xxb", "a*b"), true);
  assert.equal(filterMatches("directory", "*z*"), false);
  assert.equal(authorMatches({ firstName: "Alice", lastName: "Example" }, "Alice_"), false);
  assert.equal(authorMatches(author, ""), true);
});

test("exact author aliases distinguish a full name from longer prefix matches", () => {
  const li = { firstName: "Wei", lastName: "Li" };
  const liang = { firstName: "Wei", lastName: "Liang" };
  assert.equal(authorMatches(li, "Wei Li", { exact: true }), true);
  assert.equal(authorMatches(liang, "Wei Li"), true);
  assert.equal(authorMatches(liang, "Wei Li", { exact: true }), false);
  assert.equal(authorMatches(li, "Li Wei", { exact: true }), true);
  assert.equal(authorMatches(li, "Wei L*", { exact: true }), false);
  assert.equal(authorMatches(li, "Wei L*"), true);
  const english = { firstName: "Xiaohe", lastName: "Lin" };
  const chinese = { lastName: "林晓禾", fieldMode: 1 };
  assert.equal(authorMatches(english, "林晓禾", { exact: true }), true);
  assert.equal(authorMatches(chinese, "Xiaohe Lin", { exact: true }), true);
  assert.equal(authorMatches(english, "林?禾", { exact: true }), false);
  const rows = groupAuthors([li, liang]);
  assert.equal(authorMatches(rows.find(row => row.records.includes(li)), "Wei Li", { exact: true }), true);
  assert.equal(authorMatches(rows.find(row => row.records.includes(liang)), "Wei Li", { exact: true }), false);
});
