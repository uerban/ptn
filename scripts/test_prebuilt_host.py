"""Prebuilt hosting must stay offline at boot and never invoke a builder."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

NATIVE = Path(__file__).resolve().parents[1] / "examples/native"
sys.path.insert(0, str(NATIVE))
spec = importlib.util.spec_from_file_location("prebuilt_native_host", NATIVE / "host.py")
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)
import prebuilt


class PrebuiltHost(unittest.TestCase):
    def setUp(self):
        self.work = tempfile.TemporaryDirectory()
        self.addCleanup(self.work.cleanup)
        self.root = Path(self.work.name).resolve()
        self.config = {
            "stateDirectory": "state", "city": "vilnius", "transitMode": "prebuilt",
            "dataRootId": "must-not-bind-a-producer-root",
            "transitPack": {"source": {"kind": "https", "url": "https://mirror.example/"},
                            "trustedKeys": ["11" * 32, "22" * 32], "geometry": False},
            "memoryBudget": {"maxRssBytes": 2147483648,
                             "processFixedOverheadBytes": 200000000,
                             "perWorkerOverheadBytes": 50000000},
        }

    def invoke(self, command):
        config = self.root / "config.json"
        config.write_text(json.dumps(self.config))
        with patch.object(sys, "argv", ["host.py", "--config", str(config), command]), \
             patch.object(host, "prepare", side_effect=AssertionError("feed preparation")), \
             patch.object(host, "data_root_environment", side_effect=AssertionError("producer binding"), create=True):
            host.main()

    def test_refresh_only_calls_installer_with_discovery_keys_and_limits(self):
        self.config["transitPack"].update(maxFileBytes=1234, maxSelectedBytes=9876)
        with patch.object(prebuilt.subprocess, "run") as run:
            self.invoke("refresh")
        run.assert_called_once()
        args = run.call_args.args[0]
        self.assertEqual(Path(args[0]).name, "pt-transit")
        self.assertEqual(args[args.index("--root") + 1], str(self.root / "state/prebuilt"))
        self.assertIn("--from-discovery", args)
        self.assertIn("--without-geometry", args)
        self.assertEqual(args.count("--trusted-key"), 2)
        self.assertEqual(args[args.index("--max-selected-bytes") + 1], "9876")
        catalog = (self.root / "state/public-config/cities.json").read_text()
        self.assertNotIn("mirror.example", catalog)
        self.assertNotIn("11" * 32, catalog)

    def test_offline_serve_needs_no_source_or_installer_and_uses_separate_runtime(self):
        del self.config["transitPack"]["source"]
        with patch.object(prebuilt.subprocess, "run", side_effect=AssertionError("network or installer")), \
             patch.object(prebuilt.os, "execve") as execute:
            self.invoke("serve")
        execute.assert_called_once()
        args = execute.call_args.args[1]
        self.assertEqual(Path(args[0]).name, "pt-serve")
        self.assertIn(f"--data-root={self.root / 'state/run'}", args)
        self.assertIn(f"--transit-store-root={self.root / 'state/prebuilt'}", args)
        self.assertIn("--without-geometry", args)
        self.assertIn("--page-warm-mode=off", args)
        self.assertFalse(any(arg.startswith("--poi") for arg in args))

    def test_local_mirror_and_geometry_enable(self):
        self.config["transitPack"].update(source={"kind": "local", "directory": "/accepted/public"}, geometry=True)
        with patch.object(prebuilt.subprocess, "run") as run:
            self.invoke("refresh")
        args = run.call_args.args[0]
        self.assertIn("--source-directory", args)
        self.assertNotIn("--without-geometry", args)

    def test_failure_propagates_without_falling_back_to_producer(self):
        with patch.object(prebuilt.subprocess, "run", side_effect=subprocess.CalledProcessError(1, "pt-transit")):
            with self.assertRaises(subprocess.CalledProcessError):
                self.invoke("refresh")

    def test_bad_configuration_fails_before_any_process(self):
        invalid = [
            ("trustedKeys", []), ("trustedKeys", "11" * 32),
            ("trustedKeys", ["invalid"]), ("geometry", "false"),
            ("source", {"kind": "https", "url": "http://mirror.example"}),
            ("source", {"kind": "https", "url": "https://user:pass@mirror.example"}),
            ("source", {"kind": "local", "directory": "relative"}),
            ("maxFileBytes", True), ("maxSelectedBytes", -1),
        ]
        original = dict(self.config["transitPack"])
        for key, value in invalid:
            with self.subTest(key=key, value=value), patch.object(prebuilt.subprocess, "run") as run:
                self.config["transitPack"] = {**original, key: value}
                with self.assertRaises(ValueError):
                    self.invoke("refresh")
                run.assert_not_called()

    def test_explicit_memory_budget_and_mode_are_required(self):
        del self.config["memoryBudget"]["maxRssBytes"]
        with patch.object(prebuilt.os, "execve") as execute:
            with self.assertRaisesRegex(ValueError, "maxRssBytes"):
                self.invoke("serve")
            execute.assert_not_called()
        self.config["transitMode"] = "typo"
        with self.assertRaisesRegex(ValueError, "transitMode"):
            self.invoke("refresh")

    def test_update_cadence_is_daily_with_jitter_only_for_prebuilt(self):
        with patch("random.uniform", return_value=1.05):
            self.assertEqual(prebuilt.refresh_delay(self.config), 86400 * 1.05)
            self.assertEqual(prebuilt.refresh_delay({}), 3600)
            self.assertEqual(prebuilt.refresh_delay({**self.config, "refreshIntervalSeconds": 120}), 126)
        for value in (True, 59, "86400"):
            with self.assertRaises(ValueError):
                prebuilt.refresh_delay({"refreshIntervalSeconds": value})

    def test_invalid_loop_interval_does_not_start_refresh(self):
        self.config["refreshIntervalSeconds"] = 0
        with patch.object(host.subprocess, "run") as run:
            with self.assertRaisesRegex(ValueError, "refreshIntervalSeconds"):
                self.invoke("refresh-loop")
            run.assert_not_called()

    def test_default_source_mode_still_uses_the_legacy_server(self):
        del self.config["transitMode"]
        config = self.root / "config.json"
        config.write_text(json.dumps(self.config))
        with patch.object(sys, "argv", ["host.py", "--config", str(config), "serve"]), \
             patch.object(host, "run_prebuilt", side_effect=AssertionError("prebuilt mode")), \
             patch.object(host, "data_root_environment", return_value={}, create=True), \
             patch.object(host.os, "execv", side_effect=SystemExit) as legacy, \
             patch.object(host.os, "execve", side_effect=SystemExit) as bound:
            with self.assertRaises(SystemExit):
                host.main()
        execute = bound if bound.called else legacy
        execute.assert_called_once()
        args = execute.call_args.args[1]
        self.assertIn(f"--data-root={self.root / 'state/transit'}", args)
        self.assertFalse(any(arg.startswith("--transit-store-root") for arg in args))
