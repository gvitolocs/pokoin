#!/usr/bin/env python3
"""Daily report/notification regressions; no network or real imports."""
import contextlib
import importlib.util
import io
import json
import os
import pathlib
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = pathlib.Path(__file__).parent
spec = importlib.util.spec_from_file_location("daily_notify", SCRIPTS / "cardtrader-daily-notify.py")
notify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notify)
START = "2026-10-01T23:00:10Z"
FRESH = {"state": "fresh", "dumpDay": "2026-10-01", "sourceTimestamp": "2026-10-02T02:27:50+00:00", "printings": 62125}
STAGES = dict.fromkeys(["preflight", "catalog", "pictures", "picture-sync", "artwork", "search", "dump"], 0)


class DailySummaryTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = pathlib.Path(self.folder.name) / "2026-10-01"
        self.root.mkdir()
        self.listing = {
            "startedAt": "2026-10-01T23:19:04Z", "finishedAt": "2026-10-02T04:04:48Z",
            "totalExpansions": 3383, "completed": 3383, "listings": 20325458, "errors": [],
        }
        self.write_reports()

    def write_reports(self, errors=None):
        (self.root / "listing-dump-status.json").write_text(json.dumps(self.listing))
        (self.root / "status.json").write_text(json.dumps({"errors": errors or []}))

    def summary(self, code=0, stages=None, analytics=None):
        return notify.build_summary(self.root, START, code, stages or STAGES, analytics or FRESH)

    def test_complete_dump_and_fresh_price_writer_are_reported_separately(self):
        result = self.summary()
        self.assertEqual(result["status"], "complete")
        self.assertTrue(result["rawDumpComplete"])
        self.assertIn("3383/3383 expansions, 20325458 listings", result["message"])
        self.assertIn("source refresh 2026-10-02T02:27:50+00:00, dump bucket 2026-10-01", result["message"])

    def test_other_game_catalogue_failure_does_not_hide_successful_price_dump(self):
        self.write_reports([{"database": "pokoin_dragon_ball_super", "error": "Unfetched expansions: 1"}])
        result = self.summary(1, {**STAGES, "catalog": 1})
        self.assertEqual(result["status"], "partial")
        self.assertIn("Raw listing dump complete", result["message"])
        self.assertIn("price analytics: fresh", result["message"])
        self.assertIn("Failed stages: catalog", result["message"])
        self.assertIn("Catalogue failures: pokoin_dragon_ball_super", result["message"])

    def test_preflight_failure_is_named_without_hiding_successful_dump(self):
        result = self.summary(1, {**STAGES, "preflight": 1})
        self.assertEqual(result["status"], "partial")
        self.assertTrue(result["rawDumpComplete"])
        self.assertIn("Failed stages: preflight.", result["message"])

    def test_dump_stopped_at_deadline_is_reported_as_failed(self):
        self.listing.update({"completed": 1200, "stoppedAtDeadline": True, "maxSeconds": 36000})
        self.write_reports()
        result = self.summary(1, {**STAGES, "dump": 75})
        self.assertEqual(result["status"], "failed")
        self.assertFalse(result["rawDumpComplete"])
        self.assertIn("stopped at its 10.0 h deadline after 1200/3383 expansions", result["message"])
        self.assertIn("Failed stages: dump", result["message"])

    def test_deferred_new_expansions_are_listed_without_failing_the_catalogue(self):
        (self.root / "status.json").write_text(json.dumps({"errors": [], "deferred": [
            {"database": "pokoin_flesh_and_blood",
             "expansions": [{"id": 4908, "name": "Outbreak", "error": "HTTPError: 404"}]}]}))
        result = self.summary()
        self.assertEqual(result["status"], "complete")
        self.assertIn("deferred to the next run (CardTrader export not ready): pokoin_flesh_and_blood 4908.",
                      result["message"])
        self.assertNotIn("Catalogue failures", result["message"])

    def test_partial_or_failed_dump_never_reports_completion(self):
        for change in [{"completed": 3000}, {"errors": [{"expansionId": 4678}]}, {"totalExpansions": 0}]:
            with self.subTest(change=change):
                listing = self.listing.copy()
                self.listing.update(change)
                self.write_reports()
                result = self.summary(1)
                self.assertFalse(result["rawDumpComplete"])
                self.assertEqual(result["status"], "failed")
                self.listing = listing

    def test_missing_malformed_or_unfinished_reports_are_unverified(self):
        report = self.root / "listing-dump-status.json"
        for content in ["not-json", "[]", json.dumps({**self.listing, "finishedAt": None})]:
            with self.subTest(content=content):
                report.write_text(content)
                self.assertIn("completion is unverified", self.summary()["message"])
        report.unlink()
        self.assertEqual(self.summary()["status"], "failed")

    def test_previous_run_report_cannot_be_reused_after_early_dump_failure(self):
        self.listing["startedAt"] = "2026-09-30T23:17:21Z"
        self.listing["finishedAt"] = "2026-10-01T03:36:57Z"
        self.write_reports()
        result = self.summary(1, {**STAGES, "dump": 1})
        self.assertFalse(result["rawDumpComplete"])
        self.assertIn("stale report", result["message"])

    def test_successful_raw_dump_cannot_establish_writer_freshness(self):
        for analytics in [{"state": "unknown"}, {"state": "missing"}, {**FRESH, "state": "stale"}]:
            with self.subTest(state=analytics["state"]):
                result = self.summary(analytics=analytics)
                self.assertEqual(result["status"], "partial")
                self.assertTrue(result["rawDumpComplete"])
                self.assertNotIn("price analytics: fresh;", result["message"])

    def test_previous_nights_analytics_is_expected_before_the_oracle_refresh(self):
        # The notifier runs ~00:55; the Oracle refresh builds tonight's bucket ~02:40.
        expected = {"state": "expected", "dumpDay": "2026-09-30",
                    "sourceTimestamp": "2026-10-01T02:40:13+00:00", "printings": 66050}
        result = self.summary(analytics=expected)
        self.assertEqual(result["status"], "complete")
        self.assertIn("previous night's bucket", result["message"])
        self.assertIn("dump bucket 2026-09-30", result["message"])
        result = self.summary(analytics={**expected, "state": "stale", "dumpDay": "2026-09-29"})
        self.assertEqual(result["status"], "partial")
        self.assertIn("BEHIND, a nightly refresh was missed", result["message"])

    def test_job_code_commit_and_undeployed_commits_are_named(self):
        result = notify.build_summary(self.root, START, 0, STAGES, FRESH, {"commit": "abc123def456", "undeployed": 0})
        self.assertIn("Job code abc123def456.", result["message"])
        self.assertEqual(result["status"], "complete")
        result = notify.build_summary(self.root, START, 0, STAGES, FRESH, {"commit": "abc123def456", "undeployed": 3})
        self.assertIn("3 newer job-script commits on origin/main are not deployed", result["message"])
        self.assertEqual(result["status"], "complete")

    def test_writer_probe_has_timeouts_and_handles_missing_or_stale_data(self):
        for output, expected in [("", "missing"), ("not-json", "unknown"), ("[]", "unknown"),
                                 (json.dumps({**FRESH, "dumpDay": "2026-09-30",
                                              "sourceTimestamp": "2026-10-01T02:40:13Z"}), "expected"),
                                 (json.dumps({**FRESH, "dumpDay": "2026-09-29",
                                              "sourceTimestamp": "2026-09-30T02:40:13Z"}), "stale"),
                                 (json.dumps({**FRESH, "dumpDay": None,
                                              "sourceTimestamp": "2026-10-01T02:21:13Z"}), "stale"),
                                 (json.dumps(FRESH), "fresh")]:
            with self.subTest(output=output), patch.object(notify.subprocess, "run") as run:
                run.return_value = subprocess.CompletedProcess([], 0, output, "")
                self.assertEqual(notify.probe_analytics(START)["state"], expected)
                self.assertEqual(run.call_args.kwargs["timeout"], 12)
                self.assertIn("PGOPTIONS=-c statement_timeout=5000 -c lock_timeout=1000", run.call_args.args[0])

    def test_writer_timeout_or_process_error_is_unknown_without_exposing_error(self):
        for error in [subprocess.TimeoutExpired("docker", 12), FileNotFoundError("private path")]:
            with self.subTest(error=error), patch.object(notify.subprocess, "run", side_effect=error):
                self.assertEqual(notify.probe_analytics(START), {"state": "unknown"})

    def test_notification_failure_retains_exact_replayable_payload(self):
        args = ["--run-root", str(self.root), "--started-at", START, "--exit-code", "0"]
        for name, code in STAGES.items():
            args += ["--stage-result", f"{name}={code}"]
        with patch.object(notify, "probe_analytics", return_value=FRESH), \
                patch.object(notify, "send_summary", return_value=False), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(notify.main(args), 1)
        payload = json.loads((self.root / "notification-status.json").read_text())
        self.assertEqual(payload["delivery"], "pending")
        self.assertEqual(payload["importExitCode"], 0)
        self.assertEqual(payload["eventKey"], "cardtrader:2026-10-01:" + START)
        self.assertEqual(len(list((self.root / "notification-outbox").glob("*.json"))), 1)

    def test_delivery_uses_bounded_shared_notifier_and_captures_private_output(self):
        with patch.object(notify.subprocess, "run") as run:
            run.return_value = subprocess.CompletedProcess([], 1, "private chat", "token error")
            self.assertFalse(notify.send_summary(self.summary(), "/test/notifier.py"))
            self.assertEqual(run.call_args.kwargs["timeout"], 30)
            self.assertTrue(run.call_args.kwargs["capture_output"])
            self.assertIn("--event-key", run.call_args.args[0])

    def test_deploy_preflight_failure_restores_previous_commit_before_units(self):
        fixture = pathlib.Path(self.folder.name)
        deploy = fixture / "deploy"
        checkout = deploy / "cardtrader-daily"
        (checkout / "scripts").mkdir(parents=True)
        (checkout / "scripts/cardtrader-daily-preflight.sh").write_text(
            'echo "ERROR [pictures,artwork] /nonexistent: missing executable"\nexit 1\n')
        state = fixture / "head"
        state.write_text("oldcommit1234")
        log = fixture / "commands"
        bin_dir = fixture / "mock-bin"
        bin_dir.mkdir()
        git = bin_dir / "git"
        git.write_text("""#!/usr/bin/env python3
import os, pathlib, sys
args = sys.argv[1:]
state = pathlib.Path(os.environ['TEST_HEAD'])
with open(os.environ['TEST_COMMANDS'], 'a') as log:
    log.write(' '.join(args) + '\\n')
if 'checkout' in args:
    state.write_text(args[-1])
elif '--path-format=absolute' in args:
    print(os.environ['TEST_COMMON'])
elif 'rev-parse' in args:
    if 'HEAD' in args: print(state.read_text())
    elif '--git-dir' in args: print('.git')
    else: print('newcommit1234')
""")
        git.chmod(0o755)
        # Any attempted unit installation is a test failure, never a host operation.
        for tool in ['install', 'systemctl']:
            executable = bin_dir / tool
            executable.write_text('#!/bin/sh\necho unexpected-unit-operation >> "$TEST_COMMANDS"\nexit 99\n')
            executable.chmod(0o755)
        common = fixture / "common" / ".git"
        common.mkdir(parents=True)
        env = {**os.environ, "PATH": str(bin_dir) + ":" + os.environ["PATH"],
               "TEST_HEAD": str(state), "TEST_COMMANDS": str(log), "TEST_COMMON": str(common),
               "POKOIN_DEPLOY_DIR": str(deploy), "POKOIN_SYSTEMD_USER_DIR": str(fixture / "units"),
               "POKOIN_CT_DAILY_LOCK": str(fixture / "daily.lock")}
        result = subprocess.run(['bash', str(SCRIPTS / 'deploy-cardtrader-daily-checkout.sh')],
                                env=env, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 1)
        self.assertIn('/nonexistent', result.stdout)
        self.assertIn('restored oldcommit123; units unchanged', result.stderr)
        self.assertEqual(state.read_text(), 'oldcommit1234')
        commands = log.read_text()
        self.assertIn('checkout -q --detach --force newcommit1234', commands)
        self.assertIn('checkout -q --detach --force oldcommit1234', commands)
        self.assertNotIn('unexpected-unit-operation', commands)

    def test_wrapper_keeps_import_exit_status_when_notification_fails(self):
        # Replace only the absolute Python runtime in the temporary fixture;
        # stub executables prevent catalogue/dump/network work.
        wrapper = (SCRIPTS / "run-all-cardtrader-daily.sh").read_text()
        wrapper = wrapper.replace("/home/nez/Projects/AI/ai-toolkit/venv/bin/python", "python3")
        repo = pathlib.Path(self.folder.name) / "repo"
        (repo / "scripts").mkdir(parents=True)
        script = repo / "scripts" / "run.sh"
        script.write_text(wrapper)
        (repo / "scripts" / "cardtrader-daily-paths.sh").write_text(
            (SCRIPTS / "cardtrader-daily-paths.sh").read_text())
        (repo / "scripts" / "cardtrader-daily-preflight.sh").write_text(
            'exit "${PREFLIGHT_EXIT:-0}"\n')
        bin_dir = pathlib.Path(self.folder.name) / "bin"
        bin_dir.mkdir()
        for executable, content in {
            "node": '#!/bin/bash\nif [[ "$1" == *refresh-all-cardtrader-catalogues* ]]; then exit "$CATALOG_EXIT"; fi\nexit 0\n',
            "python3": '#!/bin/bash\nif [[ "$1" == *cardtrader-daily-notify* ]]; then exit 1; fi\nexit 0\n',
            "dump": "#!/bin/bash\nexit 0\n",
            "prices": "#!/bin/bash\nexit 0\n",
        }.items():
            path = bin_dir / executable
            path.write_text(content)
            path.chmod(0o755)
        for import_exit, preflight_exit in [(0, 0), (1, 0), (0, 1)]:
            with self.subTest(import_exit=import_exit, preflight_exit=preflight_exit):
                env = {**os.environ, "PATH": str(bin_dir) + ":" + os.environ["PATH"],
                       "POKOIN_CATALOG_RUN_ROOT": str(self.root), "CATALOG_EXIT": str(import_exit),
                       "PREFLIGHT_EXIT": str(preflight_exit),
                       "POKOIN_GPU_LEASE": str(bin_dir / "dump"),
                       "POKOIN_CARD_REFRESH": "off", "POKOIN_CT_SOLD": "off",
                       "POKOIN_CT_DUMP_BIN": str(bin_dir / "dump"),
                       "POKOIN_CT_PRICE_BIN": str(bin_dir / "prices")}
                result = subprocess.run(["bash", str(script)], env=env, capture_output=True, text=True, timeout=5)
                self.assertEqual(result.returncode, max(import_exit, preflight_exit))
                self.assertIn("import result is unchanged", result.stderr)


if __name__ == "__main__":
    unittest.main()
