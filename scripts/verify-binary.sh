#!/bin/sh
# Verify the exact standalone artifact, with isolated state for every suite.
set -eu
[ "$#" -eq 1 ] || { echo "Usage: sh scripts/verify-binary.sh PATH_TO_BINARY" >&2; exit 2; }
python3 - "$1" <<'PY'
import hashlib
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

binary = Path(sys.argv[1]).resolve(strict=True)
root = Path.cwd()
if not os.access(binary, os.X_OK):
    sys.exit(f"Binary is not executable: {binary}")

def digest():
    return hashlib.sha256(binary.read_bytes()).hexdigest()

original = digest()

def interrupted(signum, frame):
    raise SystemExit(128 + signum)

signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)

def stop(process):
    if process is None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=5)
    # A child may survive the session leader's exit.
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass

with tempfile.TemporaryDirectory(prefix="risulta-verify-") as scratch:
    for trust in (0, 1):
        for suite in ("seed.sh", "verify.sh", "tests/features-integration.py"):
            label = f"{suite.replace(chr(47), chr(95))}-trust-{trust}"
            state = Path(scratch) / label
            state.mkdir()
            with socket.socket() as probe:
                probe.bind(("127.0.0.1", 0))
                port = probe.getsockname()[1]
            base = f"http://127.0.0.1:{port}"
            env = os.environ.copy()
            env.pop("SB_TRUSTED_PROXIES", None)
            env.update(SB_DATA_DIR=str(state), PORT=str(port),
                       BASE=base, EXPECT_TRUST=str(trust),
                       RISULTA_BASE_URL=base,
                       RISULTA_ADMIN_EMAIL="admin@example.com",
                       RISULTA_ADMIN_DISPLAY_NAME="Admin",
                       RISULTA_ADMIN_PASSWORD="change-me-verify-0001",
                       ADMIN_EMAIL="admin@example.com",
                       ADMIN_PASSWORD="change-me-verify-0001")
            if trust:
                env["SB_TRUSTED_PROXIES"] = "127.0.0.1"
            server = checks = None
            log_path = Path(scratch) / f"{label}.log"
            print(f"Testing {binary.name}: {label}", flush=True)
            try:
                with log_path.open("w+") as log:
                    # Run away from the checkout so bundled assets must work.
                    server = subprocess.Popen([str(binary)], cwd=state, env=env,
                                              stdout=log, stderr=log, start_new_session=True)
                    deadline = time.monotonic() + 30
                    while True:
                        if server.poll() is not None:
                            raise RuntimeError("Server exited before readiness")
                        try:
                            with urllib.request.urlopen(env["BASE"] + "/healthz", timeout=1) as response:
                                if response.status == 200:
                                    break
                        except (OSError, ValueError):
                            pass
                        if time.monotonic() >= deadline:
                            raise TimeoutError("Server readiness exceeded 30 seconds")
                        time.sleep(0.2)
                    if suite == "seed.sh" and trust == 0:
                        child_env = env.copy()
                        child_env.update(RISULTA_MAINTENANCE_CHILD="1", PORT="0")
                        child = subprocess.run([str(binary)], cwd=state, env=child_env,
                                               capture_output=True, text=True, timeout=10)
                        child_output = child.stdout + child.stderr
                        if child.returncode or '"type":"maintenance"' not in child_output or "server listening" in child_output:
                            raise RuntimeError("One-shot maintenance entry failed: " + child_output)
                        print("One-shot maintenance entry passed without opening an HTTP listener.", flush=True)
                    runner = "python3" if suite.endswith(".py") else "sh"
                    checks = subprocess.Popen([runner, str(root / suite)], cwd=root,
                                              env=env, start_new_session=True)
                    code = checks.wait(timeout=180)
                    if code:
                        raise RuntimeError(f"{label} exited {code}")
                    if server.poll() is not None:
                        raise RuntimeError("Server exited during verification")
            except BaseException:
                print(log_path.read_text(errors="replace"), file=sys.stderr)
                raise
            finally:
                stop(checks)
                stop(server)
if digest() != original:
    sys.exit("Artifact changed during verification")
print("Seed and all verification checks passed in both proxy modes.")
PY
