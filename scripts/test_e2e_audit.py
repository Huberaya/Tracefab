#!/usr/bin/env python3
"""Regression tests for the end-to-end audit's exit-code contract."""
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

AUDIT = Path(__file__).with_name("e2e_audit.py")

FIXTURES = {
    "index.html": [
        "KNOW YOUR PRODUCT",
        "LIVING DATA CORE",
        'id="supply-chain"',
        'data-i18n="spine.',
        "Tracefab",
    ],
    "brand-console/index.html": [
        "<title>Tracefab — Brand Console</title>",
        '<div id="app"></div>',
        'id="product-detail-form"',
        'data-action="new-request"',
        "Authorization = `Bearer ${token}`",
    ],
    "supplier-portal/index.html": [
        "<title>Tracefab — Supplier Portal</title>",
        '<div id="app"></div>',
        'id="profile-form"',
        'data-action="submit-request"',
        "Authorization = `Bearer ${token}`",
    ],
    "dpp/index.html": [
        'data-i18n="dpp.metaTitle"',
        "CIRPASS",
        'data-i18n="dpp.cirIndex"',
        "GS1 Digital Link",
    ],
}


class EndToEndAuditExitCodeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="tracefab-e2e-audit-")
        self.root = Path(self.temp.name)
        for relative_path, markers in FIXTURES.items():
            path = self.root / relative_path
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("\n".join(markers), encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def run_audit(self):
        return subprocess.run(
            [sys.executable, str(AUDIT), "--root", str(self.root)],
            capture_output=True,
            text=True,
            check=False,
        )

    def test_all_required_markers_exit_zero(self):
        result = self.run_audit()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Audit Status: PASS", result.stdout)

    def test_missing_required_marker_exits_nonzero(self):
        path = self.root / "brand-console/index.html"
        path.write_text(path.read_text(encoding="utf-8").replace(
            "<title>Tracefab — Brand Console</title>",
            "<title>Wrong title</title>",
        ), encoding="utf-8")
        result = self.run_audit()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("Audit Status: FAIL", result.stdout)
        self.assertIn("Missing required markers", result.stdout)

    def test_missing_required_file_exits_nonzero(self):
        (self.root / "dpp/index.html").unlink()
        result = self.run_audit()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("Audit Status: FAIL", result.stdout)
        self.assertIn("File missing: dpp/index.html", result.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
