#!/usr/bin/env node
/* ==========================================================================
   Chantier 08 — Evidence Center : contrat statique.

   Verifie, sans base ni navigateur :
     1. l'API marque dispose d'une liste de documents (GET /api/documents)
        et d'une analyse antivirus (POST /api/documents/:id/scan), gardees
        par organisations de marque actives, enregistrees dans le routeur ;
     2. l'intention d'upload de la marque pointe vers le scan marque
        (et non vers la route fournisseur, qui repondait 404 aux marques) ;
     3. la vue Documents de la Brand Console est reelle : statistiques
        calculees depuis state.documents, table, rapports de verification
        et de securite, telechargement, formulaire d'upload ; tout le
        contenu simule de l'ancienne vue (lignes GOTS/ZDHC/SMETA en dur,
        compteurs 142/48/36/24/34, boutons data-demo-action) a disparu ;
     4. le chargement des documents est branche dans sync() de maniere
        non bloquante, avec donnees de demonstration honnetes ;
     5. le namespace i18n `evidence` existe dans en.js et les six locales
        completes ; generateur idempotent, garde de consolidation respecee ;
     6. non-regression : les routes documents existantes (download,
        security-report, verification-report, verify-ai) et le portail
        fournisseur restent enregistres ; privacy par defaut preservee.
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
const docsView = consoleHtml.slice(
  consoleHtml.indexOf('function documentsConsoleView()'),
  consoleHtml.indexOf('// Jours restants avant echeance')
);

/* --- 1. API marque : liste + scan ------------------------------------------- */
console.log('\n[1] API marque : liste et analyse des documents');
const listRoute = read('api/_routes/documents.ts');
check(/activeBrandOrganizationIds/.test(listRoute), 'liste : garde par organisations de marque actives');
check(/status:\s*\{\s*not:\s*'deleted'\s*\}/.test(listRoute), 'liste : documents supprimes exclus');
check(/_count/.test(listRoute), 'liste : compteurs de liaisons exposes');
const scanRoute = read('api/_routes/documents/[documentId]/scan.ts');
check(/activeBrandOrganizationIds|currentBrand/.test(scanRoute), 'scan marque : garde marque');
check(/scanAndFinalizeDocument/.test(scanRoute), 'scan marque : reutilise la pipeline antivirus commune');
const indexTs = read('api/index.ts');
check(indexTs.includes("{ pattern: /^documents$/, params: [], load: () => import('./_routes/documents.js') }"), 'routeur : GET /api/documents enregistre');
check(indexTs.includes("{ pattern: /^documents\\/([^\\/]+)\\/scan$/, params: ['documentId'], load: () => import('./_routes/documents/[documentId]/scan.js') }"), 'routeur : POST /api/documents/:id/scan enregistre');

/* --- 2. intention d'upload corrigee ------------------------------------------ */
console.log('\n[2] intention d\'upload de la marque');
const uploadIntent = read('api/_routes/documents/upload-intent.ts');
check(uploadIntent.includes('/api/documents/${result.document.id}/scan'), 'next.scan pointe vers le scan marque');
check(!/supplier\/documents\/[^']*scan/.test(uploadIntent), 'next.scan ne pointe plus vers la route fournisseur');
const schema = read('prisma/schema.prisma');
check(/visibility\s+document_visibility\s+@default\(private\)/.test(schema), 'visibilite privee par defaut imposee au niveau schema');

/* --- 3. vue Documents reelle -------------------------------------------------- */
console.log('\n[3] vue Documents de la Brand Console');
check(docsView.length > 2000, 'documentsConsoleView presente et substantielle');
check(!docsView.includes('data-demo-action'), 'aucun bouton data-demo-action dans la vue');
for (const fake of ['TC-2026', 'SGS Textile Testing', 'Intertek Ethical', 'SMETA 4-Pillar', 'OEKO-TEX Standard 100 Certificate']) {
  check(!docsView.includes(fake), `contenu simule supprime : ${fake}`);
}
check(/const docs = \(state\.documents \|\| \[\]\)/.test(docsView), 'table alimentee par state.documents');
check(/stats\s*=\s*\{/.test(docsView) && docsView.includes('docs.filter'), 'statistiques calculees depuis les documents charges');
for (const col of ['table.filename', 'table.kind', 'table.status', 'table.size', 'table.expires', 'table.links', 'table.created']) {
  check(docsView.includes(col), `colonne i18n : ${col}`);
}
check(/data-action="evidence-download"/.test(docsView), 'action telechargement presente');
check(/data-action="evidence-scan"/.test(docsView), 'action analyse antivirus presente');
check(/data-action="evidence-report"/.test(docsView), 'actions rapports verification/securite presentes');
check(/evidence-upload-form/.test(docsView), 'formulaire d\'upload present');
check(/verification-report/.test(consoleHtml) && /security-report/.test(consoleHtml), 'rapports charges via leurs endpoints');
check(/window\.open\(result\.download\.url/.test(consoleHtml), 'telechargement via l URL presignee de l API');

/* --- 4. chargement non bloquant + demo ---------------------------------------- */
console.log('\n[4] sync() et mode demonstration');
check(/Promise\.allSettled\(\[api\('\/api\/documents'\)\]\)/.test(consoleHtml), 'documents charges en allSettled (non bloquant)');
check(/documents: \[\]/.test(consoleHtml), 'state.documents initialise vide');
check(/evidenceDetail: null/.test(consoleHtml), 'state.evidenceDetail initialise');
check(/state\.documents = \[/.test(consoleHtml), 'donnees de demonstration fournies');
check(/demo-evidence-1/.test(consoleHtml), 'identifiants de demonstration stables');
check(/if \(state\.demo\)/.test(consoleHtml.slice(consoleHtml.indexOf('async function uploadEvidence'), consoleHtml.indexOf('async function uploadEvidence') + 3000)), 'upload : chemin demonstration explicite');

/* --- 5. namespace i18n evidence ------------------------------------------------ */
console.log('\n[5] namespace i18n evidence');
const leaves = (o, p = '', out = []) => {
  for (const [k, v] of Object.entries(o)) {
    const key = p ? `${p}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) leaves(v, key, out);
    else out.push(key);
  }
  return out.sort();
};
const get = (o, path) => path.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), o);
const source = JSON.parse(read('scripts/_chantier08_evidence_i18n.json'));
const langs = Object.keys(source);
check(langs.length === 7 && langs.includes('en'), 'source : 7 langues dont en');
const refKeys = leaves(source.en);
check(refKeys.length >= 45, `source : au moins 45 cles evidence (${refKeys.length})`);
for (const lang of langs) {
  check(JSON.stringify(leaves(source[lang])) === JSON.stringify(refKeys), 'source : parite des cles pour ' + lang);
}
const enJs = read('assets/i18n/en.js');
check(/\n  "?evidence"?\s*:\s*\{/.test(enJs), 'en.js : bloc evidence present (niveau racine)');
check(!/\},,\n/.test(enJs), 'en.js : aucune double virgule');
for (const lang of ['fr', 'de', 'it', 'es', 'nl', 'pt']) {
  const catalog = JSON.parse(read('assets/i18n/' + lang + '.json'));
  const hasAll = refKeys.every((k) => typeof get(catalog, 'evidence.' + k) === 'string');
  check(hasAll, lang + '.json : toutes les cles evidence.* presentes');
}
for (const lang of ['tr', 'zh']) {
  check(!existsSync(join(ROOT, `assets/i18n/${lang}.json`)), lang + '.json : locale partielle retiree du produit (chantier 15)');
}

/* --- 6. generateur ------------------------------------------------------------- */
console.log('\n[6] generateur build_evidence_i18n.mjs');
const generator = read('scripts/build_evidence_i18n.mjs');
const stripped = generator.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
check(!stripped.includes('(?=\\n') && !stripped.includes('(?=\n'),
  'garde de consolidation : aucun lookahead de suppression');
check(/\\n  "\?evidence"\?|\\n  evidence/.test(generator), 'test d idempotence ancre au niveau racine (indentation 2 espaces)');
const i18nFiles = ['assets/i18n/en.js', 'assets/i18n/fr.json', 'assets/i18n/de.json', 'assets/i18n/it.json', 'assets/i18n/es.json', 'assets/i18n/nl.json', 'assets/i18n/pt.json'];
const before = i18nFiles.map(read);
execFileSync(process.execPath, ['scripts/build_evidence_i18n.mjs'], { cwd: ROOT, stdio: 'pipe' });
const after = i18nFiles.map(read);
check(before.every((b, i) => b === after[i]), 'generateur idempotent : aucun fichier modifie au second passage');

/* --- 7. non-regression ---------------------------------------------------------- */
console.log('\n[7] non-regression');
check(indexTs.includes("documents/[documentId]/download.js"), 'route download toujours enregistree');
check(indexTs.includes("documents/[documentId]/security-report.js"), 'route security-report toujours enregistree');
check(indexTs.includes("documents/[documentId]/verification-report.js"), 'route verification-report toujours enregistree');
check(indexTs.includes("documents/[documentId]/verify-ai.js"), 'route verify-ai toujours enregistree');
check(indexTs.includes("supplier/documents.js") || indexTs.includes("supplier/documents'"), 'liste documents fournisseur toujours enregistree');
check(indexTs.includes("supplier/documents/[documentId]/scan.js"), 'scan fournisseur toujours enregistre');
check(read('README.md').includes('Notification Observability'), 'README : libelle Notification Observability preserve');
const supplierList = read('api/_routes/supplier/documents.ts');
check(/currentSupplier|supplier/.test(supplierList), 'liste fournisseur : garde fournisseur intacte');
check(!/visibility:\s*'public'/.test(listRoute), 'privacy : pas de bascule vers public par defaut');

/* --- 8. lentille Evidence du detail produit -------------------------------------- */
console.log('\n[8] lentille Evidence du detail produit');
const detailBlock = consoleHtml.slice(
  consoleHtml.indexOf('function productDetailView()'),
  consoleHtml.indexOf('function supplierDetailView()')
);
check(/evidenceDocs/.test(detailBlock), 'lentille : compteur reel depuis state.documents');
check(/data-view="documents"/.test(detailBlock), 'lentille : ouverture du Centre de preuves conservee');
check(!/pil-planned/.test(detailBlock.match(/const evidenceLens[\s\S]*?`;/)?.[0] || ''), 'lentille : plus marquee comme planifiee');

console.log(failures ? `\n${failures} verification(s) en echec.` : '\nContrat Evidence Center (chantier 08) : OK.');
if (failures) process.exit(1);
