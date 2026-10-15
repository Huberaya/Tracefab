#!/usr/bin/env python3
"""Static end-to-end audit for the stable public page shells and key contracts.

The audit intentionally checks current structural/functional anchors, not
presentation copy that can change with localization or a UI redesign.
A failed check must return a non-zero process exit status so CI cannot go green.
"""
import argparse
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


def run_audit(root: Path) -> bool:
    print("=== TRACEFAB END-TO-END VALIDATION AUDIT (PHASE 12) ===")
    all_pass = True

    for relative_path, markers in REQUIRED_MARKERS.items():
        file_path = root / relative_path
        if not file_path.is_file():
            print(f"❌ File missing: {relative_path}")
            all_pass = False
            continue

        content = file_path.read_text(encoding="utf-8")
        missing = [marker for marker in markers if marker.casefold() not in content.casefold()]
        if missing:
            print(f"❌ {relative_path}: Missing required markers {missing}")
            all_pass = False
        else:
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
