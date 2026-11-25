import test from "node:test";
import { execFileSync } from "node:child_process";

test("XPI packaging is deterministic, ignores unlisted files and fails on missing runtime files", () => {
  const python = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
  execFileSync(python, ["-B", "-c", String.raw`
from pathlib import Path
import shutil, subprocess, sys, tempfile, zipfile
root = Path.cwd()
with tempfile.TemporaryDirectory() as temp:
    stage = Path(temp) / "addon"
    shutil.copytree(root / "addon", stage)
    target = Path(temp) / "plugin.xpi"
    command = [sys.executable, root / "scripts/package_xpi.py", stage, target]
    def pack():
        return subprocess.run(command, input=b"fixture bundle", capture_output=True)
    assert pack().returncode == 0
    before = target.read_bytes()
    (stage / "content/unlisted.js").write_text("must stay local")
    (stage / ".env").write_text("not a release file")
    assert pack().returncode == 0 and before == target.read_bytes()
    with zipfile.ZipFile(target) as archive:
        assert archive.testzip() is None
        assert archive.read("content/quickswitcher.js") == b"fixture bundle"
        assert {"manifest.json", "content/THIRD-PARTY-LICENSES.txt"} <= set(archive.namelist())
        assert "content/unlisted.js" not in archive.namelist() and ".env" not in archive.namelist()
    (stage / "content/preferences.js").unlink()
    assert pack().returncode != 0 and before == target.read_bytes()
`]);
});
