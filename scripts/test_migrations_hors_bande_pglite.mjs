#!/usr/bin/env node
/**
 * Les cinq migrations appliquees HORS BANDE : deux chemins, mesures, compares.
 *
 * POURQUOI CE TEST EXISTE
 *
 * La production porte cinq migrations dont `applied_steps_count = 0` alors que
 * `finished_at` est renseigne (docs/security/2026-10-28-tour26-...md §4). Elles
 * ont ete executees non par `prisma migrate deploy` mais par cinq scripts
 * `scripts/apply_migration_chantier*.mjs` qui lisent le `migration.sql` et
 * l'executent instruction par instruction.
 *
 * Jusqu'ici, l'argument etait : « le SQL est le meme fichier, donc le schema
 * doit etre equivalent ». C'est une DEDUCTION, pas une mesure. Deux choses ne
 * sont pas deduites par « meme fichier » :
 *
 *   1. ATOMICITE — Prisma joue chaque migration dans une transaction ; les
 *      lanceurs executent chaque instruction en autocommit. Une erreur en
 *      milieu de fichier laisse donc un etat PARTIEL dans un cas et RIEN dans
 *      l'autre. Ce test le mesure au lieu de l'affirmer.
 *   2. DECOUPAGE — les lanceurs embarquent leur propre decoupeur SQL (respect
 *      des blocs `$$`, saut des lignes de commentaire). Un decoupeur n'est pas
 *      un analyseur : s'il coupe mal, les objets different.
 *
 * CE QUI EST MESURE
 *
 *   base A : la chaine complete SANS les cinq migrations (l'etat que laisserait
 *            `applied_steps_count = 0` pris au pied de la lettre) ;
 *   base B : A + les cinq, via le chemin « Prisma » (une transaction/fichier) ;
 *   base C : A + les cinq, via le chemin « lanceur » (instruction par
 *            instruction, autocommit, decoupeur copie du lanceur).
 *
 * On compare les catalogues : tables, colonnes, types, contraintes, index,
 * politiques RLS (roles, commande, USING, WITH CHECK), declencheurs, fonctions
 * (SECURITY DEFINER, `search_path`, proprietaire, `EXECUTE` de `tracefab_app`
 * et de PUBLIC), `relrowsecurity`/`relforcerowsecurity`.
 *
 * CE QUI N'EST PAS PROUVE
 *
 * L'etat reel de la production. Ce test prouve que les DEUX CHEMINS produisent
 * le meme schema a partir du depot, et que l'ecart entre « cinq appliquees » et
 * « cinq non appliquees » n'est pas cosmetique. Il ne dit pas dans quel etat la
 * production se trouve : cela demande une lecture de son catalogue.
 *
 *   npm run test:migrations:hors-bande
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = path.join(root, 'prisma/migrations');

let PGlite, pgcrypto, uuid_ossp;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  ({ pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto'));
  ({ uuid_ossp } = await import('@electric-sql/pglite/contrib/uuid_ossp'));
} catch {
  console.error('ECHEC  @electric-sql/pglite introuvable — executer `npm ci`.');
  process.exit(1);
}

let echecs = 0;
let verifies = 0;
const ok = (libelle, condition, detail = '') => {
  verifies += 1;
  if (condition) { console.log(`  ok    ${libelle}`); return; }
  echecs += 1;
  console.error(`  ECHEC ${libelle}${detail ? ` — ${detail}` : ''}`);
};

/* ==========================================================================
   Les cinq cibles, et le lanceur qui a servi a les appliquer hors bande
   ========================================================================== */

const CIBLES = [
  ['20261006220000_esg_pef_footprint_engine', 'scripts/test_pef_chantier3.mjs'],
  ['20261006230000_green_claims_anti_greenwashing_engine', 'scripts/test_green_claims_chantier4.mjs'],
  ['20261006240000_quality_corrective_action_plans_cap', 'scripts/test_quality_cap_chantier5.mjs'],
  ['20261006250000_universal_supplier_passport', 'scripts/apply_migration_chantier6_passport.mjs'],
  ['20261006260000_mass_balance_anti_fraud_engine', 'scripts/apply_migration_chantier7_mass_balance.mjs'],
];

const dossiers = fs.readdirSync(MIGRATIONS).filter((d) => /^\d{14}_/.test(d)).sort();
const lire = (d) => fs.readFileSync(path.join(MIGRATIONS, d, 'migration.sql'), 'utf8');
const estCible = (d) => CIBLES.some(([c]) => c === d);

async function nouvelleBase() {
  const db = new PGlite({ extensions: { pgcrypto, uuid_ossp } });
  await db.waitReady;
  await db.exec(`
    CREATE ROLE tracefab_app LOGIN PASSWORD 'runtime' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
    GRANT USAGE ON SCHEMA public TO tracefab_app;
  `);
  return db;
}

/**
 * Chemin « Prisma » : une transaction par fichier, comme `migrate deploy`.
 * On ne peut pas utiliser le vrai Prisma ici ; on reproduit donc son
 * comportement documente, et on le verifie au §3 en y injectant un echec.
 */
async function appliquerEnTransaction(db, sql) {
  await db.exec('BEGIN;');
  try {
    await db.exec(sql);
    await db.exec('COMMIT;');
    return { ok: true };
  } catch (e) {
    await db.exec('ROLLBACK;').catch(() => {});
    return { ok: false, code: e.code, message: String(e.message || e) };
  }
}

/**
 * Decoupeur des lanceurs — COPIE de scripts/apply_migration_chantier6_passport.mjs.
 * Le §2 verifie que le lanceur n'a pas change ; si ce n'est plus le cas, cette
 * copie n'est plus la bonne et le test doit le dire.
 */
function decouperCommeLeLanceur(content) {
  const statements = [];
  let current = '';
  let dansBlocDollar = false;
  let balise = '';
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!dansBlocDollar && trimmed.startsWith('--')) continue;
    const dollars = line.match(/\$[a-zA-Z0-9_]*\$/g);
    if (dollars) {
      for (const m of dollars) {
        if (!dansBlocDollar) { dansBlocDollar = true; balise = m; }
        else if (m === balise) { dansBlocDollar = false; balise = ''; }
      }
    }
    current += `${line}\n`;
    if (!dansBlocDollar && trimmed.endsWith(';')) {
      if (current.trim().length > 0) statements.push(current.trim());
      current = '';
    }
  }
  if (current.trim().length > 0) statements.push(current.trim());
  return statements;
}

/** Chemin « lanceur » : instruction par instruction, sans transaction. */
async function appliquerCommeLeLanceur(db, sql) {
  const statements = decouperCommeLeLanceur(sql);
  for (const s of statements) {
    try {
      await db.exec(s);
    } catch (e) {
      return { ok: false, code: e.code, message: String(e.message || e), statements: statements.length };
    }
  }
  return { ok: true, statements: statements.length };
}

/**
 * Empreinte du catalogue. Volontairement exhaustive sur ce qui porte une regle
 * d'autorisation ; les commentaires en sont exclus (ils ne gouvernent rien,
 * mais un commentaire modifie ne doit pas masquer un changement reel non plus :
 * c'est `pg_description` separement qui le dirait, et il n'est pas gouverne).
 */
async function empreinte(db) {
  const q = async (sql) => (await db.query(sql)).rows;
  const [colonnes, contraintes, index, politiques, fonctions, tables, declencheurs] = await Promise.all([
    q(`SELECT c.relname, a.attname, format_type(a.atttypid, a.atttypmod) AS type,
              a.attnotnull, pg_get_expr(d.adbin, d.adrelid) AS defaut
         FROM pg_catalog.pg_attribute a
         JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND a.attnum > 0 AND NOT a.attisdropped`),
    q(`SELECT conrelid::regclass::text AS tbl, conname, contype, pg_get_constraintdef(oid) AS def
         FROM pg_catalog.pg_constraint WHERE connamespace = 'public'::regnamespace`),
    q(`SELECT tablename, indexname, indexdef FROM pg_catalog.pg_indexes WHERE schemaname = 'public'`),
    q(`SELECT tablename, policyname, permissive, array_to_string(roles, ',') AS roles,
              cmd, qual, with_check
         FROM pg_catalog.pg_policies WHERE schemaname = 'public'`),
    q(`SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args,
              p.prosecdef, array_to_string(p.proconfig, ',') AS config,
              pg_get_userbyid(p.proowner) AS proprietaire,
              has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
              has_function_privilege('tracefab_app', p.oid, 'EXECUTE') AS app_exec,
              coalesce(array_to_string(p.proacl, '|'), '') AS acl
         FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'`),
    q(`SELECT c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity,
              pg_get_userbyid(c.relowner) AS proprietaire,
              coalesce(array_to_string(c.relacl, '|'), '') AS acl
         FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','S')`),
    q(`SELECT t.tgname, t.tgrelid::regclass::text AS tbl, p.proname, t.tgtype::int AS type,
              t.tgenabled
         FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
        WHERE NOT t.tgisinternal`),
  ]);
  // Index par cle stable pour comparer sans dependre de l'ordre de retour.
  const cle = (r) => JSON.stringify(r);
  return {
    colonnes: new Map(colonnes.map((r) => [`${r.relname}.${r.attname}`, r])),
    contraintes: new Map(contraintes.map((r) => [`${r.tbl}.${r.conname}`, r])),
    index: new Map(index.map((r) => [r.indexname, r])),
    politiques: new Map(politiques.map((r) => [`${r.tablename}.${r.policyname}`, r])),
    fonctions: new Map(fonctions.map((r) => [`${r.proname}(${r.args})`, r])),
    tables: new Map(tables.map((r) => [r.relname, r])),
    declencheurs: new Map(declencheurs.map((r) => [`${r.tbl}.${r.tgname}`, r])),
    brut: { colonnes, contraintes, index, politiques, fonctions, tables, declencheurs, cle },
  };
}

const SECTIONS = ['colonnes', 'contraintes', 'index', 'politiques', 'fonctions', 'tables', 'declencheurs'];

/** Compare deux empreintes. Retourne les ajouts, les retraits et les modifications. */
function comparer(a, b) {
  const ajouts = [];
  const retraits = [];
  const modifies = [];
  for (const s of SECTIONS) {
    for (const [k, v] of b[s]) {
      if (!a[s].has(k)) { ajouts.push(`${s}:${k}`); continue; }
      const avant = a[s].get(k);
      for (const champ of Object.keys(v)) {
        if (JSON.stringify(avant[champ]) !== JSON.stringify(v[champ])) {
          modifies.push(`${s}:${k}.${champ} (${JSON.stringify(avant[champ])} -> ${JSON.stringify(v[champ])})`);
        }
      }
    }
    for (const k of a[s].keys()) if (!b[s].has(k)) retraits.push(`${s}:${k}`);
  }
  return { ajouts, retraits, modifies };
}

/* ==========================================================================
   PARTIE 1 — les lanceurs sont toujours ceux que j'ai copies
   ========================================================================== */

console.log('\n  1. Les cinq lanceurs hors bande, verifies dans le depot');

for (const [nom, lanceur] of CIBLES) {
  const fichier = path.join(root, lanceur);
  const existe = fs.existsSync(fichier);
  ok(`le lanceur de ${nom.slice(0, 21)}… existe`, existe, lanceur);
  if (!existe) continue;
  const src = fs.readFileSync(fichier, 'utf8');
  ok(`  … il lit bien le migration.sql de CETTE migration`, src.includes(nom), lanceur);
  ok(`  … il n ecrit pas dans _prisma_migrations`, !/_prisma_migrations/.test(src));
}

{
  const src = fs.readFileSync(path.join(root, 'scripts/apply_migration_chantier6_passport.mjs'), 'utf8');
  ok('le decoupeur copie dans ce test correspond encore au lanceur',
    /inDollarQuote/.test(src) && /trimmed\.startsWith\('--'\)/.test(src) && /trimmed\.endsWith\(';'\)/.test(src),
    'le lanceur a change : mettre a jour decouperCommeLeLanceur()');
  ok('aucun GRANT/REVOKE ajoute par les lanceurs (ils executent le fichier tel quel)',
    !CIBLES.some(([, l]) => /\b(GRANT|REVOKE)\b/.test(
      fs.readFileSync(path.join(root, l), 'utf8').replace(/--[^\n]*/g, ''))));
}

/* ==========================================================================
   PARTIE 2 — la decouverte : la chaine SANS les cinq ne s'applique pas
   ========================================================================== */

console.log('\n  2. La chaine privee des cinq migrations ne s applique pas');

// Question prealable : que resterait-il si `applied_steps_count = 0` etait pris
// au pied de la lettre, c'est-a-dire si leur SQL n'avait jamais tourne ? La
// reponse se mesure : on rejoue la chaine en sautant les cinq.
const baseD = await nouvelleBase();
let premierEchec = null;
let appliqueesD = 0;
for (const d of dossiers) {
  if (estCible(d)) continue;
  try {
    await baseD.exec(lire(d));
    appliqueesD += 1;
  } catch (e) {
    premierEchec = { migration: d, code: e.code, message: String(e.message || e) };
    break;
  }
}
ok('la chaine sautee des cinq S ARRETE : ces migrations ne sont pas un ornement',
  premierEchec !== null, premierEchec ? `${premierEchec.migration} — ${premierEchec.code}` : 'la chaine est passee');
if (premierEchec) {
  console.log(`        arret a ${premierEchec.migration}\n        ${premierEchec.code} ${premierEchec.message.slice(0, 120)}`);
  console.log(`        ${appliqueesD} migrations ont pu passer avant l arret`);
}
// L'echec doit citer un objet cree par l'une des cinq : sinon il ne prouve rien
// sur elles en particulier.
const objetsDesCinq = ['pef_emission_factors', 'product_pef_assessments', 'green_claims_rules',
  'product_green_claims', 'green_claims_audits', 'quality_corrective_action_plans',
  'quality_cap_messages', 'supplier_universal_passports', 'supplier_passport_access_requests',
  'transaction_certificates', 'mass_balance_allocations', 'mass_balance_reconciliations'];
const nomme = premierEchec && objetsDesCinq.find((t) => premierEchec.message.includes(t));
ok('l echec nomme un objet cree par les cinq : le lien de dependance est explicite',
  Boolean(nomme), nomme || String(premierEchec?.message).slice(0, 120));
ok('=> `0 step` ne peut pas signifier « SQL jamais execute » : le reste de la chaine en depend',
  premierEchec !== null && Boolean(nomme));

/* ==========================================================================
   PARTIE 3 — trois bases : prefixe, puis cinq par deux chemins
   ========================================================================== */

console.log('\n  3. Deux chemins sur deux bases jetables');

// Pour mesurer l'apport des cinq sans etre bloque par la dependance ci-dessus,
// on part du PREFIXE de la chaine : toutes les migrations anterieures a la
// premiere des cinq. C'est un etat bien defini, et identique dans les deux cas.
const PREFIXE = dossiers.filter((d) => d < CIBLES[0][0]);
// L'intervalle entre la premiere et la derniere des cinq contient AUSSI une
// migration qui n'en fait pas partie (`production_hardening`, meme horodatage
// que la premiere, triee apres elle). La partition doit la compter, sinon la
// base ne serait pas la chaine complete — c'est ce que la premiere version de
// ce test avait laisse passer (24 + 5 + 34 = 63 pour 64 migrations).
const INTERVALLE = dossiers.filter((d) => d >= CIBLES[0][0] && d <= CIBLES[CIBLES.length - 1][0]);
const INTERCALEES = INTERVALLE.filter((d) => !estCible(d));
const RESTE = dossiers.filter((d) => d > CIBLES[CIBLES.length - 1][0] && !estCible(d));

const baseA = await nouvelleBase();
for (const d of PREFIXE) await baseA.exec(lire(d));
ok(`${PREFIXE.length} migrations de prefixe appliquees : prefixe + cinq + reste = la chaine entiere`,
  PREFIXE.length >= 20 && PREFIXE.length + INTERVALLE.length + RESTE.length === dossiers.length,
  `${PREFIXE.length} + ${INTERVALLE.length} + ${RESTE.length} != ${dossiers.length}`);

const empreinteA = await empreinte(baseA);

// Chemin « Prisma » : une transaction par fichier.
const baseB = await nouvelleBase();
for (const d of PREFIXE) await baseB.exec(lire(d));
const resultatsB = [];
for (const [nom] of CIBLES) resultatsB.push([nom, await appliquerEnTransaction(baseB, lire(nom))]);
for (const d of INTERCALEES) await baseB.exec(lire(d));
ok('les cinq passent par le chemin « Prisma » (une transaction par fichier)',
  resultatsB.every(([, r]) => r.ok),
  JSON.stringify(resultatsB.filter(([, r]) => !r.ok).map(([n, r]) => [n, r.message])));
const empreinteB5 = await empreinte(baseB);

// Chemin « lanceur » : instruction par instruction, autocommit, decoupeur copie.
const baseC = await nouvelleBase();
for (const d of PREFIXE) await baseC.exec(lire(d));
const resultatsC = [];
for (const [nom] of CIBLES) resultatsC.push([nom, await appliquerCommeLeLanceur(baseC, lire(nom))]);
for (const d of INTERCALEES) await baseC.exec(lire(d));
ok('les cinq passent par le chemin « lanceur » (instruction par instruction)',
  resultatsC.every(([, r]) => r.ok),
  JSON.stringify(resultatsC.filter(([, r]) => !r.ok).map(([n, r]) => [n, r.message])));

/* ==========================================================================
   PARTIE 4 — equivalence objet par objet, puis chaine complete
   ========================================================================== */

console.log('\n  4. Equivalence des deux chemins, objet par objet');

const bc = comparer(empreinteB5, await empreinte(baseC));
ok('chemin Prisma et chemin lanceur : aucun objet ajoute', bc.ajouts.length === 0,
  bc.ajouts.slice(0, 12).join(', '));
ok('chemin Prisma et chemin lanceur : aucun objet retire', bc.retraits.length === 0,
  bc.retraits.slice(0, 12).join(', '));
ok('chemin Prisma et chemin lanceur : aucune propriete modifiee (politiques, fonctions, RLS, privileges)',
  bc.modifies.length === 0, bc.modifies.slice(0, 12).join(' · '));

// Une comparaison « identique » ne vaut que si le catalogue est substantiel.
ok('le catalogue compare est substantiel (la comparaison n est pas vide)',
  empreinteB5.tables.size > 40 && empreinteB5.politiques.size > 80 && empreinteB5.fonctions.size > 100,
  `tables=${empreinteB5.tables.size} politiques=${empreinteB5.politiques.size} fonctions=${empreinteB5.fonctions.size}`);
ok('les politiques RLS comparent USING et WITH CHECK, pas seulement leur nom',
  [...empreinteB5.politiques.values()].filter((p) => p.qual || p.with_check).length > 80,
  `${[...empreinteB5.politiques.values()].filter((p) => p.qual || p.with_check).length} politiques portent une expression`);
const definer = [...empreinteB5.fonctions.values()].filter((f) => f.prosecdef);
ok('les fonctions SECURITY DEFINER sont comparees avec leur search_path et leur proprietaire',
  definer.length > 0 && definer.every((f) => 'config' in f && 'proprietaire' in f),
  `${definer.length} fonctions DEFINER`);

// Puis la chaine ENTIERE, pour verifier que la difference de chemin ne se
// propage pas : apres les cinq, tout le reste est applique de la meme facon.
for (const d of RESTE) await baseB.exec(lire(d));
for (const d of RESTE) await baseC.exec(lire(d));
ok(`${RESTE.length} migrations de reste appliquees apres les cinq`, RESTE.length > 0, `${RESTE.length}`);
const bFin = await empreinte(baseB);
const cFin = await empreinte(baseC);
const bcFin = comparer(bFin, cFin);
ok('chaine complete : les deux chemins convergent encore, aucun ecart',
  bcFin.ajouts.length === 0 && bcFin.retraits.length === 0 && bcFin.modifies.length === 0,
  [...bcFin.ajouts, ...bcFin.retraits, ...bcFin.modifies].slice(0, 12).join(' · '));

/* ==========================================================================
   PARTIE 4 bis — ce que les cinq apportent reellement
   ========================================================================== */

console.log('\n  4 bis. L ecart « avec les cinq » / « sans les cinq »');

ok(`l intervalle contient ${INTERCALEES.length} migration(s) hors des cinq : ${INTERCALEES.join(', ') || '(aucune)'}`,
  true);

// Pour que l'ecart mesure soit bien celui DES CINQ, on verifie que la migration
// intercalee ne cree aucune des douze tables : sa contribution est alors
// etrangere au sujet, et ne peut pas fabriquer le resultat.
const baseE = await nouvelleBase();
for (const d of PREFIXE) await baseE.exec(lire(d));
for (const d of INTERCALEES) await baseE.exec(lire(d));
const empreinteE = await empreinte(baseE);
ok('la migration intercalee ne cree aucune des douze tables (l ecart mesure vient bien des cinq)',
  objetsDesCinq.every((t) => !empreinteE.tables.has(t)),
  objetsDesCinq.filter((t) => empreinteE.tables.has(t)).join(', '));

const ab = comparer(empreinteA, empreinteB5);
ok('les cinq migrations ne RETIRENT aucun objet existant', ab.retraits.length === 0,
  ab.retraits.slice(0, 12).join(', '));
// Les modifications d'objets deja existants sont le point sensible : une
// migration « hors bande » qui ne ferait qu'ajouter des tables ne toucherait
// pas aux privileges d'autrui. On attribue donc chaque modification a sa
// migration, au lieu de constater un total.
const abE = comparer(empreinteA, empreinteE);
const modifieesParLesCinq = ab.modifies.filter((m) => !abE.modifies.includes(m));
const modifieesParLesIntercalees = ab.modifies.filter((m) => abE.modifies.includes(m));
console.log(`        modifications d objets existants : ${modifieesParLesIntercalees.length} par les intercalees, `
  + `${modifieesParLesCinq.length} par les cinq`);
if (modifieesParLesIntercalees.length) console.log(`          intercalees : ${modifieesParLesIntercalees.join(' · ')}`);
if (modifieesParLesCinq.length) console.log(`          les cinq   : ${modifieesParLesCinq.join(' · ')}`);
ok('les cinq migrations ne MODIFIENT aucun objet deja existant (elles n ajoutent que du neuf)',
  modifieesParLesCinq.length === 0, modifieesParLesCinq.slice(0, 12).join(' · '));
ok('les cinq migrations AJOUTENT des objets : `0 step` ne veut pas dire `sans effet`',
  ab.ajouts.length > 0, `${ab.ajouts.length} objets ajoutes`);

const ajoutsParSection = Object.fromEntries(
  SECTIONS.map((s) => [s, ab.ajouts.filter((a) => a.startsWith(`${s}:`)).length]));
console.log(`        ajouts : ${JSON.stringify(ajoutsParSection)}`);

const manquantes = objetsDesCinq.filter((t) => !empreinteB5.tables.has(t));
ok('les douze tables annoncees existent bien apres les cinq', manquantes.length === 0, manquantes.join(', '));
const presentesAvant = objetsDesCinq.filter((t) => empreinteA.tables.has(t));
ok('aucune des douze n existe dans le prefixe (l ecart serait reel)', presentesAvant.length === 0,
  presentesAvant.join(', '));
ok('les tables ajoutees portent leur RLS activee et forcee',
  objetsDesCinq.every((t) => empreinteB5.tables.get(t)?.relrowsecurity === true
    && empreinteB5.tables.get(t)?.relforcerowsecurity === true),
  objetsDesCinq.filter((t) => !(empreinteB5.tables.get(t)?.relrowsecurity
    && empreinteB5.tables.get(t)?.relforcerowsecurity)).join(', '));
ok('les cinq ajoutent des politiques RLS (pas seulement des tables)',
  ab.ajouts.filter((a) => a.startsWith('politiques:')).length > 0,
  `${ab.ajouts.filter((a) => a.startsWith('politiques:')).length}`);

/* ==========================================================================
   PARTIE 5 — atomicite : ce que le chemin lanceur ne garantit pas
   ========================================================================== */

console.log('\n  5. Atomicite — la difference que « meme fichier » ne couvre pas');

// On injecte une instruction qui echoue a la FIN d une copie du fichier. Ce
// n'est pas la migration du depot : c'est une copie en memoire, la migration
// versionnee n'est pas touchee.
const sqlCassee = `${lire('20261006250000_universal_supplier_passport')}
SELECT * FROM table_qui_n_existe_pas;`;

const baseAtomique = await nouvelleBase();
for (const d of PREFIXE) await baseAtomique.exec(lire(d));
const echecTransaction = await appliquerEnTransaction(baseAtomique, sqlCassee);
ok('INJECTION : le chemin « Prisma » echoue bien (sinon le test ne prouve rien)',
  echecTransaction.ok === false && echecTransaction.code === '42P01',
  `${echecTransaction.code} ${String(echecTransaction.message).slice(0, 90)}`);
const fuiteB = await baseAtomique.query(
  `SELECT count(*)::int n FROM pg_catalog.pg_class WHERE relname = 'supplier_universal_passports'`);
ok('chemin « Prisma » : la transaction annulee ne laisse AUCUNE table',
  fuiteB.rows[0].n === 0, `${fuiteB.rows[0].n}`);

const baseLanceur = await nouvelleBase();
for (const d of PREFIXE) await baseLanceur.exec(lire(d));
const echecLanceur = await appliquerCommeLeLanceur(baseLanceur, sqlCassee);
ok('INJECTION : le chemin « lanceur » echoue aussi', echecLanceur.ok === false,
  `${echecLanceur.code} ${String(echecLanceur.message).slice(0, 90)}`);
const fuiteC = await baseLanceur.query(
  `SELECT count(*)::int n FROM pg_catalog.pg_class WHERE relname = 'supplier_universal_passports'`);
ok('chemin « lanceur » : la table est DEJA CREE malgre l echec — aucune atomicite',
  fuiteC.rows[0].n === 1, `${fuiteC.rows[0].n}`);

// Consequence pratique : dans ce cas, `applied_steps_count = 0` et un schema
// partiel coexisteraient sans que rien ne le signale. C'est cela qu'il fallait
// mesurer avant de declarer « equivalent ».
ok('=> les deux chemins sont equivalents QUAND TOUT REUSSIT, et ne le sont plus des qu une instruction echoue',
  bcFin.ajouts.length === 0 && bcFin.retraits.length === 0 && bcFin.modifies.length === 0
  && fuiteB.rows[0].n === 0 && fuiteC.rows[0].n === 1);

/* ==========================================================================
   PARTIE 6 — l empreinte du catalogue ne depend pas de l ordre des requetes
   ========================================================================== */

console.log('\n  6. Stabilite de la mesure');

const empreinteB2 = await empreinte(baseB);
const bb2 = comparer(bFin, empreinteB2);
ok('deux empreintes successives de la meme base sont identiques (mesure stable)',
  bb2.ajouts.length === 0 && bb2.retraits.length === 0 && bb2.modifies.length === 0);

await Promise.all([baseA.close(), baseB.close(), baseC.close(), baseD.close(), baseE.close(),
  baseAtomique.close(), baseLanceur.close()]);

/* ========================================================================== */

console.log(`\n  --------------------------------------------`);
if (echecs === 0) {
  console.log(`  ${verifies} verifications passees.`);
  console.log('  Les deux chemins produisent le meme schema, objet par objet.');
  console.log('  L atomicite reste la seule difference reelle, et elle est mesuree.');
  process.exit(0);
}
console.log(`  ${echecs} echec(s) sur ${verifies}.`);
process.exit(1);
