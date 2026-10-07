#!/usr/bin/env python3
"""PHASE 5 completion — wire the drill-down and align the nav with the brief.

Three gaps found when auditing PHASE 5 against the brief:

  A. No path existed from the console to the Product Intelligence surface, so
     the "Overview -> Explore -> Inspect -> Act" principle was not actually
     navigable. Adds an Intelligence action on every product row and on the
     product detail screen.
  B. Three nav labels diverged from the brief wording.
  C. productsView() — the screen the drill-down passes through — was 100%
     hardcoded French. Routed through bt().

productDetailView() and its locked form contract are left untouched.

Run:  python3 scripts/patch_console_drilldown.py
"""
import json
import pathlib
import re

HTML = pathlib.Path(__file__).resolve().parent.parent / "brand-console" / "index.html"

# ── B. nav labels, aligned with the brief ───────────────────────────────────
NAV = {
    "en": {"supplyChain": "Supply chain", "requests": "Data collection", "documents": "Evidence"},
    "fr": {"supplyChain": "Chaîne d’approvisionnement", "requests": "Collecte de données", "documents": "Preuves"},
    "de": {"supplyChain": "Lieferkette", "requests": "Datenerhebung", "documents": "Nachweise"},
    "it": {"supplyChain": "Filiera", "requests": "Raccolta dati", "documents": "Prove"},
    "es": {"supplyChain": "Cadena de suministro", "requests": "Recogida de datos", "documents": "Pruebas"},
    "nl": {"supplyChain": "Toeleveringsketen", "requests": "Gegevensverzameling", "documents": "Bewijs"},
    "pt": {"supplyChain": "Cadeia de fornecimento", "requests": "Recolha de dados", "documents": "Provas"},
}

# ── C. productsView copy ────────────────────────────────────────────────────
PV = {
    "en": {
        "pvEyebrow": "Product catalogue", "pvTitle": "Products",
        "pvLead": "Track completeness across your references, then open any product in full depth.",
        "pvImport": "Import CSV", "pvExport": "Export CSV", "pvAudit": "Export audit",
        "pvNew": "+ New product", "pvProduct": "Product", "pvCategory": "Category",
        "pvStatus": "Status", "pvCompleteness": "Completeness", "pvReadiness": "Readiness",
        "pvOpen": "Open", "pvIntel": "Intelligence",
        "pvEmptyTitle": "Your catalogue is empty", "pvEmptyBody": "Create your first product reference.",
        "pvIntelHint": "Open the full product record — composition, lineage, evidence and DPP readiness.",
    },
    "fr": {
        "pvEyebrow": "Catalogue produit", "pvTitle": "Produits",
        "pvLead": "Suivez la complétude de vos références, puis ouvrez n’importe quel produit en profondeur.",
        "pvImport": "Importer CSV", "pvExport": "Exporter CSV", "pvAudit": "Exporter audit",
        "pvNew": "+ Nouveau produit", "pvProduct": "Produit", "pvCategory": "Catégorie",
        "pvStatus": "Statut", "pvCompleteness": "Complétude", "pvReadiness": "Maturité",
        "pvOpen": "Ouvrir", "pvIntel": "Intelligence",
        "pvEmptyTitle": "Votre catalogue est vide", "pvEmptyBody": "Créez votre première référence produit.",
        "pvIntelHint": "Ouvrir la fiche complète — composition, lignage, preuves et maturité DPP.",
    },
    "de": {
        "pvEyebrow": "Produktkatalog", "pvTitle": "Produkte",
        "pvLead": "Verfolgen Sie die Vollständigkeit Ihrer Artikel und öffnen Sie jedes Produkt in voller Tiefe.",
        "pvImport": "CSV importieren", "pvExport": "CSV exportieren", "pvAudit": "Audit exportieren",
        "pvNew": "+ Neues Produkt", "pvProduct": "Produkt", "pvCategory": "Kategorie",
        "pvStatus": "Status", "pvCompleteness": "Vollständigkeit", "pvReadiness": "Reife",
        "pvOpen": "Öffnen", "pvIntel": "Intelligence",
        "pvEmptyTitle": "Ihr Katalog ist leer", "pvEmptyBody": "Legen Sie Ihr erstes Produkt an.",
        "pvIntelHint": "Vollständigen Produktdatensatz öffnen — Zusammensetzung, Herkunftskette, Nachweise und DPP-Reife.",
    },
    "it": {
        "pvEyebrow": "Catalogo prodotti", "pvTitle": "Prodotti",
        "pvLead": "Monitora la completezza dei tuoi articoli, poi apri qualsiasi prodotto in profondità.",
        "pvImport": "Importa CSV", "pvExport": "Esporta CSV", "pvAudit": "Esporta audit",
        "pvNew": "+ Nuovo prodotto", "pvProduct": "Prodotto", "pvCategory": "Categoria",
        "pvStatus": "Stato", "pvCompleteness": "Completezza", "pvReadiness": "Prontezza",
        "pvOpen": "Apri", "pvIntel": "Intelligence",
        "pvEmptyTitle": "Il catalogo è vuoto", "pvEmptyBody": "Crea il tuo primo prodotto.",
        "pvIntelHint": "Apri la scheda completa — composizione, filiera, prove e prontezza DPP.",
    },
    "es": {
        "pvEyebrow": "Catálogo de productos", "pvTitle": "Productos",
        "pvLead": "Sigue la completitud de tus referencias y abre cualquier producto en profundidad.",
        "pvImport": "Importar CSV", "pvExport": "Exportar CSV", "pvAudit": "Exportar auditoría",
        "pvNew": "+ Nuevo producto", "pvProduct": "Producto", "pvCategory": "Categoría",
        "pvStatus": "Estado", "pvCompleteness": "Completitud", "pvReadiness": "Preparación",
        "pvOpen": "Abrir", "pvIntel": "Intelligence",
        "pvEmptyTitle": "Tu catálogo está vacío", "pvEmptyBody": "Crea tu primera referencia de producto.",
        "pvIntelHint": "Abrir la ficha completa — composición, trazado, pruebas y preparación DPP.",
    },
    "nl": {
        "pvEyebrow": "Productcatalogus", "pvTitle": "Producten",
        "pvLead": "Volg de volledigheid van je referenties en open elk product in volle diepte.",
        "pvImport": "CSV importeren", "pvExport": "CSV exporteren", "pvAudit": "Audit exporteren",
        "pvNew": "+ Nieuw product", "pvProduct": "Product", "pvCategory": "Categorie",
        "pvStatus": "Status", "pvCompleteness": "Volledigheid", "pvReadiness": "Gereedheid",
        "pvOpen": "Openen", "pvIntel": "Intelligence",
        "pvEmptyTitle": "Je catalogus is leeg", "pvEmptyBody": "Maak je eerste productreferentie aan.",
        "pvIntelHint": "Open het volledige productdossier — samenstelling, keten, bewijs en DPP-gereedheid.",
    },
}

NEW_PRODUCTS_VIEW = r"""function productsView() {
        const t = bt;
        const rows = state.products.map((p) => `<tr>`
          + `<td><strong>${esc(p.name)}</strong><div class="meta">${esc(p.reference)} · v${esc(p.version)}</div></td>`
          + `<td>${esc(p.category || '—')}</td>`
          + `<td>${status(p.status)}</td>`
          + `<td><div class="progress-line"><div class="progress"><span style="width:${pct(p.dataCompletion)}%"></span></div><small>${moneyless(p.dataCompletion)}%</small></div></td>`
          + `<td>${status(p.dataReadiness || 'in_progress')}</td>`
          + `<td><div class="actions" style="justify-content:flex-end">`
          + `<a class="btn btn-primary btn-small" href="/product-intelligence/?ref=${encodeURIComponent(p.reference || p.id)}" title="${esc(t('pvIntelHint'))}">${esc(t('pvIntel'))}</a>`
          + `<button class="btn btn-secondary btn-small" data-product-id="${esc(p.id)}">${esc(t('pvOpen'))}</button>`
          + `<button class="btn btn-secondary btn-small" data-dpp-product="${esc(p.id)}">${esc(t('dpp'))}</button>`
          + `<button class="btn btn-secondary btn-small" data-quality-product="${esc(p.id)}">${esc(t('quality'))}</button>`
          + `</div></td></tr>`).join('');

        return `<div class="page-head"><div><div class="eyebrow">${esc(t('pvEyebrow'))}</div>`
          + `<h1>${esc(t('pvTitle'))}</h1><p>${esc(t('pvLead'))}</p></div>`
          + `<div class="actions">`
          + `<button class="btn btn-secondary" data-action="catalog-import">${esc(t('pvImport'))}</button>`
          + `<button class="btn btn-secondary" data-action="catalog-export">${esc(t('pvExport'))}</button>`
          + `<button class="btn btn-secondary" data-action="audit-export">${esc(t('pvAudit'))}</button>`
          + `<button class="btn btn-primary" data-action="new-product">${esc(t('pvNew'))}</button>`
          + `</div></div>`
          + `<div class="card panel">${state.products.length
            ? `<div class="table-wrap"><table><thead><tr>`
              + `<th>${esc(t('pvProduct'))}</th><th>${esc(t('pvCategory'))}</th><th>${esc(t('pvStatus'))}</th>`
              + `<th>${esc(t('pvCompleteness'))}</th><th>${esc(t('pvReadiness'))}</th><th></th>`
              + `</tr></thead><tbody>${rows}</tbody></table></div>`
            : `<div class="empty"><div class="empty-icon">◇</div><strong>${esc(t('pvEmptyTitle'))}</strong>`
              + `<p>${esc(t('pvEmptyBody'))}</p>`
              + `<button class="btn btn-primary btn-small" data-action="new-product">${esc(t('pvNew'))}</button></div>`
          }</div>`;
      }"""


def main():
    s = HTML.read_text(encoding="utf-8")
    before = len(s)

    # A+C. replace productsView wholesale
    a = s.index("function productsView() {")
    b = s.index("\n      function ", a + 10)
    s = s[:a] + NEW_PRODUCTS_VIEW + s[b:]

    # A. a way into the intelligence surface from the product detail screen too
    det_a = s.index("function productDetailView() {")
    det_b = s.index("\n      function ", det_a + 10)
    det = s[det_a:det_b]
    m = re.search(r'<div class="actions">', det)
    if m:
        link = ('<div class="actions">'
                '${state.product && state.product.reference ? `<a class="btn btn-primary btn-small" '
                'href="/product-intelligence/?ref=${encodeURIComponent(state.product.reference)}">'
                '${esc(bt(\'pvIntel\'))}</a>` : \'\'}')
        det = det[:m.start()] + link + det[m.end():]
        s = s[:det_a] + det + s[det_b:]

    # B + C. locale payloads
    for lang in NAV:
        pairs = dict(NAV[lang])
        pairs.update(PV.get(lang, PV["en"]))
        mm = re.search(r"\n(\s+)%s: \{\n" % lang, s)
        assert mm, "locale %s missing" % lang
        pad = mm.group(1) + "  "
        # overwrite existing nav keys in place, insert the rest
        body_start = mm.end()
        # the last locale block closes without a trailing comma
        bm = re.search(r"\n" + mm.group(1) + r"\},?\n", s[body_start:])
        assert bm, "end of %s block not found" % lang
        body_end = body_start + bm.start()
        body = s[body_start:body_end]
        fresh = {}
        for k, v in pairs.items():
            kre = re.compile(r"^(\s+)%s:\s*(\"(?:[^\"\\]|\\.)*\"|'(?:[^'\\]|\\.)*'),\s*$" % re.escape(k), re.M)
            if kre.search(body):
                body = kre.sub(lambda mo: '%s%s: %s,' % (mo.group(1), k, json.dumps(v, ensure_ascii=False)), body, count=1)
            else:
                fresh[k] = v
        add = "".join("%s%s: %s,\n" % (pad, k, json.dumps(v, ensure_ascii=False)) for k, v in fresh.items())
        s = s[:body_start] + add + body + s[body_end:]

    HTML.write_text(s, encoding="utf-8")
    print("brand-console/index.html: %d -> %d bytes" % (before, len(s)))
    print("A  drill-down: Intelligence action on product rows + product detail")
    print("B  nav labels aligned with the brief (supplyChain / requests / documents)")
    print("C  productsView() routed through bt() in 7 locales")


if __name__ == "__main__":
    main()
