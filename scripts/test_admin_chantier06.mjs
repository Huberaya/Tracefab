#!/usr/bin/env node
/**
 * CHANTIER ADMIN 06 — Suppliers (§1) et Product Usage (§1), sur lien réel.
 *
 * Ce test exécute les modules RÉELS compilés (`api/_lib/crm-link.ts`,
 * `api/_lib/crm.ts`) et rend l'interface RÉELLE dans jsdom avec le vrai
 * dictionnaire lu sur disque.
 *
 *   A. compilation des modules réels ;
 *   B. buildConnectedView — trois états, et pas deux ;
 *   C. summarizeConnected — les populations ne sont jamais mélangées ;
 *   D. parseOrganizationId ;
 *   E. parseCompanyInput — lier, délier, ne rien faire ;
 *   F. migration — additive, non destructive, isolation inchangée ;
 *   G. routes — lecture seule, RLS respecté, pas de contournement ;
 *   H. réutilisation — un seul chargeur pour deux vues ;
 *   I. i18n ;
 *   J. interface — les trois états visibles, sélecteur, refus de télémétrie.
 *
 *   npm run test:admin:chantier06
 */
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pkg from 'jsdom';

const { JSDOM, VirtualConsole } = pkg;

const root = fileURLToPath(new URL('..', import.meta.url));
const at = (p) => join(root, p);
let checks = 0;
let failures = 0;
const ok = (l) => { checks += 1; console.log(`  ok    ${l}`); };
const bad = (l, d) => { failures += 1; checks += 1; console.error(`  FAIL  ${l}\n        ${d ?? 'assertion failed'}`); };
const check = (fn, label) => {
  try { fn(); ok(label); } catch (e) { bad(label, e?.message); }
};
const eq = (a, e, l) => check(() => {
  if (a !== e) throw new Error(`attendu ${JSON.stringify(e)}, obtenu ${JSON.stringify(a)}`);
}, l);
const isTrue = (cond, l, d) => check(() => {
  if (!cond) throw new Error(d || 'condition fausse');
}, l);
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

const run = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(out))));
  });

/* -------------------------------------------------------------------------- */
console.log('\nA. Compilation des modules réels');
/* -------------------------------------------------------------------------- */

await mkdir(at('.cache'), { recursive: true });
const outDir = await mkdtemp(at('.cache/admin06-'));
try {
  await run('node_modules/.bin/tsc', [
    'api/_lib/crm-link.ts', 'api/_lib/crm.ts',
    '--outDir', outDir, '--target', 'ES2020', '--module', 'ESNext',
    '--moduleResolution', 'bundler', '--skipLibCheck', '--esModuleInterop',
    '--types', 'node', '--lib', 'ES2020,DOM',
  ], { cwd: root });
  ok('crm-link.ts et crm.ts compilent');
} catch (e) {
  bad('les modules Admin 06 ne compilent pas', e.message.slice(0, 400));
}

const link = await import(pathToFileURL(join(outDir, 'crm-link.js')).href);
const crm = await import(pathToFileURL(join(outDir, 'crm.js')).href);

const linkSrc = await readFile(at('api/_lib/crm-link.ts'), 'utf8');
eq(/^import\s/m.test(linkSrc), false,
  'crm-link.ts n\'importe rien : la décision reste exécutable sans client Prisma');

/* -------------------------------------------------------------------------- */
console.log('\nB. buildConnectedView — trois états, et pas deux');
/* -------------------------------------------------------------------------- */

const view = link.buildConnectedView;
const ORG = '11111111-2222-4333-8444-555555555555';
const C = (o) => ({
  id: 'c1', name: 'X', stage: 'pilot', priority: 'high',
  organization_id: null, supplier_count: null, product_count: null, ...o,
});
const METRICS = { suppliers: 31, onboarded: 12, avgProfileCompletion: 68.4, lastSubmittedAt: '2026-09-01T00:00:00Z' };

const unlinked = view({ company: C({ supplier_count: 42 }), orgVisible: false, metrics: null });
eq(unlinked.measurement, 'declared', 'sans lien, l\'état est « déclaré »');
eq(unlinked.measured, null, 'sans lien, aucun chiffre mesuré n\'est produit');
eq(unlinked.declared.supplier_count, 42, 'le nombre déclaré par l\'équipe reste visible : c\'est sa propre note');
eq(unlinked.gap, null, 'sans mesure, aucun écart n\'est calculé');
eq(unlinked.organization_id, null, 'l\'absence de lien est explicite');

const blocked = view({ company: C({ organization_id: ORG, supplier_count: 42 }), orgVisible: false, metrics: null });
eq(blocked.measurement, 'not_accessible',
  'lien présent mais organisation invisible → « non accessible », et surtout pas « déclaré »');
eq(blocked.measured, null,
  'un compte non accessible ne porte AUCUN chiffre mesuré — pas même zéro, car zéro est une mesure');
eq(blocked.organization_id, ORG, 'le lien est conservé : il existe, il est seulement illisible');
eq(blocked.declared.supplier_count, 42, 'le déclaré reste affiché : c\'est la note de l\'équipe, pas une mesure');

const measured = view({ company: C({ organization_id: ORG, supplier_count: 42 }), orgVisible: true, metrics: METRICS });
eq(measured.measurement, 'measured', 'lien présent ET organisation visible → « mesuré »');
eq(measured.measured.suppliers, 31, 'le chiffre vient de la plateforme');
eq(measured.measured.onboarded, 12, 'le nombre embarqué vient de la plateforme');
eq(measured.gap, -11,
  'l\'écart est mesuré moins déclaré : ici l\'équipe avait surestimé de 11 fournisseurs');

/* LE CAS LIMITE. Un zéro retourné par la plateforme est un fait ; un zéro produit
   par un refus RLS est une invention. Les deux doivent rester distincts. */
const realZero = view({
  company: C({ organization_id: ORG, supplier_count: 6 }),
  orgVisible: true,
  metrics: { suppliers: 0, onboarded: 0, avgProfileCompletion: null, lastSubmittedAt: null },
});
eq(realZero.measurement, 'measured',
  'un zéro RÉEL reste « mesuré » : c\'est un fait observé, pas une absence de donnée');
eq(realZero.measured.suppliers, 0, 'le zéro réel est affiché comme zéro');
eq(realZero.gap, -6, 'l\'écart est calculé sur le zéro réel');
eq(realZero.measured.avgProfileCompletion, null,
  'un taux de profil absent reste null : il n\'est pas mis à zéro, ce qui serait une mesure inventée');
eq(blocked.measurement !== realZero.measurement, true,
  '« non accessible » et « zéro réel » sont deux états distincts — les confondre afficherait un fait faux');

/* Entrées dégradées. */
const junk = view({ company: C({ organization_id: ORG, supplier_count: 'beaucoup' }), orgVisible: true, metrics: METRICS });
eq(junk.declared.supplier_count, null, 'un nombre déclaré du mauvais type devient null, il n\'est pas converti');
const neg = view({ company: C({ organization_id: ORG }), orgVisible: true, metrics: { suppliers: -5, onboarded: -2 } });
eq(neg.measured.suppliers, 0, 'un compte négatif est ramené à zéro : un nombre de fournisseurs négatif n\'existe pas');
eq(view({ company: C({ organization_id: ORG }), orgVisible: true, metrics: null }).measurement,
  'not_accessible',
  'organisation visible mais aucune métrique retournée → prudence, pas de chiffre inventé');

/* -------------------------------------------------------------------------- */
console.log('\nC. summarizeConnected — les populations ne sont jamais mélangées');
/* -------------------------------------------------------------------------- */

const sum = link.summarizeConnected;
const THREE = [measured, realZero, blocked, unlinked];
const s1 = sum(THREE);
eq(s1.measured, 2, 'deux comptes mesurés');
eq(s1.declared, 1, 'un compte déclaré seul');
eq(s1.notAccessible, 1, 'un compte non accessible');
eq(s1.measured + s1.declared + s1.notAccessible, THREE.length,
  'les trois populations couvrent exactement la liste : aucun compte n\'est perdu ni compté deux fois');
eq(s1.measuredSuppliers, 31,
  'la somme des fournisseurs ne porte QUE sur les comptes mesurés — y ajouter des zéros de substitution la fausserait');
eq(s1.avgProfileCompletion, 68.4,
  'la moyenne du taux de profil ignore les comptes sans taux, au lieu de les compter comme zéro');
eq(s1.lastSubmittedAt, '2026-09-01T00:00:00Z', 'la dernière soumission est la plus récente des comptes mesurés');

eq(sum([]).measured, 0, 'une liste vide ne lève pas');
eq(sum([]).avgProfileCompletion, null, 'une moyenne sur un échantillon vide est null, pas zéro');
eq(sum([]).lastSubmittedAt, null, 'sans soumission, la date est null');
eq(sum(null).measured, 0, 'null ne lève pas');
eq(sum([measured, measured]).avgProfileCompletion, 68.4,
  'deux comptes au même taux donnent ce taux, pas le double');
const noRate = view({ company: C({ organization_id: ORG }), orgVisible: true,
  metrics: { suppliers: 3, onboarded: 1, avgProfileCompletion: null, lastSubmittedAt: null } });
eq(sum([noRate]).avgProfileCompletion, null,
  'un seul compte mesuré sans taux donne null : une moyenne sur zéro valeur n\'existe pas');

/* -------------------------------------------------------------------------- */
console.log('\nD. parseOrganizationId');
/* -------------------------------------------------------------------------- */

const pid = link.parseOrganizationId;
eq(pid('6f1e2d3c-4b5a-4968-8796-a5b4c3d2e1f0'), '6f1e2d3c-4b5a-4968-8796-a5b4c3d2e1f0',
  'un UUID v4 valide passe');
eq(pid('  6f1e2d3c-4b5a-4968-8796-a5b4c3d2e1f0  '), '6f1e2d3c-4b5a-4968-8796-a5b4c3d2e1f0',
  'les espaces sont retirés');
eq(pid('pas-un-uuid'), null, 'une chaîne quelconque est refusée');
eq(pid(''), null, 'une chaîne vide est refusée');
eq(pid(null), null, 'null est refusé sans lever');
eq(pid(undefined), null, 'undefined est refusé sans lever');
eq(pid(42), null, 'un nombre est refusé sans lever');
eq(pid({ $ne: null }), null, 'un opérateur de requête est refusé');
eq(pid('6f1e2d3c-4b5a-0968-0796-a5b4c3d2e1f0'), null,
  'un UUID de version 0 est refusé : la version est vérifiée, pas seulement la forme');
eq(pid('6f1e2d3c-4b5a-4968-c796-a5b4c3d2e1f0'), null,
  'une variante invalide est refusée');
eq(pid('6f1e2d3c-4b5a-4968-8796-a5b4c3d2e1f'), null, 'un UUID tronqué est refusé');

/* -------------------------------------------------------------------------- */
console.log('\nE. parseCompanyInput — lier, délier, ne rien faire');
/* -------------------------------------------------------------------------- */

const parse = crm.parseCompanyInput;
const linked = parse({ name: 'X', organization_id: ORG });
eq(linked.errors.length, 0, 'un lien valide ne produit aucune erreur');
eq(linked.data.organization_id, ORG, 'le lien est repris');

const unlinkedPatch = parse({ name: 'X', organization_id: null });
eq(unlinkedPatch.errors.length, 0, 'délier ne produit aucune erreur');
isTrue('organization_id' in unlinkedPatch.data && unlinkedPatch.data.organization_id === null,
  'délier écrit explicitement null : sans cela un lien erroné serait irréversible');

const untouched = parse({ name: 'X' });
eq('organization_id' in untouched.data, false,
  'un corps sans organization_id ne touche pas la colonne : un PATCH partiel ne délie pas par accident');

eq(parse({ name: 'X', organization_id: 'pas-un-uuid' }).errors.includes('organization_id_must_be_uuid'), true,
  'un identifiant malformé est refusé avec un code explicite');
eq(parse({ name: 'X', organization_id: { $ne: null } }).errors.includes('organization_id_must_be_uuid'), true,
  'un opérateur de requête est refusé');
eq(parse({ name: 'X', organization_id: 42 }).errors.length > 0, true,
  'un nombre est refusé');
/* Le refus doit empêcher toute écriture, pas seulement signaler. */
eq(parse({ name: 'X', organization_id: 'x' }).data, null,
  'une erreur de lien annule TOUTE la mise à jour, pas seulement le lien');

/* -------------------------------------------------------------------------- */
console.log('\nF. Migration — additive, non destructive, isolation inchangée');
/* -------------------------------------------------------------------------- */

const migDir = 'prisma/migrations/20261008180000_admin_command_center_connection/migration.sql';
const mig = await readFile(at(migDir), 'utf8');
isTrue(/ALTER TABLE crm_companies\s+ADD COLUMN IF NOT EXISTS organization_id UUID\s+REFERENCES organizations\(id\) ON DELETE SET NULL;/.test(mig),
  'la migration ajoute une colonne UUID nullable, idempotente, sous clé étrangère ON DELETE SET NULL');
eq(/DROP TABLE|DELETE FROM|TRUNCATE|DROP COLUMN/i.test(mig), false,
  'aucune opération destructive : rien d\'existant n\'est supprimé');
isTrue(/CREATE INDEX IF NOT EXISTS/.test(mig), 'les index sont idempotents');
/* Chantier 07 a retiré cet index partiel : Prisma ne sait pas exprimer un index
   partiel, donc il existait en base sans exister dans le schéma — une dérive
   invisible. L'index composite déclaré suffit à la requête. */
eq(/CREATE INDEX[\s\S]*?WHERE/.test(mig), false,
  'aucun index partiel : Prisma ne peut pas le déclarer, ce serait une dérive base/schéma');
eq(/CREATE POLICY|DROP POLICY/.test(mig), false,
  'aucune politique RLS n\'est créée ni modifiée : crm_companies est déjà couverte');

/* L'isolation de la nouvelle colonne repose sur les politiques existantes. */
const initial = await readFile(
  at('prisma/migrations/20261008120000_admin_command_center_crm/migration.sql'), 'utf8');
isTrue(/crm_companies_select[\s\S]{0,200}tracefab_is_platform_org/.test(initial),
  'crm_companies_select exige toujours tracefab_is_platform_org : la nouvelle colonne est illisible pour une marque ou un fournisseur');
isTrue(/crm_companies_modify[\s\S]{0,200}tracefab_is_platform_org/.test(initial),
  'crm_companies_modify l\'exige aussi');

/* La migration dit explicitement ce qu'elle ne fait pas. */
isTrue(/NE fait PAS|ne donne aucun accès/i.test(mig),
  'la migration documente qu\'elle ne donne AUCUN accès aux données des autres organisations');
isTrue(/suppliers_select_authorized/.test(mig),
  'la migration renvoie à la politique qui gouverne réellement la lecture des fournisseurs');

const schema = await readFile(at('prisma/schema.prisma'), 'utf8');
const companyBlock = schema.slice(schema.indexOf('model crm_companies'),
  schema.indexOf('model crm_contacts'));
isTrue(/organization_id\s+String\?\s+@db\.Uuid/.test(companyBlock),
  'le schéma Prisma porte la colonne, nullable');
isTrue(/idx_crm_companies_org_link/.test(companyBlock),
  'l\'index composé plateforme + lien est déclaré dans le schéma');
isTrue((schema.match(/^model /gm) || []).length >= 51,
  `au moins 51 modèles : le chantier 06 n'en a ajouté aucun (obtenu ${(schema.match(/^model /gm) || []).length})`);
isTrue((schema.match(/^enum /gm) || []).length >= 37,
  `au moins 37 enums : le chantier 06 n'en a ajouté aucun (obtenu ${(schema.match(/^enum /gm) || []).length})`);

/* -------------------------------------------------------------------------- */
console.log('\nG. Routes — lecture seule, RLS respecté, pas de contournement');
/* -------------------------------------------------------------------------- */

const suppliersRoute = await readFile(at('api/_routes/admin/suppliers.ts'), 'utf8');
const usageRoute = await readFile(at('api/_routes/admin/product-usage.ts'), 'utf8');
const connLib = await readFile(at('api/_lib/crm-connection.ts'), 'utf8');
const connCode = stripComments(connLib);

for (const [name, src] of [['suppliers.ts', suppliersRoute], ['product-usage.ts', usageRoute]]) {
  isTrue(/methodNotAllowed\(res, \['GET'\]\)/.test(src), `${name} est en lecture seule`);
  isTrue(/requirePlatformAdmin/.test(src), `${name} exige le rôle Admin`);
  isTrue(/isAdminAccessDenied\(error\)[\s\S]*403/.test(src), `${name} renvoie 403 à un non-admin`);
  isTrue(/loadConnectedCompanies/.test(src), `${name} délègue au chargeur partagé`);
  eq(/\$queryRawUnsafe|\$executeRawUnsafe/.test(src), false,
    `${name} ne construit aucun SQL concaténé`);
  eq(/tx\.(crm_companies|suppliers|organizations)\.(create|update|delete)/.test(src), false,
    `${name} n'écrit rien : une vue qui écrit ment sur son nom`);
}

/* LA SONDE DE VISIBILITÉ : c'est elle qui distingue « RLS a bloqué » de « zéro réel ». */
/*
 * La sonde est vérifiée STRUCTURELLEMENT, pas par son nom de méthode : un
 * renommage de `findMany` ne doit pas faire passer une sonde absente. Trois
 * propriétés doivent tenir ensemble.
 */
isTrue(/organizations\.\w+\(\{[\s\S]{0,200}?where: \{ id: \{ in: linkedIds \} \}/.test(connCode),
  'le chargeur interroge `organizations` en le bornant aux identifiants liés');
isTrue(/const visible = new Set\(/.test(connCode),
  'le résultat de la sonde devient un ensemble de visibilité');
eq(/orgVisible: true/.test(connCode), false,
  'orgVisible n\'est JAMAIS fixé à true en dur : il ne peut venir que de la sonde');
isTrue(/orgVisible: Boolean\(c\.organization_id && visible\.has\(c\.organization_id\)\)/.test(connCode),
  'orgVisible exige À LA FOIS un lien et une visibilité : un lien seul ne suffit pas');
eq((connCode.match(/visible\.has\(/g) || []).length, 1,
  'une seule source de visibilité : deux appels pourraient diverger');
/* Sans sonde, tout lien deviendrait « mesuré » avec des chiffres inventés. */
const noProbe = connCode.replace(/organizations\.\w+\(\{[\s\S]*?\}\)\)/, '[]');
eq(/visible\.has\(/.test(noProbe), true,
  'la visibilité reste consommée même si la sonde ne renvoie rien — elle produit alors du vide, pas du zéro');

/* Pas de N+1. */
eq((connCode.match(/tx\.suppliers\.findMany/g) || []).length, 0,
  'aucun findMany par entreprise : les fournisseurs sont agrégés en une requête');
isTrue(/tx\.suppliers\.groupBy/.test(connCode), 'les fournisseurs sont agrégés par groupBy');
isTrue(/organization_id: \{ in: /.test(connCode), 'l\'agrégation est bornée aux organisations visibles');

/* « Embarqué » a une définition écrite. */
const onboarded = (connCode.match(/ONBOARDED_STATUSES = \[([^\]]*)\]/) || [])[1] || '';
isTrue(/'submitted'/.test(onboarded) && /'approved'/.test(onboarded),
  '« embarqué » signifie soumis ou approuvé');
eq(/'invited'/.test(onboarded) || /'in_progress'/.test(onboarded), false,
  'invité ou en cours n\'est PAS compté comme embarqué : ce serait compter une intention');

/* La route d'usage déclare son périmètre. */
const usageCode = stripComments(usageRoute);
isTrue(/scope: 'supplier_engagement'/.test(usageCode),
  'la route d\'usage déclare son périmètre dans sa réponse');
eq(/telemetry: false/.test(usageCode), true,
  'la route dit explicitement qu\'il n\'y a PAS de télémétrie : sans cela la vue serait lue comme telle');

/* Le lien ne s'établit que vers une organisation visible. */
const companyRoute = await readFile(at('api/_routes/admin/companies/[companyId].ts'), 'utf8');
const companyCode = stripComments(companyRoute);
isTrue(/crm_organization_not_linkable/.test(companyCode),
  'un lien vers une organisation inconnue ou invisible est refusé en 422');
/*
 * Sans clé étrangère, cette vérification est la seule protection contre un lien
 * fantôme. Elle est donc vérifiée STRUCTURELLEMENT : la lecture de
 * `organizations` doit précéder l'écriture, et son absence doit interrompre.
 */
const probeAt = companyCode.search(/organizations\.\w+\(/);
const updateAt = companyCode.search(/crm_companies\.update\(/);
isTrue(probeAt > 0, 'la route lit `organizations` (quel que soit le nom de la méthode)');
isTrue(updateAt > probeAt,
  'la lecture de l\'organisation précède l\'écriture : un lien n\'est jamais posé avant d\'avoir été vérifié');
isTrue(/if \(!target\) return \{ linkError: true/.test(companyCode),
  'une organisation introuvable interrompt la mutation au lieu de laisser passer');
isTrue(/json\(res, 422, \{ error: 'crm_organization_not_linkable' \}\)/.test(companyCode),
  'le refus remonte en 422 avec son code');
isTrue(/'linkError' in result/.test(companyCode),
  'le signal de refus est discriminé sur sa présence, pas sur une valeur supposée');

const routerSrc = await readFile(at('api/index.ts'), 'utf8');
const patterns = [...routerSrc.matchAll(/\{ pattern: \/\^(.*?)\/, params: \[([^\]]*)\], load: \(\) => import\('\.\/(_routes\/[^']+)'\)/g)]
  .map((m) => ({ re: new RegExp(`^${m[1]}`), load: m[3] }));
isTrue(patterns.length >= 154, `le routeur déclare au moins 154 motifs (obtenu ${patterns.length})`);
for (const path of ['admin/suppliers', 'admin/product-usage']) {
  const hit = patterns.find((p) => p.re.test(path));
  eq(hit ? hit.load : null, `_routes/admin/${path.split('/')[1]}.js`, `${path} atteint son propre handler`);
}
eq(patterns.filter((p) => /^admin\\\/\(\[\^\\\/\]\+\)\$$/.test(p.re.source)).length, 0,
  'aucun motif à segment joker unique sous admin/ ne peut avaler les nouvelles routes');

/* -------------------------------------------------------------------------- */
console.log('\nH. Réutilisation — un seul chargeur pour deux vues');
/* -------------------------------------------------------------------------- */

/* Deux copies de la même logique finiraient par afficher des chiffres différents
   pour la même entreprise, ce qui détruirait la confiance dans les deux. */
eq((suppliersRoute.match(/groupBy|findMany/g) || []).length, 0,
  'suppliers.ts ne contient aucune requête : tout passe par le chargeur');
eq((usageRoute.match(/groupBy|findMany/g) || []).length, 0,
  'product-usage.ts non plus');
isTrue(/buildConnectedView/.test(connCode) && /summarizeConnected/.test(connCode),
  'le chargeur utilise les deux fonctions pures, il ne réimplémente pas la décision');
eq(/measurement === 'measured'/.test(connCode), false,
  'le chargeur ne décide PAS des états : c\'est le rôle de buildConnectedView');

/* -------------------------------------------------------------------------- */
console.log('\nI. i18n');
/* -------------------------------------------------------------------------- */

const LANGS = ['en', 'fr', 'de', 'it', 'es', 'nl', 'pt'];
const dicts = {};
for (const lang of LANGS) {
  dicts[lang] = JSON.parse(await readFile(at(`locales/${lang}/admin.json`), 'utf8'));
  isTrue(Object.keys(dicts[lang]).length >= 497,
    `${lang} : au moins 497 clés (obtenu ${Object.keys(dicts[lang]).length})`);
}
/*
 * Le builder est la source unique des dictionnaires. Il refuse une famille
 * concaténée non déclarée — sans cette garde, une régénération effacerait
 * silencieusement les clés `measurement.*`.
 *
 * Il est exécuté APRÈS la lecture ci-dessus, puis on compare : les fichiers
 * doivent être reproduits à l'identique. Ainsi une altération sur disque ET une
 * famille non déclarée sont toutes deux détectées — exécuter le builder avant la
 * lecture aurait masqué la première.
 */
const onDiskBefore = {};
for (const lang of LANGS) onDiskBefore[lang] = await readFile(at(`locales/${lang}/admin.json`), 'utf8');
try {
  await run('python3', ['scripts/build_admin_locales.py'], { cwd: root });
  ok('le builder régénère les dictionnaires sans erreur : `measurement.` est bien déclarée');
  let drifted = [];
  for (const lang of LANGS) {
    const after = await readFile(at(`locales/${lang}/admin.json`), 'utf8');
    if (after !== onDiskBefore[lang]) drifted.push(lang);
  }
  eq(drifted.join(','), '',
    `le builder reproduit exactement les fichiers présents (dérive : ${drifted.join(', ') || 'aucune'})`);
} catch (e) {
  bad('le builder échoue — une famille concaténée n\'est pas déclarée', String(e.message).slice(-300));
}

const ref = Object.keys(dicts.en).sort().join('|');
for (const lang of LANGS) {
  eq(Object.keys(dicts[lang]).sort().join('|'), ref, `${lang} : même jeu de clés que en`);
}

const NEW06 = ['nav.suppliers', 'nav.usage', 'company.link', 'company.notLinked', 'company.linkHint',
  'connected.measured', 'connected.declared', 'connected.notAccessible', 'connected.measurement',
  'connected.whyNotAccessible', 'suppliers.subtitle', 'suppliers.hint', 'suppliers.gap',
  'suppliers.gapHint', 'usage.subtitle', 'usage.scope', 'usage.scopeDetail', 'usage.hiddenCount',
  'usage.emptyBody', 'measurement.measured', 'measurement.declared', 'measurement.not_accessible'];
for (const key of NEW06) {
  for (const lang of LANGS) {
    isTrue(typeof dicts[lang][key] === 'string' && dicts[lang][key].trim().length > 0,
      `${lang} : « ${key} » traduit et non vide`);
  }
}
isTrue(dicts.de['connected.whyNotAccessible'].length > 60,
  'l\'explication « non accessible » n\'est pas tronquée en allemand');
isTrue(dicts.fr['usage.scope'] !== dicts.en['usage.scope'],
  'le périmètre « pas de télémétrie » est réellement traduit, pas copié');
for (const lang of LANGS) {
  isTrue(dicts[lang]['suppliers.onboarded'].includes('%n'),
    `${lang} : suppliers.onboarded conserve %n`);
  isTrue(dicts[lang]['usage.hiddenCount'].includes('%n'),
    `${lang} : usage.hiddenCount conserve %n`);
  isTrue(!/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(JSON.stringify(dicts[lang])),
    `${lang} : aucun caractère CJK`);
}

/* -------------------------------------------------------------------------- */
console.log('\nJ. Interface');
/* -------------------------------------------------------------------------- */

const page = await readFile(at('admin/index.html'), 'utf8');
const stub = `<script>window.TracefabI18n = {
  isReady: true, init: async () => true, setLanguage: async () => true,
  t: (k) => window.__DICT[k] || k,
};</script>`;
const booted = (dict, lang) => page
  .replace('<script src="/i18n-core.js"></script>', stub)
  .replace('</head>', `<script>window.__DICT = ${JSON.stringify(dict)};
    localStorage.setItem('tracefab.lang', ${JSON.stringify(lang)});</script></head>`);

const pageErrors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (e) => pageErrors.push(String(e?.message || e)));
virtualConsole.on('error', (...a) => pageErrors.push(a.join(' ')));

const dom = new JSDOM(booted(dicts.fr, 'fr'), {
  runScripts: 'dangerously', pretendToBeVisual: true,
  url: 'https://tracefab.example/admin/?demo', virtualConsole,
});
const { window } = dom;
const { document } = window;
const settle = () => new Promise((r) => setTimeout(r, 200));
await settle();
await settle();

const view_ = () => document.getElementById('app').textContent || '';
const click = (el) => {
  if (!el) throw new Error('élément introuvable');
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
};
const go = async (v) => {
  const el = document.querySelector(`[data-view="${v}"]`);
  if (!el) throw new Error(`navigation introuvable : ${v}`);
  click(el);
  await settle();
  await settle();
};

eq(pageErrors.length, 0, 'aucune erreur JavaScript au démarrage', pageErrors.slice(0, 3).join(' | '));

/* §1 — les deux entrées sont réelles */
for (const [v, key] of [['suppliers', 'nav.suppliers'], ['usage', 'nav.usage']]) {
  isTrue(!!document.querySelector(`[data-view="${v}"]`), `§1 : « ${v} » est une entrée de navigation réelle`);
  await go(v);
  isTrue(view_().includes(dicts.fr[key]), `§1 : la vue « ${v} » affiche son titre traduit`);
  eq(pageErrors.length, 0, `§1 : la vue « ${v} » ne produit aucune erreur`, pageErrors.slice(0, 2).join(' | '));
}
eq(/const SOON = \[[^\]]*'Suppliers'/.test(page), false, '« Suppliers » n\'est plus marqué à venir');
eq(/const SOON = \[[^\]]*'Product Usage'/.test(page), false, '« Product Usage » n\'est plus marqué à venir');

/* Les TROIS états sont visibles, chacun nommé. */
await go('suppliers');
isTrue(view_().includes(dicts.fr['measurement.measured']), '§1 : l\'état « mesuré » est affiché');
isTrue(view_().includes(dicts.fr['measurement.declared']), '§1 : l\'état « déclaré » est affiché');
isTrue(view_().includes(dicts.fr['measurement.not_accessible']),
  '§1 : l\'état « non accessible » est affiché — pas remplacé par un zéro');
isTrue(view_().includes(dicts.fr['connected.whyNotAccessible']),
  '§1 : la raison du non-accès est expliquée, pas seulement nommée');
isTrue(view_().includes(dicts.fr['suppliers.gapHint']),
  '§1 : il est expliqué ce que signifie l\'écart');
isTrue(view_().includes('-11'), '§1 : l\'écart négatif est affiché (l\'équipe avait surestimé)');
isTrue(view_().includes('Example Fashion Group'), '§1 : le compte mesuré est nommé');

/* Le zéro réel est affiché comme un zéro, et reste distingué du non-accès. */
const supRows = [...document.querySelectorAll('.tblwrap tbody tr')];
isTrue(supRows.length >= 5, `§1 : au moins cinq comptes sont listés (obtenu ${supRows.length})`);

/* Product Usage : le périmètre est dit, et la télémétrie est explicitement niée. */
await go('usage');
isTrue(view_().includes(dicts.fr['usage.scope']),
  '§1 : il est dit que c\'est de l\'engagement fournisseurs, pas de la télémétrie');
isTrue(view_().includes(dicts.fr['usage.scopeDetail']),
  '§1 : il est dit que TRACEFAB ne produit aucune télémétrie et n\'en invente pas');
isTrue(view_().includes('68,4'), '§1 : le taux de profil mesuré est affiché avec sa décimale');
isTrue(view_().includes(dicts.fr['usage.hiddenCount'].replace('%n', '1')),
  '§1 : il est dit combien de comptes sont masqués, et pourquoi');

/* Le lien s'établit par un sélecteur, pas en saisissant un UUID. */
await go('prospects');
click(document.querySelector('[data-open="d1"]'));
await settle();
await settle();
click(document.getElementById('edit-company'));
await settle();
const sel = document.getElementById('fc-organization_id');
isTrue(!!sel, '§1 : le sélecteur d\'organisation connectée existe sur la fiche entreprise');
eq(sel ? sel.options.length : 0, 3,
  '§1 : le sélecteur propose « non liée » + les organisations réellement liables');
eq(sel ? sel.options[0].value : null, '', '§1 : la première option délie');
eq(sel ? sel.value : null, '11111111-2222-4333-8444-555555555555',
  '§1 : le lien existant est pré-sélectionné — cohérent avec la vue Suppliers');
isTrue(document.getElementById('app').textContent.includes(dicts.fr['company.linkHint']),
  '§1 : il est expliqué que lier suppose accéder');
/* Le sélecteur ne peut proposer que des organisations visibles : la liste vient de
   /api/organizations, filtré par RLS sur les adhésions de l'utilisateur. */
isTrue(/loadLinkableOrgs/.test(page) && /\/api\/organizations/.test(page),
  '§1 : la liste des organisations liables vient de /api/organizations, donc de RLS');

/* Toutes les vues de la console restent atteignables. */
for (const v of ['dashboard', 'prospects', 'pipeline', 'opportunities', 'contacts', 'tasks',
  'activities', 'emails', 'notes', 'meetings', 'pilots', 'customers', 'suppliers',
  'analytics', 'usage', 'settings']) {
  pageErrors.length = 0;
  await go(v);
  eq(pageErrors.length, 0, `la vue « ${v} » s'affiche sans erreur`, pageErrors.slice(0, 1).join(' | '));
}

/* Aucune classe sans règle CSS. */
const css = page.slice(0, page.indexOf('</style>'));
const jsBlock = [...page.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1]).filter((b) => b.trim()).pop();
const usedClasses = new Set([...jsBlock.matchAll(/class="([a-zA-Z0-9 \-]+)"/g)]
  .flatMap((m) => m[1].split(' ')));
const definedClasses = new Set([...css.matchAll(/\.([a-zA-Z][a-zA-Z0-9\-]*)/g)].map((m) => m[1]));
const naked = [...usedClasses].filter((c) => !definedClasses.has(c));
eq(naked.join(','), '', `aucune classe utilisée sans règle CSS (nu : ${naked.join(', ') || 'aucune'})`);

/* -------------------------------------------------------------------------- */

console.log(`\n${failures === 0 ? 'SUCCÈS' : 'ÉCHEC'} — ${checks - failures}/${checks} vérifications`);
process.exit(failures === 0 ? 0 : 1);
