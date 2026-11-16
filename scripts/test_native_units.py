"""Shipped supervisor units must match the host command line and release layout."""

import configparser
import importlib.util
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
NATIVE = ROOT / "examples/native"
UNITS = sorted((NATIVE / "systemd").glob("*.service"))


class NativeUnits(unittest.TestCase):
    def parse(self, path):
        parser = configparser.ConfigParser(strict=True, interpolation=None)
        parser.optionxform = str
        parser.read_string(path.read_text())
        return parser

    def test_both_units_exist_and_parse(self):
        self.assertEqual([u.name for u in UNITS], ["ptn-refresh.service", "ptn-serve.service"])
        for unit in UNITS:
            parsed = self.parse(unit)
            self.assertEqual(parsed.sections(), ["Unit", "Service", "Install"])
            self.assertEqual(parsed["Service"]["User"], "ptn")
            self.assertNotEqual(parsed["Service"]["User"], "root")
            self.assertEqual(parsed["Service"]["ReadWritePaths"], "/var/lib/ptn")

    def test_units_run_commands_the_host_accepts(self):
        source = (NATIVE / "host.py").read_text()
        choices = set(re.findall(r'"([a-z-]+)"', re.search(r"choices=\((.*?)\)", source, re.S).group(1)))
        commands = {}
        for unit in UNITS:
            start = self.parse(unit)["Service"]["ExecStart"].split()
            self.assertEqual(start[1], "/opt/ptn/examples/native/host.py")
            self.assertEqual(start[2:4], ["--config", "/etc/ptn/config.json"])
            self.assertIn(start[4], choices)
            commands[unit.name] = start[4]
        self.assertEqual(commands, {"ptn-refresh.service": "refresh-loop", "ptn-serve.service": "serve"})

    def test_release_archive_copies_the_whole_native_directory(self):
        # The units and the new host modules ship only because of this copy.
        source = (ROOT / "scripts/package-release.py").read_text()
        self.assertRegex(source, r'copytree\(\s*ROOT / "examples/native"')
        for name in ("feed_change.py", "pin.py", "published.py"):
            self.assertTrue((NATIVE / name).is_file(), name)

    def test_readme_documents_the_units(self):
        text = (NATIVE / "README.md").read_text()
        for unit in UNITS:
            self.assertIn(unit.name, text)
        self.assertNotIn("No systemd or other supervisor template is included", text)


if __name__ == "__main__":
    unittest.main()
