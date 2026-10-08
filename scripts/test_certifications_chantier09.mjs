#!/usr/bin/env node
/* ==========================================================================
   Chantier 09 — Certification Intelligence : contrat statique.

   Verifie, sans base ni navigateur :
     1. l'API marque expose la vue des certificats (marque + fournisseurs
        actifs, isolation tenant) et la revue humaine, via les fonctions SQL
        existantes tracefab_register_certification / tracefab_review_certification ;
     2. la console rend la sante des certifications (valid / expiring /
        expired / needs review) derivee des donnees reelles, la veille
        d'expiration, la couverture informative du catalogue versionne, la
        declaration et la revue — sans bouton simule ;
     3. le vocabulaire reste « preparation » : jamais de promesse de
        conformite, jamais de promotion automatique par IA ;
     4. le namespace i18n `certifications` existe dans en.js et les six
        locales completes ; generateur idempotent ;
     5. non-regression : les routes fournisseur existantes (liste, detail,
        ocr-extract, auto-verify), le catalogue et les chantiers 07/08.
   ========================================================================== */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
let failures = 0;
const ok = (m) => console.log('  ok    ' + m);
const fail = (m) => { console.error('  ECHEC ' + m); failures++; };
const check = (cond, m) => (cond ? ok(m) : fail(m));

const consoleHtml = read('brand-console/index.html');
const certsView = consoleHtml.slice(
  consoleHtml.indexOf('function certificationsConsoleView()'),
  consoleHtml.indexOf('// dppConsoleView a ete supprimee')
);
const indexTs = read('api/index.ts');

/* --- 1. API marque ------------------------------------------------------------ */
console.log('\n[1] API marque : liste, declaration, revue');
const listRoute = read('api/_routes/certifications.ts');
check(/activeBrandOrganizationIds/.test(listRoute), 'liste : garde par organisations de marque actives');
check(/brand_supplier_relationships/.test(listRoute), 'liste : certificats des fournisseurs actifs inclus (vue marque)');
check(/status = 'active'/.test(listRoute), 'liste : seules les relations fournisseurs actives');
check(/tracefab_register_certification/.test(listRoute), 'declaration : fonction SQL tracefab_register_certification');
check(/values\.supplierSiteId\) throw/.test(listRoute), 'declaration marque : pas de site fournisseur');
check(/status: 'available'/.test(listRoute), 'declaration : preuve associee doit etre disponible');
const reviewRoute = read('api/_routes/certifications/[certificationId]/review.ts');
check(/tracefab_review_certification/.test(reviewRoute), 'revue : fonction SQL tracefab_review_certification');
check(/owner_organization_id: \{ in: brandIds \}/.test(reviewRoute), 'revue : limitee aux certificats de la marque');
check(/VERIFICATION_STATUSES = \['passed', 'failed', 'needs_review', 'expired'\]/.test(reviewRoute), 'revue : statut de verification explicite et borne');
check(/verification_method_required/.test(reviewRoute), 'revue : methode obligatoire (piste d audit)');
check(indexTs.includes("{ pattern: /^certifications$/, params: [], load: () => import('./_routes/certifications.js') }"), 'routeur : GET/POST /api/certifications enregistre');
check(indexTs.includes("{ pattern: /^certifications\\/([^\\/]+)\\/review$/, params: ['certificationId'], load: () => import('./_routes/certifications/[certificationId]/review.js') }"), 'routeur : POST /api/certifications/:id/review enregistre');

/* --- 2. console : sante, veille, couverture, actions --------------------------- */
console.log('\n[2] vue Certifications de la Brand Console');
check(certsView.length > 3000, 'certificationsConsoleView presente et substantielle');
check(!certsView.includes('data-demo-action'), 'aucun bouton data-demo-action dans la vue');
check(/const certNorm = \(c\) =>/.test(consoleHtml), 'normaliseur certNorm (formes API et demo)');
check(/const certHealth = \(c\) =>/.test(consoleHtml), 'derivation de la sante certHealth');
for (const bucket of ['valid', 'expiring', 'expired', 'needsReview']) {
  check(certsView.includes(`health.${bucket}`) || certsView.includes(`'${bucket}'`) || certsView.includes(bucket), `categorie de sante : ${bucket}`);
}
check(/certHealthBadge\(certHealth\(c\)\)/.test(certsView), 'badge de sante rendu par certificat');
check(/bc\('watch\.none'/.test(certsView), 'veille : etat vide explicite');
check(/bc\('watch\.ruleBody'/.test(certsView), 'veille : regle de fonctionnement affichee');
check(/bc\('coverage\.note'/.test(certsView), 'couverture : caractere informatif affiche');
check(/cert-declare-form/.test(certsView), 'formulaire de declaration present');
check(/cert-review-form/.test(consoleHtml), 'formulaire de revue humaine present');
check(/bc\('review\.note'/.test(consoleHtml), 'rappel : la verification est decidee par un humain');
check(/data-action="cert-review"/.test(certsView), 'action revue cablee');
check(/state\.certReview/.test(consoleHtml), 'etat de la ligne de revue gere');
check(/Promise\.allSettled\(\[api\('\/api\/certifications'\), api\('\/api\/catalog\/certification\-standards'\)\]\)/.test(consoleHtml), 'sync : chargement non bloquant certifications + catalogue');
check(/certifications: \[\]/.test(consoleHtml), 'state.certifications initialise vide');
check(/certStandards: \[\]/.test(consoleHtml), 'state.certStandards initialise vide');
check(/id: 'demo\-cert\-1'/.test(consoleHtml), 'donnees de demonstration avec statuts varies');
check(/status: 'expired'/.test(consoleHtml), 'demo : au moins un certificat expire (categorie expired visible)');
check(/'cert-review'\) \{ const id = el\.dataset\.certId/.test(consoleHtml), 'dispatcher : bascule de la ligne de revue');

/* --- 3. vocabulaire preparation -------------------------------------------------- */
console.log('\n[3] vocabulaire preparation, jamais conformite');
check(!/garant\w* (la |de )?conformit/i.test(certsView.replace(/ruleBody/g, '')), 'aucune promesse de conformite dans la vue');
const source = read('scripts/_chantier09_certifications_i18n.json');
check(!/guarantees\b/i.test(source), 'i18n EN : jamais "guarantees" (seule la forme negative "does not guarantee" est presente)');
check(/does not guarantee regulatory compliance/i.test(source), 'i18n EN : rappel explicite readiness-only');
check(/ne promeut jamais un certificat automatiquement/.test(source), 'i18n FR : pas de promotion automatique');
check(/never auto-promotes/.test(source), 'i18n EN : pas de promotion automatique');

/* --- 4. namespace i18n certifications ---------------------------------------------- */
console.log('\n[4] namespace i18n certifications');
const leaves = (o, p = '', out = []) => {
  for (const [k, v] of Object.entries(o)) {
    const key = p ? `${p}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) leaves(v, key, out);
    else out.push(key);
  }
  return out.sort();
};
const get = (o, path) => path.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), o);
const i18nSource = JSON.parse(source);
const langs = Object.keys(i18nSource);
check(langs.length === 7 && langs.includes('en'), 'source : 7 langues dont en');
const refKeys = leaves(i18nSource.en);
check(refKeys.length >= 60, `source : au moins 60 cles certifications (${refKeys.length})`);
for (const lang of langs) {
  check(JSON.stringify(leaves(i18nSource[lang])) === JSON.stringify(refKeys), 'source : parite des cles pour ' + lang);
}
const enJs = read('assets/i18n/en.js');
check(/\n  "?certifications"?\s*:\s*\{/.test(enJs), 'en.js : bloc certifications present (niveau racine)');
check(!/\},,\n/.test(enJs), 'en.js : aucune double virgule');
for (const lang of ['fr', 'de', 'it', 'es', 'nl', 'pt']) {
  const catalog = JSON.parse(read('assets/i18n/' + lang + '.json'));
  const hasAll = refKeys.every((k) => typeof get(catalog, 'certifications.' + k) === 'string');
  check(hasAll, lang + '.json : toutes les cles certifications.* presentes');
}
for (const lang of ['tr', 'zh']) {
  const catalog = JSON.parse(read('assets/i18n/' + lang + '.json'));
  check(!('certifications' in catalog), lang + '.json : namespace certifications exclu (locales partielles)');
}

/* --- 5. generateur ------------------------------------------------------------------ */
console.log('\n[5] generateur build_certifications_i18n.mjs');
const generator = read('scripts/build_certifications_i18n.mjs');
const stripped = generator.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
check(!stripped.includes('(?=\\n') && !stripped.includes('(?=\n'), 'garde de consolidation : aucun lookahead de suppression');
check(/\\n  "certifications"|\\n  certifications/.test(generator), 'test d idempotence ancre au niveau racine');
const i18nFiles = ['assets/i18n/en.js', 'assets/i18n/fr.json', 'assets/i18n/de.json', 'assets/i18n/it.json', 'assets/i18n/es.json', 'assets/i18n/nl.json', 'assets/i18n/pt.json'];
const before = i18nFiles.map(read);
execFileSync(process.execPath, ['scripts/build_certifications_i18n.mjs'], { cwd: ROOT, stdio: 'pipe' });
const after = i18nFiles.map(read);
check(before.every((b, i) => b === after[i]), 'generateur idempotent : aucun fichier modifie au second passage');

/* --- 6. non-regression ----------------------------------------------------------------- */
console.log('\n[6] non-regression');
for (const route of [
  'supplier/certifications.js',
  'supplier/certifications/[certificationId].js',
  'supplier/certifications/ocr-extract.js',
  'supplier/certifications/[certificationId]/auto-verify.js',
  'catalog/certification-standards.js',
  'documents.js',
  'documents/[documentId]/scan.js',
]) {
  check(indexTs.includes(route), `route toujours enregistree : ${route}`);
}
check(/const certJours = \(c\) =>/.test(consoleHtml), 'veille historique certJours conservee');
check(/certsExpiring/.test(consoleHtml), 'Command Center : pilule certifications expirantes conservee');
const detailBlock = consoleHtml.slice(
  consoleHtml.indexOf('function productDetailView()'),
  consoleHtml.indexOf('function supplierDetailView()')
);
check(/data-view="certifications"/.test(detailBlock), 'lentille ch07 : ouverture de la vue certifications conservee');
check(/certHealthBadge\(certHealth\(c\)\)/.test(detailBlock), 'lentille ch07 : forme normalisee + badge de sante');
check(read('README.md').includes('Notification Observability'), 'README : libelle Notification Observability preserve');

console.log(failures ? `\n${failures} verification(s) en echec.` : '\nContrat Certification Intelligence (chantier 09) : OK.');
if (failures) process.exit(1);
