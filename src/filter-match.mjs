// SPDX-License-Identifier: AGPL-3.0-or-later
import { normalize } from "./core.mjs";

export function filterMatches(value, pattern, { exact = false } = {}) {
  value = normalize(value); pattern = normalize(pattern);
  if (exact) return value === pattern;
  if (!/[*?]/u.test(pattern)) return value.includes(pattern);
  const text = [...value], glob = [...`*${pattern}*`];
  let i = 0, j = 0, star = -1, retry = 0;
  while (i < text.length) {
    if (glob[j] === "*") { star = j++; retry = i; }
    else if (glob[j] === "?" || glob[j] === text[i]) { i++; j++; }
    else if (star >= 0) { j = star + 1; i = ++retry; }
    else return false;
  }
  while (glob[j] === "*") j++;
  return j === glob.length;
}
