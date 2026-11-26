import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
try {
  for (const name of ["esbuild", "pinyin-pro"]) await access(path.join(root, "node_modules", name, "package.json"));
} catch { throw new Error("Run npm ci in this checkout before building; parent dependencies are not release inputs."); }
const { build } = await import("esbuild");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const manifest = JSON.parse(await readFile(path.join(root, "addon/manifest.json"), "utf8"));
const compatibility = manifest.applications.zotero;
const repository = pkg.repository.url.replace(/\.git$/, "");
const expectedFeed = `${repository.replace("https://github.com/", "https://raw.githubusercontent.com/")}/main/updates.json`;
if (manifest.version !== pkg.version || compatibility.update_url !== expectedFeed) {
  throw new Error("The install manifest must match the package version and public update feed.");
}
if (!pkg.author || manifest.author !== pkg.author || manifest.homepage_url !== repository) {
  throw new Error("The install manifest must match the package author and link to its repository.");
}

const { outputFiles } = await build({ absWorkingDir: root, entryPoints: ["src/index.mjs"], bundle: true,
  write: false, format: "iife", globalName: "QuickSwitcher", target: "firefox128", legalComments: "eof" });
const filename = `${pkg.name}-${pkg.version}.xpi`;
const out = path.join(root, "dist", filename);
await mkdir(path.dirname(out), { recursive: true });
const python = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
execFileSync(python, [path.join(root, "scripts/package_xpi.py"), path.join(root, "addon"), out], { input: outputFiles[0].contents });
const update = { version: pkg.version, update_link: `${repository}/releases/download/v${pkg.version}/${filename}`,
  update_hash: `sha256:${createHash("sha256").update(await readFile(out)).digest("hex")}`,
  applications: { zotero: { strict_min_version: compatibility.strict_min_version, strict_max_version: compatibility.strict_max_version } } };
await writeFile(path.join(root, "updates.json"), JSON.stringify({ addons: { [compatibility.id]: { updates: [update] } } }, null, 2) + "\n");
console.log(`dist/${filename}  ${update.update_hash}`);
