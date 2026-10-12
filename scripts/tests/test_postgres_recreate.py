import copy, importlib.util, json, pathlib, subprocess, sys, unittest
from unittest.mock import patch

SOURCE = pathlib.Path(__file__).parents[1] / "postgres-recreate.py"
spec = importlib.util.spec_from_file_location("recreate", SOURCE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

IMAGE_ENV = ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "PG_MAJOR=17",
             "PG_VERSION=17.6", "PGDATA=/var/lib/postgresql/data"]
OLD_IMAGE = {"Config": {"Env": IMAGE_ENV, "Entrypoint": ["docker-entrypoint.sh"]}}
NEW_IMAGE = {"Config": {"Env": [e.replace("17.6", "17.11") for e in IMAGE_ENV], "Entrypoint": ["docker-entrypoint.sh"]}}
PG18_IMAGE = {"Config": {"Env": ["PG_MAJOR=18", "PG_VERSION=18.6", "PGDATA=/var/lib/postgresql/18/docker"],
                         "Entrypoint": ["docker-entrypoint.sh"]}}

# The nezopt writer as scripts/install-pokoin-postgres-nvme.sh creates it, plus
# the pokoin-overflow attachment scripts/nezopt-k3s.sh adds.
WRITER = {
    "Id": "0123456789abcdef0123",
    "Name": "/pokoin-marketplace-postgres-15t",
    "Image": "sha256:old",
    "State": {"Running": True},
    "Config": {
        "Image": "postgres:17-alpine", "User": "1000:1000", "Hostname": "0123456789ab",
        "StopSignal": "SIGINT", "Entrypoint": ["docker-entrypoint.sh"], "Labels": {},
        "Env": ["POSTGRES_USER=pokoin_marketplace", "POSTGRES_PASSWORD=s3cret", "POSTGRES_DB=pokoin_marketplace", *IMAGE_ENV],
        "Cmd": ["postgres", "-c", "listen_addresses=*", "-c", "wal_level=replica"],
    },
    "HostConfig": {
        "RestartPolicy": {"Name": "unless-stopped", "MaximumRetryCount": 0},
        "ShmSize": 5 * 1024 ** 3, "Memory": 16 * 1024 ** 3, "MemorySwap": 32 * 1024 ** 3,
        "PortBindings": {"5432/tcp": [{"HostIp": "127.0.0.1", "HostPort": "25432"},
                                      {"HostIp": "192.168.178.55", "HostPort": "25432"}]},
        "Binds": ["/home/nez/data/pokoin-marketplace-postgres/data:/var/lib/postgresql/data",
                  "/home/nez/data/pokoin-marketplace-postgres/run:/var/run/postgresql"],
        "NetworkMode": "default", "LogConfig": {"Type": "json-file", "Config": {}}, "IpcMode": "private",
    },
    "Mounts": [{"Type": "bind", "Destination": "/var/lib/postgresql/data"},
               {"Type": "bind", "Destination": "/var/run/postgresql"}],
    "NetworkSettings": {"Networks": {
        "bridge": {"IPAMConfig": None, "Aliases": None},
        "pokoin-overflow": {"IPAMConfig": {"IPv4Address": "172.31.250.10"}, "Aliases": ["0123456789ab"]},
    }},
}


class PlanTests(unittest.TestCase):
    def test_writer_run_command_keeps_every_setting(self):
        argv = module.run_argv(WRITER, OLD_IMAGE, "postgres:17.11-alpine", "/tmp/x.env")
        self.assertEqual(argv, [
            "run", "-d", "--name", "pokoin-marketplace-postgres-15t", "--restart", "unless-stopped",
            "--user", "1000:1000", "--shm-size", f"{5 * 1024 ** 3}b", "--memory", f"{16 * 1024 ** 3}b",
            "--stop-signal", "SIGINT", "--env-file", "/tmp/x.env",
            "-p", "127.0.0.1:25432:5432", "-p", "192.168.178.55:25432:5432",
            "-v", "/home/nez/data/pokoin-marketplace-postgres/data:/var/lib/postgresql/data",
            "-v", "/home/nez/data/pokoin-marketplace-postgres/run:/var/run/postgresql",
            "postgres:17.11-alpine", "postgres", "-c", "listen_addresses=*", "-c", "wal_level=replica",
        ])

    def test_only_runtime_env_is_carried_over(self):
        self.assertEqual(module.runtime_env(WRITER, OLD_IMAGE), {
            "POSTGRES_USER": "pokoin_marketplace", "POSTGRES_PASSWORD": "s3cret", "POSTGRES_DB": "pokoin_marketplace"})

    def test_static_ip_network_is_reconnected(self):
        run, extra = module.network_plan(WRITER)
        self.assertEqual(run, [])
        self.assertEqual(extra, [("pokoin-overflow", "172.31.250.10", [])])

    def test_anonymous_volume_is_reused_by_name(self):
        replica = copy.deepcopy(WRITER)
        replica["HostConfig"]["Binds"] = []
        replica["Mounts"] = [{"Type": "volume", "Name": "abc123", "Destination": "/var/lib/postgresql/data"}]
        self.assertEqual(module.mount_args(replica), ["-v", "abc123:/var/lib/postgresql/data"])

    def test_ports_without_host_ip_or_port(self):
        self.assertEqual(module.port_args({"5432/tcp": [{"HostIp": "", "HostPort": "5432"}],
                                           "9187/tcp": [{"HostIp": "::1", "HostPort": ""}]}),
                         ["-p", "5432:5432", "-p", "[::1]::9187"])

    def test_same_major_minor_update_passes(self):
        self.assertEqual(module.check(WRITER, OLD_IMAGE, NEW_IMAGE["Config"], "postgres:17.11-alpine", 17), [])

    def test_major_upgrade_is_refused(self):
        problems = module.check(WRITER, OLD_IMAGE, PG18_IMAGE["Config"], "postgres:18.6-alpine", 17)
        self.assertTrue(any("pg_upgrade" in p for p in problems))
        self.assertTrue(any("pin PGDATA" in p for p in problems))

    def test_compose_and_privileged_containers_are_refused(self):
        odd = copy.deepcopy(WRITER)
        odd["Config"]["Labels"] = {"com.docker.compose.project": "pi"}
        odd["HostConfig"]["Privileged"] = True
        problems = module.unsupported(odd, OLD_IMAGE)
        self.assertEqual(len(problems), 2)


class ApplyTests(unittest.TestCase):
    def run_main(self, ready):
        calls = []
        def fake_run(command, capture_output=False, text=False):
            calls.append(command)
            args = command[1:]
            out = ""
            if args[:2] == ["container", "inspect"]:
                out = json.dumps([WRITER])
            elif args[:2] == ["image", "inspect"]:
                out = json.dumps([OLD_IMAGE if args[2] == "sha256:old" else NEW_IMAGE])
            elif args[-2:] == ["cat", "/var/lib/postgresql/data/PG_VERSION"]:
                out = "17\n"
            elif args[-2:] == ["postgres", "--version"]:
                out = "postgres (PostgreSQL) 17.6\n"
            elif "pg_isready" in args:
                return subprocess.CompletedProcess(command, 0 if ready else 2, "", "")
            return subprocess.CompletedProcess(command, 0, out, "")
        argv = ["postgres-recreate.py", "pokoin-marketplace-postgres-15t", "postgres:17.11-alpine", "--apply", "--ready-timeout", "1"]
        with patch.object(module.subprocess, "run", side_effect=fake_run), patch.object(sys, "argv", argv), \
             patch.object(module.time, "sleep"):
            try:
                module.main()
                outcome = "ok"
            except SystemExit as exit:
                outcome = str(exit)
        return outcome, [c[1:] for c in calls]

    def test_apply_swaps_container_and_reconnects_overflow_network(self):
        outcome, calls = self.run_main(ready=True)
        self.assertEqual(outcome, "ok")
        order = [c[:2] for c in calls if c[0] in ("stop", "rename", "run", "network", "update")]
        self.assertEqual(order, [["stop", "-t"], ["network", "disconnect"], ["rename", "pokoin-marketplace-postgres-15t"],
                                 ["update", "--restart"], ["run", "-d"], ["network", "connect"]])
        self.assertIn(["network", "connect", "--ip", "172.31.250.10", "pokoin-overflow", "pokoin-marketplace-postgres-15t"], calls)
        self.assertFalse(any(c[0] == "rm" for c in calls))

    def test_not_ready_rolls_back_to_old_container(self):
        outcome, calls = self.run_main(ready=False)
        self.assertIn("rolled back", outcome)
        self.assertIn(["rm", "-f", "pokoin-marketplace-postgres-15t"], calls)
        self.assertIn(["rename", "pokoin-marketplace-postgres-15t-pre-17.11-alpine", "pokoin-marketplace-postgres-15t"], calls)
        self.assertIn(["update", "--restart", "unless-stopped", "pokoin-marketplace-postgres-15t"], calls)
        self.assertEqual(calls[-1], ["start", "pokoin-marketplace-postgres-15t"])

    def test_password_never_reaches_the_command_line(self):
        _, calls = self.run_main(ready=True)
        self.assertFalse(any("s3cret" in part for c in calls for part in c))


if __name__ == "__main__":
    unittest.main()
