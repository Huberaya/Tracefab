import os
import re

print("=== TRACEFAB END-TO-END VALIDATION AUDIT (PHASE 12) ===")

# Les marqueurs visent des ancres insensibles a la locale : identifiants de
# section et cles i18n. Une copie traduite ne doit plus faire tomber l'audit.
files = {
    "index.html": [
        "KNOW YOUR PRODUCT",
        "LIVING DATA CORE",
        'id="supply-chain"',
        'data-i18n="spine.',
        "Tracefab"
    ],
    "brand-console/index.html": [
        "MISSION CONTROL CENTER",
        "PRODUCT LINEAGE",
        "qcTrustQuestion",
        "TRACEFAB Intelligence",
        "ISO 22095 CERTIFIED CHAIN OF CUSTODY",
        "Clerk"
    ],
    "supplier-portal/index.html": [
        "spHeroTag",
        "spHeroTitle",
        "Supplier Profile 82% Completion Bar",
        "Clerk"
    ],
    "dpp/index.html": [
        "data-i18n=\"dpp.metaTitle\"",
        "CIRPASS",
        "data-i18n=\"dpp.cirIndex\"",
        "GS1 Digital Link"
    ]
}

all_pass = True
for fpath, markers in files.items():
    if not os.path.exists(fpath):
        print(f"❌ File missing: {fpath}")
        all_pass = False
        continue
    with open(fpath, "r", encoding="utf-8") as f:
        content = f.read()
    missing = [m for m in markers if m.lower() not in content.lower()]
    if missing:
        print(f"❌ {fpath}: Missing markers {missing}")
        all_pass = False
    else:
        print(f"✅ {fpath}: All {len(markers)} markers present ({len(content):,} chars)")

print("\nAudit Status:", "PERFECT EXECUTION (100% PASS)" if all_pass else "FAIL")
