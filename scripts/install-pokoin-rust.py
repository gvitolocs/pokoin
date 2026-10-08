#!/usr/bin/env python3
"""Install one verified native artifact, restoring the previous release on failure."""
import argparse, fcntl, hashlib, json, os, pathlib, re, shlex, subprocess, sys, time, urllib.request

BASE = pathlib.Path("/srv/pokoin/rust")
UNIT = pathlib.Path("/etc/systemd/system/pokoin-rust-api.service")
ENV = BASE / "pokoin-api.env"
CURRENT = BASE / "current"
SERVICE = "pokoin-rust-api.service"

def run(*args):
    return subprocess.check_output(args, text=True).strip()

def env_values(text):
    values = {}
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        key, sep, raw = line.partition("=")
        if sep and re.fullmatch(r"[A-Za-z_][A-Za-z_0-9]*", key.strip()):
            parts = shlex.split(raw, posix=True)
            values[key.strip()] = parts[0] if parts else ""
    return values

def env_text(values):
    # EnvironmentFile double quotes preserve spaces and literal PEM backslashes.
    def quote(value):
        return '"' + value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n") + '"'
    return "".join(f"{key}={quote(value)}\n" for key, value in sorted(values.items()))

def atomic_bytes(path, data, mode):
    temp = path.with_name(path.name + ".install")
    with open(temp, "wb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temp, mode)
    os.replace(temp, path)

def point(path, target):
    temp = path.with_name(path.name + ".install")
    temp.unlink(missing_ok=True)
    temp.symlink_to(target)
    os.replace(temp, path)

def healthy(commit, timeout=35):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        try:
            with urllib.request.urlopen("http://127.0.0.1:18082/health", timeout=2) as response:
                data = json.load(response)
            if all(data.get(key) is True for key in ("ready", "db", "redis")) and data.get("release") == commit:
                return data
        except (OSError, ValueError):
            pass
        time.sleep(1)
    raise RuntimeError("native readiness/release check failed")

def install(args):
    candidate = pathlib.Path(args.candidate)
    if hashlib.sha256(candidate.read_bytes()).hexdigest() != args.sha256:
        raise RuntimeError("artifact digest mismatch")
    version = json.loads(run(str(candidate), "--version"))
    if version.get("commit") != args.commit or version.get("dirty") is not False:
        raise RuntimeError("artifact is not a clean build of the requested commit")
    if not re.fullmatch(r"[0-9a-f]{40}", args.commit):
        raise RuntimeError("a full commit SHA is required")
    BASE.mkdir(parents=True, exist_ok=True)
    lock = open(BASE / "deploy.lock", "a")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    old_target = os.readlink(CURRENT) if CURRENT.is_symlink() else None
    if CURRENT.exists() and old_target is None:
        raise RuntimeError("current release is not a managed symlink")
    backup = BASE / "rollbacks" / f"{int(time.time())}-{args.commit[:12]}"
    backup.mkdir(parents=True)
    saved = {}
    for path in (ENV, UNIT):
        saved[path] = (path.read_bytes(), path.stat().st_mode & 0o777, path.stat().st_uid, path.stat().st_gid) if path.exists() else None
        if saved[path]:
            atomic_bytes(backup / path.name, saved[path][0], saved[path][1])
    atomic_bytes(backup / "release.json", json.dumps({"previous": old_target, "next": args.commit, "sha256": args.sha256}).encode(), 0o600)
    values = env_values(saved[ENV][0].decode()) if saved[ENV] else {}
    deployed = json.loads(run("docker", "inspect", "pokoin-oracle-api"))[0]["Config"]["Env"]
    # Existing native settings win; the legacy image supplies configured service bindings.
    for entry in deployed:
        key, sep, value = entry.partition("=")
        if sep and key not in {"PATH","NODE_VERSION","YARN_VERSION","HOME","HOSTNAME","PORT","NODE_ENV"}:
            values.setdefault(key, value)
    values["POKOIN_RUST_RELEASE"] = args.commit
    values["MARKETPLACE_SEARCH_ENGINE"] = "redis"
    destination = BASE / "releases" / f"pokoin-api-{args.commit[:12]}-aarch64"
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() and hashlib.sha256(destination.read_bytes()).hexdigest() != args.sha256:
        raise RuntimeError("release path already contains a different artifact")
    atomic_bytes(destination, candidate.read_bytes(), 0o755)
    try:
        atomic_bytes(ENV, env_text(values).encode(), 0o640)
        run("chown", "root:nes", str(ENV))
        atomic_bytes(UNIT, pathlib.Path(args.unit).read_bytes(), 0o644)
        point(CURRENT, destination)
        run("systemctl", "daemon-reload")
        run("systemctl", "restart", SERVICE)
        health = healthy(args.commit)
        if old_target:
            point(BASE / "previous", old_target)
        print(json.dumps({"event":"native_release_installed","commit":args.commit,"sha256":args.sha256,"health":health,"rollback":str(backup)}))
    except Exception:
        for path, original in saved.items():
            if original:
                atomic_bytes(path, original[0], original[1])
                os.chown(path, original[2], original[3])
            else:
                path.unlink(missing_ok=True)
        if old_target:
            point(CURRENT, old_target)
        else:
            CURRENT.unlink(missing_ok=True)
        run("systemctl", "daemon-reload")
        run("systemctl", "restart" if old_target else "stop", SERVICE)
        print(json.dumps({"event":"native_release_rolled_back","commit":args.commit,"previous":old_target,"backup":str(backup)}), file=sys.stderr)
        raise

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    for name in ("candidate","commit","sha256","unit"):
        parser.add_argument("--"+name, required=True)
    install(parser.parse_args())
