    (async function() {
      const urlParams = new URLSearchParams(window.location.search);
      const ref = urlParams.get('ref') || urlParams.get('token') || 'nhan-textile-pt';

      let state = {
        data: null,
        loading: true,
        error: null,
        modalOpen: false
      };


      const pt_ = (k) => (window.TF_I18N ? window.TF_I18N.t('passport.' + k, k) : k);
      const LANG_NAMES = {en:'🇬🇧 English',fr:'🇫🇷 Français',de:'🇩🇪 Deutsch',it:'🇮🇹 Italiano',es:'🇪🇸 Español',nl:'🇳🇱 Nederlands',pt:'🇵🇹 Português'};
      function langSelect() {
        const api = window.TF_I18N;
        if (!api) return '';
        const opts = api.supported.map((l) => `<option value="${l}"${l === api.lang ? ' selected' : ''}>${LANG_NAMES[l] || l}</option>`).join('');
        return `<select id="passport-lang-select" aria-label="Language" data-tf-act="p01" data-tf-on="change">${opts}</select>`;
      }

      function mountLangSelect() {
        const slot = document.getElementById('passport-lang-slot');
        if (slot) slot.innerHTML = langSelect();
      }

      async function fetchPassport() {
        try {
          const res = await fetch(`/api/passport/${encodeURIComponent(ref)}`);
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || pt_('errNotFound'));
          }
          state.data = await res.json();
          state.loading = false;
          // Donnees reelles : la banniere de demonstration n'a plus lieu d'etre.
          const b = document.getElementById('passport-demo-banner');
          if (b) b.hidden = true;
          document.body.removeAttribute('data-tf-demo');
        } catch (e) {
          // If server call fails, fallback to realistic verified demo supplier
          console.warn('API error, loading verified demonstration passport:', e.message);
          // Repli sur un fournisseur fictif : la banniere reste visible et la
          // page entiere se declare comme donnee de demonstration.
          document.body.setAttribute('data-tf-demo', '');
          state.data = {
            passport: {
              id: 'demo-passport-1',
              slug: 'nhan-textile-pt',
              shareToken: 'pass_demo_pt_123',
              headline: 'Integrated textile manufacture certified GOTS & OEKO-TEX. Spinning, knitting and eco-responsible garment making.',
              tradeSecretMode: 'redacted',
              viewsCount: 28,
              lastViewedAt: new Date().toISOString()
            },
            supplier: {
              legalName: 'Nhãn Textile Lda',
              displayName: 'Nhãn Textile Portugal',
              countryCode: 'PT',
              website: 'https://nhantextile.example.pt',
              activityTypes: ['ginning', 'spinning', 'knitting', 'sewing', 'packaging'],
              profileSummary: 'Nhãn Textile has run a 14,000 m² industrial park in Porto since 1998, dedicated to premium circular jersey, combed fleece and certified ethical garment making.',
              employeeCountRange: '251-1000',
              yearEstablished: 1998,
              profileCompletion: 92,
              contactName: 'CSR & Quality Director'
            },
            sites: [
              { id: 's1', name: 'Knitting & Cutting Workshop (Porto)', countryCode: 'PT', city: 'Porto', address: '[Trade secret redacted — NDA required]', activityTypes: ['knitting', 'cutting'], isActive: true },
              { id: 's2', name: 'Garment Making & Finishing Unit (Braga)', countryCode: 'PT', city: 'Braga', address: '[Trade secret redacted — NDA required]', activityTypes: ['sewing', 'packaging'], isActive: true }
            ],
            certifications: [
              { id: 'c1', standardName: 'Global Organic Textile Standard (GOTS)', standardCode: 'GOTS 7.0', issuerName: 'Control Union Certifications B.V.', certificateNumber: 'CU812345GOTS-2025-01', issuedAt: '2025-01-15', expiresAt: '2027-01-14', isVerified: true },
              { id: 'c2', standardName: 'STANDARD 100 by OEKO-TEX', standardCode: 'OEKO-TEX 100', issuerName: 'CITEVE', certificateNumber: '12345-OEKO-2025', issuedAt: '2025-03-01', expiresAt: '2026-02-28', isVerified: true },
              { id: 'c3', standardName: 'SMETA 4-Pillars Ethical Audit', standardCode: 'SMETA 4P', issuerName: 'Intertek', certificateNumber: 'SMETA-2025-PT', issuedAt: '2025-02-10', expiresAt: '2027-02-09', isVerified: true }
            ],
            materials: [
              { id: 'm1', name: 'Organic Cotton Jersey 185 gsm', materialType: 'yarn', originCountryCode: 'PT', composition: { cotton_organic: 95, elastane: 5 } },
              { id: 'm2', name: 'Pre-consumer Recycled Cotton Fleece 320 gsm', materialType: 'fabric', originCountryCode: 'PT', composition: { cotton_recycled: 60, cotton_organic: 40 } }
            ],
            qualityScore: {
              completeness: 92,
              freshness: 95,
              documentationCoverage: 100,
              consistency: 90
            },
            tradeSecretProtection: {
              exactAddressesMasked: true,
              mode: 'redacted',
              legalBasis: 'Directive (EU) 2016/943 on the protection of trade secrets'
            }
          };
          state.loading = false;
        }
        render();
      }

      function render() {
        const app = document.getElementById('app');
        if (state.loading) return;

        const d = state.data;
        const sup = d.supplier;
        const pass = d.passport;
        const score = d.qualityScore;

        app.innerHTML = `
          <div class="hero-card">
            <div class="hero-top">
              <div class="supplier-title">
                <h1>${esc(sup.displayName || sup.legalName)}</h1>
                <div class="supplier-meta">
                  <span class="badge badge-country">${esc(sup.countryCode || 'PT')}</span>
                  <span>${esc(pt_('founded'))} <strong>${sup.yearEstablished || '1998'}</strong></span>
                  <span>·</span>
                  <span>${esc(pt_('employees'))} <strong>${sup.employeeCountRange || '251-1000'}</strong></span>
                  <span>·</span>
                  <span class="cert-verified">✓ ${esc(pt_('audited'))}</span>
                </div>
              </div>
              <button class="btn btn-emerald" data-tf-act="p02">
                ${esc(pt_('ctaFullAccessNda'))}
              </button>
            </div>

            <div class="headline-text">
              "${esc(pass.headline || sup.profileSummary || pt_('headlineFallback'))}"
            </div>

            <div class="kpi-row">
              <div class="kpi-box">
                <div class="kpi-label">${esc(pt_('kpiCompletion'))}</div>
                <div class="kpi-val">${moneyless(sup.profileCompletion)}%</div>
              </div>
              <div class="kpi-box">
                <div class="kpi-label">${esc(pt_('kpiEvidence'))}</div>
                <div class="kpi-val">${score ? moneyless(score.documentationCoverage) : '100'}%</div>
              </div>
              <div class="kpi-box">
                <div class="kpi-label">${esc(pt_('kpiCerts'))}</div>
                <div class="kpi-val">${d.certifications.length}</div>
              </div>
              <div class="kpi-box">
                <div class="kpi-label">${esc(pt_('kpiSites'))}</div>
                <div class="kpi-val">${d.sites.length}</div>
              </div>
            </div>
          </div>

          <div class="nda-banner">
                        <div class="nda-content">
              <strong>${esc(pt_('ndaTitle'))}</strong><br>
              ${esc(pt_('ndaBody'))}
            </div>
          </div>

          <div class="grid-2">
            <!-- Certifications -->
            <div class="card">
              <div class="card-head">
                <h2>${esc(pt_('certsTitle'))}</h2>
                <span class="card-badge">${d.certifications.length} ${esc(pt_('certsActive'))}</span>
              </div>
              <div class="item-list">
                ${d.certifications.map((c) => `
                  <div class="item-box">
                    <div class="item-top">
                      <strong>${esc(c.standardName)}</strong>
                      <span class="cert-verified">✓ ${esc(pt_('certVerified'))}</span>
                    </div>
                    <div class="item-desc">
                      ${esc(pt_('certIssuer'))} <strong>${esc(c.issuerName || pt_('certIssuerFallback'))}</strong><br>
                      ${esc(pt_('certNumber'))} <code>${esc(c.certificateNumber || 'CU812345')}</code><br>
                      ${esc(pt_('certValidUntil'))} <strong>${date(c.expiresAt)}</strong>
                    </div>
                  </div>
                `).join('')}
              </div>
            </div>

            <!-- Sites Industriels -->
            <div class="card">
              <div class="card-head">
                <h2>${esc(pt_('sitesTitle'))}</h2>
                <span class="card-badge">${d.sites.length} ${esc(pt_('sitesCount'))}</span>
              </div>
              <div class="item-list">
                ${d.sites.map((s) => `
                  <div class="item-box">
                    <div class="item-top">
                      <strong>${esc(s.name)}</strong>
                      <span class="badge badge-active">${esc(pt_('siteActive'))}</span>
                    </div>
                    <div class="item-desc">
                      ${esc(pt_('siteLocation'))} <strong>${esc(s.city || 'Portugal')}, ${esc(s.countryCode)}</strong><br>
                      ${esc(pt_('siteAddress'))} <em>${esc(s.address)}</em><br>
                      ${esc(pt_('siteActivities'))} ${(s.activityTypes || []).map((a) => `<span class="badge">${esc(a)}</span>`).join('')}
                    </div>
                  </div>
                `).join('')}
              </div>
            </div>
          </div>

          <!-- Matériaux & Savoir-faire -->
          <div class="card" style="margin-bottom:24px">
            <div class="card-head">
              <h2>${esc(pt_('matsTitle'))}</h2>
              <span class="card-badge">${d.materials.length} ${esc(pt_('matsCount'))}</span>
            </div>
            <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(280px, 1fr));gap:14px">
              ${d.materials.map((m) => `
                <div class="item-box">
                  <div class="item-top">
                    <strong>${esc(m.name)}</strong>
                    <span class="badge badge-country">${esc(m.materialType || pt_('matTypeFallback'))}</span>
                  </div>
                  <div class="item-desc" style="margin-top:6px">
                    ${esc(pt_('matOrigin'))} <strong>${esc(m.originCountryCode || 'Portugal')}</strong><br>
                    ${m.composition ? `${esc(pt_('matComposition'))} <code>${typeof m.composition === 'string' ? esc(m.composition) : esc(JSON.stringify(m.composition))}</code>` : ''}
                  </div>
                </div>
              `).join('')}
            </div>
          </div>

          <!-- Sticky Bar for Inbound Conversion -->
          <div class="sticky-bar">
            <div class="sticky-text">
              <strong>${esc(pt_('stickyTitle'))}</strong>
              <p>${esc(pt_('stickyBody'))}</p>
            </div>
            <button class="btn btn-primary" data-tf-act="p02">
              ${esc(pt_('ctaFullAccess'))}
            </button>
          </div>
        `;
      }

      function esc(str) {
        if (!str) return '';
        return String(str).replace(/[&<>"']/g, (m) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[m]);
      }
      function date(d) {
        if (!d) return '—';
        return new Date(d).toLocaleDateString((window.TF_I18N && window.TF_I18N.lang) || 'en', { day: '2-digit', month: 'short', year: 'numeric' });
      }
      function moneyless(n) { return Math.round(Number(n) || 0); }

      window.openRequestModal = function() {
        const mc = document.getElementById('modal-container');
        mc.innerHTML = `
          <div class="modal-backdrop" data-tf-act="p03">
            <div class="modal-box">
              <div class="modal-head">
                <div>
                  <div class="modal-eyebrow">${esc(pt_('modalEyebrow'))}</div>
                  <h3>${esc(pt_('modalTitle'))}</h3>
                </div>
                <button class="close-btn" data-tf-act="p04">×</button>
              </div>
              <p class="modal-intro">
                ${esc(pt_('modalIntroA'))} <strong>${esc(state.data?.supplier?.displayName || pt_('modalSupplierFallback'))}</strong>${esc(pt_('modalIntroB'))}
              </p>
              <form id="access-form" data-tf-act="p05" data-tf-on="submit">
                <div class="form-group">
                  <label>${esc(pt_('fName'))}</label>
                  <input class="input" name="requesterName" required placeholder="${esc(pt_('fNamePh'))}">
                </div>
                <div class="form-group">
                  <label>${esc(pt_('fEmail'))}</label>
                  <input class="input" name="requesterEmail" type="email" required placeholder="marie@mybrand.com">
                </div>
                <div class="form-group">
                  <label>${esc(pt_('fCompany'))}</label>
                  <input class="input" name="requesterCompany" required placeholder="${esc(pt_('fCompanyPh'))}">
                </div>
                <div class="form-group">
                  <label>${esc(pt_('fMessage'))}</label>
                  <textarea class="textarea" name="message" rows="3" placeholder="${esc(pt_('fMessagePh'))}"></textarea>
                </div>
                <div class="form-group" style="margin-top:14px">
                  <label class="checkbox-label">
                    <input type="checkbox" name="ndaAccepted" required checked>
                    <span>${esc(pt_('fNda'))}</span>
                  </label>
                </div>
                <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:24px">
                  <button type="button" class="btn btn-ghost" data-tf-act="p04">${esc(pt_('btnCancel'))}</button>
                  <button type="submit" class="btn btn-emerald">${esc(pt_('btnSubmit'))}</button>
                </div>
              </form>
            </div>
          </div>
        `;
      };

      window.closeRequestModal = function() {
        document.getElementById('modal-container').innerHTML = '';
      };

      window.submitAccessRequest = async function(e) {
        e.preventDefault();
        const form = e.target;
        const formData = new FormData(form);
        const body = {
          requesterName: formData.get('requesterName'),
          requesterEmail: formData.get('requesterEmail'),
          requesterCompany: formData.get('requesterCompany'),
          message: formData.get('message'),
          ndaAccepted: true
        };

        try {
          const res = await fetch(`/api/passport/${encodeURIComponent(ref)}/request-access`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          });
          const result = await res.json();
          if (!res.ok) throw new Error(result.error || pt_('errSend'));

          document.getElementById('modal-container').innerHTML = `
            <div class="modal-backdrop" data-tf-act="p04">
              <div class="modal-box modal-box--ok">
                <div class="modal-ok-mark">✓</div>
                <h3 >${esc(pt_('okTitle'))}</h3>
                <p class="modal-intro">
                  ${esc(result.message || pt_('okBody'))}
                </p>
                <button class="btn btn-primary" data-tf-act="p04">${esc(pt_('btnGotIt'))}</button>
              </div>
            </div>
          `;
        } catch (err) {
          alert(pt_('errPrefix') + ' ' + err.message);
        }
      };

      document.addEventListener('tf:languagechange', () => { mountLangSelect(); if (state.data) render(); });
      // Charger la locale avant le premier rendu, sinon la page s'affiche en
      // anglais puis bascule.
      (window.TF_I18N ? window.TF_I18N.setLanguage(window.TF_I18N.lang) : Promise.resolve())
        .then(mountLangSelect, mountLangSelect)
        .then(fetchPassport, fetchPassport);
    

      /* Gestionnaires de la page, enregistres dans la portee du module.
       * Les attributs inline etaient evalues en portee globale, ce qui
       * obligeait a exposer des fonctions sur window ; ici, state et render
       * sont directement accessibles. */
      window.TFActions.register({
        p01: function (event) { window.TF_I18N && window.TF_I18N.setLanguage(this.value); },
        p02: function (event) { openRequestModal(); },
        p03: function (event) { if(event.target === this) closeRequestModal(); },
        p04: function (event) { closeRequestModal(); },
        p05: function (event) { submitAccessRequest(event); },
      });
    })();
  
