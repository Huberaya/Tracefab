#!/usr/bin/env python3
"""PHASE 8 — Evidence Center + Quality Center.

Evidence Center: the brief's seven evidence types, each record carrying
Source / Date / Issuer / Product / Supplier / Status / Verification / Expiration,
on the trust scale already defined in the design system.

Quality Center: leads with "Can you trust your data?" and the five briefed
measures, then a CRITICAL / WARNING / REVIEW / RESOLVED board where every issue
carries the button that goes to its fix. The existing product-scoped score
(backed by /api/quality/products/) is preserved underneath as the drill-down.

Also replaces the fake `onclick="alert(...)"` buttons in these two views: they
promised actions the app never performed.

Run:  python3 scripts/patch_console_evidence_quality.py
"""
import json
import pathlib
import re

HTML = pathlib.Path(__file__).resolve().parent.parent / "brand-console" / "index.html"

DEMO_EVIDENCE = r"""
      // ── PHASE 8 — demonstration evidence ────────────────────────────────
      // Seven evidence types from the brief. Every record carries the eight
      // attributes an auditor asks for. Demonstration data, flagged as such.
      function demoEvidence() {
        return [
          { id:'ev-01', type:'certificate', title:'GOTS Scope Certificate', ref:'CU-881294',
            issuer:'Control Union', source:'supplierUpload', date:'2026-03-14', expires:'2027-03-13',
            product:'AW26-0248', supplier:'Atelier Milano', trust:'certified', verification:'thirdParty' },
          { id:'ev-02', type:'testReport', title:'OEKO-TEX Standard 100 test report', ref:'SH-2026-4471',
            issuer:'Hohenstein', source:'labDirect', date:'2026-02-02', expires:'2027-02-01',
            product:'AW26-0248', supplier:'Lisboa Dyeworks', trust:'verified', verification:'thirdParty' },
          { id:'ev-03', type:'audit', title:'SA8000 social audit — Porto facility', ref:'AUD-2025-882',
            issuer:'SGS', source:'auditBody', date:'2025-11-19', expires:'2026-11-18',
            product:'—', supplier:'Porto Knitwear', trust:'verified', verification:'thirdParty' },
          { id:'ev-04', type:'declaration', title:'ZDHC MRSL conformity declaration', ref:'DEC-4410',
            issuer:'Lisboa Dyeworks', source:'supplierUpload', date:'2026-01-08', expires:'2026-12-31',
            product:'AW26-0248', supplier:'Lisboa Dyeworks', trust:'declared', verification:'selfDeclared' },
          { id:'ev-05', type:'productionRecord', title:'Dye lot production record — batch 2026-114', ref:'PR-2026-114',
            issuer:'Lisboa Dyeworks', source:'erpSync', date:'2026-04-02', expires:'',
            product:'AW26-0248', supplier:'Lisboa Dyeworks', trust:'documented', verification:'brandReviewed' },
          { id:'ev-06', type:'invoice', title:'Transaction certificate — organic cotton yarn', ref:'TC-77210',
            issuer:'Control Union', source:'supplierUpload', date:'2026-02-21', expires:'',
            product:'AW26-0248', supplier:'Izmir Spinning', trust:'certified', verification:'thirdParty' },
          { id:'ev-07', type:'document', title:'Supplier code of conduct — signed', ref:'DOC-1182',
            issuer:'Atelier Milano', source:'supplierUpload', date:'2025-09-30', expires:'',
            product:'—', supplier:'Atelier Milano', trust:'documented', verification:'brandReviewed' },
          { id:'ev-08', type:'certificate', title:'GRS Scope Certificate', ref:'CU-902118',
            issuer:'Control Union', source:'supplierUpload', date:'2025-10-22', expires:'2026-10-21',
            product:'AW26-0311', supplier:'Izmir Spinning', trust:'review', verification:'pending' },
          { id:'ev-09', type:'testReport', title:'Fibre composition analysis', ref:'LAB-2026-0097',
            issuer:'Intertek', source:'labDirect', date:'2026-03-28', expires:'',
            product:'AW26-0311', supplier:'Izmir Spinning', trust:'verified', verification:'thirdParty' },
          { id:'ev-10', type:'declaration', title:'REACH SVHC statement', ref:'DEC-5521',
            issuer:'Porto Knitwear', source:'supplierUpload', date:'2024-12-15', expires:'2025-12-14',
            product:'AW26-0402', supplier:'Porto Knitwear', trust:'missing', verification:'expired' }
        ];
      }

      const EV_TYPES = ['document', 'certificate', 'testReport', 'declaration', 'audit', 'invoice', 'productionRecord'];
      const evidenceRecords = () => (state.documents && state.documents.length)
        ? state.documents
        : (state.demo ? demoEvidence() : []);
      // An expiry inside 90 days is worth saying out loud.
      const evExpiringSoon = (rec) => {
        if (!rec.expires) return false;
        const d = new Date(rec.expires).getTime() - Date.now();
        return d > 0 && d < 90 * 86400000;
      };
      const evExpired = (rec) => !!rec.expires && new Date(rec.expires).getTime() < Date.now();
"""

EVIDENCE_VIEW = r"""function documentsConsoleView() {
        const recs = evidenceRecords();
        const counts = {};
        EV_TYPES.forEach((t) => { counts[t] = recs.filter((r) => r.type === t).length; });
        const expiring = recs.filter(evExpiringSoon);
        const expired = recs.filter(evExpired);

        const typeBand = `<div class="ev-types">
          <button class="ev-type is-on" data-ev-type="all">
            <span class="ev-type__v">${moneyless(recs.length)}</span>
            <span class="ev-type__n">${esc(bt('evAll'))}</span></button>
          ${EV_TYPES.map((t) => `<button class="ev-type" data-ev-type="${t}">
            <span class="ev-type__v">${moneyless(counts[t])}</span>
            <span class="ev-type__n">${esc(bt('evT_' + t))}</span></button>`).join('')}
        </div>`;

        const alertBar = (expired.length || expiring.length) ? `<div class="ev-alert">
          ${expired.length ? `<span class="ev-alert__i" data-sev="critical">${moneyless(expired.length)}</span>
            <span>${esc(bt('evExpired'))}</span>` : ''}
          ${expiring.length ? `<span class="ev-alert__i" data-sev="warning">${moneyless(expiring.length)}</span>
            <span>${esc(bt('evExpiringSoon'))}</span>` : ''}
        </div>` : '';

        const rows = recs.map((r) => {
          const soon = evExpiringSoon(r), gone = evExpired(r);
          return `<tr data-ev-row="${esc(r.type)}">
            <td><strong>${esc(r.title)}</strong><div class="meta">${esc(r.ref || '—')}</div></td>
            <td>${esc(bt('evT_' + r.type))}</td>
            <td>${esc(r.issuer || '—')}</td>
            <td><span class="meta">${esc(bt('evSrc_' + (r.source || 'supplierUpload')))}</span></td>
            <td>${esc(r.product || '—')}</td>
            <td>${esc(r.supplier || '—')}</td>
            <td>${date(r.date)}</td>
            <td>${r.expires
              ? `<span class="ev-exp${gone ? ' is-gone' : (soon ? ' is-soon' : '')}">${date(r.expires)}</span>`
              : `<span class="meta">${esc(bt('evNoExpiry'))}</span>`}</td>
            <td><span class="tf-trust" data-level="${esc(r.trust)}">${esc(bt('evTrust_' + r.trust))}</span></td>
            <td><span class="meta">${esc(bt('evV_' + (r.verification || 'selfDeclared')))}</span></td>
          </tr>`;
        }).join('');

        return `<div class="page-head"><div>
            <div class="eyebrow">${esc(bt('evEyebrow'))}</div>
            <h1>${esc(bt('evTitle'))}</h1><p>${esc(bt('evLead'))}</p></div>
            <div class="actions">${state.demo ? `<span class="mc-demo">${esc(bt('mcDemoData'))}</span>` : ''}</div>
          </div>

          ${typeBand}
          ${alertBar}

          <div style="height:22px"></div>
          <div class="card panel">
            <div class="panel-head"><h2>${esc(bt('evRegister'))}</h2>
              <span class="meta">${esc(bt('evTrustScale'))}</span></div>
            <div class="table-wrap"><table><thead><tr>
              <th>${esc(bt('evC_item'))}</th><th>${esc(bt('evC_type'))}</th><th>${esc(bt('evC_issuer'))}</th>
              <th>${esc(bt('evC_source'))}</th><th>${esc(bt('evC_product'))}</th><th>${esc(bt('evC_supplier'))}</th>
              <th>${esc(bt('evC_date'))}</th><th>${esc(bt('evC_expires'))}</th>
              <th>${esc(bt('evC_status'))}</th><th>${esc(bt('evC_verification'))}</th>
            </tr></thead><tbody>${rows || `<tr><td colspan="10"><div class="empty"><strong>${esc(bt('evEmpty'))}</strong></div></td></tr>`}</tbody></table></div>
          </div>`;
      }"""

QUALITY_VIEW = r"""function qualityView() {
        const recs = evidenceRecords();
        const q = state.quality;

        // Workspace-level answer first. Demonstration figures match the Overview.
        const m = state.demo
          ? { completeness: 92.4, evidence: 84, verification: 78, supplier: 87, product: 91 }
          : {
              completeness: q?.score?.completeness ?? null,
              evidence: q?.score?.documentationCoverage ?? null,
              verification: recs.length ? Math.round(recs.filter((r) => r.verification === 'thirdParty').length / recs.length * 100) : null,
              supplier: null,
              product: q?.score?.consistency ?? null
            };
        const metric = (key, value, accent) => `<div class="qc-metric">
            <div class="qc-metric__v${accent ? ' is-accent' : ''}">${value === null ? '—' : (Number(value).toLocaleString(locale(), { maximumFractionDigits: 1 }) + '%')}</div>
            <div class="qc-metric__k">${esc(bt(key))}</div>
            <div class="qc-metric__bar"><i style="width:${pct(value || 0)}%"></i></div>
          </div>`;

        // CRITICAL / WARNING / REVIEW / RESOLVED, derived from the issue feed.
        const issues = (q?.issues || []).map((i) => ({ ...i, band: qcBand(i) }));
        const demoIssues = state.demo ? [
          { id: 'q1', band: 'critical', ruleKey: 'product_expired_certification', message: bt('qcI1'), view: 'certifications', detectedAt: new Date(Date.now() - 2 * 86400000).toISOString() },
          { id: 'q2', band: 'critical', ruleKey: 'evidence_expired', message: bt('qcI2'), view: 'documents', detectedAt: new Date(Date.now() - 5 * 86400000).toISOString() },
          { id: 'q3', band: 'warning', ruleKey: 'product_missing_evidence', message: bt('qcI3'), view: 'documents', detectedAt: new Date(Date.now() - 9 * 86400000).toISOString() },
          { id: 'q4', band: 'warning', ruleKey: 'supplier_data_stale', message: bt('qcI4'), view: 'suppliers', detectedAt: new Date(Date.now() - 14 * 86400000).toISOString() },
          { id: 'q5', band: 'review', ruleKey: 'evidence_pending_verification', message: bt('qcI5'), view: 'documents', detectedAt: new Date(Date.now() - 3 * 86400000).toISOString() },
          { id: 'q6', band: 'resolved', ruleKey: 'product_incomplete_composition', message: bt('qcI6'), view: 'products', detectedAt: new Date(Date.now() - 21 * 86400000).toISOString() }
        ] : [];
        const all = issues.concat(demoIssues);
        const bands = ['critical', 'warning', 'review', 'resolved'];
        const bandCount = {};
        bands.forEach((b) => { bandCount[b] = all.filter((i) => i.band === b).length; });

        const board = `<div class="qc-board">${bands.map((b) => `
          <div class="qc-band" data-band="${b}">
            <div class="qc-band__v">${moneyless(bandCount[b])}</div>
            <div class="qc-band__n">${esc(bt('qcB_' + b))}</div>
          </div>`).join('')}</div>`;

        const list = all.length ? all.map((i) => `<div class="qc-issue" data-band="${esc(i.band)}">
            <span class="qc-issue__sev" data-band="${esc(i.band)}">${esc(bt('qcB_' + i.band))}</span>
            <div class="qc-issue__b">
              <strong>${esc(i.message)}</strong>
              <p class="meta">${esc(i.ruleKey)} · ${esc(bt('qcDetected'))} ${date(i.detectedAt)}</p>
            </div>
            <button class="btn btn-secondary btn-small" data-view="${esc(qcFixView(i))}">${esc(bt('qcFix'))}</button>
          </div>`).join('')
          : `<div class="empty"><strong>${esc(bt('qcNoIssues'))}</strong><p>${esc(bt('qcNoIssuesD'))}</p></div>`;

        const productPanel = state.selectedProduct
          ? `<div class="card panel"><div class="panel-head">
               <div><h2>${esc(state.selectedProduct.name)}</h2>
               <p class="meta">${esc(bt('qcNotCert'))}</p></div>
               <div class="actions">
                 <button class="btn btn-secondary btn-small" data-action="select-quality-product">${esc(bt('qcChangeProduct'))}</button>
                 <button class="btn btn-primary btn-small" data-action="compute-quality">${esc(bt('qcRecompute'))}</button>
               </div></div>
             ${q?.score ? `<div class="grid score-grid">${scoreCard(bt('qcCompleteness'), q.score.completeness)}${scoreCard(bt('qcFreshness'), q.score.freshness)}${scoreCard(bt('qcEvidence'), q.score.documentationCoverage)}${scoreCard(bt('qcConsistency'), q.score.consistency)}</div>`
               : `<div class="empty"><div class="empty-icon">◒</div><strong>${esc(bt('qcNoScore'))}</strong><p>${esc(bt('qcNoScoreD'))}</p><button class="btn btn-primary btn-small" data-action="compute-quality">${esc(bt('qcComputeNow'))}</button></div>`}
             </div>`
          : `<div class="card panel"><div class="panel-head"><h2>${esc(bt('qcPerProduct'))}</h2></div>
             <label>${esc(bt('qcProduct'))}<select class="select" id="quality-product-select">
               <option value="">${esc(bt('qcChoose'))}</option>
               ${state.products.map((p) => `<option value="${esc(p.id)}">${esc(p.reference)} — ${esc(p.name)}</option>`).join('')}
             </select></label></div>`;

        return `<div class="page-head"><div>
            <div class="eyebrow">${esc(bt('qcEyebrow'))}</div>
            <h1>${esc(bt('qcTitle'))}</h1><p>${esc(bt('qcLead'))}</p></div>
            <div class="actions">${state.demo ? `<span class="mc-demo">${esc(bt('mcDemoData'))}</span>` : ''}</div>
          </div>

          <div class="qc-metrics">
            ${metric('qcMCompleteness', m.completeness, true)}
            ${metric('qcMEvidence', m.evidence)}
            ${metric('qcMVerification', m.verification)}
            ${metric('qcMSupplier', m.supplier)}
            ${metric('qcMProduct', m.product)}
          </div>

          <div style="height:26px"></div>
          <div class="eyebrow" style="margin-bottom:10px">${esc(bt('qcIssues'))}</div>
          ${board}
          <div style="height:14px"></div>
          <div class="card panel">${list}</div>

          <div style="height:26px"></div>
          ${productPanel}
          ${complianceContractPanel()}${capContractPanel()}`;
      }

      // Existing severities/statuses mapped onto the brief's four bands.
      function qcBand(issue) {
        if (issue.status === 'resolved' || issue.status === 'waived') return 'resolved';
        if (issue.status === 'acknowledged') return 'review';
        if (issue.severity === 'blocking' || issue.severity === 'critical') return 'critical';
        if (issue.severity === 'warning') return 'warning';
        return 'review';
      }

      // Every issue has to land on the screen that fixes it.
      function qcFixView(issue) {
        if (issue.view) return issue.view;
        const k = issue.ruleKey || '';
        if (k.indexOf('certification') >= 0) return 'certifications';
        if (k.indexOf('evidence') >= 0 || k.indexOf('document') >= 0) return 'documents';
        if (k.indexOf('supplier') >= 0) return 'suppliers';
        return 'products';
      }"""

T = {
    "en": {
        "evEyebrow": "Evidence", "evTitle": "Evidence Center",
        "evLead": "Every claim, traced back to the document that proves it. Source, issuer, date and expiry on every record.",
        "evAll": "All evidence", "evRegister": "Evidence register", "evTrustScale": "Ranked on the trust scale",
        "evExpired": "expired and still referenced", "evExpiringSoon": "expiring within 90 days",
        "evNoExpiry": "No expiry", "evEmpty": "No evidence recorded yet",
        "evT_document": "Documents", "evT_certificate": "Certificates", "evT_testReport": "Test reports",
        "evT_declaration": "Declarations", "evT_audit": "Audits", "evT_invoice": "Invoices",
        "evT_productionRecord": "Production records",
        "evC_item": "Evidence", "evC_type": "Type", "evC_issuer": "Issuer", "evC_source": "Source",
        "evC_product": "Product", "evC_supplier": "Supplier", "evC_date": "Issued", "evC_expires": "Expires",
        "evC_status": "Trust", "evC_verification": "Verification",
        "evSrc_supplierUpload": "Supplier upload", "evSrc_labDirect": "Lab direct",
        "evSrc_auditBody": "Audit body", "evSrc_erpSync": "ERP sync",
        "evV_thirdParty": "Third party", "evV_brandReviewed": "Brand reviewed",
        "evV_selfDeclared": "Self-declared", "evV_pending": "Pending", "evV_expired": "Expired",
        "evTrust_missing": "Missing", "evTrust_review": "Review", "evTrust_declared": "Declared",
        "evTrust_documented": "Documented", "evTrust_verified": "Verified", "evTrust_certified": "Certified",
        "qcEyebrow": "Data quality", "qcTitle": "Can you trust your data?",
        "qcLead": "Five measures answer that question. Below them, every open issue carries the button that fixes it.",
        "qcMCompleteness": "Data completeness", "qcMEvidence": "Evidence coverage",
        "qcMVerification": "Verification rate", "qcMSupplier": "Supplier quality", "qcMProduct": "Product quality",
        "qcIssues": "Open issues", "qcB_critical": "Critical", "qcB_warning": "Warning",
        "qcB_review": "Review", "qcB_resolved": "Resolved",
        "qcDetected": "detected", "qcFix": "Fix this",
        "qcNoIssues": "No open issue", "qcNoIssuesD": "Quality rules report nothing blocking.",
        "qcI1": "GOTS certificate on the main component has expired.",
        "qcI2": "A REACH SVHC statement past its expiry date is still referenced by a product.",
        "qcI3": "Some product data has no supporting evidence attached.",
        "qcI4": "Supplier data has not been refreshed in over 12 months.",
        "qcI5": "A GRS scope certificate is awaiting verification.",
        "qcI6": "Composition percentages did not add up to 100%.",
        "qcPerProduct": "Per-product score", "qcProduct": "Product", "qcChoose": "Choose a product…",
        "qcChangeProduct": "Change product", "qcRecompute": "Recompute score",
        "qcNoScore": "Score not computed", "qcNoScoreD": "Run a first quality computation for this product.",
        "qcComputeNow": "Compute now",
        "qcCompleteness": "Completeness", "qcFreshness": "Freshness", "qcEvidence": "Evidence", "qcConsistency": "Consistency",
        "qcNotCert": "The score describes data readiness. It is not a certification.",
    },
    "fr": {
        "evEyebrow": "Preuves", "evTitle": "Centre de preuves",
        "evLead": "Chaque affirmation ramenée au document qui la prouve. Source, émetteur, date et expiration sur chaque pièce.",
        "evAll": "Toutes les preuves", "evRegister": "Registre des preuves", "evTrustScale": "Classées sur l’échelle de confiance",
        "evExpired": "expirées et encore référencées", "evExpiringSoon": "expirent sous 90 jours",
        "evNoExpiry": "Sans expiration", "evEmpty": "Aucune preuve enregistrée",
        "evT_document": "Documents", "evT_certificate": "Certificats", "evT_testReport": "Rapports d’essai",
        "evT_declaration": "Déclarations", "evT_audit": "Audits", "evT_invoice": "Factures",
        "evT_productionRecord": "Relevés de production",
        "evC_item": "Preuve", "evC_type": "Type", "evC_issuer": "Émetteur", "evC_source": "Source",
        "evC_product": "Produit", "evC_supplier": "Fournisseur", "evC_date": "Émise le", "evC_expires": "Expire le",
        "evC_status": "Confiance", "evC_verification": "Vérification",
        "evSrc_supplierUpload": "Dépôt fournisseur", "evSrc_labDirect": "Laboratoire direct",
        "evSrc_auditBody": "Organisme d’audit", "evSrc_erpSync": "Synchro ERP",
        "evV_thirdParty": "Tierce partie", "evV_brandReviewed": "Revue marque",
        "evV_selfDeclared": "Auto-déclarée", "evV_pending": "En attente", "evV_expired": "Expirée",
        "evTrust_missing": "Manquante", "evTrust_review": "À revoir", "evTrust_declared": "Déclarée",
        "evTrust_documented": "Documentée", "evTrust_verified": "Vérifiée", "evTrust_certified": "Certifiée",
        "qcEyebrow": "Qualité des données", "qcTitle": "Pouvez-vous faire confiance à vos données ?",
        "qcLead": "Cinq mesures répondent à cette question. En dessous, chaque anomalie ouverte porte le bouton qui la règle.",
        "qcMCompleteness": "Complétude des données", "qcMEvidence": "Couverture des preuves",
        "qcMVerification": "Taux de vérification", "qcMSupplier": "Qualité fournisseur", "qcMProduct": "Qualité produit",
        "qcIssues": "Anomalies ouvertes", "qcB_critical": "Critique", "qcB_warning": "Avertissement",
        "qcB_review": "À revoir", "qcB_resolved": "Résolue",
        "qcDetected": "détectée le", "qcFix": "Corriger",
        "qcNoIssues": "Aucune anomalie ouverte", "qcNoIssuesD": "Les règles qualité ne remontent aucun blocage.",
        "qcI1": "Le certificat GOTS du composant principal est expiré.",
        "qcI2": "Une déclaration REACH SVHC périmée est encore référencée par un produit.",
        "qcI3": "Certaines données produit n’ont aucune preuve rattachée.",
        "qcI4": "Les données fournisseur n’ont pas été rafraîchies depuis plus de 12 mois.",
        "qcI5": "Un certificat GRS attend sa vérification.",
        "qcI6": "Les pourcentages de composition ne totalisaient pas 100 %.",
        "qcPerProduct": "Score par produit", "qcProduct": "Produit", "qcChoose": "Choisir un produit…",
        "qcChangeProduct": "Changer de produit", "qcRecompute": "Recalculer le score",
        "qcNoScore": "Score non calculé", "qcNoScoreD": "Lancez un premier calcul qualité pour ce produit.",
        "qcComputeNow": "Calculer maintenant",
        "qcCompleteness": "Complétude", "qcFreshness": "Fraîcheur", "qcEvidence": "Preuves", "qcConsistency": "Cohérence",
        "qcNotCert": "Le score décrit l’état de préparation des données. Il ne constitue pas une certification.",
    },
    "de": {
        "evEyebrow": "Nachweise", "evTitle": "Nachweiszentrum",
        "evLead": "Jede Aussage zurückgeführt auf das Dokument, das sie belegt. Quelle, Aussteller, Datum und Ablauf bei jedem Eintrag.",
        "evAll": "Alle Nachweise", "evRegister": "Nachweisregister", "evTrustScale": "Eingeordnet auf der Vertrauensskala",
        "evExpired": "abgelaufen und weiterhin referenziert", "evExpiringSoon": "laufen in 90 Tagen ab",
        "evNoExpiry": "Ohne Ablauf", "evEmpty": "Noch kein Nachweis erfasst",
        "evT_document": "Dokumente", "evT_certificate": "Zertifikate", "evT_testReport": "Prüfberichte",
        "evT_declaration": "Erklärungen", "evT_audit": "Audits", "evT_invoice": "Rechnungen",
        "evT_productionRecord": "Produktionsnachweise",
        "evC_item": "Nachweis", "evC_type": "Typ", "evC_issuer": "Aussteller", "evC_source": "Quelle",
        "evC_product": "Produkt", "evC_supplier": "Lieferant", "evC_date": "Ausgestellt", "evC_expires": "Läuft ab",
        "evC_status": "Vertrauen", "evC_verification": "Verifizierung",
        "evSrc_supplierUpload": "Lieferanten-Upload", "evSrc_labDirect": "Labor direkt",
        "evSrc_auditBody": "Auditstelle", "evSrc_erpSync": "ERP-Sync",
        "evV_thirdParty": "Dritte Partei", "evV_brandReviewed": "Von der Marke geprüft",
        "evV_selfDeclared": "Selbsterklärt", "evV_pending": "Ausstehend", "evV_expired": "Abgelaufen",
        "evTrust_missing": "Fehlt", "evTrust_review": "Zu prüfen", "evTrust_declared": "Erklärt",
        "evTrust_documented": "Dokumentiert", "evTrust_verified": "Verifiziert", "evTrust_certified": "Zertifiziert",
        "qcEyebrow": "Datenqualität", "qcTitle": "Können Sie Ihren Daten vertrauen?",
        "qcLead": "Fünf Kennzahlen beantworten diese Frage. Darunter trägt jeder offene Befund die Schaltfläche, die ihn behebt.",
        "qcMCompleteness": "Datenvollständigkeit", "qcMEvidence": "Nachweisabdeckung",
        "qcMVerification": "Verifizierungsquote", "qcMSupplier": "Lieferantenqualität", "qcMProduct": "Produktqualität",
        "qcIssues": "Offene Befunde", "qcB_critical": "Kritisch", "qcB_warning": "Warnung",
        "qcB_review": "Zu prüfen", "qcB_resolved": "Behoben",
        "qcDetected": "erkannt am", "qcFix": "Beheben",
        "qcNoIssues": "Kein offener Befund", "qcNoIssuesD": "Die Qualitätsregeln melden nichts Blockierendes.",
        "qcI1": "Das GOTS-Zertifikat der Hauptkomponente ist abgelaufen.",
        "qcI2": "Eine abgelaufene REACH-SVHC-Erklärung wird noch von einem Produkt referenziert.",
        "qcI3": "Für einige Produktdaten ist kein Nachweis hinterlegt.",
        "qcI4": "Lieferantendaten wurden seit über 12 Monaten nicht aktualisiert.",
        "qcI5": "Ein GRS-Zertifikat wartet auf Verifizierung.",
        "qcI6": "Die Zusammensetzungsanteile ergaben nicht 100 %.",
        "qcPerProduct": "Score je Produkt", "qcProduct": "Produkt", "qcChoose": "Produkt wählen…",
        "qcChangeProduct": "Produkt wechseln", "qcRecompute": "Score neu berechnen",
        "qcNoScore": "Score nicht berechnet", "qcNoScoreD": "Starten Sie eine erste Qualitätsberechnung für dieses Produkt.",
        "qcComputeNow": "Jetzt berechnen",
        "qcCompleteness": "Vollständigkeit", "qcFreshness": "Aktualität", "qcEvidence": "Nachweise", "qcConsistency": "Konsistenz",
        "qcNotCert": "Der Score beschreibt die Datenreife. Er ist keine Zertifizierung.",
    },
    "it": {
        "evEyebrow": "Prove", "evTitle": "Centro prove",
        "evLead": "Ogni affermazione ricondotta al documento che la dimostra. Fonte, emittente, data e scadenza su ogni voce.",
        "evAll": "Tutte le prove", "evRegister": "Registro delle prove", "evTrustScale": "Classificate sulla scala di fiducia",
        "evExpired": "scadute e ancora referenziate", "evExpiringSoon": "scadono entro 90 giorni",
        "evNoExpiry": "Senza scadenza", "evEmpty": "Nessuna prova registrata",
        "evT_document": "Documenti", "evT_certificate": "Certificati", "evT_testReport": "Rapporti di prova",
        "evT_declaration": "Dichiarazioni", "evT_audit": "Audit", "evT_invoice": "Fatture",
        "evT_productionRecord": "Registri di produzione",
        "evC_item": "Prova", "evC_type": "Tipo", "evC_issuer": "Emittente", "evC_source": "Fonte",
        "evC_product": "Prodotto", "evC_supplier": "Fornitore", "evC_date": "Emessa il", "evC_expires": "Scade il",
        "evC_status": "Fiducia", "evC_verification": "Verifica",
        "evSrc_supplierUpload": "Caricamento fornitore", "evSrc_labDirect": "Laboratorio diretto",
        "evSrc_auditBody": "Ente di audit", "evSrc_erpSync": "Sincronizzazione ERP",
        "evV_thirdParty": "Terza parte", "evV_brandReviewed": "Rivista dal marchio",
        "evV_selfDeclared": "Autodichiarata", "evV_pending": "In attesa", "evV_expired": "Scaduta",
        "evTrust_missing": "Mancante", "evTrust_review": "Da rivedere", "evTrust_declared": "Dichiarata",
        "evTrust_documented": "Documentata", "evTrust_verified": "Verificata", "evTrust_certified": "Certificata",
        "qcEyebrow": "Qualità dei dati", "qcTitle": "Puoi fidarti dei tuoi dati?",
        "qcLead": "Cinque misure rispondono a questa domanda. Sotto, ogni anomalia aperta porta il pulsante che la risolve.",
        "qcMCompleteness": "Completezza dei dati", "qcMEvidence": "Copertura delle prove",
        "qcMVerification": "Tasso di verifica", "qcMSupplier": "Qualità fornitore", "qcMProduct": "Qualità prodotto",
        "qcIssues": "Anomalie aperte", "qcB_critical": "Critica", "qcB_warning": "Avviso",
        "qcB_review": "Da rivedere", "qcB_resolved": "Risolta",
        "qcDetected": "rilevata il", "qcFix": "Risolvi",
        "qcNoIssues": "Nessuna anomalia aperta", "qcNoIssuesD": "Le regole di qualità non segnalano blocchi.",
        "qcI1": "Il certificato GOTS del componente principale è scaduto.",
        "qcI2": "Una dichiarazione REACH SVHC scaduta è ancora referenziata da un prodotto.",
        "qcI3": "Alcuni dati di prodotto non hanno prove allegate.",
        "qcI4": "I dati del fornitore non vengono aggiornati da oltre 12 mesi.",
        "qcI5": "Un certificato GRS attende la verifica.",
        "qcI6": "Le percentuali di composizione non raggiungevano il 100%.",
        "qcPerProduct": "Punteggio per prodotto", "qcProduct": "Prodotto", "qcChoose": "Scegli un prodotto…",
        "qcChangeProduct": "Cambia prodotto", "qcRecompute": "Ricalcola il punteggio",
        "qcNoScore": "Punteggio non calcolato", "qcNoScoreD": "Avvia un primo calcolo qualità per questo prodotto.",
        "qcComputeNow": "Calcola ora",
        "qcCompleteness": "Completezza", "qcFreshness": "Freschezza", "qcEvidence": "Prove", "qcConsistency": "Coerenza",
        "qcNotCert": "Il punteggio descrive la prontezza dei dati. Non è una certificazione.",
    },
    "es": {
        "evEyebrow": "Pruebas", "evTitle": "Centro de pruebas",
        "evLead": "Cada afirmación remitida al documento que la demuestra. Fuente, emisor, fecha y caducidad en cada registro.",
        "evAll": "Todas las pruebas", "evRegister": "Registro de pruebas", "evTrustScale": "Clasificadas en la escala de confianza",
        "evExpired": "caducadas y aún referenciadas", "evExpiringSoon": "caducan en 90 días",
        "evNoExpiry": "Sin caducidad", "evEmpty": "Ninguna prueba registrada",
        "evT_document": "Documentos", "evT_certificate": "Certificados", "evT_testReport": "Informes de ensayo",
        "evT_declaration": "Declaraciones", "evT_audit": "Auditorías", "evT_invoice": "Facturas",
        "evT_productionRecord": "Registros de producción",
        "evC_item": "Prueba", "evC_type": "Tipo", "evC_issuer": "Emisor", "evC_source": "Fuente",
        "evC_product": "Producto", "evC_supplier": "Proveedor", "evC_date": "Emitida", "evC_expires": "Caduca",
        "evC_status": "Confianza", "evC_verification": "Verificación",
        "evSrc_supplierUpload": "Carga del proveedor", "evSrc_labDirect": "Laboratorio directo",
        "evSrc_auditBody": "Organismo auditor", "evSrc_erpSync": "Sincronización ERP",
        "evV_thirdParty": "Tercera parte", "evV_brandReviewed": "Revisada por la marca",
        "evV_selfDeclared": "Autodeclarada", "evV_pending": "Pendiente", "evV_expired": "Caducada",
        "evTrust_missing": "Falta", "evTrust_review": "Por revisar", "evTrust_declared": "Declarada",
        "evTrust_documented": "Documentada", "evTrust_verified": "Verificada", "evTrust_certified": "Certificada",
        "qcEyebrow": "Calidad de los datos", "qcTitle": "¿Puedes confiar en tus datos?",
        "qcLead": "Cinco medidas responden a esa pregunta. Debajo, cada incidencia abierta lleva el botón que la resuelve.",
        "qcMCompleteness": "Integridad de los datos", "qcMEvidence": "Cobertura de pruebas",
        "qcMVerification": "Tasa de verificación", "qcMSupplier": "Calidad del proveedor", "qcMProduct": "Calidad del producto",
        "qcIssues": "Incidencias abiertas", "qcB_critical": "Crítica", "qcB_warning": "Aviso",
        "qcB_review": "Por revisar", "qcB_resolved": "Resuelta",
        "qcDetected": "detectada el", "qcFix": "Resolver",
        "qcNoIssues": "Ninguna incidencia abierta", "qcNoIssuesD": "Las reglas de calidad no reportan bloqueos.",
        "qcI1": "El certificado GOTS del componente principal ha caducado.",
        "qcI2": "Una declaración REACH SVHC caducada sigue referenciada por un producto.",
        "qcI3": "Algunos datos de producto no tienen prueba adjunta.",
        "qcI4": "Los datos del proveedor no se han actualizado en más de 12 meses.",
        "qcI5": "Un certificado GRS está pendiente de verificación.",
        "qcI6": "Los porcentajes de composición no sumaban 100 %.",
        "qcPerProduct": "Puntuación por producto", "qcProduct": "Producto", "qcChoose": "Elegir un producto…",
        "qcChangeProduct": "Cambiar de producto", "qcRecompute": "Recalcular la puntuación",
        "qcNoScore": "Puntuación no calculada", "qcNoScoreD": "Lanza un primer cálculo de calidad para este producto.",
        "qcComputeNow": "Calcular ahora",
        "qcCompleteness": "Integridad", "qcFreshness": "Frescura", "qcEvidence": "Pruebas", "qcConsistency": "Coherencia",
        "qcNotCert": "La puntuación describe la preparación de los datos. No es una certificación.",
    },
    "nl": {
        "evEyebrow": "Bewijs", "evTitle": "Bewijscentrum",
        "evLead": "Elke bewering herleid tot het document dat haar aantoont. Bron, uitgever, datum en vervaldatum bij elk item.",
        "evAll": "Al het bewijs", "evRegister": "Bewijsregister", "evTrustScale": "Gerangschikt op de vertrouwensschaal",
        "evExpired": "verlopen en nog steeds gebruikt", "evExpiringSoon": "verlopen binnen 90 dagen",
        "evNoExpiry": "Geen vervaldatum", "evEmpty": "Nog geen bewijs vastgelegd",
        "evT_document": "Documenten", "evT_certificate": "Certificaten", "evT_testReport": "Testrapporten",
        "evT_declaration": "Verklaringen", "evT_audit": "Audits", "evT_invoice": "Facturen",
        "evT_productionRecord": "Productieregistraties",
        "evC_item": "Bewijs", "evC_type": "Type", "evC_issuer": "Uitgever", "evC_source": "Bron",
        "evC_product": "Product", "evC_supplier": "Leverancier", "evC_date": "Afgegeven", "evC_expires": "Verloopt",
        "evC_status": "Vertrouwen", "evC_verification": "Verificatie",
        "evSrc_supplierUpload": "Upload leverancier", "evSrc_labDirect": "Lab direct",
        "evSrc_auditBody": "Auditinstantie", "evSrc_erpSync": "ERP-synchronisatie",
        "evV_thirdParty": "Derde partij", "evV_brandReviewed": "Door merk beoordeeld",
        "evV_selfDeclared": "Zelf opgegeven", "evV_pending": "In afwachting", "evV_expired": "Verlopen",
        "evTrust_missing": "Ontbreekt", "evTrust_review": "Te beoordelen", "evTrust_declared": "Opgegeven",
        "evTrust_documented": "Gedocumenteerd", "evTrust_verified": "Geverifieerd", "evTrust_certified": "Gecertificeerd",
        "qcEyebrow": "Datakwaliteit", "qcTitle": "Kunt u uw gegevens vertrouwen?",
        "qcLead": "Vijf maatstaven beantwoorden die vraag. Daaronder draagt elk open punt de knop die het oplost.",
        "qcMCompleteness": "Volledigheid van gegevens", "qcMEvidence": "Bewijsdekking",
        "qcMVerification": "Verificatiegraad", "qcMSupplier": "Leverancierskwaliteit", "qcMProduct": "Productkwaliteit",
        "qcIssues": "Open punten", "qcB_critical": "Kritiek", "qcB_warning": "Waarschuwing",
        "qcB_review": "Te beoordelen", "qcB_resolved": "Opgelost",
        "qcDetected": "gedetecteerd op", "qcFix": "Oplossen",
        "qcNoIssues": "Geen open punt", "qcNoIssuesD": "De kwaliteitsregels melden niets blokkerends.",
        "qcI1": "Het GOTS-certificaat van het hoofdbestanddeel is verlopen.",
        "qcI2": "Een verlopen REACH SVHC-verklaring wordt nog door een product gebruikt.",
        "qcI3": "Bij sommige productgegevens ontbreekt bewijs.",
        "qcI4": "Leveranciersgegevens zijn al meer dan 12 maanden niet bijgewerkt.",
        "qcI5": "Een GRS-certificaat wacht op verificatie.",
        "qcI6": "De samenstellingspercentages kwamen niet op 100% uit.",
        "qcPerProduct": "Score per product", "qcProduct": "Product", "qcChoose": "Kies een product…",
        "qcChangeProduct": "Ander product", "qcRecompute": "Score herberekenen",
        "qcNoScore": "Score niet berekend", "qcNoScoreD": "Start een eerste kwaliteitsberekening voor dit product.",
        "qcComputeNow": "Nu berekenen",
        "qcCompleteness": "Volledigheid", "qcFreshness": "Actualiteit", "qcEvidence": "Bewijs", "qcConsistency": "Consistentie",
        "qcNotCert": "De score beschrijft de datagereedheid. Het is geen certificering.",
    },
}


def replace_fn(src, name, new_body):
    a = src.index("function %s(" % name)
    nxt = re.search(r"\n      function \w+\(", src[a + 10:])
    b = a + 10 + nxt.start()
    return src[:a] + new_body + src[b:]


def main():
    s = HTML.read_text(encoding="utf-8")
    before = len(s)

    # helpers go just before the evidence view
    anchor = "      function documentsConsoleView() {"
    assert anchor in s, "documentsConsoleView anchor not found"
    s = s.replace(anchor, DEMO_EVIDENCE.rstrip() + "\n\n" + anchor, 1)

    s = replace_fn(s, "documentsConsoleView", EVIDENCE_VIEW)
    s = replace_fn(s, "qualityView", QUALITY_VIEW)

    # the evidence type band filters the register client-side
    listener = "        search?.addEventListener('input', filterRequests); filter?.addEventListener('change', filterRequests);"
    assert listener in s
    s = s.replace(listener, listener + """
        document.querySelectorAll('[data-ev-type]').forEach((el) => el.addEventListener('click', () => {
          const want = el.dataset.evType;
          document.querySelectorAll('[data-ev-type]').forEach((b) => b.classList.toggle('is-on', b === el));
          document.querySelectorAll('[data-ev-row]').forEach((row) => {
            row.hidden = want !== 'all' && row.dataset.evRow !== want;
          });
        }));""", 1)

    # ── fake buttons ────────────────────────────────────────────────────────
    # 19 buttons across the console called alert() with a message claiming the
    # action had succeeded — "CSRD report exported", "Settings saved", "Email
    # reminder sent to Rui Silva". Nothing was performed. On a product whose
    # whole pitch is trust, a button that lies is worse than no button.
    fakes = re.findall(r'onclick="alert\([^"]*\)"', s)
    s = re.sub(r'onclick="alert\([^"]*\)"', 'data-demo-action="1"', s)
    assert 'onclick="alert(' not in s

    hook = "        document.querySelectorAll('[data-ev-type]').forEach"
    assert hook in s
    s = s.replace(hook, """        document.querySelectorAll('[data-demo-action]').forEach((el) => el.addEventListener('click', (event) => {
          event.preventDefault();
          notify(bt('demoUnavailable'));
        }));
""" + hook, 1)

    msg = {
        "en": "Not available in demonstration mode — connect the TRACEFAB APIs to run this action.",
        "fr": "Indisponible en mode démonstration — connectez les API TRACEFAB pour exécuter cette action.",
        "de": "Im Demonstrationsmodus nicht verfügbar — verbinden Sie die TRACEFAB-APIs, um diese Aktion auszuführen.",
        "it": "Non disponibile in modalità dimostrativa — collega le API TRACEFAB per eseguire questa azione.",
        "es": "No disponible en modo demostración — conecta las API de TRACEFAB para ejecutar esta acción.",
        "nl": "Niet beschikbaar in demonstratiemodus — verbind de TRACEFAB-API's om deze actie uit te voeren.",
    }
    for lang, text in msg.items():
        T[lang]["demoUnavailable"] = text
    print("  %d fake onclick=alert() buttons replaced with an honest toast" % len(fakes))

    for lang, pairs in T.items():
        mm = re.search(r"\n(\s+)%s: \{\n" % lang, s)
        assert mm, "locale %s not found" % lang
        pad = mm.group(1) + "  "
        block = "".join("%s%s: %s,\n" % (pad, k, json.dumps(v, ensure_ascii=False))
                        for k, v in pairs.items())
        s = s[:mm.end()] + block + s[mm.end():]


    HTML.write_text(s, encoding="utf-8")
    print("brand-console/index.html: %d -> %d bytes" % (before, len(s)))
    print("  Evidence Center: 7 types x 8 attributes, trust scale, expiry alerts")
    print("  Quality Center: 'Can you trust your data?' + 5 measures + 4 bands")
    print("  fake onclick=alert() removed from both views")
    print("  %d keys x %d locales" % (len(T["en"]), len(T)))


if __name__ == "__main__":
    main()
