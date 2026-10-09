/* ==========================================================================
   TRACEFAB — Product Intelligence (v3.0)

   One product, eleven lenses. The page is data-driven: the demonstration
   record below carries structure and entity names, every label comes from the
   i18n catalogue (pi.* namespace) so no business copy lives in the markup.

   Depends on tf-i18n.js (window.TF_I18N).
   ========================================================================== */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var t = function (k, f) { return window.TF_I18N ? window.TF_I18N.t(k, f) : (f || ''); };
  var esc = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  /* ── Demonstration record ────────────────────────────────────────────── */

  var P = {
    ref: 'AW26-0248',
    gtin: '03701234567890',
    sku: 'TS-ORG-AW26-0248',
    /* headline signals — named apart from the quality[] / evidence[] collections
       below so the object literal cannot shadow them */
    scoreQuality: 94, scoreEvidence: 88, scoreTraceability: 91, scoreDpp: 88,

    composition: [
      { k: 'organicCotton', pct: 92, level: 'certified', std: 'GOTS 6.0' },
      { k: 'recycledElastane', pct: 6, level: 'verified', std: 'GRS 4.0' },
      { k: 'sewingThread', pct: 2, level: 'documented', std: 'OEKO-TEX 100' }
    ],

    lineage: [
      { id: 'fiber', org: 'Algodão Vivo Cooperative', country: 'PT', level: 'certified' },
      { id: 'spinner', org: 'Guimarães Ring Spinners', country: 'PT', level: 'documented' },
      { id: 'yarn', org: 'Guimarães Ring Spinners', country: 'PT', level: 'verified' },
      { id: 'fabric', org: 'Portugal Textile Mill', country: 'PT', level: 'verified' },
      { id: 'dyehouse', org: 'Adriatic Dye House', country: 'IT', level: 'review' },
      { id: 'manufacturer', org: 'Atelier Milano', country: 'IT', level: 'certified' },
      { id: 'product', org: 'Atelier Demo', country: 'FR', level: 'verified' },
      { id: 'dpp', org: 'TRACEFAB', country: 'EU', level: 'review' }
    ],

    materials: [
      { name: 'Organic combed cotton 30/1', type: 'yarn', supplier: 'Guimarães Ring Spinners', origin: 'Portugal', level: 'documented' },
      { name: 'Single jersey 180 g/m²', type: 'fabric', supplier: 'Portugal Textile Mill', origin: 'Portugal', level: 'verified' },
      { name: 'Reactive dye — deep forest', type: 'chemical', supplier: 'Adriatic Dye House', origin: 'Italy', level: 'review' },
      { name: 'Recycled elastane rib', type: 'trim', supplier: 'Portugal Textile Mill', origin: 'Portugal', level: 'verified' },
      { name: 'Organic cotton sewing thread', type: 'trim', supplier: 'Atelier Milano', origin: 'Italy', level: 'documented' }
    ],

    manufacturing: [
      { step: 'spinning', facility: 'Guimarães Spinning Mill', country: 'Portugal', level: 'documented' },
      { step: 'knitting', facility: 'Guimarães Weaving Hall', country: 'Portugal', level: 'verified' },
      { step: 'dyeing', facility: 'Prato Finishing Plant', country: 'Italy', level: 'review' },
      { step: 'cutting', facility: 'Milan Cutting Room', country: 'Italy', level: 'documented' },
      { step: 'assembly', facility: 'Milan Assembly Site', country: 'Italy', level: 'certified' },
      { step: 'finishing', facility: 'Milan Assembly Site', country: 'Italy', level: 'verified' }
    ],

    suppliers: [
      { org: 'Atelier Milano', tier: 1, country: 'Italy', q: 87, certs: 8, level: 'certified' },
      { org: 'Portugal Textile Mill', tier: 2, country: 'Portugal', q: 87, certs: 3, level: 'verified' },
      { org: 'Adriatic Dye House', tier: 2, country: 'Italy', q: 78, certs: 2, level: 'review' },
      { org: 'Guimarães Ring Spinners', tier: 3, country: 'Portugal', q: 89, certs: 4, level: 'documented' },
      { org: 'Algodão Vivo Cooperative', tier: 4, country: 'Portugal', q: 96, certs: 3, level: 'certified' }
    ],

    evidence: [
      { k: 'transactionCert', issuer: 'Control Union', date: '2026-02-14', exp: '2027-02-13', level: 'certified' },
      { k: 'labReport', issuer: 'Intertek', date: '2026-03-02', exp: '2027-03-01', level: 'verified' },
      { k: 'socialAudit', issuer: 'SGS', date: '2026-01-20', exp: '2027-01-19', level: 'certified' },
      { k: 'wastewater', issuer: 'Adriatic Dye House', date: '2025-04-11', exp: '2026-04-10', level: 'review' },
      { k: 'productionRecord', issuer: 'Atelier Milano', date: '2026-05-06', exp: null, level: 'documented' },
      { k: 'materialDeclaration', issuer: 'Fibrha Material Lab', date: '2026-02-28', exp: null, level: 'verified' }
    ],

    certifications: [
      { name: 'GOTS 6.0', scope: 'scopeFiberFabric', holder: 'Algodão Vivo Cooperative', exp: '2027-02-13', level: 'certified' },
      { name: 'GRS 4.0', scope: 'scopeRecycled', holder: 'Portugal Textile Mill', exp: '2027-05-30', level: 'certified' },
      { name: 'OEKO-TEX Standard 100', scope: 'scopeChemical', holder: 'Guimarães Ring Spinners', exp: '2026-12-31', level: 'verified' },
      { name: 'SA8000', scope: 'scopeSocial', holder: 'Atelier Milano', exp: '2027-01-19', level: 'certified' },
      { name: 'ZDHC MRSL Level 3', scope: 'scopeWastewater', holder: 'Adriatic Dye House', exp: '2026-04-10', level: 'review' }
    ],

    quality: [
      { k: 'completeness', v: 94 },
      { k: 'evidenceCoverage', v: 88 },
      { k: 'verificationRate', v: 76 },
      { k: 'supplyChainDepth', v: 91 }
    ],
    issues: [
      { sev: 'critical', k: 'issueWastewater', view: 'evidence' },
      { sev: 'warning', k: 'issueOekoTex', view: 'certifications' },
      { sev: 'review', k: 'issueSpinnerVerify', view: 'supplyChain' }
    ],

    dppReady: ['dppIdentity', 'dppComposition', 'dppMaterials', 'dppSuppliers', 'dppManufacturing', 'dppCare', 'dppCircularity'],
    dppGaps: ['dppGapWastewater', 'dppGapRepair'],

    history: [
      { d: '2026-06-02', k: 'hDppRecomputed', level: 'review' },
      { d: '2026-05-06', k: 'hProductionRecord', level: 'documented' },
      { d: '2026-04-18', k: 'hDyeFlagged', level: 'review' },
      { d: '2026-03-02', k: 'hLabReport', level: 'verified' },
      { d: '2026-02-28', k: 'hComposition', level: 'verified' },
      { d: '2026-02-14', k: 'hGotsLinked', level: 'certified' },
      { d: '2026-01-20', k: 'hSocialAudit', level: 'certified' },
      { d: '2025-11-30', k: 'hCreated', level: 'declared' }
    ]
  };

  var TABS = ['overview', 'composition', 'materials', 'supplyChain', 'manufacturing',
    'suppliers', 'evidence', 'certifications', 'quality', 'dpp', 'history'];

  /* ── Fragments ───────────────────────────────────────────────────────── */

  function chip(level) {
    return '<span class="status" style="color:var(--tf-trust-' + level + '-ink);background:var(--tf-trust-' + level +
      '-bg)">' + esc(t('pi.trust.' + level, level)) + '</span>';
  }

  function dl(rows) {
    return '<div class="card"><div class="pi-dl">' + rows.map(function (r) {
      return '<div><div class="pi-dt">' + esc(r[0]) + '</div><div class="pi-dd">' + r[1] + '</div></div>';
    }).join('') + '</div></div>';
  }

  function table(head, rows) {
    return '<div class="card panel"><div class="table-wrap"><table><thead><tr>' +
      head.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') +
      '</tr></thead><tbody>' + rows.map(function (r) {
        return '<tr>' + r.map(function (c) { return '<td>' + c + '</td>'; }).join('') + '</tr>';
      }).join('') + '</tbody></table></div></div>';
  }

  function sectionTitle(key) {
    return '<div class="eyebrow" style="margin:0 0 11px">' + esc(t('pi.sections.' + key, key)) + '</div>';
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso + 'T00:00:00Z').toLocaleDateString(
        (window.TF_I18N && window.TF_I18N.lang) || 'en',
        { year: 'numeric', month: 'short', day: '2-digit', timeZone: 'UTC' }
      );
    } catch (e) { return iso; }
  }

  /* ── Lineage ─────────────────────────────────────────────────────────── */

  function renderLineage() {
    var host = $('#pi-lineage');
    if (!host) return;
    host.style.setProperty('--pi-hops', String(P.lineage.length));
    host.innerHTML = P.lineage.map(function (n, i) {
      return '<button class="pi-link' + (i === P.lineage.length - 1 ? ' is-active' : '') + '" data-node="' + n.id + '">' +
        '<span class="pi-link__i">' + String(i + 1).padStart(2, '0') + ' · ' + esc(n.country) + '</span>' +
        '<span class="pi-link__n">' + esc(t('pi.lineage.nodes.' + n.id, n.id)) + '</span>' +
        '<span class="pi-link__s">' + esc(n.org) + '</span>' +
        chip(n.level) + '</button>';
    }).join('');

    host.addEventListener('click', function (e) {
      var btn = e.target.closest('.pi-link');
      if (!btn) return;
      host.querySelectorAll('.pi-link').forEach(function (b) { b.classList.remove('is-active'); });
      btn.classList.add('is-active');
      var node = P.lineage.filter(function (n) { return n.id === btn.dataset.node; })[0];
      var out = $('#pi-lineage-detail');
      if (node && out) {
        out.innerHTML =
          '<div class="pi-dt">' + esc(t('pi.lineage.nodes.' + node.id, node.id)) + '</div>' +
          '<div class="pi-dd"><strong>' + esc(node.org) + '</strong>' + chip(node.level) +
          '<span class="pi-dd__note">' + esc(t('pi.lineage.detail.' + node.id, '')) + '</span></div>';
      }
    });
  }

  /* ── Tab panels ──────────────────────────────────────────────────────── */

  var L = function (k) { return t('pi.labels.' + k, k); };

  var PANELS = {
    overview: function () {
      return sectionTitle('identity') + dl([
        [L('reference'), '<strong>' + esc(P.ref) + '</strong>'],
        [L('gtin'), '<span class="meta" style="text-transform:none">' + esc(P.gtin) + '</span>'],
        [L('sku'), '<span class="meta" style="text-transform:none">' + esc(P.sku) + '</span>'],
        [L('category'), esc(t('pi.values.category', ''))],
        [L('collection'), esc(t('pi.values.collection', ''))],
        [L('madeIn'), esc(t('pi.values.madeIn', '')) + chip('certified')],
        [L('status'), esc(t('pi.values.status', '')) + chip('verified')]
      ]) +
      '<div style="height:26px"></div>' + sectionTitle('timeline') +
      '<div class="card" style="padding:26px"><div class="pi-timeline">' +
        P.history.slice(0, 5).map(function (h) {
          return '<div class="pi-event" data-level="' + h.level + '">' +
            '<div class="pi-event__d">' + esc(fmtDate(h.d)) + '</div>' +
            '<div class="pi-event__t">' + esc(t('pi.history.' + h.k, h.k)) + '</div></div>';
        }).join('') + '</div></div>';
    },

    composition: function () {
      var colors = { certified: 'var(--tf-emerald-deep)', verified: 'var(--tf-emerald)', documented: 'var(--tf-trust-documented)', review: 'var(--tf-trust-review)' };
      return sectionTitle('composition') +
        '<div class="card" style="padding:26px;margin-bottom:17px"><div class="pi-comp">' +
          P.composition.map(function (c) { return '<i style="width:' + c.pct + '%;background:' + colors[c.level] + '"></i>'; }).join('') +
        '</div></div>' +
        table([L('material'), L('share'), L('standard'), L('proof')],
          P.composition.map(function (c) {
            return ['<strong>' + esc(t('pi.fibers.' + c.k, c.k)) + '</strong>',
              '<span style="font-variant-numeric:tabular-nums">' + c.pct + '%</span>',
              '<span class="meta" style="text-transform:none">' + esc(c.std) + '</span>',
              chip(c.level)];
          })) +
        '<p class="meta" style="margin-top:13px;text-transform:none;letter-spacing:0">' + esc(t('pi.notes.composition', '')) + '</p>';
    },

    materials: function () {
      return sectionTitle('materials') + table(
        [L('material'), L('type'), L('supplier'), L('origin'), L('proof')],
        P.materials.map(function (m) {
          return ['<strong>' + esc(m.name) + '</strong>',
            '<span class="meta">' + esc(t('pi.types.' + m.type, m.type)) + '</span>',
            esc(m.supplier), esc(m.origin), chip(m.level)];
        }));
    },

    supplyChain: function () {
      return sectionTitle('lineage') +
        '<p class="meta" style="margin:0 0 13px;text-transform:none;letter-spacing:0">' + esc(t('pi.notes.lineage', '')) + '</p>' +
        '<div class="pi-lineage" id="pi-lineage"></div>' +
        '<div class="card" style="margin-top:17px"><div class="pi-dl"><div id="pi-lineage-detail"></div></div></div>';
    },

    manufacturing: function () {
      return sectionTitle('manufacturing') + table(
        [L('step'), L('facility'), L('country'), L('proof')],
        P.manufacturing.map(function (m) {
          return ['<strong>' + esc(t('pi.steps.' + m.step, m.step)) + '</strong>',
            esc(m.facility), esc(m.country), chip(m.level)];
        }));
    },

    suppliers: function () {
      return sectionTitle('suppliers') + table(
        [L('supplier'), L('tier'), L('country'), L('dataQuality'), L('certificates'), L('proof')],
        P.suppliers.map(function (sp) {
          return ['<strong>' + esc(sp.org) + '</strong>',
            '<span class="tier-badge">' + esc(L('tier')) + ' ' + sp.tier + '</span>',
            esc(sp.country),
            '<span style="font-variant-numeric:tabular-nums">' + sp.q + '%</span>',
            String(sp.certs), chip(sp.level)];
        }));
    },

    evidence: function () {
      return sectionTitle('evidence') + table(
        [L('document'), L('issuer'), L('issued'), L('expires'), L('verification')],
        P.evidence.map(function (e) {
          var expired = e.exp && new Date(e.exp) < new Date('2026-10-07');
          return ['<strong>' + esc(t('pi.docs.' + e.k, e.k)) + '</strong>',
            esc(e.issuer),
            '<span class="meta" style="text-transform:none">' + esc(fmtDate(e.date)) + '</span>',
            '<span class="meta" style="text-transform:none;' + (expired ? 'color:var(--tf-trust-missing-ink)' : '') + '">' + esc(fmtDate(e.exp)) + '</span>',
            chip(e.level)];
        })) +
        '<p class="meta" style="margin-top:13px;text-transform:none;letter-spacing:0">' + esc(t('pi.notes.evidence', '')) + '</p>';
    },

    certifications: function () {
      return sectionTitle('certifications') + table(
        [L('certificate'), L('scope'), L('holder'), L('expires'), L('proof')],
        P.certifications.map(function (c) {
          return ['<strong>' + esc(c.name) + '</strong>',
            '<span class="meta">' + esc(t('pi.scopes.' + c.scope, c.scope)) + '</span>',
            esc(c.holder),
            '<span class="meta" style="text-transform:none">' + esc(fmtDate(c.exp)) + '</span>',
            chip(c.level)];
        }));
    },

    quality: function () {
      return sectionTitle('quality') +
        '<div class="mc-band mc-band--4" style="margin-bottom:22px">' +
          P.quality.map(function (q) {
            return '<div class="mc-cell"><div class="mc-cell__k">' + esc(t('pi.quality.' + q.k, q.k)) + '</div>' +
              '<div class="mc-cell__v">' + q.v + '%</div>' +
              '<div class="mc-cell__bar"><i style="width:' + q.v + '%"></i></div></div>';
          }).join('') +
        '</div>' +
        '<div class="card panel"><div class="panel-head"><h2>' + esc(t('pi.sections.issues', '')) + '</h2>' +
        '<span class="meta">' + esc(t('pi.notes.issues', '')) + '</span></div><div class="mc-attention">' +
          P.issues.map(function (i, n) {
            return '<button class="mc-alert" data-sev="' + i.sev + '" data-goto="' + i.view + '">' +
              '<span class="mc-alert__n">' + (n + 1) + '</span><span>' +
              '<span class="mc-alert__t">' + esc(t('pi.issues.' + i.k + '.t', '')) + '</span><br>' +
              '<span class="mc-alert__d">' + esc(t('pi.issues.' + i.k + '.d', '')) + '</span></span>' +
              '<span class="mc-alert__go">' + esc(t('pi.labels.fix', 'Fix')) + ' →</span></button>';
          }).join('') +
        '</div></div>';
    },

    dpp: function () {
      return sectionTitle('dpp') +
        '<div class="card dpp-hero">' +
          '<div><div class="eyebrow">' + esc(t('pi.dpp.title', '')) + '</div>' +
          '<p style="margin:9px 0 0;color:var(--tf-ink-muted);max-width:60ch">' + esc(t('pi.dpp.lead', '')) + '</p>' +
          '<p class="meta" style="margin:13px 0 0;text-transform:none;letter-spacing:0;color:var(--tf-trust-review-ink)">' + esc(t('pi.dpp.legal', '')) + '</p></div>' +
          '<div class="dpp-gauge-box"><div class="dpp-gauge-val">' + P.scoreDpp + '%</div>' +
          '<div class="dpp-gauge-label">' + esc(t('pi.dpp.score', '')) + '</div></div>' +
        '</div>' +
        '<div class="grid split" style="margin-top:17px">' +
          '<div class="card panel"><div class="panel-head"><h2>' + esc(t('pi.dpp.ready', '')) + '</h2></div><div class="pillar-items">' +
            P.dppReady.map(function (k) {
              return '<div class="pillar-item"><span class="check-icon" style="color:var(--tf-emerald)">✓</span>' +
                '<span class="pillar-item-label">' + esc(t('pi.dpp.items.' + k, k)) + '</span></div>';
            }).join('') + '</div></div>' +
          '<div class="card panel"><div class="panel-head"><h2>' + esc(t('pi.dpp.missing', '')) + '</h2></div><div class="pillar-items">' +
            P.dppGaps.map(function (k) {
              return '<div class="pillar-item"><span class="check-icon" style="color:var(--tf-trust-review-ink)">⚠</span>' +
                '<span class="pillar-item-label">' + esc(t('pi.dpp.items.' + k, k)) + '</span></div>';
            }).join('') + '</div></div>' +
        '</div>';
    },

    history: function () {
      return sectionTitle('history') +
        '<div class="card" style="padding:26px"><div class="pi-timeline">' +
          P.history.map(function (h) {
            return '<div class="pi-event" data-level="' + h.level + '">' +
              '<div class="pi-event__d">' + esc(fmtDate(h.d)) + '</div>' +
              '<div class="pi-event__t">' + esc(t('pi.history.' + h.k, h.k)) + '</div>' +
              '<div class="pi-event__x">' + esc(t('pi.trust.' + h.level, h.level)) + '</div></div>';
          }).join('') + '</div></div>';
    }
  };

  /* ── Boot ────────────────────────────────────────────────────────────── */

  function renderTabs() {
    var nav = $('#pi-tabs');
    var host = $('#pi-panel');
    if (!nav || !host) return;

    nav.innerHTML = TABS.map(function (id, i) {
      return '<button class="pi-tab" role="tab" id="pi-tab-' + id + '" aria-controls="pi-panel" ' +
        'aria-selected="' + (i === 0) + '" data-tab="' + id + '">' +
        esc(t('pi.tabs.' + id, id)) + '</button>';
    }).join('');

    var show = function (id) {
      nav.querySelectorAll('.pi-tab').forEach(function (b) {
        b.setAttribute('aria-selected', String(b.dataset.tab === id));
      });
      host.innerHTML = (PANELS[id] || PANELS.overview)();
      host.setAttribute('aria-labelledby', 'pi-tab-' + id);
      if (id === 'supplyChain') renderLineage();
      host.querySelectorAll('[data-goto]').forEach(function (b) {
        b.addEventListener('click', function () { show(b.dataset.goto); });
      });
      try { history.replaceState(null, '', '#' + id); } catch (e) { /* noop */ }
    };

    nav.addEventListener('click', function (e) {
      var b = e.target.closest('.pi-tab');
      if (b) show(b.dataset.tab);
    });
    nav.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      var cur = TABS.indexOf(document.activeElement.dataset ? document.activeElement.dataset.tab : '');
      if (cur < 0) return;
      e.preventDefault();
      var next = (cur + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length;
      var el = nav.querySelector('[data-tab="' + TABS[next] + '"]');
      if (el) { el.focus(); show(TABS[next]); }
    });

    var initial = (location.hash || '').replace('#', '');
    show(TABS.indexOf(initial) >= 0 ? initial : 'overview');
  }

  function renderHeader() {
    var m = $('#pi-metrics');
    if (!m) return;
    var cells = [
      [P.scoreQuality, 'quality'], [P.scoreEvidence, 'evidence'],
      [P.scoreTraceability, 'traceability'], [P.scoreDpp, 'dpp']
    ];
    m.innerHTML = cells.map(function (c, i) {
      return '<div class="mc-cell"><div class="mc-cell__k">' + esc(t('pi.metrics.' + c[1], c[1])) + '</div>' +
        '<div class="mc-cell__v' + (i === 3 ? ' is-accent' : '') + '">' + c[0] + '%</div>' +
        '<div class="mc-cell__bar"><i style="width:' + c[0] + '%"></i></div></div>';
    }).join('');
  }

  function applyRequestedRef() {
    var want = '';
    try { want = new URLSearchParams(location.search).get('ref') || ''; } catch (e) { /* noop */ }
    var note = $('#pi-reqnote');
    if (!note) return;
    if (want && want !== P.ref) {
      // The drill-down carried a reference this demonstration record cannot
      // serve. Say so rather than silently showing someone else's product.
      note.textContent = t('pi.notes.otherRef', '').replace('{ref}', want);
      note.hidden = false;
    } else {
      note.hidden = true;
    }
  }

  function start() {
    renderHeader();
    renderTabs();
    applyRequestedRef();
  }

  function boot() {
    if (window.TF_I18N && window.TF_I18N.ready) window.TF_I18N.ready.then(start);
    else start();
    document.addEventListener('tf:languagechange', start);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
