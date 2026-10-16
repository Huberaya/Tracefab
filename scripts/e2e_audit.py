#!/usr/bin/env python3
"""Static end-to-end audit for page shells and their declared JavaScript bundles.

The audit checks stable structural/functional anchors, not presentation copy
that can change with localization or a UI redesign. A failed check must return
a non-zero process exit status so CI cannot go green — this is the fail-closed
contract exercised by scripts/test_e2e_audit.py.

Scope audited:
  - all 9 page HTML shells present in the repository;
  - every <script src=...> must resolve to /assets/... on disk and be declared
    in assets/js/.page-bundles.json (no orphan, no CDN, no missing file);
  - stable functional markers per page (titles, anchors like #app, data-i18n
    keys unique to a surface, Clerk hook);
  - the page-bundles manifest is valid JSON, is an object, references only
    existing files and existing pages.

Extending REQUIRED_MARKERS when a new surface is added is deliberate: it
forces the auditor to name the stable structural anchors of the new page
before CI accepts it.
"""
import argparse
import json
import re
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Per-page required markers (case-insensitive substring match in the full
# page source AFTER manifest-owned scripts have been inlined).
#
# Selection rules:
#   - <title>  — guarantees the page shipped with the correct identity.
#   - Mount point (#app, #clerk-sign-in) — guarantees the React/Clerk tree can
#     mount; an app without its mount point renders a blank page.
#   - One data-i18n key that is UNIQUE to the surface — protects against
#     accidentally serving the wrong bundle on the wrong route.
# ---------------------------------------------------------------------------
REQUIRED_MARKERS = {
    "index.html": [
        "<title>TRACEFAB — The intelligence layer for the global textile supply chain</title>",
        'id="supply-chain"',
        'data-i18n="spine.',
        "Tracefab",
    ],
    "brand-console/index.html": [
        "<title>Tracefab — Brand Console</title>",
        # Mount point may carry attributes (e.g. id="app" class="loaded").
        ('<div[^>]+id="app"', 'div id=app'),
        'data-action="new-request"',
    ],
    "supplier-portal/index.html": [
        "<title>Tracefab — Supplier Portal</title>",
        ('<div[^>]+id="app"', 'div id=app'),
        'data-action="submit-request"',
    ],
    "dpp/index.html": [
        'data-i18n="dpp.metaTitle"',
        "CIRPASS",
        'data-i18n="dpp.cirIndex"',
        "GS1 Digital Link",
    ],
    "operations/index.html": [
        "<title>Tracefab — Operations</title>",
        ('<div[^>]+id="app"', 'div id=app'),
    ],
    "passport/index.html": [
        ('<div[^>]+id="app"', 'div id=app'),
        'data-i18n="passport.metaTitle"',
        'data-i18n="passport.seal"',
    ],
    "product-intelligence/index.html": [
        "<title>TRACEFAB — Product Intelligence</title>",
        'data-i18n="pi.demoBanner"',
    ],
    "quality-center/index.html": [
        "<title>Tracefab — Quality Center</title>",
        ('<div[^>]+id="app"', 'div id=app'),
    ],
    "invitations/accept/index.html": [
        'id="clerk-sign-in"',
        'data-i18n="invite.metaTitle"',
        'data-i18n="invite.acceptBtn"',
    ],
}

# Any <script src=...> not matching one of these prefixes is a foreign resource
# (CDN, Clerk, absolute URL, http://…) and must be reviewed explicitly rather
# than silently accepted.
ALLOWED_SCRIPT_PREFIXES: tuple[str, ...] = (
    "/assets/",
    # Clerk is loaded from its own CDN for session handling — explicit allow.
    "https://",  # Any other https:// script will be flagged below.
)
CLERK_SCRIPT_ALLOWLIST: tuple[str, ...] = (
    "https://clerk.",
)

SCRIPT_TAG = re.compile(r'<script\s[^>]*src="([^"]+)"[^>]*></script>', re.IGNORECASE)


def load_bundles(root: Path) -> dict:
    manifest_path = root / "assets/js/.page-bundles.json"
    with manifest_path.open(encoding="utf-8") as manifest_file:
        bundles = json.load(manifest_file)
    if not isinstance(bundles, dict):
        raise ValueError("assets/js/.page-bundles.json must contain a JSON object")
    # All keys must be known pages, all values must be lists of strings.
    for page, declared in bundles.items():
        if page not in REQUIRED_MARKERS:
            raise ValueError(f"manifest declares unknown page: {page}")
        if not isinstance(declared, list) or not all(isinstance(s, str) for s in declared):
            raise ValueError(f"manifest entry for {page} must be a list of strings")
        for asset in declared:
            if not asset.startswith("/assets/"):
                raise ValueError(f"manifest entry {page}: asset must start with /assets/: {asset}")
    return bundles


def audit_script_sources(root: Path, relative_path: str, html: str, bundles: dict) -> list[str]:
    """Validate every <script src=...>: no foreign origin, declared bundles must
    exist on disk and be referenced; undeclared scripts must be explicitly
    allowed (shared tf-* helpers, Clerk)."""
    errors: list[str] = []
    declared_set = set(bundles.get(relative_path, []))
    referenced_owned: set[str] = set()
    allowed_shared: set[str] = set()

    for match in SCRIPT_TAG.finditer(html):
        src = match.group(1).split("?", 1)[0]

        # Allow Clerk CDN explicitly (sessions portail).
        if any(src.startswith(prefix) for prefix in CLERK_SCRIPT_ALLOWLIST):
            allowed_shared.add(src)
            continue

        if not src.startswith("/assets/"):
            errors.append(
                f"{relative_path}: foreign <script src> not in allow-list: {src}"
            )
            continue

        if src.startswith("/assets/js/tf-") or src.startswith("/assets/i18n/"):
            # Shared helpers (tf-skip-meta, tf-i18n, tf-actions, tf-landing…)
            # and the i18n catalogue (en.js and locale JSON loaded at runtime):
            # présents sur plusieurs pages, pas dans le manifest applicatif.
            disk_path = root / src.lstrip("/")
            if not disk_path.is_file():
                errors.append(f"{relative_path}: shared helper missing on disk: {src}")
            allowed_shared.add(src)
            continue

        if src not in declared_set:
            errors.append(
                f"{relative_path}: page references a JavaScript asset not declared "
                f"in .page-bundles.json: {src}"
            )
            continue

        disk_path = root / src.lstrip("/")
        if not disk_path.is_file():
            errors.append(f"{relative_path}: declared JavaScript bundle missing on disk: {src}")
            continue

        referenced_owned.add(src)

    for asset in sorted(declared_set - referenced_owned):
        errors.append(
            f"{relative_path}: manifest bundle is not referenced by the page: {asset}"
        )
    return errors


def load_page_source(root: Path, relative_path: str, bundles: dict) -> tuple[str, list[str]]:
    """Inline every manifest-owned JS script (so that markers inside the bundle
    are found by marker matching, like data-action= or Authorization = …)."""
    html = (root / relative_path).read_text(encoding="utf-8")
    declared = bundles.get(relative_path, [])
    declared_set = set(declared)
    errors: list[str] = []

    def inline_owned_script(match: re.Match) -> str:
        full_tag = match.group(0)
        src_attr = re.search(r'src="([^"]+)"', full_tag)
        if not src_attr:
            return full_tag
        href = src_attr.group(1).split("?", 1)[0]
        if href not in declared_set:
            return full_tag
        disk_path = root / href.lstrip("/")
        if not disk_path.is_file():
            return full_tag  # l'erreur est déjà rapportée par audit_script_sources
        source = disk_path.read_text(encoding="utf-8")
        # Replace just the src= attribute with an inline body. Using a lambda
        # avoids re.sub interpreting backslashes in the JS source as regex
        # group references (bad escape \s error).
        return re.sub(
            r'\s+src="[^"]+"',
            lambda _m: f">\n{source}\n<script ",
            full_tag,
            count=1,
        )

    complete_source = SCRIPT_TAG.sub(inline_owned_script, html)
    return complete_source, errors


def run_audit(root: Path) -> bool:
    print("=== TRACEFAB END-TO-END VALIDATION AUDIT (FAIL-CLOSED) ===")
    all_pass = True
    try:
        bundles = load_bundles(root)
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print(f"❌ JavaScript bundle manifest invalid or missing: {error}")
        print("\nAudit Status: FAIL")
        return False

    # 1. Chaque page déclarée dans REQUIRED_MARKERS doit exister et satisfaire
    #    ses ancrages fonctionnels.
    for relative_path, markers in REQUIRED_MARKERS.items():
        file_path = root / relative_path
        if not file_path.is_file():
            print(f"❌ File missing: {relative_path}")
            all_pass = False
            continue

        try:
            content = file_path.read_text(encoding="utf-8")
        except (OSError, UnicodeError) as error:
            print(f"❌ Cannot read {relative_path}: {error}")
            all_pass = False
            continue

        source_errors = audit_script_sources(root, relative_path, content, bundles)
        if source_errors:
            all_pass = False
            for error in source_errors:
                print(f"❌ {error}")

        complete_source, inline_errors = load_page_source(root, relative_path, bundles)
        if inline_errors:
            all_pass = False
            for error in inline_errors:
                print(f"❌ {error}")

        missing = []
        haystack = complete_source.casefold()
        for marker in markers:
            if isinstance(marker, tuple):
                pattern, label = marker
                if not re.search(pattern, complete_source, flags=re.IGNORECASE):
                    missing.append(label)
            elif marker.casefold() not in haystack:
                missing.append(marker)
        if missing:
            print(f"❌ {relative_path}: Missing required markers {missing}")
            all_pass = False
        elif not source_errors and not inline_errors:
            print(f"✅ {relative_path}: All {len(markers)} required markers present ({len(content):,} chars)")

    # 2. Aucune page HTML du dépôt n'est OMISE de REQUIRED_MARKERS (sinon une
    #    nouvelle surface peut être ajoutée sans être auditée).
    known_pages = set(REQUIRED_MARKERS.keys())
    for html in list(root.glob("*/index.html")) + [root / "index.html"]:
        rel = str(html.relative_to(root))
        if rel == "index.html":
            pass
        if rel not in known_pages:
            print(f"❌ {rel}: page HTML présente dans le dépôt mais absente de REQUIRED_MARKERS")
            all_pass = False

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
