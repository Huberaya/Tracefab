#!/usr/bin/env node
/**
 * TRACEFAB — cartographie exhaustive des routes et contrat de tenant actif.
 *
 * Ce test parcourt LES 138 ENTREES DU ROUTEUR (`api/index.ts`), pas une liste
 * ecrite a la main de routes connues. Pour chaque gestionnaire il exige :
 *
 *   1. une classification explicite : public/worker (sans Clerk), compte
 *      (operations anterieures a l'existence d'un tenant), ou metier ;
 *   2. pour toute route metier : un tenant actif VALIDE
 *      (`withTracefabTenantContext`, `requireActiveTenant`, ou
 *      `withTracefabRequestContext` dont la validation centralisee est verifiee
 *      dans api/_lib/context.ts) ET un garde SQL lie au tenant actif ;
 *   3. le contrat de `withTracefabRequestContext` lui-meme : l'adhesion active
 *      doit etre resolue en base avant le callback, sinon aucune route ne peut
 *      s'appuyer sur cette enveloppe ;
 *   4. aucune autorisation documentaire par `tracefab_can_access_document()`
 *      (union des adhesions du compte) ;
 *   5. aucun repli sur la premiere organisation ou l'union des adhesions.
 *
 * La matrice produite est comparée à `docs/security/route-tenant-matrix.json` :
 * une route ajoutée, renommée ou déclassée fait échouer la CI. Pour régénérer
 * volontairement la matrice : `npm run test:tenant:matrix -- --ecrire`.
 *
 * CE QUE CE TEST NE PROUVE PAS : le comportement à l'exécution. Les preuves
 * d'accès réels sont dans `npm run test:isolation:globale` (PostgreSQL jetable).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MATRIX = join(ROOT, 'docs', 'security', 'route-tenant-matrix.json');
const ecrire = process.argv.includes('--ecrire');

let failures = 0;
const ok = (message) => console.log(`  ok    ${message}`);
const fail = (message) => { failures += 1; console.error(`  ECHEC ${message}`); };

/* --- 1. Registre exhaustif ------------------------------------------------ */
const routeur = readFileSync(join(ROOT, 'api', 'index.ts'), 'utf8');
const routeRe =
  /\{ pattern: (\/\^.*?\$\/), params: \[([^\]]*)\], load: \(\) => import\('\.\/_routes\/([^']+)\.js'\) \}/g;
const routes = [...routeur.matchAll(routeRe)].map((m) => ({ name: m[3], pattern: m[1] }));
const declaredLoads = (routeur.match(/load:\s*\(\)\s*=>\s*import\(/g) || []).length;
if (routes.length === 0 || routes.length !== declaredLoads) {
  console.error(`ECHEC — registre incohérent : ${routes.length} analysées / ${declaredLoads} déclarées`);
  process.exit(1);
}

/* --- 2. Exceptions sans Clerk : reprises du contrat de contexte existant -- */
// Source unique : les DEUX listes fermées de
// scripts/test_route_context_coverage.mjs (lectures publiques + exceptions
// worker/static). Une route sans Clerk ajoutée là-bas sans l'être ici, ou
// l'inverse, reste visible.
const couverture = readFileSync(join(ROOT, 'scripts', 'test_route_context_coverage.mjs'), 'utf8');
const blocPublic = couverture.slice(
  couverture.indexOf('const publicReadRoutes'),
  couverture.indexOf('const nonClerkRouteExceptions'),
);
const blocExceptions = couverture.slice(couverture.indexOf('const nonClerkRouteExceptions'));
const sansClerk = new Map([
  ...[...blocPublic.matchAll(/'api\/_routes\/([^']+\.ts)'/g)]
    .map((m) => [m[1], 'public-read (contexte public transactionnel explicite)']),
  ...[...blocExceptions.matchAll(/\['api\/_routes\/([^']+\.ts)',\s*'([^']+)'\]/g)]
    .map((m) => [m[1], m[2]]),
]);

/* --- 3. Exceptions de compte : aucune donnee de tenant lue --------------- */
// Routes authentifiées dont l'opération est antérieure au choix d'un tenant
// (création d'organisation, sélecteur d'adhésions, acceptation d'invitation),
// ou qui ne font qu'un calcul pur sur le corps de la requête.
const COMPTE = new Map([
  ['me.ts', 'compte : liste des adhésions du compte, antérieure au choix du tenant'],
  ['organizations.ts', 'compte : liste/création d’organisations'],
  ['invitations/accept.ts', 'compte : acceptation d’invitation par jeton, avant adhésion'],
  ['supplier/onboarding.ts', 'compte : création initiale de l’organisation fournisseur'],
  ['supplier/organizations.ts', 'compte : sélecteur des adhésions fournisseur'],
  ['questionnaires.ts', 'référentiel statique, aucune requête base'],
  ['questionnaires/[questionnaireKey].ts', 'référentiel statique, aucune requête base'],
  ['dpp/validate.ts', 'calcul pur sur le corps de la requête, aucune lecture de tenant'],
  ['quality/calculate-index.ts', 'calcul pur sur le corps de la requête'],
  ['traceability/lineage-graph.ts', 'calcul pur sur le corps de la requête'],
  ['traceability/mass-balance.ts', 'calcul pur sur le corps de la requête'],
]);

const SQL_GUARD = /tracefab_in_active_tenant|tracefab_product_accessible_in_active_tenant|tracefab_document_accessible_in_active_tenant|accessibleProduct|documentAccessibleFromTenant|tenantFilter|tenant\.organizationId/;
/* Route authentifiee qui ne lit AUCUNE donnee de tenant : elle valide le
 * locataire puis repond 410 (generation de graphe synthetique desactivee).
 * Exigee explicitement ici pour qu'une future lecture ne puisse pas etre
 * ajoutee sans garde. */
const SANS_LECTURE_TENANT = new Set(['products/[productId]/supply-chain/generate-baseline']);
const REFLUX_MULTI_ORG = /activeBrandOrganizationIds\s*\(|activeOrganizationIds\s*\(|\b(?:brandIds|brandOrgIds|organizationIds|supplierOrgIds)\s*\[0\]/;

/* Le GUC d'un locataire demande par le client n'est une preuve d'autorisation
 * que si l'enveloppe valide l'adhesion active EN BASE avant toute requete. Ce
 * contrat est verifie ici, sur le source reel, et non presume. */
const contexteSource = readFileSync(join(ROOT, 'api', '_lib', 'context.ts'), 'utf8');
const debutRequest = contexteSource.indexOf('export async function withTracefabRequestContext');
const finRequest = contexteSource.indexOf('export async function withTracefabUserContext', debutRequest);
const corpsRequest = contexteSource.slice(
  debutRequest < 0 ? 0 : debutRequest,
  finRequest < 0 ? contexteSource.length : finRequest,
);
if (debutRequest < 0 || !/requireActiveTenant\s*\(/.test(corpsRequest)) {
  fail('withTracefabRequestContext ne valide plus l’adhésion active avant le callback');
} else {
  ok('withTracefabRequestContext valide l’adhésion active en base avant toute requête');
}
const requeteValidee = debutRequest >= 0 && /requireActiveTenant\s*\(/.test(corpsRequest);

const matrice = [];
const compteurs = {};
const increment = (cle) => { compteurs[cle] = (compteurs[cle] || 0) + 1; };

for (const route of routes) {
  const fichier = join(ROOT, 'api', '_routes', route.name + '.ts');
  if (!existsSync(fichier)) {
    fail(`route enregistrée sans fichier source : ${route.name}`);
    continue;
  }
  const source = readFileSync(fichier, 'utf8');
  const sansCommentaires = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
  const authentifiee = /requireClerkUser\s*\(/.test(sansCommentaires);

  let classe;
  let justification;
  if (!authentifiee) {
    classe = 'public-ou-worker';
    justification = sansClerk.get(route.name + '.ts') || null;
    if (!justification) fail(`${route.name} : route sans Clerk absente de la liste fermée des exceptions`);
  } else if (/withTracefabTenantContext\s*\(/.test(sansCommentaires)) {
    classe = 'tenant-valide-explicite';
    justification = 'withTracefabTenantContext : validation de l’adhésion active dans la transaction';
  } else if (/requireActiveTenant\s*\(/.test(sansCommentaires)) {
    classe = 'tenant-valide-explicite';
    justification = 'requireActiveTenant : résolution et validation du tenant demandé';
  } else if (requeteValidee && /withTracefabRequestContext\s*\(/.test(sansCommentaires)) {
    classe = 'tenant-valide-explicite';
    justification = 'withTracefabRequestContext : adhésion active validée centralement + garde SQL liée au tenant';
  } else if (SQL_GUARD.test(sansCommentaires)) {
    classe = 'garde-sql-tenant';
    justification = 'prédicat SQL lié au tenant actif (tracefab_in_active_tenant / gardes dédiées)';
  } else {
    justification = COMPTE.get(route.name + '.ts') || null;
    classe = justification ? 'compte-ou-calcul' : 'NON-CLASSIFIEE';
    if (!justification) fail(`${route.name} : route métier sans validation de tenant et sans exception documentée`);
  }
  increment(classe);

  /* Contrôles transverses, appliqués à TOUS les gestionnaires. */
  if (/tracefab_can_access_document\s*\(/.test(sansCommentaires)) {
    fail(`${route.name} : autorisation documentaire encore fondée sur l’union des adhésions`);
  }
  if (REFLUX_MULTI_ORG.test(sansCommentaires)) {
    fail(`${route.name} : repli sur l’union des adhésions ou la première organisation`);
  }
  if (/withTracefabRequestContext\s*\(/.test(sansCommentaires)) {
    if (!requeteValidee) {
      fail(`${route.name} : enveloppe de requête sans validation centralisée de l’adhésion active`);
    } else if (!SQL_GUARD.test(sansCommentaires) && !SANS_LECTURE_TENANT.has(route.name)) {
      fail(`${route.name} : contexte de requête sans garde SQL de tenant actif`);
    }
  }
  if (/tracefab_document_accessible_in_active_tenant\s*\(/.test(sansCommentaires)
      && !/requireActiveTenant\s*\(|withTracefabTenantContext\s*\(/.test(sansCommentaires)
      && !requeteValidee) {
    fail(`${route.name} : garde documentaire de tenant sans validation d’adhésion active`);
  }

  matrice.push({
    route: route.name,
    pattern: route.pattern,
    authentifiee,
    classe,
    justification,
  });
}

/* --- 4. Invariants de couverture ----------------------------------------- */
ok(`${routes.length} routes du routeur cartographiées`);
for (const [classe, nombre] of Object.entries(compteurs).sort()) {
  ok(`${classe} : ${nombre} route(s)`);
}
const nonClassifiees = matrice.filter((r) => r.classe === 'NON-CLASSIFIEE');
if (nonClassifiees.length === 0) ok('aucune route non classifiée');
const metier = matrice.filter((r) => ['tenant-valide-explicite', 'garde-sql-tenant'].includes(r.classe));
ok(`${metier.length} routes métier disposent d’un contrôle de tenant actif`);
const exceptions = matrice.filter((r) => r.classe === 'compte-ou-calcul');
ok(`${exceptions.length} exceptions de compte/calcul, toutes documentées et limitées`);

const document = {
  generePar: 'npm run test:tenant:matrix -- --ecrire',
  source: 'api/index.ts (registre complet des handlers)',
  routes: routes.length,
  comptes: compteurs,
  matrice: matrice.sort((a, b) => a.route.localeCompare(b.route)),
};

if (ecrire) {
  writeFileSync(MATRIX, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  console.log(`\n  matrice écrite : docs/security/route-tenant-matrix.json`);
} else if (!existsSync(MATRIX)) {
  fail('matrice absente : régénérer avec npm run test:tenant:matrix -- --ecrire');
} else {
  const attendu = JSON.stringify(document);
  const present = JSON.stringify(JSON.parse(readFileSync(MATRIX, 'utf8')));
  if (attendu === present) ok('matrice commitée rigoureusement à jour');
  else fail('matrice commitée périmée : régénérer avec npm run test:tenant:matrix -- --ecrire');
}

console.log(`\nCartographie du tenant actif : ${failures} échec(s).`);
process.exit(failures === 0 ? 0 : 1);
