#!/usr/bin/env node
/* ==========================================================================
   Chantier 15 — i18n complet : contrat statique.

   Verifie, sans navigateur :
     1. le runtime tf-i18n supporte les metadonnees localisees par page
        (crochet TF_I18N_PAGE_META) ;
     2. le namespace i18n15 existe dans en.js et les six locales completes,
        avec parite stricte ;
     3. tr et zh sont retirees du produit : catalogues supprimes, plus
        d option ni de declaration SUPPORTED etendue cote portail ;
     4. Brand Console : les textes métier listes par l audit passent par le
        helper b15 (plus aucun litteral en dur), metadonnees de la SPA
        appliquees au boot et a chaque changement de langue ;
     5. Portail fournisseur : idem via s15 ;
     6. Quality Center : metadonnees localisees via q15 ;
     7. Pages site : chacune declare TF_I18N_PAGE_META ;
     8. generateur idempotent ; non-regression README + namespaces precedents.
   ========================================================================== */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
let failures = 0;
const ok = (m) => console.log('  ok    ' + m);
const fail = (m) => { console.error('  ECHEC ' + m); failures++; };
const check = (cond, m) => (cond ? ok(m) : fail(m));

const consoleHtml = read('brand-console/index.html');
const portalHtml = read('supplier-portal/index.html');
const qcHtml = read('quality-center/index.html');
const tfI18n = read('assets/js/tf-i18n.js');

/* --- 1. runtime : metadonnees par page -------------------------------------- */
console.log('\n[1] runtime tf-i18n');
check(/TF_I18N_PAGE_META/.test(tfI18n), 'crochet TF_I18N_PAGE_META present');
check(/pageMeta\.title \|\| 'meta\.title'/.test(tfI18n), 'titre : repli sur meta.title');
check(/pageMeta\.description \|\| 'meta\.description'/.test(tfI18n), 'description : repli sur meta.description');
check(/TF_I18N_SKIP_META/.test(tfI18n), 'garde SPA (SKIP_META) preservee');
check(/var SUPPORTED = \['en', 'fr', 'de', 'it', 'es', 'nl', 'pt'\];/.test(tfI18n), 'runtime : liste strictement limitee aux 7 locales completes');
check(!tfI18n.includes('window.TF_I18N_SUPPORTED'), 'runtime : aucune surcharge par page ne peut exposer une locale partielle');

/* --- 2. namespace i18n15 ------------------------------------------------------ */
console.log('\n[2] namespace i18n15');
const leaves = (o, p = '', out = []) => {
  for (const [k, v] of Object.entries(o)) {
    const key = p ? `${p}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) leaves(v, key, out);
    else out.push(key);
  }
  return out.sort();
};
const get = (o, path) => path.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), o);
const source = JSON.parse(read('scripts/_chantier15_i18n.json'));
const langs = Object.keys(source);
check(langs.length === 7 && langs.includes('en'), 'source : 7 langues dont en');
const refKeys = leaves(source.en);
check(refKeys.length === 118, `source : 118 cles i18n15 (${refKeys.length})`);
for (const scope of ['siteMeta', 'appMeta', 'console', 'portal', 'qc']) {
  check(scope in source.en, `source : sous-portee ${scope} presente`);
}
for (const lang of langs) {
  check(JSON.stringify(leaves(source[lang])) === JSON.stringify(refKeys), 'source : parite des cles pour ' + lang);
}
const enJs = read('assets/i18n/en.js');
check(/\n  "?i18n15"?\s*:\s*\{/.test(enJs), 'en.js : bloc i18n15 present (niveau racine)');
check(!/\},,\n/.test(enJs), 'en.js : aucune double virgule');
for (const lang of ['fr', 'de', 'it', 'es', 'nl', 'pt']) {
  const catalog = JSON.parse(read('assets/i18n/' + lang + '.json'));
  const hasAll = refKeys.every((k) => typeof get(catalog, 'i18n15.' + k) === 'string');
  check(hasAll, lang + '.json : toutes les cles i18n15.* presentes');
}

/* --- 3. retrait de tr / zh ------------------------------------------------------- */
console.log('\n[3] tr et zh retirees du produit');
check(!existsSync(join(ROOT, 'assets/i18n/tr.json')), 'catalogue tr.json supprime');
check(!existsSync(join(ROOT, 'assets/i18n/zh.json')), 'catalogue zh.json supprime');
check(!portalHtml.includes('TF_I18N_SUPPORTED'), 'portail : plus de declaration SUPPORTED etendue');
check(!/<option value="tr"/.test(portalHtml), 'portail : plus d option de langue tr');
check(!/<option value="zh"/.test(portalHtml), 'portail : plus d option de langue zh');
check(!/tr:'tr-TR'|zh:'zh-CN'/.test(consoleHtml + portalHtml), 'formats de date : aucune locale retiree dans les maps BCP47');
check(!/\bTürkçe\b/.test(portalHtml), 'portail : libelle turc retire du selecteur');
const appBuilder = read('scripts/build_app_i18n.mjs');
check(/const LANGS = \['en', 'fr', 'de', 'it', 'es', 'nl', 'pt'\];/.test(appBuilder), 'build_app_i18n : LANGS sans tr ni zh');
check(!/\n  tr: \{/.test(appBuilder) && !/\n  zh: \{/.test(appBuilder), 'build_app_i18n : blocs de remplissage tr/zh supprimes');
const portalOverviewBuilder = read('scripts/build_portal_overview_i18n.mjs');
check(/const LANGS = \['en', 'fr', 'de', 'it', 'es', 'nl', 'pt'\];/.test(portalOverviewBuilder), 'build_portal_overview : uniquement les 7 langues completes');
check(!/cle: \[en, fr, de, it, es, nl, pt, tr, zh\]/.test(portalOverviewBuilder), 'build_portal_overview : donnees tr/zh retirees');

const consolidation = read('scripts/test_i18n_consolidation.mjs');
check(/catalogues partiels ont ete retires|retirees du produit/.test(consolidation), 'consolidation : le retrait est documente et verifie');
check(!/'Taslak'/.test(consolidation), 'consolidation : l attente « turc servi » est remplacee');

/* --- 4. Brand Console ------------------------------------------------------------- */
console.log('\n[4] Brand Console : textes extraits');
for (const hard of ['Connexion indisponible', 'Questionnaire Builder', 'Settings & Governance',
  "Actions d'infrastructure rapides", '<h2>Demandes</h2>', 'Nomenclature & Bilan Massique (BOM)</h2>',
  "Piste d'audit immuable", '<h2>Profil fournisseur</h2>', "Protocoles d'Audit Actifs (",
  '<h2>Rapprochement produit</h2>', '<h2>Se connecter</h2>', 'eyebrow">Catalogue</div>',
  'eyebrow">Configuration</div>', 'eyebrow">Digital Product Passport</div>', 'eyebrow">Espace marque</div>',
  'eyebrow">Form Studio</div>', 'Profil Actif :', 'eyebrow">Reporting & CSRD Audits</div>',
  'eyebrow">Supply Chain</div>', 'Import fournisseurs terminé', 'Import catalogue terminé',
  'créé et disponible pour toutes les marques', 'placeholder="UUID produit"', 'Organic cotton certifié',
  'Document check, issuer registry', '<label>SKU<input', "Signé par le directeur",
  'Audit greenClaimsAudit :', '<label>Valeur<input', '>Interne</option>',
  '<small>brand console</small>', 'Tracefab Brand Console</div>', '<th>Certifications</th>',
  'Lot / Batch ID</span>', '<strong>Aucune demande</strong>', '>Avancement</th>', '>Ouvrir</button>',
  'Zero Data Silos · Full Audit Trail', '<th data-tfsort>Organisation</th>', 'Partenaire actif</span>',
  'Identifiants</dt>', '<dt class="meta">Version</dt>', '<label>Couleur<input',
  '<label>Poids unitaire (g)<input', '<label>Tailles<input', 'type="submit">Valider</button>',
  'pil-summary-label">Liens</span>', '<dt class="meta">Contact</dt>', 'data-issue-id="${esc(issue.id)}">Acquitter',
  "Note d'Audit / Justification :", '<div class="kpi-label">Invitations</div>',
  '>Import possible</span>', 'MISSION CONTROL CENTER · LAYER 01–07', '>Readiness</th>']) {
  check(!consoleHtml.includes(hard), `texte en dur supprime : ${hard.slice(0, 48)}`);
}
check(/function b15\(key, vars = \{\}\)/.test(consoleHtml), 'helper b15 defini');
check(/T\.t\('i18n15\.' \+ key/.test(consoleHtml), 'helper b15 resout via i18n15');
check(/function applyConsoleMeta\(\)/.test(consoleHtml), 'metadonnees SPA : fonction presente');
check(/i18n15\.appMeta\.consoleTitle/.test(consoleHtml) && /i18n15\.appMeta\.consoleDesc/.test(consoleHtml), 'metadonnees SPA : cles titre et description');
check(/applyConsoleMeta\(\);\s*\n\s*if \(i18nReady\) render\(\);/.test(consoleHtml), 'metadonnees SPA : reappliquees a chaque changement de langue');
check(/applyConsoleMeta\(\); \}, \(\) => \{ i18nReady = true; applyConsoleMeta\(\); \}\)/.test(consoleHtml), 'metadonnees SPA : appliquees au boot');

/* --- 5. Portail fournisseur ---------------------------------------------------------- */
console.log('\n[5] Portail fournisseur : textes extraits');
for (const hard of ['<label>Standard<input', '<label>Code<input', '<label>Site<select', '<label>Type<input',
  '<label>Type<select', '<label>Objet<select', '<label>Origine<input', '<label>Expiration<input',
  '<label>Preuve disponible<select', '<label>Type de preuve<select', '<label>Fichier<input',
  '<label>Valeur<textarea', '<label class="field-full">Email<input', '<h2>Invitation</h2>',
  'certificat(s)</h2>', 'membre(s)</h2>', "|| 'Membre')", 'invitation(s) en attente',
  'expire le', 'Invitation créée. Token', 'Invitation renvoyée. Token', 'Nomenclature validée à 100%',
  'Erreur de validation :', 'ligne(s) détectée(s)', 'marque(s)</span>', "'Organisation cliente'",
  'document(s)</h2>', 'octet(s)</p>', 'maintenir son profil',
  '<small>supplier portal</small>', 'Tracefab Supplier Portal</div>',
  '<dt class="meta">Version</dt>', '>Calculer maintenant</button>', 'Choisir…', '>Oui</option>',
  '>Non</option>', '<strong>Demande introuvable</strong>']) {
  check(!portalHtml.includes(hard), `texte en dur supprime : ${hard.slice(0, 48)}`);
}
check(/function s15\(key, vars = \{\}\)/.test(portalHtml), 'helper s15 defini');
check(/function applyPortalMeta\(\)/.test(portalHtml), 'metadonnees portail : fonction presente');
check(/i18n15\.appMeta\.portalTitle/.test(portalHtml) && /i18n15\.appMeta\.portalDesc/.test(portalHtml), 'metadonnees portail : cles titre et description');
check(/applyPortalMeta\(\);\s*\n\s*if \(i18nReady\) render\(\);/.test(portalHtml), 'metadonnees portail : reappliquees a chaque changement de langue');
check(/content="Tracefab Supplier Portal — maintain your profile and answer data requests\."/.test(portalHtml), 'meta statique : repli anglais coherent');
check(/s15\('portal\.portalLabel'\)/.test(portalHtml), 'label portail traduit');

/* --- 6. Quality Center ------------------------------------------------------------------ */
console.log('\n[6] Quality Center');
check(/function q15\(key\)/.test(qcHtml), 'helper q15 defini');
check(/function applyQcMeta\(\)/.test(qcHtml), 'metadonnees QC : fonction presente');
check(/q15\('qc\.appLabel'\)/.test(qcHtml), 'badge application traduit');
check(!/<small>quality center<\/small>/.test(qcHtml), 'logo Quality Center : aucun label anglais en dur');
check(!/'Quality Center'\}/.test(qcHtml), 'badge anglais code en dur supprime');
check(!/scores, issues et actions de qualité des données/.test(qcHtml), 'meta description francaise remplacee');

const operationsHtml = read('operations/index.html');
const piHtml = read('product-intelligence/index.html');
const inviteHtml = read('invitations/accept/index.html');
const dppHtml = read('dpp/index.html');
const passportHtml = read('passport/index.html');
check(/<title data-i18n="i18n15\.appMeta\.operationsTitle"/.test(operationsHtml), 'Operations : titre localise');
check(/o15\('appMeta\.operationsLabel'\)/.test(operationsHtml), 'Operations : label de marque localise');
check(/data-i18n-attr="content:i18n15\.appMeta\.operationsDesc"/.test(operationsHtml), 'Operations : description localisee');
check(/window\.TF_I18N_PAGE_META = \{ title: 'i18n15\.appMeta\.piTitle', description: 'i18n15\.appMeta\.piDesc' \}/.test(piHtml), 'Product Intelligence : metadonnees page propres');
check(/data-i18n-attr="content:i18n15\.appMeta\.inviteDesc"/.test(inviteHtml), 'Invitation : description localisee');
check(/data-i18n="i18n15\.appMeta\.inviteLabel"/.test(inviteHtml), 'Invitation : label de marque localise');
check(/data-i18n="i18n15\.appMeta\.passportLabel"/.test(passportHtml), 'Passeport : label de marque localise');
check(/q15\('qc\.appLabel'\)/.test(qcHtml), 'Quality Center : label de marque localise');
check(/data-i18n="dpp\.metaTitle"/.test(dppHtml) && /content:dpp\.metaDesc/.test(dppHtml), 'DPP public : metadonnees deja localisees');
check(/data-i18n="passport\.metaTitle"/.test(passportHtml) && /content:passport\.metaDesc/.test(passportHtml), 'Passeport fournisseur : metadonnees deja localisees');


/* --- 7. Pages site ------------------------------------------------------------------------ */
console.log('\n[7] pages site : metadonnees localisees par page');
const pages = {
  'platform/index.html': ['platformTitle', 'platformDesc'],
  'security/index.html': ['securityTitle', 'securityDesc'],
  'resources/index.html': ['resourcesTitle', 'resourcesDesc'],
  'about/index.html': ['aboutTitle', 'aboutDesc'],
  'contact/index.html': ['contactTitle', 'contactDesc'],
};
for (const [page, [tk, dk]] of Object.entries(pages)) {
  const html = read(page);
  const declared = html.includes(`window.TF_I18N_PAGE_META = { title: 'i18n15.siteMeta.${tk}', description: 'i18n15.siteMeta.${dk}' };`);
  const before = html.indexOf('TF_I18N_PAGE_META') < html.indexOf('assets/js/tf-i18n.js');
  check(declared && before, page + ' : declaration PAGE_META avant le runtime');
}

/* --- 8. generateur ---------------------------------------------------------------------------- */
console.log('\n[8] generateur build_i18n_chantier15.mjs');
const generator = read('scripts/build_i18n_chantier15.mjs');
const stripped = generator.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
check(!stripped.includes('(?=\\n') && !stripped.includes('(?=\n'), 'garde de consolidation : aucun lookahead de suppression');
check(/\\n  "i18n15"|\\n  i18n15/.test(generator), 'test d idempotence ancre au niveau racine');
const i18nFiles = ['assets/i18n/en.js', 'assets/i18n/fr.json', 'assets/i18n/de.json', 'assets/i18n/it.json', 'assets/i18n/es.json', 'assets/i18n/nl.json', 'assets/i18n/pt.json'];
const before = i18nFiles.map(read);
execFileSync(process.execPath, ['scripts/build_i18n_chantier15.mjs'], { cwd: ROOT, stdio: 'pipe' });
const after = i18nFiles.map(read);
check(before.every((b, i) => b === after[i]), 'generateur idempotent : aucun fichier modifie au second passage');

/* --- 9. non-regression -------------------------------------------------------------------------- */
console.log('\n[9] non-regression');
check(read('README.md').includes('Notification Observability'), 'README : libelle Notification Observability preserve');
for (const ns of ['supplyGraph', 'intelAsk', 'intel', 'evidence', 'certifications', 'qualityPremium']) {
  check(new RegExp('\\n  "' + ns + '"\\s*:\\s*\\{').test(enJs), 'en.js : namespace ' + ns + ' preserve');
}
check(consoleHtml.includes('function intelligenceView()'), 'console : vue TRACEFAB Intelligence (ch12) presente');
check(portalHtml.includes('<option value="fr"'), 'portail : les 7 langues produit restent selectionnables');
const packageJson = JSON.parse(read('package.json'));
check(packageJson.scripts['test:i18nchantier15'] === 'node scripts/test_i18n_chantier15.mjs', 'script npm du contrat declare');
check(packageJson.scripts.test.includes('npm run test:i18nchantier15'), 'contrat i18n15 inclus dans npm test');

console.log(failures ? `\n${failures} verification(s) en echec.` : '\nContrat i18n complet (chantier 15) : OK.');
if (failures) process.exit(1);
