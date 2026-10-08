#!/usr/bin/env node
/* ==========================================================================
   Chantier 06 — Supplier Portal 2.0 : contrat statique.

   Verifie, sans base ni navigateur :
     1. la feuille de style tracefab-portal2.css porte les classes sp2-…
        (taches, onboarding, partages) avec mobile-first et
        prefers-reduced-motion ;
     2. l'overview du portail embarque le dashboard « WHAT DO I NEED TO
        DO? » : taches derivees de l etat (retards, echeances, CAP,
        certifications expirantes, point faible du profil), aucune donnee
        inventee, anciens replis factices (|| 4, || 82) supprimes ;
     3. l onboarding guide 9 etapes existe, chaque etape etant derivee de
        l etat reel (profil, sites, matieres, certifications, preuves,
        equipe, demandes, passeport), et l onboarding historique
        (selfOnboardingView) reste intact ;
     4. la vue des partages de donnees par marque lit state.shares (deja
        charge depuis /api/supplier/shares) sans rien inventer ;
     5. le namespace i18n `portal2` existe dans en.js et les six locales
        completes, paritaire avec la source du chantier ;
     6. le generateur build_portal2_i18n.mjs est idempotent et respecte la
        garde de consolidation.
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

const portal = read('supplier-portal/index.html');

/* --- 1. feuille de style --------------------------------------------------- */
console.log('\n[1] assets/design-system/tracefab-portal2.css');
check(existsSync(join(ROOT, 'assets/design-system/tracefab-portal2.css')), 'fichier present');
const css = read('assets/design-system/tracefab-portal2.css');
for (const cls of ['.sp2-todo', '.sp2-task', '.sp2-steps', '.sp2-step', '.sp2-onb-progress', '.sp2-shares', '.sp2-share', '.sp2-empty']) {
  check(css.includes(cls), 'classe ' + cls + ' definie');
}
check(/@media \(max-width: 720px\)/.test(css), 'adaptation mobile-first');
check(/prefers-reduced-motion/.test(css), 'respect de prefers-reduced-motion');

/* --- 2. dashboard WHAT DO I NEED TO DO -------------------------------------- */
console.log('\n[2] dashboard de taches');
check(portal.includes('/assets/design-system/tracefab-portal2.css'), 'css portal2 charge');
check(/function todoTasks\(\)/.test(portal), 'fonction todoTasks presente');
check(/\$\{todoSection\(\)\}/.test(portal), 'todoSection inseree dans l overview');
check(portal.includes("openRequests().forEach"), 'taches derivees des demandes reelles');
check(portal.includes("(state.caps || []).forEach"), 'CAP derives de state.caps');
check(portal.includes("certification.expiresAt"), 'certifications expirantes derivees de state.certifications');
check(portal.includes("spDimensions()"), 'point faible derive des dimensions reelles du profil');
check(portal.includes("data-request-id=\"${esc(task.id)}\""), 'taches demande cliquables (ouverture reelle)');
check(portal.includes("data-view=\"${esc(task.view)}\""), 'taches hors demande cliquables (navigation)');
check(!portal.includes("state.shares?.length || 4"), 'repli factice || 4 supprime du KPI partages');
check(!portal.includes("state.profile?.profileCompletion || 82"), 'repli factice || 82 supprime');
check(/p2t\('todo\.empty'/.test(portal), 'etat vide quand rien a faire');

/* --- 3. onboarding guide 9 etapes -------------------------------------------- */
console.log('\n[3] onboarding guide');
check(/function onboardingSteps\(\)/.test(portal), 'fonction onboardingSteps presente');
check(/function onboardingView\(\)/.test(portal), 'vue onboarding presente');
const stepsBlock = portal.slice(portal.indexOf('function onboardingSteps()'), portal.indexOf('function onboardingView()'));
check((stepsBlock.match(/p2t\('onb\.step\d',/g) || []).length === 9, 'exactement 9 etapes referencees');
check(/Number\(p\.profileCompletion\) >= 80/.test(stepsBlock), 'etape 1 derivee de profileCompletion');
check(/\(state\.sites \|\| \[\]\)\.length > 0/.test(stepsBlock), 'etape sites derivee de state.sites');
check(/\(state\.certifications \|\| \[\]\)\.length > 0/.test(stepsBlock), 'etape certifications derivee');
check(/\(state\.documents \|\| \[\]\)\.length > 0/.test(stepsBlock), 'etape preuves derivee de state.documents');
check(/\(state\.members \|\| \[\]\)\.length > 1/.test(stepsBlock), 'etape equipe derivee de state.members');
check(/state\.passport && \(state\.passport\.headline \|\| state\.passport\.isPublic\)/.test(stepsBlock), 'etape passeport derivee de state.passport');
check(/onboardingView\(\)/.test(portal) && /state\.view === 'onboarding'/.test(portal), 'vue onboarding cablee au rendu');
check(portal.includes("navButton('onboarding'"), 'entree navigation onboarding');

/* onboarding historique intact (contrat chantier 6 backend) */
check(portal.includes("state.view = 'selfOnboarding'"), 'selfOnboarding toujours declenche');
check(portal.includes('selfOnboardingView('), 'selfOnboardingView intacte');
check(portal.includes('id="self-onboarding-form"'), 'formulaire self-onboarding-form intact');
check(portal.includes('submitSelfOnboarding('), 'submitSelfOnboarding intacte');
check(portal.includes('/api/supplier/onboarding'), 'appel /api/supplier/onboarding intact');

/* --- 4. partages par marque ----------------------------------------------------- */
console.log('\n[4] partages de donnees par marque');
check(/function sharesView\(\)/.test(portal), 'vue partages presente');
check(/state\.view === 'shares'/.test(portal), 'vue shares cablee au rendu');
check(portal.includes("navButton('shares'"), 'entree navigation shares');
check(portal.includes('state.shares || []'), 'lecture exclusive de state.shares (charge depuis /api/supplier/shares)');
check(portal.includes("Object.keys(share.scope)"), 'perimetre du partage montre depuis le scope reel');
check(/p2t\('shares\.empty'/.test(portal), 'etat vide gere');
check(/p2t\('shares\.intro'/.test(portal), 'honnetete : octroi/revocation expliques cote marque');
check(!/api\('\/api\/supplier\/shares', \{ method: ?'DELETE'/.test(portal), 'aucune revocation inventee (pas de DELETE dans l API)');

/* --- 5. i18n ------------------------------------------------------------------------ */
console.log('\n[5] namespace i18n portal2');
const leaves = (o, p = '', out = []) => {
  for (const [k, v] of Object.entries(o)) {
    const key = p ? `${p}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) leaves(v, key, out);
    else out.push(key);
  }
  return out.sort();
};
const get = (o, path) => path.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), o);

const source = JSON.parse(read('scripts/_chantier06_portal2_i18n.json'));
const langs = Object.keys(source);
check(langs.length === 7 && langs.includes('en'), 'source : 7 langues dont en');
const refKeys = leaves(source.en);
check(refKeys.length === 47, 'source : 47 cles portal2 (' + refKeys.length + ')');
for (const lang of langs) {
  check(JSON.stringify(leaves(source[lang])) === JSON.stringify(refKeys), 'source : parite des cles pour ' + lang);
}
const enJs = read('assets/i18n/en.js');
check(/\n\s*"?portal2"?\s*:\s*\{/.test(enJs), 'en.js : bloc portal2 present');
for (const lang of ['fr', 'de', 'it', 'es', 'nl', 'pt']) {
  const catalog = JSON.parse(read('assets/i18n/' + lang + '.json'));
  const hasAll = refKeys.every((k) => typeof get(catalog, 'portal2.' + k) === 'string');
  check(hasAll, lang + '.json : toutes les cles portal2.* presentes');
}
for (const lang of ['tr', 'zh']) {
  check(!existsSync(join(ROOT, `assets/i18n/${lang}.json`)),
    lang + '.json : locale partielle retiree du produit (chantier 15)');
}

/* --- 6. generateur --------------------------------------------------------------------- */
console.log('\n[6] generateur build_portal2_i18n.mjs');
const generator = read('scripts/build_portal2_i18n.mjs');
const stripped = generator.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
check(!stripped.includes('(?=\\n') && !stripped.includes('(?=\n'),
  'garde de consolidation : aucun lookahead de suppression (?=\\n\\};)');
const i18nFiles = ['assets/i18n/en.js', 'assets/i18n/fr.json', 'assets/i18n/de.json', 'assets/i18n/it.json', 'assets/i18n/es.json', 'assets/i18n/nl.json', 'assets/i18n/pt.json'];
const before = i18nFiles.map(read);
execFileSync(process.execPath, ['scripts/build_portal2_i18n.mjs'], { cwd: ROOT, stdio: 'pipe' });
const after = i18nFiles.map(read);
check(JSON.stringify(before) === JSON.stringify(after), 'generateur idempotent (seconde execution sans effet)');

/* --- resultat ------------------------------------------------------------------------------ */
console.log('');
if (failures) {
  console.error('Contrat Chantier 06 (Supplier Portal 2.0) : ' + failures + ' verification(s) en echec.');
  process.exit(1);
}
console.log('Contrat Chantier 06 (Supplier Portal 2.0) : toutes les verifications passent.');
