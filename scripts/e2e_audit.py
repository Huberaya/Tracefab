#!/usr/bin/env python3
"""Static end-to-end audit for page shells and their declared JavaScript bundles.

The audit checks stable structural/functional anchors, not presentation copy
that can change with localization or a UI redesign. A failed check must return
a non-zero process exit status so CI cannot go green.
"""
import argparse
import json
import re
import sys
from pathlib import Path

REQUIRED_MARKERS = {
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

SCRIPT_TAG = re.compile(r'<script src="(/assets/js/[^"]+)"([^>]*)></script>')


def load_bundles(root: Path) -> dict:
    manifest_path = root / "assets/js/.page-bundles.json"
    with manifest_path.open(encoding="utf-8") as manifest_file:
        bundles = json.load(manifest_file)
    if not isinstance(bundles, dict):
        raise ValueError("assets/js/.page-bundles.json must contain a JSON object")
    return bundles


def load_page_source(root: Path, relative_path: str, bundles: dict) -> tuple[str, list[str]]:
    """Mirror the repository page_source helper: inline only manifest-owned JS."""
    html = (root / relative_path).read_text(encoding="utf-8")
    declared = bundles.get(relative_path, [])
    if not isinstance(declared, list) or not all(isinstance(item, str) for item in declared):
        return html, [f"{relative_path}: invalid JavaScript bundle manifest entry"]

    declared_set = set(declared)
    referenced: set[str] = set()
    errors: list[str] = []

    def inline_owned_script(match: re.Match) -> str:
        href, attributes = match.group(1), match.group(2)
        asset_path = href.split("?", 1)[0]
        if asset_path not in declared_set:
            return match.group(0)
        referenced.add(asset_path)
        disk_path = root / asset_path.lstrip("/")
        if not disk_path.is_file():
            errors.append(f"{relative_path}: declared JavaScript bundle missing: {asset_path}")
            return match.group(0)
        source = disk_path.read_text(encoding="utf-8")
        return f"<script{attributes}>\n{source}\n</script>"

    complete_source = SCRIPT_TAG.sub(inline_owned_script, html)
    for asset_path in sorted(declared_set - referenced):
        errors.append(f"{relative_path}: manifest bundle is not referenced by the page: {asset_path}")
    return complete_source, errors


def run_audit(root: Path) -> bool:
    print("=== TRACEFAB END-TO-END VALIDATION AUDIT (PHASE 12) ===")
    all_pass = True
    try:
        bundles = load_bundles(root)
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print(f"❌ JavaScript bundle manifest invalid or missing: {error}")
        print("\nAudit Status: FAIL")
        return False

    for relative_path, markers in REQUIRED_MARKERS.items():
        file_path = root / relative_path
        if not file_path.is_file():
            print(f"❌ File missing: {relative_path}")
            all_pass = False
            continue

        try:
            content, source_errors = load_page_source(root, relative_path, bundles)
        except (OSError, UnicodeError) as error:
            print(f"❌ Cannot read {relative_path}: {error}")
            all_pass = False
            continue

        if source_errors:
            all_pass = False
            for error in source_errors:
                print(f"❌ {error}")

        missing = [marker for marker in markers if marker.casefold() not in content.casefold()]
        if missing:
            print(f"❌ {relative_path}: Missing required markers {missing}")
            all_pass = False
        elif not source_errors:
            print(f"✅ {relative_path}: All {len(markers)} required markers present ({len(content):,} chars)")

    print("\nAudit Status:", "PASS" if all_pass else "FAIL")
    return all_pass


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(__file__).resolve().parent.parent,
        help="Repository root to audit (defaults to the repository containing this script).",
    )
    args = parser.parse_args()
    return 0 if run_audit(args.root.resolve()) else 1


if __name__ == "__main__":
    sys.exit(main())
