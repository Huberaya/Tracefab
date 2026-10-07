#!/usr/bin/env python3
"""PHASE 5 — add the Risk surface to the Brand Console.

`risk` is the only navigation entry from the brief that the console did not
have. The dispatch in render() falls through to requestDetailView(), so a nav
button without a view would have rendered the wrong screen; this patch adds
both. It also removes the last two hardcoded French labels in the nav and the
one emoji that broke the geometric icon set.

Run:  python3 scripts/patch_console_risk.py
"""
import json
import pathlib
import re

HTML = pathlib.Path(__file__).resolve().parent.parent / "brand-console" / "index.html"

# ── i18n ────────────────────────────────────────────────────────────────────
KEYS = {
    "en": {
        "risk": "Risk", "massBalance": "Mass balance (TC)", "integrations": "Integrations",
        "riskTitle": "Risk", "riskLead": "Where the supply chain is exposed, and what is already being done about it.",
        "riskSuppliersReview": "Suppliers need review", "riskCertsExpiring": "Certificates expiring",
        "riskCountriesWatch": "Countries on watch", "riskCriticalFindings": "Critical findings",
        "riskRegister": "Risk register", "riskSupplier": "Supplier", "riskCountry": "Country",
        "riskTier": "Tier", "riskType": "Risk", "riskSeverity": "Severity", "riskStatus": "Status",
        "riskTypeCert": "Certificate", "riskTypeData": "Data gap", "riskTypeAudit": "Audit finding",
        "riskTypeGeo": "Geographic", "riskSevCritical": "Critical", "riskSevWarning": "Warning",
        "riskSevReview": "Review", "riskOpen": "Open", "riskMitigating": "Mitigating",
        "riskExposure": "Exposure by tier",
        "riskNote": "Severity is derived from evidence age, certificate validity and audit findings. It is an operational signal, not a compliance verdict.",
        "riskNoneTitle": "No open risk", "riskNoneBody": "Nothing in this workspace is currently flagged.",
    },
    "fr": {
        "risk": "Risque", "massBalance": "Bilan massique (TC)", "integrations": "Intégrations",
        "riskTitle": "Risque", "riskLead": "Où la chaîne est exposée, et ce qui est déjà engagé pour y répondre.",
        "riskSuppliersReview": "Fournisseurs à revoir", "riskCertsExpiring": "Certificats expirants",
        "riskCountriesWatch": "Pays sous surveillance", "riskCriticalFindings": "Constats critiques",
        "riskRegister": "Registre des risques", "riskSupplier": "Fournisseur", "riskCountry": "Pays",
        "riskTier": "Rang", "riskType": "Risque", "riskSeverity": "Gravité", "riskStatus": "Statut",
        "riskTypeCert": "Certificat", "riskTypeData": "Donnée manquante", "riskTypeAudit": "Constat d’audit",
        "riskTypeGeo": "Géographique", "riskSevCritical": "Critique", "riskSevWarning": "Avertissement",
        "riskSevReview": "À revoir", "riskOpen": "Ouvert", "riskMitigating": "En traitement",
        "riskExposure": "Exposition par rang",
        "riskNote": "La gravité découle de l’ancienneté des preuves, de la validité des certificats et des constats d’audit. C’est un signal opérationnel, pas un verdict de conformité.",
        "riskNoneTitle": "Aucun risque ouvert", "riskNoneBody": "Rien n’est actuellement signalé dans cet espace.",
    },
    "de": {
        "risk": "Risiko", "massBalance": "Massenbilanz (TC)", "integrations": "Integrationen",
        "riskTitle": "Risiko", "riskLead": "Wo die Lieferkette exponiert ist und was bereits dagegen läuft.",
        "riskSuppliersReview": "Lieferanten zu prüfen", "riskCertsExpiring": "Ablaufende Zertifikate",
        "riskCountriesWatch": "Länder unter Beobachtung", "riskCriticalFindings": "Kritische Feststellungen",
        "riskRegister": "Risikoregister", "riskSupplier": "Lieferant", "riskCountry": "Land",
        "riskTier": "Stufe", "riskType": "Risiko", "riskSeverity": "Schweregrad", "riskStatus": "Status",
        "riskTypeCert": "Zertifikat", "riskTypeData": "Datenlücke", "riskTypeAudit": "Audit-Feststellung",
        "riskTypeGeo": "Geografisch", "riskSevCritical": "Kritisch", "riskSevWarning": "Warnung",
        "riskSevReview": "Prüfen", "riskOpen": "Offen", "riskMitigating": "In Bearbeitung",
        "riskExposure": "Exposition nach Stufe",
        "riskNote": "Der Schweregrad ergibt sich aus Nachweisalter, Zertifikatsgültigkeit und Audit-Feststellungen. Ein operatives Signal, kein Compliance-Urteil.",
        "riskNoneTitle": "Kein offenes Risiko", "riskNoneBody": "In diesem Arbeitsbereich ist derzeit nichts markiert.",
    },
    "it": {
        "risk": "Rischio", "massBalance": "Bilancio di massa (TC)", "integrations": "Integrazioni",
        "riskTitle": "Rischio", "riskLead": "Dove la filiera è esposta e cosa è già in corso per rispondervi.",
        "riskSuppliersReview": "Fornitori da rivedere", "riskCertsExpiring": "Certificati in scadenza",
        "riskCountriesWatch": "Paesi sotto osservazione", "riskCriticalFindings": "Rilievi critici",
        "riskRegister": "Registro dei rischi", "riskSupplier": "Fornitore", "riskCountry": "Paese",
        "riskTier": "Livello", "riskType": "Rischio", "riskSeverity": "Gravità", "riskStatus": "Stato",
        "riskTypeCert": "Certificato", "riskTypeData": "Dato mancante", "riskTypeAudit": "Rilievo di audit",
        "riskTypeGeo": "Geografico", "riskSevCritical": "Critico", "riskSevWarning": "Avviso",
        "riskSevReview": "Da rivedere", "riskOpen": "Aperto", "riskMitigating": "In gestione",
        "riskExposure": "Esposizione per livello",
        "riskNote": "La gravità deriva dall’età delle prove, dalla validità dei certificati e dai rilievi di audit. È un segnale operativo, non un verdetto di conformità.",
        "riskNoneTitle": "Nessun rischio aperto", "riskNoneBody": "Al momento nulla è segnalato in questo spazio.",
    },
    "es": {
        "risk": "Riesgo", "massBalance": "Balance de masa (TC)", "integrations": "Integraciones",
        "riskTitle": "Riesgo", "riskLead": "Dónde está expuesta la cadena y qué se está haciendo ya al respecto.",
        "riskSuppliersReview": "Proveedores por revisar", "riskCertsExpiring": "Certificados por vencer",
        "riskCountriesWatch": "Países en vigilancia", "riskCriticalFindings": "Hallazgos críticos",
        "riskRegister": "Registro de riesgos", "riskSupplier": "Proveedor", "riskCountry": "País",
        "riskTier": "Nivel", "riskType": "Riesgo", "riskSeverity": "Gravedad", "riskStatus": "Estado",
        "riskTypeCert": "Certificado", "riskTypeData": "Dato faltante", "riskTypeAudit": "Hallazgo de auditoría",
        "riskTypeGeo": "Geográfico", "riskSevCritical": "Crítico", "riskSevWarning": "Advertencia",
        "riskSevReview": "Por revisar", "riskOpen": "Abierto", "riskMitigating": "En tratamiento",
        "riskExposure": "Exposición por nivel",
        "riskNote": "La gravedad se deriva de la antigüedad de las pruebas, la validez de los certificados y los hallazgos de auditoría. Es una señal operativa, no un veredicto de conformidad.",
        "riskNoneTitle": "Sin riesgo abierto", "riskNoneBody": "Actualmente no hay nada marcado en este espacio.",
    },
    "nl": {
        "risk": "Risico", "massBalance": "Massabalans (TC)", "integrations": "Integraties",
        "riskTitle": "Risico", "riskLead": "Waar de keten blootstaat, en wat er al aan gedaan wordt.",
        "riskSuppliersReview": "Leveranciers te beoordelen", "riskCertsExpiring": "Verlopende certificaten",
        "riskCountriesWatch": "Landen onder toezicht", "riskCriticalFindings": "Kritieke bevindingen",
        "riskRegister": "Risicoregister", "riskSupplier": "Leverancier", "riskCountry": "Land",
        "riskTier": "Niveau", "riskType": "Risico", "riskSeverity": "Ernst", "riskStatus": "Status",
        "riskTypeCert": "Certificaat", "riskTypeData": "Ontbrekend gegeven", "riskTypeAudit": "Auditbevinding",
        "riskTypeGeo": "Geografisch", "riskSevCritical": "Kritiek", "riskSevWarning": "Waarschuwing",
        "riskSevReview": "Beoordelen", "riskOpen": "Open", "riskMitigating": "In behandeling",
        "riskExposure": "Blootstelling per niveau",
        "riskNote": "De ernst volgt uit de ouderdom van bewijs, de geldigheid van certificaten en auditbevindingen. Een operationeel signaal, geen nalevingsoordeel.",
        "riskNoneTitle": "Geen open risico", "riskNoneBody": "Er is momenteel niets gemarkeerd in deze werkruimte.",
    },
}

# ── the view ────────────────────────────────────────────────────────────────
RISK_VIEW = r"""
      function riskView() {
        // Demonstration mode shows the briefed figures. Connected mode derives
        // everything from live state and prints an em dash rather than guessing.
        const demo = state.demo;
        const sup = suppliers() || [];
        const counts = requestCounts ? requestCounts() : {};

        const rows = demo ? [
          { s: 'Adriatic Dye House', c: 'Italy', t: 2, k: 'riskTypeCert', sev: 'critical', st: 'riskOpen' },
          { s: 'Anatolia Weaving', c: 'Türkiye', t: 2, k: 'riskTypeAudit', sev: 'critical', st: 'riskMitigating' },
          { s: 'Guimarães Ring Spinners', c: 'Portugal', t: 3, k: 'riskTypeCert', sev: 'warning', st: 'riskOpen' },
          { s: 'Dhaka Knit Works', c: 'Bangladesh', t: 2, k: 'riskTypeGeo', sev: 'warning', st: 'riskMitigating' },
          { s: 'Coimbra Trims', c: 'Portugal', t: 3, k: 'riskTypeData', sev: 'review', st: 'riskOpen' },
          { s: 'Atelier Milano', c: 'Italy', t: 1, k: 'riskTypeData', sev: 'review', st: 'riskMitigating' }
        ] : [];

        const cells = [
          [demo ? 5 : (sup.length ? String(sup.filter(x => (x.dataQuality || 0) < 70).length) : '—'), 'riskSuppliersReview'],
          [demo ? 8 : '—', 'riskCertsExpiring'],
          [demo ? 3 : '—', 'riskCountriesWatch'],
          [demo ? 2 : (rows.filter(r => r.sev === 'critical').length || '—'), 'riskCriticalFindings']
        ];

        const band = `<div class="mc-band mc-band--4 is-dark">${cells.map(function (c, i) {
          return `<div class="mc-cell"><div class="mc-cell__k">${esc(bt(c[1]))}</div>`
            + `<div class="mc-cell__v${i === 3 ? ' is-accent' : ''}">${esc(String(c[0]))}</div></div>`;
        }).join('')}</div>`;

        const table = rows.length ? `<div class="card panel"><div class="panel-head"><h2>${esc(bt('riskRegister'))}</h2>`
          + `<span class="meta">${esc(bt('riskNote'))}</span></div>`
          + `<div class="table-wrap"><table><thead><tr>`
          + `<th>${esc(bt('riskSupplier'))}</th><th>${esc(bt('riskCountry'))}</th><th>${esc(bt('riskTier'))}</th>`
          + `<th>${esc(bt('riskType'))}</th><th>${esc(bt('riskSeverity'))}</th><th>${esc(bt('riskStatus'))}</th>`
          + `</tr></thead><tbody>${rows.map(function (r) {
            const sevKey = r.sev === 'critical' ? 'riskSevCritical' : r.sev === 'warning' ? 'riskSevWarning' : 'riskSevReview';
            return `<tr><td><strong>${esc(r.s)}</strong></td><td>${esc(r.c)}</td>`
              + `<td><span class="tier-badge">${esc(bt('riskTier'))} ${r.t}</span></td>`
              + `<td>${esc(bt(r.k))}</td>`
              + `<td><span class="mc-sev" data-sev="${r.sev}">${esc(bt(sevKey))}</span></td>`
              + `<td><span class="meta">${esc(bt(r.st))}</span></td></tr>`;
          }).join('')}</tbody></table></div></div>`
          : `<div class="card panel"><div class="empty-state"><h3>${esc(bt('riskNoneTitle'))}</h3>`
            + `<p>${esc(bt('riskNoneBody'))}</p></div></div>`;

        return `<div class="page-head"><div><div class="eyebrow">${esc(bt('navCollection'))}</div>`
          + `<h1>${esc(bt('riskTitle'))}</h1><p>${esc(bt('riskLead'))}</p></div>`
          + `<div class="actions">${demo ? `<span class="mc-demo">${esc(bt('mcDemoChip'))}</span>` : ''}</div></div>`
          + band + `<div style="height:24px"></div>` + table;
      }
"""


def main():
    s = HTML.read_text(encoding="utf-8")
    before = len(s)

    # 1. nav: add risk, de-hardcode two labels, drop the emoji
    old_nav = "${navButton('quality', '◒', bt('quality'))}"
    assert old_nav in s, "nav quality anchor missing"
    s = s.replace(old_nav, old_nav + "\n                ${navButton('risk', '⚠', bt('risk'))}", 1)

    s = s.replace("${navButton('massBalance', '⚖', 'Bilan Massique (TC)')}",
                  "${navButton('massBalance', '⚖', bt('massBalance'))}", 1)
    s = s.replace("${navButton('integrations', '⇄', 'Intégrations')}",
                  "${navButton('integrations', '⇄', bt('integrations'))}", 1)
    s = s.replace("${navButton('dpp', '📋', bt('dpp'))}",
                  "${navButton('dpp', '▣', bt('dpp'))}", 1)

    # 2. dispatch
    anchor = "state.view === 'quality' ? qualityView() :"
    assert anchor in s, "render dispatch anchor missing"
    s = s.replace(anchor, anchor + "\n          state.view === 'risk' ? riskView() :", 1)

    # 3. the view itself, inserted just before render()
    rmark = "\nfunction render() {"
    assert rmark in s, "render() definition missing"
    s = s.replace(rmark, "\n" + RISK_VIEW + rmark, 1)

    # 4. i18n keys per locale
    for lang, pairs in KEYS.items():
        m = re.search(r"\n(\s+)%s: \{\n" % lang, s)
        assert m, "locale %s not found in brandTranslations" % lang
        pad = m.group(1) + "  "
        block = "".join("%s%s: %s,\n" % (pad, k, json.dumps(v, ensure_ascii=False))
                        for k, v in pairs.items())
        s = s[:m.end()] + block + s[m.end():]

    HTML.write_text(s, encoding="utf-8")
    print("brand-console/index.html: %d -> %d bytes" % (before, len(s)))
    print("risk view + dispatch + nav entry added")
    print("de-hardcoded: massBalance, integrations; emoji 📋 -> ▣")
    print("i18n: %d keys x %d locales" % (len(KEYS["en"]), len(KEYS)))


if __name__ == "__main__":
    main()
