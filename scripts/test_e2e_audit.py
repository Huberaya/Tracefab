#!/usr/bin/env python3
"""Regression tests for the end-to-end audit's fail-closed contract."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

AUDIT = Path(__file__).with_name("e2e_audit.py")

PAGE_FIXTURES = {
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
        '<script src="/assets/js/brand-console.1.js?v=test"></script>',
    ],
    "supplier-portal/index.html": [
        "<title>Tracefab — Supplier Portal</title>",
        '<div id="app"></div>',
        '<script src="/assets/js/supplier-portal.1.js?v=test"></script>',
    ],
    "dpp/index.html": [
        'data-i18n="dpp.metaTitle"',
        "CIRPASS",
        'data-i18n="dpp.cirIndex"',
        "GS1 Digital Link",
    ],
}

BUNDLE_FIXTURES = {
    "brand-console/index.html": ["/assets/js/brand-console.1.js"],
    "supplier-portal/index.html": ["/assets/js/supplier-portal.1.js"],
    "index.html": [],
    "dpp/index.html": [],
}

ASSET_FIXTURES = {
    "assets/js/brand-console.1.js": [
        'id="product-detail-form"',
        'data-action="new-request"',
        "Authorization = `Bearer ${token}`",
    ],
    "assets/js/supplier-portal.1.js": [
        'id="profile-form"',
        'data-action="submit-request"',
        "Authorization = `Bearer ${token}`",
    ],
}


class EndToEndAuditFailClosedTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="tracefab-e2e-audit-")
        self.root = Path(self.temp.name)
        for relative_path, lines in PAGE_FIXTURES.items():
            path = self.root / relative_path
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("\n".join(lines), encoding="utf-8")
        for relative_path, lines in ASSET_FIXTURES.items():
            path = self.root / relative_path
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("\n".join(lines), encoding="utf-8")
        manifest = self.root / "assets/js/.page-bundles.json"
        manifest.parent.mkdir(parents=True, exist_ok=True)
        manifest.write_text(json.dumps(BUNDLE_FIXTURES), encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def run_audit(self):
        return subprocess.run(
            [sys.executable, str(AUDIT), "--root", str(self.root)],
            capture_output=True,
            text=True,
            check=False,
        )

    def test_valid_pages_and_declared_bundles_exit_zero(self):
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

    def test_missing_required_page_exits_nonzero(self):
        (self.root / "dpp/index.html").unlink()
        result = self.run_audit()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("Audit Status: FAIL", result.stdout)
        self.assertIn("File missing: dpp/index.html", result.stdout)

    def test_missing_declared_bundle_exits_nonzero(self):
        (self.root / "assets/js/brand-console.1.js").unlink()
        result = self.run_audit()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("declared JavaScript bundle missing", result.stdout)
        self.assertIn("Audit Status: FAIL", result.stdout)

    def test_missing_functional_marker_in_bundle_exits_nonzero(self):
        path = self.root / "assets/js/brand-console.1.js"
        path.write_text(path.read_text(encoding="utf-8").replace(
            'id="product-detail-form"',
            'id="obsolete-form"',
        ), encoding="utf-8")
        result = self.run_audit()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("Missing required markers", result.stdout)
        self.assertIn("Audit Status: FAIL", result.stdout)

    def test_unreferenced_manifest_bundle_exits_nonzero(self):
        manifest = self.root / "assets/js/.page-bundles.json"
        bundles = json.loads(manifest.read_text(encoding="utf-8"))
        bundles["brand-console/index.html"].append("/assets/js/orphaned.js")
        manifest.write_text(json.dumps(bundles), encoding="utf-8")
        result = self.run_audit()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("manifest bundle is not referenced", result.stdout)
        self.assertIn("Audit Status: FAIL", result.stdout)

    def test_malformed_manifest_exits_nonzero(self):
        manifest = self.root / "assets/js/.page-bundles.json"
        manifest.write_text("{ invalid JSON", encoding="utf-8")
        result = self.run_audit()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("manifest invalid or missing", result.stdout)
        self.assertIn("Audit Status: FAIL", result.stdout)

    def test_non_object_manifest_exits_nonzero(self):
        manifest = self.root / "assets/js/.page-bundles.json"
        manifest.write_text("[]", encoding="utf-8")
        result = self.run_audit()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("must contain a JSON object", result.stdout)
        self.assertIn("Audit Status: FAIL", result.stdout)

    def test_missing_manifest_exits_nonzero(self):
        (self.root / "assets/js/.page-bundles.json").unlink()
        result = self.run_audit()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("manifest invalid or missing", result.stdout)
        self.assertIn("Audit Status: FAIL", result.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
