#!/usr/bin/env python3
"""Recreate a Postgres container on a new image of the SAME major version.

A minor update (17.x -> 17.11) only swaps binaries: the data directory is
reused as is. Docker cannot change a container's image in place, so this
rebuilds the `docker run` from `docker inspect` and keeps the old container,
stopped and renamed, for rollback. docs/POSTGRES_VERSION.md is the runbook.

  scripts/postgres-recreate.py pokoin-marketplace-postgres-15t postgres:17.11-alpine          # dry run
  scripts/postgres-recreate.py pokoin-marketplace-postgres-15t postgres:17.11-alpine --apply

Refuses, without touching anything, when:
- the new image is a different major than the data directory (PG_VERSION);
  a major upgrade needs pg_upgrade or dump/restore, not a container swap;
- the new image keeps its data somewhere else (Postgres 18+ images moved
  PGDATA) and the container does not pin PGDATA itself;
- the container uses a setting this script does not carry over.

On --apply, if the new container is not ready within --ready-timeout seconds,
it is removed and the old one is renamed back, reconnected and started.
"""
import argparse, json, os, re, subprocess, sys, tempfile, time

DEFAULT_SHM = 64 * 1024 * 1024
DEFAULT_NETWORKS = {"", "default", "bridge"}
# Non-default HostConfig settings that would be silently dropped: refuse instead.
UNSUPPORTED = ("Privileged", "Devices", "VolumesFrom", "Links", "Dns", "DnsSearch", "PidMode", "CgroupParent")


def docker(*args, capture=True, check=True):
    result = subprocess.run(["docker", *args], capture_output=capture, text=True)
    if check and result.returncode != 0:
        raise SystemExit(f"docker {' '.join(args[:2])} failed: {(result.stderr or '').strip()}")
    return result.stdout if capture else ""


def inspect(kind, name):
    return json.loads(docker(kind, "inspect", name))[0]


def major_of_tag(image):
    tag = image.rsplit(":", 1)[1] if ":" in image.rsplit("/", 1)[-1] else "latest"
    found = re.match(r"(\d+)", tag)
    return int(found.group(1)) if found else None


def env_dict(pairs):
    return dict(pair.split("=", 1) for pair in pairs or [] if "=" in pair)


def runtime_env(container, old_image):
    """Variables set with -e/--env-file: container env minus the image's own."""
    image_env = env_dict(old_image["Config"].get("Env"))
    return {k: v for k, v in env_dict(container["Config"].get("Env")).items() if image_env.get(k) != v}


def port_args(bindings):
    args = []
    for container_port, hosts in sorted((bindings or {}).items()):
        port = container_port[:-4] if container_port.endswith("/tcp") else container_port
        for host in hosts or []:
            ip, host_port = host.get("HostIp") or "", host.get("HostPort") or ""
            if ":" in ip:
                ip = f"[{ip}]"
            args += ["-p", f"{ip}:{host_port}:{port}" if ip else (f"{host_port}:{port}" if host_port else port)]
    return args


def mount_args(container):
    host = container["HostConfig"]
    args, covered = [], set()
    for bind in host.get("Binds") or []:
        args += ["-v", bind]
        covered.add(bind.split(":")[1])
    for mount in host.get("Mounts") or []:
        spec = [f"type={mount['Type']}", f"source={mount.get('Source', '')}", f"target={mount['Target']}"]
        if mount.get("ReadOnly"):
            spec.append("readonly")
        args += ["--mount", ",".join(spec)]
        covered.add(mount["Target"])
    for target, options in sorted((host.get("Tmpfs") or {}).items()):
        args += ["--tmpfs", f"{target}:{options}" if options else target]
        covered.add(target)
    # Anonymous or named volumes not given above (e.g. the image's VOLUME on
    # PGDATA): reuse them by name, or the new container gets an empty one.
    for mount in container.get("Mounts") or []:
        if mount.get("Type") == "volume" and mount["Destination"] not in covered:
            args += ["-v", f"{mount['Name']}:{mount['Destination']}"]
    return args


def network_plan(container):
    """(run args for the primary network, [(network, ip, aliases)] to connect after)."""
    mode = container["HostConfig"].get("NetworkMode") or "default"
    networks = container.get("NetworkSettings", {}).get("Networks") or {}
    def endpoint(name):
        settings = networks.get(name) or {}
        ip = ((settings.get("IPAMConfig") or {}).get("IPv4Address")) or ""
        implicit = {container["Name"].lstrip("/"), container["Config"].get("Hostname")}
        aliases = [a for a in settings.get("Aliases") or [] if not container["Id"].startswith(a) and a not in implicit]
        return ip, aliases
    run, extra = [], []
    if mode not in DEFAULT_NETWORKS:
        run += ["--network", mode]
        if mode not in ("host", "none") and not mode.startswith("container:"):
            ip, aliases = endpoint(mode)
            run += ["--ip", ip] if ip else []
            for alias in aliases:
                run += ["--network-alias", alias]
    primary = "bridge" if mode in DEFAULT_NETWORKS else mode
    for name in sorted(networks):
        if name != primary:
            extra.append((name, *endpoint(name)))
    return run, extra


def unsupported(container, old_image):
    host, problems = container["HostConfig"], []
    for key in UNSUPPORTED:
        if host.get(key):
            problems.append(f"HostConfig.{key}={host[key]!r}")
    if "com.docker.compose.project" in (container["Config"].get("Labels") or {}):
        problems.append("created by docker compose: update the image in its compose file instead")
    if any("\n" in value for value in runtime_env(container, old_image).values()):
        problems.append("an environment value contains a newline (cannot go through --env-file)")
    if host.get("IpcMode") not in (None, "", "private", "shareable"):
        problems.append(f"HostConfig.IpcMode={host['IpcMode']!r}")
    entry, image_entry = container["Config"].get("Entrypoint"), old_image["Config"].get("Entrypoint")
    if entry != image_entry and entry and len(entry) > 1:
        problems.append(f"Config.Entrypoint={entry!r} (more than one word)")
    return problems


def run_argv(container, old_image, new_image, env_file):
    config, host = container["Config"], container["HostConfig"]
    name = container["Name"].lstrip("/")
    argv = ["run", "-d", "--name", name]
    policy = host.get("RestartPolicy") or {}
    if policy.get("Name") and policy["Name"] != "no":
        retries = policy.get("MaximumRetryCount") or 0
        argv += ["--restart", f"{policy['Name']}:{retries}" if policy["Name"] == "on-failure" and retries else policy["Name"]]
    if config.get("User"):
        argv += ["--user", config["User"]]
    if host.get("ShmSize") and host["ShmSize"] != DEFAULT_SHM:
        argv += ["--shm-size", f"{host['ShmSize']}b"]
    if host.get("Memory"):
        argv += ["--memory", f"{host['Memory']}b"]
        swap = host.get("MemorySwap") or 0
        if swap not in (0, -1, 2 * host["Memory"]):
            argv += ["--memory-swap", f"{swap}b"]
    if host.get("NanoCpus"):
        argv += ["--cpus", f"{host['NanoCpus'] / 1e9:g}"]
    if config.get("StopSignal"):
        argv += ["--stop-signal", config["StopSignal"]]
    if config.get("StopTimeout") is not None:
        argv += ["--stop-timeout", str(config["StopTimeout"])]
    if host.get("Init"):
        argv += ["--init"]
    for flag, key in (("--cap-add", "CapAdd"), ("--cap-drop", "CapDrop"), ("--security-opt", "SecurityOpt"), ("--add-host", "ExtraHosts")):
        for value in host.get(key) or []:
            argv += [flag, value]
    for limit in host.get("Ulimits") or []:
        argv += ["--ulimit", f"{limit['Name']}={limit['Soft']}:{limit['Hard']}"]
    for key, value in sorted((host.get("Sysctls") or {}).items()):
        argv += ["--sysctl", f"{key}={value}"]
    log = host.get("LogConfig") or {}
    if log.get("Type") and log["Type"] != "json-file" or log.get("Config"):
        argv += ["--log-driver", log.get("Type") or "json-file"]
        for key, value in sorted((log.get("Config") or {}).items()):
            argv += ["--log-opt", f"{key}={value}"]
    if runtime_env(container, old_image):
        argv += ["--env-file", env_file]
    argv += port_args(host.get("PortBindings"))
    argv += mount_args(container)
    argv += network_plan(container)[0]
    entry = config.get("Entrypoint")
    if entry and entry != old_image["Config"].get("Entrypoint"):
        argv += ["--entrypoint", entry[0]]
    return argv + [new_image] + list(config.get("Cmd") or [])


def check(container, old_image, new_image_config, new_image, data_major):
    problems = unsupported(container, old_image)
    new_major = major_of_tag(new_image)
    if new_major is None or new_major != data_major:
        problems.append(f"data directory is Postgres {data_major}, {new_image} is not; a major upgrade needs pg_upgrade (docs/POSTGRES_VERSION.md)")
    run_env = runtime_env(container, old_image)
    old_pgdata = env_dict(old_image["Config"].get("Env")).get("PGDATA")
    new_pgdata = env_dict(new_image_config.get("Env")).get("PGDATA")
    if "PGDATA" not in run_env and old_pgdata != new_pgdata:
        problems.append(f"{new_image} keeps data in {new_pgdata}, the container uses {old_pgdata}; pin PGDATA first")
    return problems


def quote(argv):
    return " ".join(a if re.fullmatch(r"[\w@%+=:,./\[\]-]+", a) else "'" + a.replace("'", "'\\''") + "'" for a in argv)


def wait_ready(name, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if subprocess.run(["docker", "exec", name, "pg_isready", "-q"], capture_output=True).returncode == 0:
            return True
        time.sleep(1)
    return False


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("container")
    parser.add_argument("image", help="new image, same major, e.g. postgres:17.11-alpine")
    parser.add_argument("--apply", action="store_true", help="do it (default: print the plan only)")
    parser.add_argument("--stop-timeout", type=int, default=60)
    parser.add_argument("--ready-timeout", type=int, default=180)
    args = parser.parse_args()

    container = inspect("container", args.container)
    name = container["Name"].lstrip("/")
    old_image = inspect("image", container["Image"])
    pgdata = env_dict(container["Config"].get("Env")).get("PGDATA", "/var/lib/postgresql/data")
    data_major = int(docker("exec", name, "cat", f"{pgdata}/PG_VERSION").strip().split(".")[0]) \
        if container["State"].get("Running") else major_of_tag(container["Config"]["Image"])
    running = docker("exec", name, "postgres", "--version").strip() if container["State"].get("Running") else "(stopped)"
    if args.apply:
        docker("pull", args.image, capture=False)
    try:
        new_image_config = inspect("image", args.image)["Config"]
    except SystemExit:
        raise SystemExit(f"{args.image} is not pulled yet: run `docker pull {args.image}` (or --apply, which pulls)")

    problems = check(container, old_image, new_image_config, args.image, data_major)
    if problems:
        raise SystemExit("refusing:\n  - " + "\n  - ".join(problems))

    suffix = re.sub(r"[^\w.-]", "-", args.image.rsplit(":", 1)[-1])
    backup = f"{name}-pre-{suffix}"
    env = runtime_env(container, old_image)
    _, extra = network_plan(container)
    fd, env_file = tempfile.mkstemp(prefix="pg-recreate-", suffix=".env")
    os.close(fd)
    argv = run_argv(container, old_image, args.image, env_file)
    print(f"{name}: {running}, data directory Postgres {data_major}, image {container['Config']['Image']} -> {args.image}")
    print(f"keep old container as {backup} (stopped, restart=no)")
    print("env carried over (values hidden): " + (", ".join(sorted(env)) or "none"))
    print("docker " + quote(argv))
    for network, ip, aliases in extra:
        print("docker " + quote(["network", "connect", *(["--ip", ip] if ip else []), *sum((["--alias", a] for a in aliases), []), network, name]))
    if not args.apply:
        os.unlink(env_file)
        print("dry run: nothing changed. Re-run with --apply.")
        return

    os.chmod(env_file, 0o600)
    with open(env_file, "w") as handle:
        handle.writelines(f"{k}={v}\n" for k, v in env.items())

    def restore(reason):
        print(f"ROLLBACK: {reason}", file=sys.stderr)
        docker("rm", "-f", name, check=False)
        docker("rename", backup, name, check=False)
        docker("update", "--restart", (container["HostConfig"].get("RestartPolicy") or {}).get("Name") or "no", name, check=False)
        for network, ip, aliases in extra:
            docker("network", "connect", *(["--ip", ip] if ip else []), *sum((["--alias", a] for a in aliases), []), network, name, check=False)
        docker("start", name, check=False)
        raise SystemExit(f"rolled back to the old container; check `docker logs {name}`")

    try:
        docker("stop", "-t", str(args.stop_timeout), name)
        for network, _, _ in extra:
            docker("network", "disconnect", network, name, check=False)
        docker("rename", name, backup)
        docker("update", "--restart", "no", backup)
        result = subprocess.run(["docker", *argv], capture_output=True, text=True)
        if result.returncode != 0:
            restore(f"docker run failed: {result.stderr.strip()}")
        for network, ip, aliases in extra:
            connect = subprocess.run(["docker", "network", "connect", *(["--ip", ip] if ip else []), *sum((["--alias", a] for a in aliases), []), network, name], capture_output=True, text=True)
            if connect.returncode != 0:
                restore(f"network connect {network} failed: {connect.stderr.strip()}")
        if not wait_ready(name, args.ready_timeout):
            restore(f"not ready after {args.ready_timeout}s")
    finally:
        if os.path.exists(env_file):
            os.unlink(env_file)
    print(f"ready: {docker('exec', name, 'postgres', '--version').strip()}")
    print(f"rollback: docker rm -f {name} && docker rename {backup} {name} && docker start {name}  (then reconnect networks above)")
    print(f"once happy: docker rm {backup}")


if __name__ == "__main__":
    main()
