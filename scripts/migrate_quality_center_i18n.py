#!/usr/bin/env python3
"""
Branche quality-center/ sur le catalogue unique.

Les remplacements portent sur des fragments HTML entiers et non sur des
mots isoles : plusieurs libelles sont homonymes entre les metriques et les
filtres (« Avertissements », « Acquittees », « Bloquantes »), et un
remplacement mot a mot aurait touche la mauvaise occurrence.

Non idempotent : restaurer depuis git avant toute reexecution.
"""
import sys
import pathlib

P = pathlib.Path(__file__).resolve().parent.parent / 'quality-center/index.html'
src = P.read_text(encoding='utf-8')
done = 0


def sub(old, new, label, count=1):
    global src, done
    n = src.count(old)
    if n != count:
        print(f"  ECHEC  {label} — {n} occurrence(s), {count} attendue(s)")
        sys.exit(1)
    src = src.replace(old, new, count)
    print(f"  ok     {label}")
    done += 1


# -- 1. chargement du catalogue -------------------------------------------
sub(
    '</head>',
    """    <!-- i18n : catalogue unique /assets/i18n. Cette page n'avait aucun
         mecanisme de traduction alors qu'elle est atteignable depuis trois
         pages ; elle suit desormais la langue choisie ailleurs. -->
    <script>window.TF_I18N_SKIP_META = true;</script>
    <script src="/assets/i18n/en.js"></script>
    <script src="/assets/js/tf-i18n.js"></script>
  </head>""",
    'chargement du catalogue',
)

# -- 2. helpers de resolution ---------------------------------------------
sub(
    "      function render(){",
    """      // q() lit la portee propre a cette page, s() le fonds commun deja
      // partage avec la console et le portail (statuts).
      const q = (k) => (window.TF_I18N ? window.TF_I18N.t('quality.' + k, k) : k);
      const s = (k) => (window.TF_I18N ? window.TF_I18N.t('shared.' + k, k) : k);

      function render(){""",
    'helpers q() et s()',
)

# -- 3. ecrans d'attente et d'erreur --------------------------------------
sub(
    """app.innerHTML='<div class="auth"><div class="muted">Chargement du Quality Center…</div></div>';return;""",
    """app.innerHTML=`<div class="auth"><div class="muted">${q('loading')}</div></div>`;return;""",
    'ecran de chargement',
)
sub(
    """<div class="eyebrow">Tracefab Quality Center</div><h1>Qualité indisponible</h1><p class="muted">${esc(state.error)}</p><button class="btn btn-primary" data-action="retry">Réessayer</button>""",
    """<div class="eyebrow">${q('eyebrowBrand')}</div><h1>${q('unavailable')}</h1><p class="muted">${esc(state.error)}</p><button class="btn btn-primary" data-action="retry">${q('retry')}</button>""",
    'ecran d erreur',
)
sub(
    """app.innerHTML='<div class="auth"><div class="auth-card"><div class="eyebrow">Tracefab Quality Center</div><h1>Contrôler la qualité de la donnée.</h1><p class="muted">Scores explicables, issues actionnables et historique des décisions de revue.</p><div id="clerk-sign-in"></div></div></div>';""",
    """app.innerHTML=`<div class="auth"><div class="auth-card"><div class="eyebrow">${q('eyebrowBrand')}</div><h1>${q('signInTitle')}</h1><p class="muted">${q('signInLede')}</p><div id="clerk-sign-in"></div></div></div>`;""",
    'ecran de connexion',
)

# -- 4. barre superieure et hero ------------------------------------------
sub(
    """<span class="${state.demo?'demo':''}">${state.demo?'Mode démo':'Quality Center'}</span><a href="/">Accueil</a><a href="/brand-console/">Brand Console</a>""",
    """<span class="${state.demo?'demo':''}">${state.demo?q('demoMode'):'Quality Center'}</span><a href="/">${q('navHome')}</a><a href="/brand-console/">${q('navConsole')}</a>""",
    'barre superieure',
)
sub(
    """<div class="eyebrow">P1 · qualité des données</div><h1>Décider avec des signaux explicables.</h1><p class="lede">Un espace de revue transversal pour les produits et fournisseurs accessibles à votre organisation. Les statuts déclaratifs ne sont jamais transformés en certification.</p></div><button class="btn btn-primary" data-action="refresh">Rafraîchir</button>""",
    """<div class="eyebrow">${q('eyebrow')}</div><h1>${q('heroTitle')}</h1><p class="lede">${q('heroLede')}</p></div><button class="btn btn-primary" data-action="refresh">${q('refresh')}</button>""",
    'hero',
)

# -- 5. metriques ----------------------------------------------------------
sub(
    """<div class="metric"><label>Issues visibles</label><strong>${num(m.totalIssues)}</strong></div><div class="metric danger"><label>Bloquantes ouvertes</label><strong>${num(m.blockingIssues)}</strong></div><div class="metric warn"><label>Avertissements</label><strong>${num(m.warningIssues)}</strong></div><div class="metric"><label>À traiter</label><strong>${num(m.openIssues)}</strong></div><div class="metric"><label>Acquittées</label><strong>${num(m.acknowledgedIssues)}</strong></div>""",
    """<div class="metric"><label>${q('metricTotal')}</label><strong>${num(m.totalIssues)}</strong></div><div class="metric danger"><label>${q('metricBlocking')}</label><strong>${num(m.blockingIssues)}</strong></div><div class="metric warn"><label>${q('metricWarning')}</label><strong>${num(m.warningIssues)}</strong></div><div class="metric"><label>${q('metricOpen')}</label><strong>${num(m.openIssues)}</strong></div><div class="metric"><label>${q('metricAcknowledged')}</label><strong>${num(m.acknowledgedIssues)}</strong></div>""",
    'metriques',
)

# -- 6. filtres (statuts repris du fonds commun) ---------------------------
sub(
    """<h2>Issues prioritaires</h2><div class="filters"><select data-filter="severity"><option value="">Toutes les sévérités</option><option value="blocking">Bloquantes</option><option value="warning">Avertissements</option><option value="info">Information</option></select><select data-filter="status"><option value="">Tous les statuts</option><option value="open">Ouvertes</option><option value="acknowledged">Acquittées</option><option value="waived">Waivées</option></select></div>""",
    """<h2>${q('issuesTitle')}</h2><div class="filters"><select data-filter="severity"><option value="">${q('allSeverities')}</option><option value="blocking">${q('sevBlocking')}</option><option value="warning">${q('metricWarning')}</option><option value="info">${q('sevInfo')}</option></select><select data-filter="status"><option value="">${q('allStatuses')}</option><option value="open">${s('stOpen')}</option><option value="acknowledged">${s('stAcknowledged')}</option><option value="waived">${s('stWaived')}</option></select></div>""",
    'filtres',
)

# -- 7. tableau ------------------------------------------------------------
sub(
    """<th>Sujet</th><th>Issue</th><th>Gravité</th><th>Statut</th><th>Action</th>""",
    """<th>${q('colSubject')}</th><th>${q('colIssue')}</th><th>${q('colSeverity')}</th><th>${q('colStatus')}</th><th>${q('colAction')}</th>""",
    'en-tetes du tableau',
)
sub(
    """data-id="${esc(i.id)}">Acquitter</button>""",
    """data-id="${esc(i.id)}">${q('actionAck')}</button>""",
    'bouton acquitter',
)
sub(
    """data-id="${esc(i.id)}">Waiver</button>""",
    """data-id="${esc(i.id)}">${q('actionWaive')}</button>""",
    'bouton waiver',
)
sub(
    """'<div class="empty">Aucune issue pour ces filtres.</div>'""",
    """`<div class="empty">${q('emptyIssues')}</div>`""",
    'tableau vide',
)

# -- 8. panneau des scores -------------------------------------------------
sub(
    """<h2>Derniers scores</h2>""",
    """<h2>${q('scoresTitle')}</h2>""",
    'titre des scores',
)
sub(
    """· calculé ${new Date(s.computedAt).toLocaleDateString('fr-FR')}""",
    """· ${q('computedOn')} ${new Date(s.computedAt).toLocaleDateString((window.TF_I18N && window.TF_I18N.lang) || 'en')}""",
    'date de calcul localisee',
)
sub(
    """[['Complétude',s.completeness],['Fraîcheur',s.freshness],['Preuves',s.documentationCoverage],['Cohérence',s.consistency]]""",
    """[[q('barCompleteness'),s.completeness],[q('barFreshness'),s.freshness],[q('barEvidence'),s.documentationCoverage],[q('barConsistency'),s.consistency]]""",
    'libelles des barres',
)
sub(
    """'<div class="empty">Aucun score calculé.</div>'""",
    """`<div class="empty">${q('emptyScores')}</div>`""",
    'scores vides',
)

# -- 9. notifications et invite -------------------------------------------
sub(
    """state.notice=action==='ack'?'Issue acquittée en mode démo.':'Waiver enregistré en mode démo.';""",
    """state.notice=action==='ack'?q('noticeAck'):q('noticeWaive');""",
    'notifications de demonstration',
)
sub(
    """window.prompt('Motif du waiver')""",
    """window.prompt(q('promptWaive'))""",
    'invite de motif',
)
sub(
    """state.notice='Action enregistrée.';""",
    """state.notice=q('noticeSaved');""",
    'notification enregistree',
)

# -- 10. re-rendu sur changement de langue --------------------------------
sub(
    """      function bind(){""",
    """      // La langue peut changer depuis la console ou un autre onglet.
      document.addEventListener('tf:languagechange', () => { if (state.i18nReady) render(); });

      function bind(){""",
    'ecoute du changement de langue',
)

P.write_text(src, encoding='utf-8')
print(f"\n  {done} remplacement(s) appliques.")
