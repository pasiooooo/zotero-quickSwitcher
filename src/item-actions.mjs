// SPDX-License-Identifier: AGPL-3.0-or-later
import { t } from "./i18n.mjs";

export function itemWebURL(item) {
  const doi = Zotero.Utilities.cleanDOI(item.getField("DOI") || "");
  if (doi) return "https://doi.org/" + encodeURIComponent(doi).replaceAll("%2F", "/");
  const value = item.getField("url");
  if (!value) throw new Error(t("条目没有 DOI 或 URL"));
  let url;
  try { url = new URL(value); } catch { throw new Error(t("条目 URL 无效")); }
  if (!["https:", "http:"].includes(url.protocol)) throw new Error(t("条目 URL 无效"));
  return url.href;
}
