#!/usr/bin/env python3
"""Inject the Product Intelligence (pi.*) namespace into the TRACEFAB locale bundles.

EN is the reference locale and lives in assets/i18n/en.js.
FR is authored here too. DE/IT/ES/NL intentionally fall back to EN until
PHASE 12 (the i18n rollout phase) — tf-i18n.js resolves missing keys against
the EN bundle, so the page degrades to English copy rather than to raw keys.

Run:  python3 scripts/build_pi_locales.py
"""
import json
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent
I18N = ROOT / "assets" / "i18n"

EN = {
    "demoBanner": "Demonstration record — every figure on this page is demonstration data.",
    "console": "product intelligence",
    "demoUser": "Demonstration workspace",
    "nav": {
        "main": "Main console", "overview": "Overview", "products": "Products",
        "suppliers": "Suppliers", "materials": "Materials", "supplyChain": "Supply chain",
        "collection": "Collection & compliance", "dataCollection": "Data collection",
        "evidence": "Evidence", "certifications": "Certifications", "quality": "Quality",
        "risk": "Risk", "dpp": "DPP", "governance": "Governance", "reports": "Reports",
        "settings": "Settings",
    },
    "product": {
        "name": "Organic Cotton T-Shirt", "ref": "AW26-0248",
        "collection": "Autumn / Winter 2026",
        "lead": "Every value below carries a level of proof. Nothing is asserted without a document behind it.",
    },
    "actions": {"viewPassport": "View public passport", "requestData": "Request data"},
    "sections": {
        "signals": "Product signals", "identity": "Identity", "timeline": "Recent activity",
        "composition": "Composition", "materials": "Materials", "lineage": "Product lineage",
        "manufacturing": "Manufacturing", "suppliers": "Suppliers", "evidence": "Evidence",
        "certifications": "Certifications", "quality": "Data quality", "issues": "Open issues",
        "dpp": "DPP readiness", "history": "Full history",
    },
    "metrics": {"quality": "Data quality", "evidence": "Evidence coverage",
                "traceability": "Traceability", "dpp": "DPP readiness"},
    "tabs": {
        "overview": "Overview", "composition": "Composition", "materials": "Materials",
        "supplyChain": "Supply chain", "manufacturing": "Manufacturing", "suppliers": "Suppliers",
        "evidence": "Evidence", "certifications": "Certifications", "quality": "Quality",
        "dpp": "DPP", "history": "History",
    },
    "trust": {"missing": "Missing", "review": "Review", "declared": "Declared",
              "documented": "Documented", "verified": "Verified", "certified": "Certified"},
    "labels": {
        "reference": "Reference", "gtin": "GTIN", "sku": "SKU", "category": "Category",
        "collection": "Collection", "madeIn": "Made in", "status": "Status",
        "material": "Material", "share": "Share", "standard": "Standard", "proof": "Proof",
        "type": "Type", "supplier": "Supplier", "origin": "Origin", "step": "Step",
        "facility": "Facility", "country": "Country", "tier": "Tier",
        "dataQuality": "Data quality", "certificates": "Certificates", "document": "Document",
        "issuer": "Issuer", "issued": "Issued", "expires": "Expires",
        "verification": "Verification", "certificate": "Certificate", "scope": "Scope",
        "holder": "Holder", "fix": "Fix",
    },
    "values": {
        "category": "Jersey knitwear — short sleeve",
        "collection": "Autumn / Winter 2026",
        "madeIn": "Italy",
        "status": "Active — publication pending",
    },
    "fibers": {"organicCotton": "Organic cotton", "recycledElastane": "Recycled elastane",
               "sewingThread": "Sewing thread"},
    "types": {"yarn": "Yarn", "fabric": "Fabric", "chemical": "Chemical", "trim": "Trim"},
    "steps": {"spinning": "Spinning", "knitting": "Knitting", "dyeing": "Dyeing",
              "cutting": "Cutting", "assembly": "Assembly", "finishing": "Finishing"},
    "lineage": {
        "nodes": {"fiber": "Fiber", "spinner": "Spinner", "yarn": "Yarn", "fabric": "Fabric",
                  "dyehouse": "Dye house", "manufacturer": "Manufacturer",
                  "product": "Finished product", "dpp": "DPP"},
        "detail": {
            "fiber": "Raw organic cotton with per-lot transaction certificates, reconciled against mass balance.",
            "spinner": "Ring spinning of combed organic yarn. Third-party verification still pending on two counts.",
            "yarn": "Yarn lots linked to the product bill of materials with full chain-of-custody records.",
            "fabric": "Single jersey knitting with closed-loop water treatment at the Guimarães hall.",
            "dyehouse": "Reactive dyeing and finishing. Latest wastewater report is outside the twelve-month window.",
            "manufacturer": "Tier 1 assembly. Social and quality audits current, two findings in progress.",
            "product": "The finished article. Composition, identifiers, chain and evidence consolidated.",
            "dpp": "Publication readiness indicator. Two evidence items still outstanding.",
        },
    },
    "docs": {
        "transactionCert": "Transaction certificate", "labReport": "Laboratory test report",
        "socialAudit": "Social audit report", "wastewater": "Wastewater analysis",
        "productionRecord": "Production record", "materialDeclaration": "Material declaration",
    },
    "scopes": {
        "scopeFiberFabric": "Fiber to fabric", "scopeRecycled": "Recycled content",
        "scopeChemical": "Chemical safety", "scopeSocial": "Social compliance",
        "scopeWastewater": "Wastewater discharge",
    },
    "quality": {"completeness": "Completeness", "evidenceCoverage": "Evidence coverage",
                "verificationRate": "Verification rate", "supplyChainDepth": "Supply chain depth"},
    "issues": {
        "issueWastewater": {"t": "Wastewater analysis out of date",
                            "d": "Adriatic Dye House — last report exceeds the twelve-month window"},
        "issueOekoTex": {"t": "OEKO-TEX certificate expiring",
                         "d": "Guimarães Ring Spinners — valid for less than 90 days"},
        "issueSpinnerVerify": {"t": "Spinner data awaiting verification",
                               "d": "Two yarn counts declared but not third-party verified"},
    },
    "dpp": {
        "title": "Digital Product Passport readiness",
        "lead": "What this product could publish today, and what is still missing before it can.",
        "legal": "A readiness indicator, never a legal certification.",
        "score": "Readiness", "ready": "Ready to publish", "missing": "What is missing?",
        "items": {
            "dppIdentity": "Product identity and identifiers",
            "dppComposition": "Composition resolved to the percent",
            "dppMaterials": "Materials and their origin",
            "dppSuppliers": "Suppliers across four tiers",
            "dppManufacturing": "Manufacturing steps and facilities",
            "dppCare": "Care and maintenance instructions",
            "dppCircularity": "Circularity and recycled content",
            "dppGapWastewater": "Current wastewater analysis for the dye house",
            "dppGapRepair": "Repair and spare-part information",
        },
    },
    "history": {
        "hDppRecomputed": "DPP readiness recomputed — 88%",
        "hProductionRecord": "Production record attached by Atelier Milano",
        "hDyeFlagged": "Dye house flagged for review — wastewater report expired",
        "hLabReport": "Laboratory test report verified by Intertek",
        "hComposition": "Composition declaration resolved to the percent",
        "hGotsLinked": "GOTS 6.0 transaction certificate linked",
        "hSocialAudit": "SA8000 social audit accepted",
        "hCreated": "Product created in the workspace",
    },
    "notes": {
        "composition": "Percentages are resolved against the bill of materials and reconciled with the fiber transaction certificates.",
        "lineage": "Select a stage to inspect the organisation behind it. Each hop carries its own level of proof.",
        "evidence": "Every document is stored with its issuer, scope, validity window and a SHA-256 integrity seal.",
        "issues": "Each issue links to the screen that resolves it",
    },
}

FR = {
    "demoBanner": "Fiche de démonstration — tous les chiffres de cette page sont des données de démonstration.",
    "console": "intelligence produit",
    "demoUser": "Espace de démonstration",
    "nav": {
        "main": "Console principale", "overview": "Vue d’ensemble", "products": "Produits",
        "suppliers": "Fournisseurs", "materials": "Matières", "supplyChain": "Chaîne d’approvisionnement",
        "collection": "Collecte & conformité", "dataCollection": "Collecte de données",
        "evidence": "Preuves", "certifications": "Certifications", "quality": "Qualité",
        "risk": "Risque", "dpp": "DPP", "governance": "Gouvernance", "reports": "Rapports",
        "settings": "Paramètres",
    },
    "product": {
        "name": "T-shirt en coton biologique", "ref": "AW26-0248",
        "collection": "Automne / Hiver 2026",
        "lead": "Chaque valeur ci-dessous porte un niveau de preuve. Rien n’est affirmé sans un document derrière.",
    },
    "actions": {"viewPassport": "Voir le passeport public", "requestData": "Demander des données"},
    "sections": {
        "signals": "Signaux produit", "identity": "Identité", "timeline": "Activité récente",
        "composition": "Composition", "materials": "Matières", "lineage": "Lignage produit",
        "manufacturing": "Fabrication", "suppliers": "Fournisseurs", "evidence": "Preuves",
        "certifications": "Certifications", "quality": "Qualité des données", "issues": "Anomalies ouvertes",
        "dpp": "Préparation DPP", "history": "Historique complet",
    },
    "metrics": {"quality": "Qualité des données", "evidence": "Couverture des preuves",
                "traceability": "Traçabilité", "dpp": "Préparation DPP"},
    "tabs": {
        "overview": "Vue d’ensemble", "composition": "Composition", "materials": "Matières",
        "supplyChain": "Chaîne", "manufacturing": "Fabrication", "suppliers": "Fournisseurs",
        "evidence": "Preuves", "certifications": "Certifications", "quality": "Qualité",
        "dpp": "DPP", "history": "Historique",
    },
    "trust": {"missing": "Manquant", "review": "À revoir", "declared": "Déclaré",
              "documented": "Documenté", "verified": "Vérifié", "certified": "Certifié"},
    "labels": {
        "reference": "Référence", "gtin": "GTIN", "sku": "SKU", "category": "Catégorie",
        "collection": "Collection", "madeIn": "Fabriqué en", "status": "Statut",
        "material": "Matière", "share": "Part", "standard": "Référentiel", "proof": "Preuve",
        "type": "Type", "supplier": "Fournisseur", "origin": "Origine", "step": "Étape",
        "facility": "Site", "country": "Pays", "tier": "Rang",
        "dataQuality": "Qualité des données", "certificates": "Certificats", "document": "Document",
        "issuer": "Émetteur", "issued": "Émis le", "expires": "Expire le",
        "verification": "Vérification", "certificate": "Certificat", "scope": "Portée",
        "holder": "Détenteur", "fix": "Corriger",
    },
    "values": {
        "category": "Maille jersey — manches courtes",
        "collection": "Automne / Hiver 2026",
        "madeIn": "Italie",
        "status": "Actif — publication en attente",
    },
    "fibers": {"organicCotton": "Coton biologique", "recycledElastane": "Élasthanne recyclé",
               "sewingThread": "Fil à coudre"},
    "types": {"yarn": "Fil", "fabric": "Tissu", "chemical": "Produit chimique", "trim": "Fourniture"},
    "steps": {"spinning": "Filature", "knitting": "Tricotage", "dyeing": "Teinture",
              "cutting": "Coupe", "assembly": "Assemblage", "finishing": "Finition"},
    "lineage": {
        "nodes": {"fiber": "Fibre", "spinner": "Filateur", "yarn": "Fil", "fabric": "Tissu",
                  "dyehouse": "Teinturerie", "manufacturer": "Fabricant",
                  "product": "Produit fini", "dpp": "DPP"},
        "detail": {
            "fiber": "Coton biologique brut avec certificats de transaction par lot, réconciliés avec le bilan massique.",
            "spinner": "Filature à anneaux de fil biologique peigné. Vérification tierce encore en attente sur deux titrages.",
            "yarn": "Lots de fil rattachés à la nomenclature produit avec une chaîne de garde complète.",
            "fabric": "Tricotage jersey avec traitement de l’eau en circuit fermé à l’atelier de Guimarães.",
            "dyehouse": "Teinture réactive et finition. Le dernier rapport d’eaux usées dépasse la fenêtre de douze mois.",
            "manufacturer": "Assemblage de rang 1. Audits sociaux et qualité à jour, deux constats en cours.",
            "product": "L’article fini. Composition, identifiants, chaîne et preuves consolidés.",
            "dpp": "Indicateur de préparation à la publication. Deux preuves restent à fournir.",
        },
    },
    "docs": {
        "transactionCert": "Certificat de transaction", "labReport": "Rapport d’essai laboratoire",
        "socialAudit": "Rapport d’audit social", "wastewater": "Analyse des eaux usées",
        "productionRecord": "Relevé de production", "materialDeclaration": "Déclaration matière",
    },
    "scopes": {
        "scopeFiberFabric": "De la fibre au tissu", "scopeRecycled": "Contenu recyclé",
        "scopeChemical": "Sécurité chimique", "scopeSocial": "Conformité sociale",
        "scopeWastewater": "Rejets aqueux",
    },
    "quality": {"completeness": "Complétude", "evidenceCoverage": "Couverture des preuves",
                "verificationRate": "Taux de vérification", "supplyChainDepth": "Profondeur de chaîne"},
    "issues": {
        "issueWastewater": {"t": "Analyse des eaux usées périmée",
                            "d": "Adriatic Dye House — le dernier rapport dépasse la fenêtre de douze mois"},
        "issueOekoTex": {"t": "Certificat OEKO-TEX bientôt expiré",
                         "d": "Guimarães Ring Spinners — valide moins de 90 jours"},
        "issueSpinnerVerify": {"t": "Données filateur en attente de vérification",
                               "d": "Deux titrages déclarés mais non vérifiés par un tiers"},
    },
    "dpp": {
        "title": "Préparation au Passeport Numérique de Produit",
        "lead": "Ce que ce produit pourrait publier aujourd’hui, et ce qui manque encore pour y arriver.",
        "legal": "Un indicateur de préparation, jamais une certification juridique.",
        "score": "Préparation", "ready": "Prêt à publier", "missing": "Que manque-t-il ?",
        "items": {
            "dppIdentity": "Identité produit et identifiants",
            "dppComposition": "Composition résolue au pourcentage",
            "dppMaterials": "Matières et leur origine",
            "dppSuppliers": "Fournisseurs sur quatre rangs",
            "dppManufacturing": "Étapes de fabrication et sites",
            "dppCare": "Instructions d’entretien",
            "dppCircularity": "Circularité et contenu recyclé",
            "dppGapWastewater": "Analyse des eaux usées à jour pour la teinturerie",
            "dppGapRepair": "Informations de réparation et pièces détachées",
        },
    },
    "history": {
        "hDppRecomputed": "Préparation DPP recalculée — 88 %",
        "hProductionRecord": "Relevé de production joint par Atelier Milano",
        "hDyeFlagged": "Teinturerie signalée pour revue — rapport d’eaux usées expiré",
        "hLabReport": "Rapport d’essai vérifié par Intertek",
        "hComposition": "Déclaration de composition résolue au pourcentage",
        "hGotsLinked": "Certificat de transaction GOTS 6.0 rattaché",
        "hSocialAudit": "Audit social SA8000 accepté",
        "hCreated": "Produit créé dans l’espace de travail",
    },
    "notes": {
        "composition": "Les pourcentages sont résolus sur la nomenclature et réconciliés avec les certificats de transaction fibre.",
        "lineage": "Sélectionnez une étape pour inspecter l’organisation derrière. Chaque maillon porte son propre niveau de preuve.",
        "evidence": "Chaque document est stocké avec son émetteur, sa portée, sa fenêtre de validité et un sceau d’intégrité SHA-256.",
        "issues": "Chaque anomalie mène à l’écran qui la résout",
    },
}


def js_literal(obj, indent=2):
    """Render a dict as a JS object literal using single quotes, matching en.js."""
    pad = " " * indent
    out = ["{"]
    items = list(obj.items())
    for i, (k, v) in enumerate(items):
        comma = "," if i < len(items) - 1 else ""
        key = k if re.fullmatch(r"[A-Za-z_$][\w$]*", k) else "'%s'" % k
        if isinstance(v, dict):
            out.append("%s%s: %s%s" % (pad, key, js_literal(v, indent + 2), comma))
        else:
            out.append("%s%s: '%s'%s" % (pad, key, v.replace("\\", "\\\\").replace("'", "\\'"), comma))
    out.append(" " * (indent - 2) + "}")
    return "\n".join(out)


def inject_en():
    path = I18N / "en.js"
    src = path.read_text(encoding="utf-8")
    if "\n  pi: {" in src:
        src = re.sub(r"\n  pi: \{.*?\n  \},(?=\n  lang:)", "", src, flags=re.S)
    marker = "\n  lang: {"
    assert marker in src, "lang anchor not found in en.js"
    block = "\n  pi: " + js_literal(EN, 4) + ","
    src = src.replace(marker, block + marker, 1)
    path.write_text(src, encoding="utf-8")
    return len(src)


def inject_json(lang, data):
    path = I18N / ("%s.json" % lang)
    bundle = json.loads(path.read_text(encoding="utf-8"))
    bundle["pi"] = data
    # keep `lang` last for readability
    tail = bundle.pop("lang")
    bundle["lang"] = tail
    path.write_text(json.dumps(bundle, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return path


def count(d):
    return sum(count(v) if isinstance(v, dict) else 1 for v in d.values())


if __name__ == "__main__":
    size = inject_en()
    inject_json("fr", FR)
    print("pi.* keys: %d" % count(EN))
    print("en.js -> %d bytes" % size)
    print("fr.json updated")
    print("de/it/es/nl: resolved against EN by tf-i18n.js until PHASE 12")
