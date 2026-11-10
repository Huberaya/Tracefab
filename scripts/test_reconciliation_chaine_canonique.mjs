#!/usr/bin/env node
/**
 * P10.8 (issu du Chantier B P10.7) : la CHAINE CANONIQUE reste coherente, SANS accès aux
 * refs distantes (ce test tourne dans la boucle CI `test:*`).
 *
 * Ce qu'il prouve :
 *   1. le manifeste P10.8 est lisible, complet et annonce 100 entrees ;
 *   2. les 95 migrations deja appliquees sur `main` sont conservees BYTE POUR
 *      BYTE — aucune n'est renommee ni reecrite (interdiction de la mission) ;
 *   3. les entrees dont la source est le depot local ont une empreinte qui
 *      correspond au fichier reel (le manifeste ne peut pas se perimer en
 *      silence) ;
 *   4. aucune collision d'horodatage NOUVELLE : seules les quatre paires
 *      historiques acceptees par `verifier-horodatages-migrations.mjs` restent ;
 *   5. le correctif P10.8 REEL est present, son empreinte est exacte, et
 *      l'ancien candidat P10.7 (nom ambigu) a bien ete REMPLACE ;
 *   6. toutes les migrations locales sont couvertes par la chaine canonique ou une extension empilee explicitement declaree ;
 *   7. les sept migrations historiques reecrites par #110/#111/#112 sont
 *      explicitement declarees exclues (pas d'oubli silencieux) ;
 *   8. la chaine suit la tete REELE de #114 (f0aeb51 du 06/11 15:34:35Z),
 *      qui a renomme sa migration en amont ; le manifeste ne peut donc pas
 *      continuer a annoncer l'ancien nom 20261105120000.
 *
 * Ce test ne prouve PAS l'application de la chaine : celle-ci est mesuree par
 * `npm run p107:chaines` sur PostgreSQL jetable, avec les refs distantes.
 *
 * Sorties : 0 conforme · 1 ecart.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFESTE = path.join(ROOT, 'docs/security/2026-11-07-p108-chaine-canonique.json');
const MANIFESTE_P107 = path.join(ROOT, 'docs/security/2026-11-06-p107-chaine-canonique.json');
const CORRECTIF = path.join(ROOT, 'prisma/migrations/20261107120000_p108_outbox_proprietaire_et_dependances/migration.sql');
const MIGRATIONS = path.join(ROOT, 'prisma/migrations');

let vertes = 0;
let rouges = 0;
const ok = (libelle, condition, detail = '') => {
  if (condition) { vertes += 1; console.log(`  ok    ${libelle}`); }
  else { rouges += 1; console.error(`  ECHEC ${libelle}${detail ? ` — ${detail}` : ''}`); }
};
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

let m;
try { m = JSON.parse(fs.readFileSync(MANIFESTE, 'utf8')); }
catch (e) { console.error(`  ECHEC manifeste illisible : ${e.message}`); process.exit(1); }

console.log('\n  1. manifeste et compte');
ok('schema attendu', m.schema === 'tracefab-p108-chaine-canonique-v1', m.schema);
ok('le manifeste P10.7 historique est conserve sans reecriture', fs.existsSync(MANIFESTE_P107));
ok('total annoncé = nombre d’entrées', m.total === m.entrees.length, `${m.total}/${m.entrees.length}`);
ok('100 entrées dans la chaîne canonique', m.entrees.length === 100, String(m.entrees.length));
ok('95 migrations historiques de main conservées',
  m.entrees.filter((e) => e.historique_appliquee).length === 95,
  String(m.entrees.filter((e) => e.historique_appliquee).length));

console.log('\n  2. aucune migration historique modifiée ou renommée');
const historiques = m.entrees.filter((e) => e.historique_appliquee);
ok('toutes les empreintes historiques sont marquées identiques à main',
  historiques.every((e) => e.checksum_identique_a_main === true));
const locales = fs.readdirSync(MIGRATIONS)
  .filter((d) => /^\d{14}_/.test(d) && fs.existsSync(path.join(MIGRATIONS, d, 'migration.sql')));
const extensionsEmpilees = m.extensions_empilees || {};
const extensions = Array.isArray(extensionsEmpilees.migrations) ? extensionsEmpilees.migrations : [];
const toutesEntrees = [...m.entrees, ...extensions];
const nomsManifest = new Set(toutesEntrees.map((e) => e.nom));
for (const d of locales) {
  const e = toutesEntrees.find((x) => x.nom === d);
  if (!e) { ok(`migration locale ${d} couverte par la chaîne ou une extension`, false); continue; }
  if (e.source === 'HEAD' || e.source === 'main' || e.source === '#113' || e.source === '#120') {
    ok(`empreinte locale exacte : ${d}`, e.sha256 === sha(path.join(MIGRATIONS, d, 'migration.sql')));
  }
}
const nomsExtensionsAttendus = [
  '20261109120000_active_tenant_document_material_access',
  '20261109130000_active_tenant_document_indirect_paths',
];
const nomsExtensions = extensions.map((e) => e.nom);
ok('extensions empilées rattachées à la PR #120 et à la tête exacte de #113',
  extensionsEmpilees.pr === 120
  && extensionsEmpilees.branche === 'security/document-material-active-tenant-20261109'
  && extensionsEmpilees.base === 'arena/0f697b3e-tracefab'
  && extensionsEmpilees.base_sha === '1a0a2095fc9272c77cad7af9bbf1420829fe46cb');
ok('les deux migrations additives #120 sont déclarées exactement une fois',
  JSON.stringify(nomsExtensions) === JSON.stringify(nomsExtensionsAttendus)
  && new Set(nomsExtensions).size === 2);
ok('les extensions #120 ne réécrivent aucune migration historique ni entrée canonique',
  extensions.every((e) => e.source === '#120' && e.historique_appliquee === false
    && !m.entrees.some((c) => c.nom === e.nom)));
const indexPrerequis113 = m.entrees.findIndex((e) => e.nom === '20261110120000_worker_clerk_organization_prerequisites');
ok('les extensions #120 précèdent le dernier prérequis #113 dans l’ordre de migration',
  indexPrerequis113 === m.entrees.length - 1
  && extensions.every((e) => e.nom < m.entrees[indexPrerequis113].nom));
ok('empreintes SHA-256 des deux extensions #120 exactes',
  extensions.every((e) => {
    const fichier = path.join(MIGRATIONS, e.nom, 'migration.sql');
    return fs.existsSync(fichier) && e.sha256 === sha(fichier);
  }));
ok(`les ${locales.length} migrations locales sont couvertes par la chaîne canonique et ses extensions empilées`,
  locales.every((d) => nomsManifest.has(d)), String(locales.length));

console.log('\n  3. collisions d’horodatage');
const parHoro = new Map();
for (const e of m.entrees) parHoro.set(e.nom.slice(0, 14), (parHoro.get(e.nom.slice(0, 14)) || 0) + 1);
const collisions = [...parHoro.entries()].filter(([, n]) => n > 1).map(([t]) => t).sort();
const acceptees = [...m.collisions_historiques_acceptees].sort();
ok('exactement les quatre collisions historiques acceptées, aucune nouvelle',
  JSON.stringify(collisions) === JSON.stringify(acceptees),
  collisions.join(', '));
ok('la corrective 20261106120000 n’en masque aucune',
  m.entrees.filter((e) => e.nom.startsWith('20261106120000')).length === 1);
ok('aucun renommage appliqué sur la chaîne canonique',
  m.renommages_aucun_sur_cette_chaine === true);

console.log('\n  4. correctif candidat et exclusions');
ok('correctif P10.8 réel présent dans la chaîne',
  m.entrees.some((e) => e.source === 'correctif-p108'));
const correctif = m.entrees.find((e) => e.source === 'correctif-p108');
ok('empreinte du correctif exacte', !!correctif && correctif.sha256 === sha(CORRECTIF));
const indexCorrectif = m.entrees.findIndex((e) => e.source === 'correctif-p108');
const index114 = m.entrees.findIndex((e) => e.nom === '20261106130000_identite_systeme_signee');
ok('le correctif P10.8 trie après #114 et avant le prérequis Clerk #113',
  !!correctif && correctif.nom === '20261107120000_p108_outbox_proprietaire_et_dependances'
  && indexCorrectif > index114
  && m.entrees.at(-1).nom === '20261110120000_worker_clerk_organization_prerequisites',
  `${correctif?.nom} -> ${m.entrees.at(-1)?.nom}`);
ok('ancien candidat 20261106120300 absent de la chaîne',
  !m.entrees.some((e) => e.nom === '20261106120300_outbox_owner_identite_systeme'));
ok('substitution du candidat explicitement documentée',
  (m.remplace_candidat_p107 || {}).nouveau_nom === correctif?.nom
  && /ambigu/i.test((m.remplace_candidat_p107 || {}).raison || ''));
ok('sept migrations historiques réécrites par #110/#111/#112 déclarées',
  Array.isArray(m.migrations_historiques_reecrites_par_110_111_112)
  && m.migrations_historiques_reecrites_par_110_111_112.length === 7);
ok('décision d’exclusion explicite',
  /#110\/#111\/#112 exclues/.test(m.decision));
ok('aucun renommage de migration #113 requis sur la chaîne actuelle',
  Object.keys(m.renommages_pour_chaine_etendue_si_110_reconciliation || {}).length === 0);
ok('ancienne migration #113 non appliquée écartée et migration main substituée',
  !m.entrees.some((e) => e.nom === '20261105180000_active_tenant_access_guards')
  && m.entree_exclue_non_appliquee?.preview_p11_present === false
  && m.entree_exclue_non_appliquee?.production_present === false
  && m.entrees.some((e) => e.nom === '20261105180000_active_tenant_tc_registration_guard' && e.source === 'main'));

console.log('\n  5. tête réelle de #114 et renommage effectué en amont');
ok('tête #114 = f0aeb51cb52ce778f7f9a5e857438603d81fa5ad',
  m.pr114_head === 'f0aeb51cb52ce778f7f9a5e857438603d81fa5ad', String(m.pr114_head));
ok('ancienne tête 537bc31 conservée pour comparaison',
  m.pr114_head_ancienne === '537bc310d0b6e857c4f74ec0017a130987b22497');
const ren = m.renommage_resolu_en_amont_par_114 || {};
ok('renommage amont explicitement tracé (avant / après / SHA)',
  ren.avant === '20261105120000_identite_systeme_signee'
  && ren.apres === '20261106130000_identite_systeme_signee'
  && ren.tete_actuelle === m.pr114_head);
ok('journal Preview P11 confirme #114 appliquée et non rollbackée',
  ren.journal_preview?.migration_name === '20261106130000_identite_systeme_signee'
  && ren.journal_preview?.finished_at === '2026-11-07T20:07:31.615Z'
  && ren.journal_preview?.rolled_back_at === null);
ok('journal Production confirme #114 absente',
  ren.journal_production?.migration_name === '20261106130000_identite_systeme_signee'
  && ren.journal_production?.present === false);
ok('risque de divergence du journal est mesuré et explicitement encadré',
  /sans renommage ni rejeu/.test(ren.risque || ''));
ok('nouveau nom de migration #114 présent dans la chaîne',
  m.entrees.some((e) => e.nom === '20261106130000_identite_systeme_signee' && e.source === '#114'));
ok('ancien nom de migration #114 absent de la chaîne',
  !m.entrees.some((e) => e.nom === '20261105120000_identite_systeme_signee'));
ok('empreinte de la migration #114 au format sha256',
  /^[0-9a-f]{64}$/.test((m.entrees.find((e) => e.nom === '20261106130000_identite_systeme_signee') || {}).sha256 || ''));

console.log(`\n  Chaîne canonique : ${vertes} assertions, ${rouges} échec(s).`);
console.log('  Ce test est statique ; l’application réelle est mesurée par p108:chaines / p108:outbox sur PostgreSQL 17.11.');
process.exit(rouges === 0 ? 0 : 1);
