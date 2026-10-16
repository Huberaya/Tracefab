#!/usr/bin/env python3
"""Regression tests for the end-to-end audit's fail-closed contract.

Every contract the audit promises is exercised against a temporary fixture
tree. Adding a new failure mode to the audit? Add a test here first.
"""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

AUDIT = Path(__file__).with_name("e2e_audit.py")

# A minimal page fixture that exercises every class of marker the audit
# expects for a known-good state.
PAGE_FIXTURES = {
    "index.html": [
        "<!doctype html><html><head><title>TRACEFAB — The intelligence layer for the global textile supply chain</title>",
        '<script src="/assets/i18n/en.js?v=x"></script>',
        '<script src="/assets/js/index.0.js?v=x"></script>',
        "</head><body>",
        '<div id="supply-chain" data-i18n="spine.x">Tracefab</div>',
        "</body></html>",
    ],
    "brand-console/index.html": [
        "<!doctype html><html><head><title>Tracefab — Brand Console</title>",
        '<script src="/assets/js/tf-skip-meta.js?v=x"></script>',
        '<script src="/assets/i18n/en.js?v=x"></script>',
        '<script src="/assets/js/brand-console.1.js?v=x"></script>',
        "</head><body><div id=\"app\"></div></body></html>",
    ],
    "supplier-portal/index.html": [
        "<!doctype html><html><head><title>Tracefab — Supplier Portal</title>",
        '<script src="/assets/js/supplier-portal.0.js?v=x"></script>',
        '<script src="/assets/js/supplier-portal.1.js?v=x"></script>',
        "</head><body><div id=\"app\"><form data-action=\"submit-request\"></form></div></body></html>",
    ],
    "dpp/index.html": [
        "<!doctype html><html><head>",
        '<script src="/assets/js/tf-skip-meta.js?v=x"></script>',
        '<script src="/assets/i18n/en.js?v=x"></script>',
        '<script src="/assets/js/dpp.1.js?v=x"></script>',
        '<script src="/assets/js/dpp.2.js?v=x"></script>',
        "</head><body><div data-i18n=\"dpp.metaTitle\">x</div>",
        "<span>CIRPASS</span><span data-i18n=\"dpp.cirIndex\"></span><span>GS1 Digital Link</span>",
        "</body></html>",
    ],
    "operations/index.html": [
        "<!doctype html><html><head><title>Tracefab — Operations</title>",
        '<script src="/assets/js/tf-skip-meta.js?v=x"></script>',
        '<script src="/assets/i18n/en.js?v=x"></script>',
        '<script src="/assets/js/operations.1.js?v=x"></script>',
        "</head><body><div id=\"app\"></div></body></html>",
    ],
    "passport/index.html": [
        "<!doctype html><html><head>",
        '<script src="/assets/js/tf-skip-meta.js?v=x"></script>',
        '<script src="/assets/i18n/en.js?v=x"></script>',
        '<script src="/assets/js/passport.1.js?v=x"></script>',
        "</head><body><div id=\"app\" class=\"x\"></div>",
        "<span data-i18n=\"passport.metaTitle\"></span><span data-i18n=\"passport.seal\"></span>",
        "</body></html>",
    ],
    "product-intelligence/index.html": [
        "<!doctype html><html><head><title>TRACEFAB — Product Intelligence</title>",
        '<script src="/assets/i18n/en.js?v=x"></script>',
        '<script src="/assets/js/product-intelligence.0.js?v=x"></script>',
        "</head><body><span data-i18n=\"pi.demoBanner\"></span></body></html>",
    ],
    "quality-center/index.html": [
        "<!doctype html><html><head><title>Tracefab — Quality Center</title>",
        '<script src="/assets/js/tf-skip-meta.js?v=x"></script>',
        '<script src="/assets/i18n/en.js?v=x"></script>',
        '<script src="/assets/js/quality-center.1.js?v=x"></script>',
        "</head><body><div id=\"app\"></div></body></html>",
    ],
    "invitations/accept/index.html": [
        "<!doctype html><html><head>",
        '<script src="/assets/js/tf-skip-meta.js?v=x"></script>',
        '<script src="/assets/i18n/en.js?v=x"></script>',
        '<script src="/assets/js/invitations-accept.1.js?v=x"></script>',
        "</head><body><div id=\"clerk-sign-in\"></div>",
        "<span data-i18n=\"invite.metaTitle\"></span><button data-i18n=\"invite.acceptBtn\"></button>",
        "</body></html>",
    ],
}

BUNDLE_FIXTURES = {
    "brand-console/index.html": ["/assets/js/brand-console.1.js"],
    "supplier-portal/index.html": ["/assets/js/supplier-portal.0.js", "/assets/js/supplier-portal.1.js"],
    "dpp/index.html": ["/assets/js/dpp.1.js", "/assets/js/dpp.2.js"],
    "operations/index.html": ["/assets/js/operations.1.js"],
    "passport/index.html": ["/assets/js/passport.1.js"],
    "product-intelligence/index.html": ["/assets/js/product-intelligence.0.js"],
    "quality-center/index.html": ["/assets/js/quality-center.1.js"],
    "invitations/accept/index.html": ["/assets/js/invitations-accept.1.js"],
    "index.html": ["/assets/js/index.0.js"],
}

# Contenu des bundles JS : les markers fonctionnels qu'on doit y trouver
# (data-action=, Authorization) doivent être présents dans le fichier pour
# que l'inline en détecte la présence.
ASSET_FIXTURES = {
    "assets/js/brand-console.1.js": ['data-action="new-request"'],
    "assets/js/supplier-portal.1.js": ['data-action="submit-request"'],
    "assets/js/dpp.1.js": ["CIRPASS", 'data-i18n="dpp.cirIndex"', "GS1 Digital Link"],
    "assets/js/dpp.2.js": ['data-i18n="dpp.metaTitle"'],
    "assets/js/passport.1.js": ['data-i18n="passport.metaTitle"', 'data-i18n="passport.seal"'],
    "assets/js/operations.1.js": ["console.log"],
    "assets/js/product-intelligence.0.js": ['data-i18n="pi.demoBanner"'],
    "assets/js/quality-center.1.js": ["console.log"],
    "assets/js/invitations-accept.1.js": ['data-i18n="invite.acceptBtn"'],
    "assets/js/index.0.js": ['id="supply-chain"', 'data-i18n="spine.', "Tracefab"],
    "assets/js/supplier-portal.0.js": ["// chunk 0"],
    # Shared helpers et catalogue i18n (fichiers présents pour que src= resolve)
    "assets/js/tf-skip-meta.js": ["// skip meta helper"],
    "assets/i18n/en.js": ["window.i18n = {}"],
}


class EndToEndAuditFailClosedTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="tracefab-e2e-audit-")
        self.root = Path(self.temp.name)
        for relative_path, lines in PAGE_FIXTURES.items():
            path = self.root / relative_path
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("\n".join(lines), encoding="utf-8")
        for relative_path, contents in ASSET_FIXTURES.items():
            path = self.root / relative_path
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("\n".join(contents), encoding="utf-8")
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

    # --- Happy path ---
    def test_all_pages_and_bundles_pass(self):
        result = self.run_audit()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Audit Status: PASS", result.stdout)

    # --- Markers / pages ---
    def test_missing_required_marker_exits_nonzero(self):
        path = self.root / "brand-console/index.html"
        path.write_text(
            path.read_text(encoding="utf-8").replace(
                "<title>Tracefab — Brand Console</title>",
                "<title>Wrong title</title>",
            ),
            encoding="utf-8",
        )
        result = self.run_audit()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("Audit Status: FAIL", result.stdout)
        self.assertIn("Missing required markers", result.stdout)

    def test_missing_required_page_exits_nonzero(self):
        (self.root / "dpp/index.html").unlink()
        result = self.run_audit()
        self.assertEqual(result.returncode, 1)
        self.assertIn("File missing: dpp/index.html", result.stdout)

    def test_unlisted_html_page_exits_nonzero(self):
        # Une nouvelle page HTML débarque sans être ajoutée aux markers.
        rogue = self.root / "super-secret/index.html"
        rogue.parent.mkdir(parents=True, exist_ok=True)
        rogue.write_text("<html><body>oops</body></html>", encoding="utf-8")
        result = self.run_audit()
        self.assertEqual(result.returncode, 1)
        self.assertIn("page HTML présente dans le dépôt mais absente de REQUIRED_MARKERS", result.stdout)

    def test_mounted_app_with_attributes_still_matches(self):
        # <div id=app class=loaded> doit matcher (id=app regex with attrs).
        path = self.root / "passport/index.html"
        path.write_text(
            path.read_text(encoding="utf-8").replace(
                '<div id="app" class="x">',
                '<div id="app" class="hydrated">',
            ),
            encoding="utf-8",
        )
        result = self.run_audit()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    # --- Bundles / manifest ---
    def test_missing_declared_bundle_exits_nonzero(self):
        (self.root / "assets/js/brand-console.1.js").unlink()
        result = self.run_audit()
        self.assertEqual(result.returncode, 1)
        self.assertIn("declared JavaScript bundle missing on disk", result.stdout)

    def test_missing_functional_marker_in_bundle_exits_nonzero(self):
        path = self.root / "assets/js/brand-console.1.js"
        path.write_text(
            path.read_text(encoding="utf-8").replace(
                'data-action="new-request"', 'data-action="old-action"',
            ),
            encoding="utf-8",
        )
        result = self.run_audit()
        self.assertEqual(result.returncode, 1)
        self.assertIn("Missing required markers", result.stdout)

    def test_unreferenced_manifest_bundle_exits_nonzero(self):
        manifest = self.root / "assets/js/.page-bundles.json"
        bundles = json.loads(manifest.read_text(encoding="utf-8"))
        bundles["brand-console/index.html"].append("/assets/js/orphaned.js")
        manifest.write_text(json.dumps(bundles), encoding="utf-8")
        result = self.run_audit()
        self.assertEqual(result.returncode, 1)
        self.assertIn("manifest bundle is not referenced by the page", result.stdout)

    def test_referenced_bundle_not_in_manifest_exits_nonzero(self):
        path = self.root / "brand-console/index.html"
        path.write_text(
            path.read_text(encoding="utf-8").replace(
                'src="/assets/js/brand-console.1.js',
                'src="/assets/js/rogue-bundle.js',
            ),
            encoding="utf-8",
        )
        (self.root / "assets/js/rogue-bundle.js").write_text("console.log('hi')", encoding="utf-8")
        result = self.run_audit()
        self.assertEqual(result.returncode, 1)
        self.assertIn("page references a JavaScript asset not declared in .page-bundles.json", result.stdout)

    def test_malformed_manifest_exits_nonzero(self):
        manifest = self.root / "assets/js/.page-bundles.json"
        manifest.write_text("{ invalid JSON", encoding="utf-8")
        result = self.run_audit()
        self.assertEqual(result.returncode, 1)
        self.assertIn("manifest invalid or missing", result.stdout)

    def test_non_object_manifest_exits_nonzero(self):
        manifest = self.root / "assets/js/.page-bundles.json"
        manifest.write_text("[]", encoding="utf-8")
        result = self.run_audit()
        self.assertEqual(result.returncode, 1)
        self.assertIn("must contain a JSON object", result.stdout)

    def test_manifest_with_unknown_page_exits_nonzero(self):
        manifest = self.root / "assets/js/.page-bundles.json"
        bundles = json.loads(manifest.read_text(encoding="utf-8"))
        bundles["future-page/index.html"] = ["/assets/js/future.js"]
        manifest.write_text(json.dumps(bundles), encoding="utf-8")
        result = self.run_audit()
        self.assertEqual(result.returncode, 1)
        self.assertIn("manifest declares unknown page: future-page/index.html", result.stdout)

    def test_missing_manifest_exits_nonzero(self):
        (self.root / "assets/js/.page-bundles.json").unlink()
        result = self.run_audit()
        self.assertEqual(result.returncode, 1)
        self.assertIn("manifest invalid or missing", result.stdout)

    # --- Shared helpers / foreign origins ---
    def test_missing_shared_helper_exits_nonzero(self):
        (self.root / "assets/js/tf-skip-meta.js").unlink()
        result = self.run_audit()
        self.assertEqual(result.returncode, 1)
        self.assertIn("shared helper missing on disk", result.stdout)

    def test_foreign_script_not_in_allowlist_exits_nonzero(self):
        path = self.root / "brand-console/index.html"
        path.write_text(
            path.read_text(encoding="utf-8").replace(
                "</head>",
                '<script src="https://evil.example.com/x.js"></script></head>',
            ),
            encoding="utf-8",
        )
        result = self.run_audit()
        self.assertEqual(result.returncode, 1)
        self.assertIn("foreign <script src> not in allow-list", result.stdout)

    def test_clerk_script_allowed(self):
        path = self.root / "invitations/accept/index.html"
        path.write_text(
            path.read_text(encoding="utf-8").replace(
                "</head>",
                '<script src="https://clerk.example.com/clerk.js"></script></head>',
            ),
            encoding="utf-8",
        )
        result = self.run_audit()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
