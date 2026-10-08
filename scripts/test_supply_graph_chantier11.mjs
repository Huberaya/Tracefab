#!/usr/bin/env node
/* ==========================================================================
   Chantier 11 — Supply Chain Graph & Map : contrat statique.

   Verifie, sans base ni navigateur :
     1. l'API expose les sites geographiques du graphe
        (GET /api/products/:id/supply-chain/map) avec la meme garde que le
        graphe ;
     2. la vue Supply Chain de la Brand Console est reelle : resume depuis
        le calcul serveur, graphe SVG interactif (zoom/pan/filtres),
        selection de noeud vers un dossier (preuve/fournisseur/qualite),
        carte des sites avec flux, table d'etapes reelles, export JSON ;
     3. tout le contenu simule de l ancienne vue est supprime (badge
        ISO 22095 / 98.4 %, echelons codes en dur, table de reconciliation
        massique fictive, resume de repli invente) ;
     4. le namespace i18n `supplyGraph` existe dans en.js et les six
        locales completes ; generateur idempotent ;
     5. non-regression : routes supply-chain et traceability, lentille
        ch07, formulaires d ajout de noeuds/liens.
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
const scBlock = consoleHtml.slice(
  consoleHtml.indexOf('/* Chantier 11'),
  consoleHtml.indexOf('function dppView()')
);
const indexTs = read('api/index.ts');

/* --- 1. API carte ------------------------------------------------------------- */
console.log('\n[1] API : carte des sites du graphe');
const mapRoute = read('api/_routes/products/[productId]/supply-chain/map.ts');
check(/activeBrandOrganizationIds/.test(mapRoute), 'carte : garde par organisations de marque actives');
check(/brand_organization_id: \{ in: brandOrgIds \}/.test(mapRoute), 'carte : le produit doit appartenir a la marque');
check(/JOIN supplier_sites/.test(mapRoute) && /latitude/.test(mapRoute) && /longitude/.test(mapRoute), 'carte : jointure sites avec coordonnees');
check(/DISTINCT/.test(mapRoute), 'carte : pas de doublons');
check(indexTs.includes("{ pattern: /^products\\/([^\\/]+)\\/supply\\-chain\\/map$/, params: ['productId'], load: () => import('./_routes/products/[productId]/supply-chain/map.js') }"), 'routeur : entree map au format litteral');
check(indexTs.indexOf('supply\\-chain\\/map') < indexTs.indexOf("'^products\\/([^\\/]+)\\/supply\\-chain$'".slice(1, -1)), 'routeur : map avant la route graphe generique');

/* --- 2. vue reelle -------------------------------------------------------------- */
console.log('\n[2] vue Supply Chain de la Brand Console');
check(scBlock.length > 5000, 'bloc supply chain present et substantiel');
for (const fake of ['ISO 22095', '98.4', 'tc-echelon', 'Ege Birlik', 'İzmir', 'Identity Preserved', 'MASS RECONCILIATION', 'PROCESS LOSS', 'TC-CU-881294', 'data-demo-action', 'nodeCount: 14', 'documentationRate: 98']) {
  check(!scBlock.includes(fake), `contenu simule supprime : ${fake}`);
}
check(/summary\.documentationRate/.test(scBlock), 'resume : taux de documentation reel du serveur');
check(/summary\.stagesCoveredCount/.test(scBlock), 'resume : etapes couvertes reelles');
check(/summary\.isCompleteChain/.test(scBlock), 'resume : chaine complete affichee quand le moteur le dit');
check(/data-scg-type=/.test(scBlock), 'filtres par type de noeud');
check(/data-scg-documented/.test(scBlock), 'filtre documentes uniquement');
check(/data-scg-zoom=/.test(scBlock) && /data-scg-reset/.test(scBlock), 'controles zoom / reinitialisation');
check(/id="scg-svg"/.test(scBlock) && /scg-viewport/.test(scBlock), 'graphe SVG avec viewport transformable');
check(/data-node-id=/.test(scBlock), 'noeuds selectionnables');
check(/supplyNodeDossier/.test(scBlock), 'dossier de noeud present');
check(/chain-open-evidence/.test(scBlock) && /chain-open-quality/.test(scBlock) && /data-supplier-id-view/.test(scBlock), 'dossier : liens preuve / qualite / fournisseur');
check(/scg-map-svg/.test(scBlock), 'carte SVG des sites');
check(/latitude/.test(scBlock) && /longitude/.test(scBlock), 'carte : projection depuis les coordonnees reelles');
check(/sequence_number/.test(scBlock), 'carte : flux suivant la sequence de la chaine');
check(/SG\('stages\.|sg\('stages\./.test(scBlock) && /SCG_STAGE_ORDER/.test(scBlock), 'table d etapes reelles depuis sc.stages');
check(/sg\('summary\.empty'/.test(scBlock), 'etat vide explicite (aucune chaine)');
check(/sg\('graph\.empty'/.test(scBlock), 'etat vide explicite (filtres)');
check(/sg\('map\.empty'/.test(scBlock), 'etat vide explicite (carte sans coordonnees)');
check(/sg\('map\.noCoords'/.test(scBlock), 'sites sans coordonnes comptes honnetement');
check(/data-action="export-supply-chain"/.test(scBlock), 'export JSON de la chaine');

/* --- 3. cablage ------------------------------------------------------------------- */
console.log('\n[3] chargement et interactivite');
check(/supply\\-chain\/map/.test(consoleHtml) || /supply-chain\/map/.test(consoleHtml), 'loadSupplyChain : carte chargee');
check(/api\(`\/api\/products\/\$\{encodeURIComponent\(productId\)\}\/supply\-chain\/map`\)/.test(consoleHtml), 'endpoint carte appele');
check(/map\.status === 'fulfilled'/.test(consoleHtml), 'carte non bloquante pour la vue');
check(/supplyChainMap: null/.test(consoleHtml) && /chainSelectedNode: null/.test(consoleHtml) && /scgFilters: null/.test(consoleHtml) && /scgView: null/.test(consoleHtml), 'etat initialise');
check(/exportSupplyChain\(\)/.test(consoleHtml) && /downloadTextFile\(`tracefab-supply-chain/.test(consoleHtml), 'export JSON reel (telechargement)');
check(/'export-supply-chain'\) exportSupplyChain\(\)/.test(consoleHtml), 'dispatcher : export');
check(/'chain-open-evidence'\) \{ state\.view = 'documents'/.test(consoleHtml), 'dispatcher : ouverture Evidence Center');
check(/'chain-open-quality'\)/.test(consoleHtml), 'dispatcher : ouverture vue qualite');
check(/addEventListener\('wheel'/.test(consoleHtml) && /addEventListener\('pointerdown'/.test(consoleHtml), 'zoom molette + deplacement au pointeur cables');
check(/scg-node'\)\.forEach/.test(consoleHtml) && /keydown/.test(consoleHtml), 'selection de noeud (clic + clavier)');
check(/latitude: 41\.5337/.test(consoleHtml), 'demo : sites avec coordonnees publiques (Barcelos / Guimaraes)');

/* --- 4. namespace i18n supplyGraph --------------------------------------------------- */
console.log('\n[4] namespace i18n supplyGraph');
const leaves = (o, p = '', out = []) => {
  for (const [k, v] of Object.entries(o)) {
    const key = p ? `${p}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) leaves(v, key, out);
    else out.push(key);
  }
  return out.sort();
};
const get = (o, path) => path.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), o);
const source = JSON.parse(read('scripts/_chantier11_supply_graph_i18n.json'));
const langs = Object.keys(source);
check(langs.length === 7 && langs.includes('en'), 'source : 7 langues dont en');
const refKeys = leaves(source.en);
check(refKeys.length >= 45, `source : au moins 45 cles supplyGraph (${refKeys.length})`);
for (const lang of langs) {
  check(JSON.stringify(leaves(source[lang])) === JSON.stringify(refKeys), 'source : parite des cles pour ' + lang);
}
const enJs = read('assets/i18n/en.js');
check(/\n  "?supplyGraph"?\s*:\s*\{/.test(enJs), 'en.js : bloc supplyGraph present (niveau racine)');
check(!/\},,\n/.test(enJs), 'en.js : aucune double virgule');
for (const lang of ['fr', 'de', 'it', 'es', 'nl', 'pt']) {
  const catalog = JSON.parse(read('assets/i18n/' + lang + '.json'));
  const hasAll = refKeys.every((k) => typeof get(catalog, 'supplyGraph.' + k) === 'string');
  check(hasAll, lang + '.json : toutes les cles supplyGraph.* presentes');
}
for (const lang of ['tr', 'zh']) {
  check(!existsSync(join(ROOT, `assets/i18n/${lang}.json`)), lang + '.json : locale partielle retiree du produit (chantier 15)');
}

/* --- 5. generateur --------------------------------------------------------------------- */
console.log('\n[5] generateur build_supply_graph_i18n.mjs');
const generator = read('scripts/build_supply_graph_i18n.mjs');
const stripped = generator.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
check(!stripped.includes('(?=\\n') && !stripped.includes('(?=\n'), 'garde de consolidation : aucun lookahead de suppression');
check(/\\n  "supplyGraph"|\\n  supplyGraph/.test(generator), 'test d idempotence ancre au niveau racine');
const i18nFiles = ['assets/i18n/en.js', 'assets/i18n/fr.json', 'assets/i18n/de.json', 'assets/i18n/it.json', 'assets/i18n/es.json', 'assets/i18n/nl.json', 'assets/i18n/pt.json'];
const before = i18nFiles.map(read);
execFileSync(process.execPath, ['scripts/build_supply_graph_i18n.mjs'], { cwd: ROOT, stdio: 'pipe' });
const after = i18nFiles.map(read);
check(before.every((b, i) => b === after[i]), 'generateur idempotent : aucun fichier modifie au second passage');

/* --- 6. non-regression --------------------------------------------------------------------- */
console.log('\n[6] non-regression');
for (const route of [
  'supply-chain.js',
  'supply-chain/nodes.js',
  'supply-chain/links.js',
  'supply-chain/generate-baseline.js',
  'supply-chain/nodes/[nodeId].js',
  'supply-chain/links/[linkId].js',
  'traceability/audit-chain.js',
  'traceability/lineage-graph.js',
  'traceability/mass-balance.js',
  'quality/products/[productId]/history.js',
  'certifications.js',
]) {
  check(indexTs.includes(route), `route toujours enregistree : ${route}`);
}
check(consoleHtml.includes('id="chain-node-form"') && consoleHtml.includes('chain-link-form'), 'formulaires ajout noeud/lien conserves');
check(existsSync(join(ROOT, 'assets/design-system/tracefab-supplychain.css')), 'css tracefab-supplychain.css present');
check(consoleHtml.includes('/assets/design-system/tracefab-supplychain.css'), 'css supply chain charge par la console');
const css = read('assets/design-system/tracefab-supplychain.css');
check(/prefers-reduced-motion/.test(css), 'css : respect de prefers-reduced-motion');
check(/@media \(max-width: 720px\)/.test(css), 'css : adaptation mobile');
const detailBlock = consoleHtml.slice(
  consoleHtml.indexOf('function productDetailView()'),
  consoleHtml.indexOf('function supplierDetailView()')
);
check(/supply-chain/.test(detailBlock), 'lentille ch07 : graphe de tracabilite toujours charge');
check(read('README.md').includes('Notification Observability'), 'README : libelle Notification Observability preserve');

console.log(failures ? `\n${failures} verification(s) en echec.` : '\nContrat Supply Chain Graph & Map (chantier 11) : OK.');
if (failures) process.exit(1);
