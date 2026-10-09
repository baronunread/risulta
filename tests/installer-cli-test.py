"""Check CLI installation from a file and from stdin using disposable paths."""
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile

source = Path("deploy/install.sh").read_text()
function = source[source.index("install_cli() {"):source.index("\nsay() {")]
fixture = b"#!/bin/sh\nprintf '%s\\n' \"$@\"\n"
for piped, bad_checksum in [(False, False), (True, False), (True, True)]:
    with tempfile.TemporaryDirectory(prefix="risulta-cli-test-") as directory:
        root = Path(directory)
        (root / "bin").mkdir()
        (root / "env").mkdir()
        (root / "fixture").write_bytes(fixture)
        digest = "0" * 64 if bad_checksum else hashlib.sha256(fixture).hexdigest()
        (root / "checksum").write_text(digest + "  install.sh\n")
        mocks = root / "mocks"
        mocks.mkdir()
        curl = mocks / "curl"
        curl.write_text("#!/bin/sh\nwhile [ \"$#\" -gt 0 ]; do case \"$1\" in -o) output=$2; shift 2;; https:*) url=$1; shift;; *) shift;; esac; done\ncase \"$url\" in *.sha256) cp \"$TEST_ROOT/checksum\" \"$output\";; *) cp \"$TEST_ROOT/fixture\" \"$output\";; esac\n")
        curl.chmod(0o755)
        body = "set -eu\n" + function.replace("/usr/local/bin/risulta", str(root / "bin/risulta"))
        body += "\nfail() { echo \"$*\" >&2; exit 1; }\n"
        body += f"ENV_DIR='{root}/env'\ntmp_dir='{root}'\ndownload_base=https://example.test/v0.1.8\ninstall_cli\n"
        script = root / "install.sh"
        script.write_text(body)
        env = os.environ.copy()
        env.update(TEST_ROOT=str(root), PATH=str(mocks) + os.pathsep + env["PATH"])
        result = subprocess.run(["sh"] if piped else ["sh", str(script)], input=body if piped else None, env=env, text=True, capture_output=True)
        assert result.returncode == (1 if bad_checksum else 0), result.stderr
        cached = root / "env/installer.sh"
        if bad_checksum:
            assert not cached.exists() and not (root / "bin/risulta").exists()
        else:
            assert cached.read_bytes() == (fixture if piped else script.read_bytes())
            assert cached.stat().st_mode & 0o777 == 0o600
            assert (root / "bin/risulta").stat().st_mode & 0o777 == 0o755
            assert "python" not in (root / "bin/risulta").read_text()
print("CLI installation OK (file, stdin, private installer, verified download and checksum failure)")
