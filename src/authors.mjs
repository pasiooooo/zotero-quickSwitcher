// SPDX-License-Identifier: AGPL-3.0-or-later
import { pinyin } from "pinyin-pro";
import { normalize } from "./core.mjs";
import { filterMatches } from "./filter-match.mjs";

const han = /\p{Script=Han}/u;
const compoundSurnames = /^(欧阳|歐陽|司马|司馬|上官|诸葛|諸葛|东方|東方|皇甫|尉迟|尉遲|公孙|公孫|慕容|长孙|長孫|司徒|司空|夏侯|宇文|南宫|南宮|轩辕|軒轅|令狐|端木|拓跋|鲜于|鮮于|闻人|聞人|钟离|鍾離|申屠|太史|赫连|赫連|澹台|第五)/u;
const syllables = new Set(`a ai an ang ao e ei en eng er o ou
ba bai ban bang bao bei ben beng bi bian biao bie bin bing bo bu
ca cai can cang cao ce cen ceng cha chai chan chang chao che chen cheng chi chong chou chu chua chuai chuan chuang chui chun chuo ci cong cou cu cuan cui cun cuo
da dai dan dang dao de dei den deng di dia dian diao die ding diu dong dou du duan dui dun duo
fa fan fang fei fen feng fo fou fu
ga gai gan gang gao ge gei gen geng gong gou gu gua guai guan guang gui gun guo
ha hai han hang hao he hei hen heng hong hou hu hua huai huan huang hui hun huo
ji jia jian jiang jiao jie jin jing jiong jiu ju juan jue jun
ka kai kan kang kao ke ken keng kong kou ku kua kuai kuan kuang kui kun kuo
la lai lan lang lao le lei leng li lia lian liang liao lie lin ling liu lo long lou lu luan lun luo lv lve
ma mai man mang mao me mei men meng mi mian miao mie min ming miu mo mou mu
na nai nan nang nao ne nei nen neng ni nian niang niao nie nin ning niu nong nou nu nuan nuo nv nve
pa pai pan pang pao pei pen peng pi pian piao pie pin ping po pou pu
qi qia qian qiang qiao qie qin qing qiong qiu qu quan que qun
ran rang rao re ren reng ri rong rou ru rua ruan rui run ruo
sa sai san sang sao se sen seng sha shai shan shang shao she shei shen sheng shi shou shu shua shuai shuan shuang shui shun shuo si song sou su suan sui sun suo
ta tai tan tang tao te teng ti tian tiao tie ting tong tou tu tuan tui tun tuo
wa wai wan wang wei wen weng wo wu
xi xia xian xiang xiao xie xin xing xiong xiu xu xuan xue xun
ya yan yang yao ye yi yin ying yo yong you yu yuan yue yun
za zai zan zang zao ze zei zen zeng zha zhai zhan zhang zhao zhe zhei zhen zheng zhi zhong zhou zhu zhua zhuai zhuan zhuang zhui zhun zhuo zi zong zou zu zuan zui zun zuo`.split(/\s+/u));
const finals = { a: "a", o: "o", e: "e", i: "i", u: "u", v: "v", ai: "d", ei: "w", ao: "c", ou: "z", an: "j", en: "f", ang: "h", eng: "g", ong: "s", ia: "x", ie: "p", iao: "n", iu: "q", ian: "m", in: "b", iang: "l", ing: "k", iong: "s", ua: "x", uo: "o", uai: "k", ui: "v", uan: "r", un: "y", uang: "l", ueng: "g", ve: "t", ue: "t" };
const zeroInitials = { a: "aa", o: "oo", e: "ee", ai: "ai", ei: "ei", ao: "ao", ou: "ou", an: "an", en: "en", ang: "ah", eng: "eg", er: "er" };
const nameCache = new Map(), queryCache = new Map();
const compact = value => normalize(value).replace(/[\s.,，·'’-]/gu, "");

// shortcut: unseparated romanization chooses the fewest syllables; add alternate splits if an ambiguous author needs them.
function splitPinyin(value) {
  const costs = Array(value.length + 1).fill(Infinity), lengths = Array(value.length).fill(0);
  costs[value.length] = 0;
  for (let offset = value.length - 1; offset >= 0; offset--) {
    for (let size = Math.min(6, value.length - offset); size > 0; size--) {
      const syllable = value.slice(offset, offset + size);
      if (syllables.has(syllable) && costs[offset + size] + 1 < costs[offset]) {
        costs[offset] = costs[offset + size] + 1; lengths[offset] = size;
      }
    }
  }
  if (!Number.isFinite(costs[0])) return null;
  const parts = [];
  for (let offset = 0; offset < value.length; offset += lengths[offset]) parts.push(value.slice(offset, offset + lengths[offset]));
  return parts;
}

function romanParts(value, surname = false) {
  const roman = pinyin(value, { toneType: "none", type: "array", nonZh: "consecutive", surname: surname ? "head" : "off", v: true });
  return roman.flatMap(part => String(part).split(/[\s.,，·'’-]+/u).filter(Boolean).flatMap(word => {
    const vForm = normalize(word.replace(/[Üü]/gu, "v")).replace(/^([ln])yu$/u, "$1v");
    return splitPinyin(vForm) || splitPinyin(normalize(word)) || [normalize(word)];
  }));
}

function shuangpin(syllable) {
  if (zeroInitials[syllable]) return zeroInitials[syllable];
  const initial = syllable.match(/^(zh|ch|sh|[bpmfdtnlgkhjqxrzcsyw])/u)?.[0];
  const final = initial && finals[syllable.slice(initial.length)];
  return final ? ({ zh: "v", ch: "i", sh: "u" }[initial] || initial) + final : syllable;
}

function partsOf(creator) {
  const first = String(creator.firstName || "").trim(), last = String(creator.lastName || "").trim();
  const source = [first, last].filter(Boolean).join(" ");
  if (first && last && !creator.fieldMode) return { source, family: last, given: first };
  const comma = source.split(/[,，]/u).map(part => part.trim());
  if (comma.length === 2 && comma.every(Boolean)) return { source, family: comma[0], given: comma[1] };
  const words = source.split(/\s+/u);
  if (words.length === 2) {
    const reversedChinese = words.every(word => /^\p{Script=Han}+$/u.test(word))
      && (words[1].match(compoundSurnames)?.[0] === words[1] || [...words[1]].length === 1 && [...words[0]].length > 1 && !compoundSurnames.test(words[0]));
    return { source, family: words[reversedChinese ? 1 : 0], given: words[reversedChinese ? 0 : 1] };
  }
  if (/^\p{Script=Han}{2,5}$/u.test(source)) {
    const family = source.match(compoundSurnames)?.[0] || [...source][0];
    return { source, family, given: source.slice(family.length) };
  }
  return { source, family: source, given: "" };
}

function forms(creator, initials) {
  const { source, family, given } = partsOf(creator);
  const familyRoman = romanParts(family, true), givenRoman = romanParts(given);
  const aliases = new Set([normalize(source), compact(source)]);
  for (const order of given ? [[family, given], [given, family]] : [[family]]) {
    aliases.add(normalize(order.join(" "))); aliases.add(compact(order.join("")));
  }
  for (const order of given ? [[familyRoman, givenRoman], [givenRoman, familyRoman]] : [[familyRoman]]) {
    const syllableOrder = order.flat();
    aliases.add(order.map(part => part.join("")).join(" "));
    aliases.add(syllableOrder.join(" ")); aliases.add(syllableOrder.join(""));
    aliases.add(syllableOrder.map(shuangpin).join(""));
    aliases.add(syllableOrder.map(part => part.replace(/^([ln])v/u, "$1u")).join(""));
    aliases.add(syllableOrder.map(part => part.replace(/^([ln])v/u, "$1yu")).join(""));
  }
  if (initials && given) {
    const initialsForms = new Set([givenRoman.map(part => part[0]).join(""), romanParts(given)[0]?.[0],
      normalize(given).split(/[\s-]+/u).map(part => part[0]).join("")]);
    for (const abbreviation of initialsForms) if (abbreviation) {
      const surname = familyRoman.join("");
      aliases.add(`${surname} ${abbreviation}`); aliases.add(`${abbreviation} ${surname}`);
      aliases.add(surname + abbreviation); aliases.add(abbreviation + surname);
    }
  }
  const orders = [familyRoman.join("") + givenRoman.join(""), givenRoman.join("") + familyRoman.join("")];
  return { source, aliases: [...aliases].filter(Boolean), key: orders.sort()[0],
    title: han.test(source) && given && han.test(family) && han.test(given) ? family + given : source };
}

export function authorAliases(creator) {
  if (creator.aliases) return creator.aliases;
  const key = `${creator.fieldMode || 0}\0${creator.firstName || ""}\0${creator.lastName || ""}`;
  if (!nameCache.has(key)) {
    if (nameCache.size >= 20000) nameCache.delete(nameCache.keys().next().value);
    nameCache.set(key, forms(creator, true).aliases);
  }
  return nameCache.get(key);
}

function phoneticWildcardMatches(value, pattern) {
  value = compact(value); pattern = compact(pattern);
  let offsets = new Set(Array.from({ length: value.length + 1 }, (_, i) => i));
  for (const char of pattern) {
    const next = new Set();
    if (char === "*") {
      if (!offsets.size) return false;
      let first = value.length;
      for (const offset of offsets) if (offset < first) first = offset;
      for (let i = first; i <= value.length; i++) next.add(i);
    } else for (const offset of offsets) {
      if (char === "?") {
        for (let size = 1; size <= 6 && offset + size <= value.length; size++) {
          if (syllables.has(value.slice(offset, offset + size))) next.add(offset + size);
        }
      } else if (value[offset] === char) next.add(offset + 1);
    }
    offsets = next;
    if (!offsets.size) return false;
  }
  return !!offsets.size;
}

export function authorMatches(creator, value, { exact = false } = {}) {
  value = normalize(value);
  if (!value) return true;
  if (!queryCache.has(value)) {
    if (queryCache.size >= 256) queryCache.delete(queryCache.keys().next().value);
    queryCache.set(value, forms({ lastName: value, fieldMode: 1 }, false).aliases);
  }
  const candidates = authorAliases(creator);
  const chineseQuestion = han.test(value) && value.includes("?");
  return queryCache.get(value).some(query => candidates.some(alias => exact ? alias === query
    : filterMatches(alias, query) || chineseQuestion && phoneticWildcardMatches(alias, query)));
}

export function groupAuthors(records) {
  const groups = new Map();
  for (const record of records) {
    const data = forms(record, true);
    if (!data.source) continue;
    if (!groups.has(data.key)) groups.set(data.key, { kind: "author", key: data.key, title: data.title, labels: new Set(), aliases: new Set(), records: [], count: 0 });
    const row = groups.get(data.key);
    row.records.push(record); row.labels.add(data.source); row.count += Number(record.count) || 0;
    if (han.test(data.title) && !han.test(row.title)) row.title = data.title;
    for (const alias of data.aliases) row.aliases.add(alias);
  }
  return [...groups.values()].map(({ labels, aliases, ...row }) => ({ ...row, authors: [...labels].join(" · "), aliases: [...aliases] }))
    .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title));
}
