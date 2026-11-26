from io import BytesIO
from pathlib import Path
import sys
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


source, target = map(Path, sys.argv[1:])
files = ("bootstrap.js", "manifest.json", "content/THIRD-PARTY-LICENSES.txt", "content/clipboard-worker.js",
         "content/global.xhtml", "content/hotkey-worker.js", "content/icon.svg", "content/pdf-outline-data.js",
         "content/pdf-preview.html", "content/pdf-preview.js", "content/preferences.js", "content/preferences.xhtml",
         "content/style.css", "content/zotero-command.svg")
entries = {name: (source / name).read_bytes() for name in files}
entries["LICENSE"] = (Path(__file__).resolve().parents[1] / "LICENSE").read_bytes()
entries["content/quickswitcher.js"] = sys.stdin.buffer.read()
if not entries["content/quickswitcher.js"]:
    raise SystemExit("Missing compiled launcher")
buffer = BytesIO()
with ZipFile(buffer, "w") as archive:
    for name, data in sorted(entries.items()):
        entry = ZipInfo(name)
        entry.create_system = 3
        entry.external_attr = 0o100644 << 16
        archive.writestr(entry, data, compress_type=ZIP_DEFLATED)
target.write_bytes(buffer.getvalue())
