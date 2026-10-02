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
STAGES = dict.fromkeys(["catalog", "pictures", "picture-sync", "artwork", "search", "dump"], 0)


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

    def test_writer_probe_has_timeouts_and_handles_missing_or_stale_data(self):
        for output, expected in [("", "missing"), ("not-json", "unknown"), ("[]", "unknown"),
                                 (json.dumps({**FRESH, "sourceTimestamp": "2026-10-01T02:21:13Z"}), "stale"),
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

    def test_wrapper_keeps_import_exit_status_when_notification_fails(self):
        # Replace only the absolute Python runtime in the temporary fixture;
        # stub executables prevent catalogue/dump/network work.
        wrapper = (SCRIPTS / "run-all-cardtrader-daily.sh").read_text()
        wrapper = wrapper.replace("/home/nez/Projects/ai-toolkit/venv/bin/python", "python3")
        repo = pathlib.Path(self.folder.name) / "repo"
        (repo / "scripts").mkdir(parents=True)
        script = repo / "scripts" / "run.sh"
        script.write_text(wrapper)
        bin_dir = pathlib.Path(self.folder.name) / "bin"
        bin_dir.mkdir()
        for executable, content in {
            "node": '#!/bin/bash\nif [[ "$1" == *refresh-all-cardtrader-catalogues* ]]; then exit "$CATALOG_EXIT"; fi\nexit 0\n',
            "python3": '#!/bin/bash\nif [[ "$1" == *cardtrader-daily-notify* ]]; then exit 1; fi\nexit 0\n',
        }.items():
            path = bin_dir / executable
            path.write_text(content)
            path.chmod(0o755)
        for import_exit in [0, 1]:
            with self.subTest(import_exit=import_exit):
                env = {**os.environ, "PATH": str(bin_dir) + ":" + os.environ["PATH"],
                       "POKOIN_CATALOG_RUN_ROOT": str(self.root), "CATALOG_EXIT": str(import_exit)}
                result = subprocess.run(["bash", str(script)], env=env, capture_output=True, text=True, timeout=5)
                self.assertEqual(result.returncode, import_exit)
                self.assertIn("import result is unchanged", result.stderr)


if __name__ == "__main__":
    unittest.main()
