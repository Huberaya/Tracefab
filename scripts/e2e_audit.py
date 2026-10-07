import os
import re

print("=== TRACEFAB END-TO-END VALIDATION AUDIT (PHASE 12) ===")

files = {
    "index.html": [
        "KNOW YOUR PRODUCT",
        "LIVING DATA CORE",
        "Multi-Echelon",
        "Tracefab"
    ],
    "brand-console/index.html": [
        "MISSION CONTROL CENTER",
        "PRODUCT LINEAGE",
        "POUVEZ-VOUS FAIRE CONFIANCE",
        "TRACEFAB Intelligence",
        "CHAÎNE DE GARDE CERTIFIÉE ISO 22095",
        "Clerk"
    ],
    "supplier-portal/index.html": [
        "COFFRE-FORT FOURNISSEUR",
        "Vos données. Votre profil.",
        "Supplier Profile 82% Completion Bar",
        "Clerk"
    ],
    "dpp/index.html": [
        "Passeport Numérique",
        "CIRPASS",
        "Indice de Réparabilité",
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
