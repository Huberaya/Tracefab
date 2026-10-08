#!/usr/bin/env node
/* ==========================================================================
   Chantier 12 — TRACEFAB Intelligence : contrat statique.

   Verifie, sans base ni navigateur :
     1. l'API expose un moteur de questions DETERMINISTE
        (GET /api/intel/ask) : liste fixe d'intentions, calcul sur les
        certifications / produits / documents du tenant, categories
        epistemiques (known / inferred / missing / needs_review), plafond
        de resultats, garde d'authentification et d'isolation ;
     2. la vue TRACEFAB Intelligence de la Brand Console est reelle :
        intentions cliquables, saisie libre rattachee a une intention ou
        honnetement signalee « non couverte », panneau de reponse avec
        resume, badges de categorie, liens vers les entites sources et
        mention « Based on » avec comptes et horodatage ;
     3. tout le contenu simule de l ancienne vue est supprime (badge
        marketing « zero hallucination », reponse unique codee en dur,
        citations avec fausses empreintes, stubs ne calculant rien) ;
     4. aucun LLM / generation de texte n'est branche (moteur
        deterministe uniquement) ;
     5. le namespace i18n `intelAsk` existe dans en.js et les six
        locales completes ; generateur idempotent ;
     6. non-regression : lentille ch07 (Product Intelligence), registre
        de routes, README.
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
const intelBlock = consoleHtml.slice(
  consoleHtml.indexOf('/* Chantier 12'),
  consoleHtml.indexOf('      function render() {')
);
const indexTs = read('api/index.ts');

/* --- 1. API : moteur de questions deterministe ---------------------------------- */
console.log('\n[1] API : GET /api/intel/ask');
check(existsSync(join(ROOT, 'api/_routes/intel/ask.ts')), 'route : api/_routes/intel/ask.ts existe');
const route = read('api/_routes/intel/ask.ts');
check(/req\.method !== 'GET'/.test(route) && /methodNotAllowed\(res, \['GET'\]\)/.test(route), 'route : GET uniquement');
check(/export default async function handler/.test(route), 'route : handler par defaut exporte');
for (const intent of ['certificates_expiring', 'certificates_expired', 'certifications_needs_review', 'products_missing_data', 'documents_pending', 'evidence_unlinked']) {
  check(route.includes(`'${intent}'`), `route : intention ${intent} declaree`);
}
check(/invalid_intent/.test(route), 'route : intention inconnue rejetee en 400');
check(/Math\.min\(365, Math\.max\(1/.test(route), 'route : fenetre encadree entre 1 et 365 jours');
check(/requireClerkUser\(req\)/.test(route), 'route : authentification Clerk obligatoire');
check(/withTracefabUserContext/.test(route), 'route : contexte utilisateur trace');
check(/activeBrandOrganizationIds/.test(route), 'route : isolation par organisations de marque actives');
check(/brandIds\.length\)?\s*(?:return|\?)/.test(route.replace(/\s+/g, ' ')), 'route : marque sans organisation repond 200 vide');
check(/FINDING_LIMIT = 100/.test(route), 'route : plafond de 100 resultats');
for (const cat of ["'known'", "'inferred'", "'missing'", "'needs_review'"]) {
  check(route.includes(`category: ${cat}`), `route : categorie epistemique ${cat} attribuee`);
}
check(/computedAt: new Date\(\)\.toISOString\(\)/.test(route), 'route : horodatage du calcul retourne');
check(/basedOn/.test(route) && /certifications: 0, products: 0, documents: 0/.test(route), 'route : compteurs « Based on » toujours presents');
check(/isUnauthorized\(error\)/.test(route) && /json\(res, 401/.test(route), 'route : 401 avant toute autre erreur');
check(/sqlBusinessError\(error\)/.test(route), 'route : erreurs metier mappées');
check(/missing_clerk_secret_key/.test(route) && /clerk_not_configured/.test(route), 'route : Clerk non configure signale en 503');

/* --- 2. aucun LLM ---------------------------------------------------------------- */
console.log('\n[2] moteur deterministe : aucun LLM branche');
const routeNoComments = route.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/data_completion/g, '');
for (const llm of ['openai', 'anthropic', 'gpt-', 'claude', 'completion', 'prompt', 'generateText', 'streamText']) {
  check(!routeNoComments.toLowerCase().includes(llm), `route : aucune reference a ${llm}`);
}
check(!/fetch\(/.test(routeNoComments), 'route : aucun appel reseau sortant (calcul local uniquement)');
check(!/Math\.random/.test(routeNoComments), 'route : aucun aleatoire (determinisme)');

/* --- 3. routeur -------------------------------------------------------------------- */
console.log('\n[3] routeur');
check(indexTs.includes("{ pattern: /^intel\\/ask$/, params: [], load: () => import('./_routes/intel/ask.js') }"), 'routeur : entree intel/ask au format litteral');
check(indexTs.indexOf('/^intel\\/ask$/') !== -1 && indexTs.indexOf('/^intel\\/ask$/') < indexTs.indexOf('notification\\-outbox\\/health'), 'routeur : entree intel avant internal/notification-outbox');

/* --- 4. vue reelle dans la Brand Console -------------------------------------------- */
console.log('\n[4] vue TRACEFAB Intelligence (Brand Console)');
check(intelBlock.length > 6000, 'bloc intelligence present et substantiel');
for (const fake of ['ZERO HALLUCINATION', 'AGENTIC', 'iaSuggestions', 'iaVerifiedSynthesis', 'iaResponseTime', 'iaRefArticle', 'iaAnomaly', 'iaCitedProof', 'iaCitedEvidence', 'onclick="askIntel', 'submitIntelQuery', 'intel-query-input', 'state.activeIntelQuery', 'state.activeIntelAnswer']) {
  check(!intelBlock.includes(fake), `contenu simule supprime : ${fake}`);
}
check(!/onclick="askIntel/.test(consoleHtml), 'console : plus aucun onclick inline vers le moteur');
check(!consoleHtml.includes('submitIntelQuery'), 'console : stub submitIntelQuery supprime');
check(!consoleHtml.includes('intel-query-input'), 'console : ancien champ de saisie supprime');
check(/data-action="intel-ask" data-intent=/.test(intelBlock), 'vue : intentions cliquables via data-action');
check(/IA_INTENTS/.test(intelBlock), 'vue : liste d intentions unique cote client');
check(/id="intel-ask-form"/.test(intelBlock), 'vue : formulaire de saisie libre');
check(/iaMatchIntent/.test(intelBlock), 'vue : saisie libre rattachee a une intention par mots-cles');
check(/askIntelQuestion/.test(intelBlock), 'vue : question sans intention repondue honnetement');
check(/notCovered/.test(intelBlock), 'vue : panneau « non couverte » localise');
check(/\/api\/intel\/ask\?intent=/.test(intelBlock), 'vue : appel reel a GET /api/intel/ask');
check(/state\.demo/.test(intelBlock) && /intelDemoAnswer/.test(intelBlock), 'vue : mode demo calcule depuis l etat reel (pas de reponse codee en dur)');
check(/ia\('answer\.basedOn'/.test(intelBlock) && /ia\('sources\.certifications'/.test(intelBlock), 'vue : mention « Based on » avec comptes de sources');
check(/ia\('answer\.computedAt'/.test(intelBlock), 'vue : horodatage du calcul affiche');
check(/ia\('legend\.note'/.test(intelBlock), 'vue : legende Known / Inferred / Missing / Needs review');
check(/iaCategoryBadge\('known'\)/.test(intelBlock) && /iaCategoryBadge\('needs_review'\)/.test(intelBlock), 'vue : badges des quatre categories affiches');
check(/data-view="certifications"/.test(intelBlock) && /data-product-id=/.test(intelBlock) && /data-view="documents"/.test(intelBlock), 'vue : liens profonds vers les entites sources');
check(/intelAsk\./.test(intelBlock), 'vue : namespace i18n intelAsk utilise');
check(/window\.TF_I18N/.test(intelBlock), 'vue : traduction via TF_I18N (aucun texte metier code en dur)');
check(/intelAnswer: null,/.test(consoleHtml) && /intelState: null,/.test(consoleHtml) && /intelLoading: false,/.test(consoleHtml), 'console : etat intel initialise');
check(/action === 'intel-ask'\) askIntelIntent\(el\.dataset\.intent\)/.test(consoleHtml), 'console : dispatcher intel-ask');
check(/getElementById\('intel-ask-form'\)/.test(consoleHtml), 'console : handler submit du formulaire intel');

/* --- 5. namespace i18n intelAsk ------------------------------------------------------ */
console.log('\n[5] namespace i18n intelAsk');
const leaves = (o, p = '', out = []) => {
  for (const [k, v] of Object.entries(o)) {
    const key = p ? `${p}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) leaves(v, key, out);
    else out.push(key);
  }
  return out.sort();
};
const get = (o, path) => path.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), o);
const source = JSON.parse(read('scripts/_chantier12_intel_ask_i18n.json'));
const langs = Object.keys(source);
check(langs.length === 7 && langs.includes('en'), 'source : 7 langues dont en');
const refKeys = leaves(source.en);
check(refKeys.length >= 38, `source : au moins 38 cles intelAsk (${refKeys.length})`);
for (const lang of langs) {
  check(JSON.stringify(leaves(source[lang])) === JSON.stringify(refKeys), 'source : parite des cles pour ' + lang);
}
const enJs = read('assets/i18n/en.js');
check(/\n  "?intelAsk"?\s*:\s*\{/.test(enJs), 'en.js : bloc intelAsk present (niveau racine)');
check(/\n  intel:\s*\{/.test(enJs) || /\n  "intel":\s*\{/.test(enJs), 'en.js : namespace ch07 intel preserve (non-regression)');
check(!/\},,\n/.test(enJs), 'en.js : aucune double virgule');
for (const lang of ['fr', 'de', 'it', 'es', 'nl', 'pt']) {
  const catalog = JSON.parse(read('assets/i18n/' + lang + '.json'));
  const hasAll = refKeys.every((k) => typeof get(catalog, 'intelAsk.' + k) === 'string');
  check(hasAll, lang + '.json : toutes les cles intelAsk.* presentes');
}
for (const lang of ['tr', 'zh']) {
  check(!existsSync(join(ROOT, `assets/i18n/${lang}.json`)), lang + '.json : locale partielle retiree du produit (chantier 15)');
}

/* --- 6. generateur -------------------------------------------------------------------- */
console.log('\n[6] generateur build_intel_ask_i18n.mjs');
const generator = read('scripts/build_intel_ask_i18n.mjs');
const stripped = generator.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
check(!stripped.includes('(?=\\n') && !stripped.includes('(?=\n'), 'garde de consolidation : aucun lookahead de suppression');
check(/\\n  "intelAsk"|\\n  intelAsk/.test(generator), 'test d idempotence ancre au niveau racine');
const i18nFiles = ['assets/i18n/en.js', 'assets/i18n/fr.json', 'assets/i18n/de.json', 'assets/i18n/it.json', 'assets/i18n/es.json', 'assets/i18n/nl.json', 'assets/i18n/pt.json'];
const before = i18nFiles.map(read);
execFileSync(process.execPath, ['scripts/build_intel_ask_i18n.mjs'], { cwd: ROOT, stdio: 'pipe' });
const after = i18nFiles.map(read);
check(before.every((b, i) => b === after[i]), 'generateur idempotent : aucun fichier modifie au second passage');

/* --- 7. non-regression ------------------------------------------------------------------ */
console.log('\n[7] non-regression');
check(read('README.md').includes('Notification Observability'), 'README : libelle Notification Observability preserve');
check(consoleHtml.includes('function productDetailView()'), 'console : fiche produit (lentille ch07) presente');
check(consoleHtml.includes("state.view === 'intelligence' ? intelligenceView()"), 'console : la navigation pointe toujours vers intelligenceView');
check(existsSync(join(ROOT, 'api/_routes/certifications/[certificationId]')), 'API : route certifications (ch09) presente');

console.log(failures ? `\n${failures} verification(s) en echec.` : '\nContrat TRACEFAB Intelligence (chantier 12) : OK.');
if (failures) process.exit(1);
