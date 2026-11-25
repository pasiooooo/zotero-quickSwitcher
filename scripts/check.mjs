import { readdir, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
for (const dir of ["src", "scripts", "tests", "addon"]) {
  const files = await readdir(path.join(root, dir), { recursive: true });
  for (const file of files.filter(f => /\.(?:mjs|js)$/.test(f))) {
    execFileSync(process.execPath, ["--check", path.join(root, dir, file)], { stdio: "inherit" });
  }
}
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const manifest = JSON.parse(await readFile(path.join(root, "addon/manifest.json"), "utf8"));
if (manifest.version !== pkg.version) throw new Error("Package/manifest versions differ");
if (!manifest.applications?.zotero?.update_url) throw new Error("Zotero plugin installer requires update_url metadata");
const fragment = await readFile(path.join(root, "addon/content/preferences.xhtml"), "utf8");
if (fragment.includes("<?xml")) throw new Error("Preference panes must be XML fragments without a document declaration");
console.log("Syntax and manifest checks passed");
