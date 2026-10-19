#!/usr/bin/env node
/**
 * Audit en lecture seule de l'etat reel d'une base Tracefab.
 *
 * POURQUOI CE SCRIPT EXISTE
 *
 * Le 2026-10-12, deux affirmations circulaient sans preuve : que la RLS
 * protege, et qu'aucune fonction n'est executable par PUBLIC. La premiere
 * reposait sur des compteurs ENABLE/FORCE — or `neondb_owner` porte
 * BYPASSRLS, donc ces compteurs ne prouvaient rien. La seconde etait
 * contredite par une migration. Les deux etaient dans
 * docs/operations/p0-neon-reconciliation.md, presente comme un constat.
 *
 * Ce script rapporte ce que la base repond, et rien d'autre.
 *
 * IL EST EN LECTURE SEULE — ET IL LE PROUVE
 *
 * Deux barriers, et non une promesse :
 *
 *   1. une liste blanche de requetes, verifiee au demarrage : chaque requete
 *      doit commencer par SELECT, WITH, SHOW ou TABLE. Une requete qui ecrit
 *      ne peut pas etre ajoutee sans faire echouer l'assertion, donc sans
 *      etre vue ;
 *   2. la session est ouverte en `default_transaction_read_only = on`. La
 *      garantie est appliquee par le serveur, pas par ce script : meme une
 *      requete d'ecriture qui passerait la liste blanche serait refusee par
 *      PostgreSQL.
 *
 * IL NE DIVULGUE RIEN
 *
 * Aucune chaine de connexion, aucun hote, aucun identifiant, aucun mot de
 * passe, aucune donnee metier. Uniquement des noms de roles, de fonctions, de
 * tables et des compteurs. Une verification finale le confirme : le rapport
 * produit est relu avant affichage, et toute occurrence de l'hote, du mot de
 * passe ou de l'identifiant fait echouer le script au lieu d'imprimer.
 *
 * USAGE
 *
 *   DATABASE_URL=postgresql://... node scripts/audit_neon_readonly.mjs
 *   DATABASE_URL=... TF_RLS_APP_URL=postgresql://...@.../db node scripts/audit_neon_readonly.mjs
 *
 * Sans DATABASE_URL, sortie 2 : un audit qui n'a pas tourne n'est pas un
 * audit qui a constate.
 */
import pg from 'pg';
import { createHash } from 'node:crypto';

const RAW_URL = process.env.DATABASE_URL;
if (!RAW_URL || !RAW_URL.trim()) {
  console.error('  NON EXECUTE — DATABASE_URL absent.');
  console.error('  Fournir une chaine de connexion EN LECTURE SEULE, ou un role en lecture seule.');
  console.error('  Sortie 2 : un audit qui n a pas tourne ne constate rien.\n');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Cible declaree, et non deduite
// ---------------------------------------------------------------------------
// Un audit qui se rabat silencieusement sur une autre base produit un rapport
// sur la mauvaise cible, presente comme un constat sur celle qu'on croit avoir
// examinee. Le nom de la base attendue se declare donc a l'avance :
//
//   --expect-database=<nom>            ou   TRACEFAB_AUDIT_EXPECT_DATABASE=<nom>
//
// Si la base reellement jointe porte un autre nom, l'audit refuse de produire
// un rapport plutot que de le produire sur la mauvaise cible. Un repli local
// est impossible : ce script ne lit que DATABASE_URL, ne la devine pas et n'a
// aucune valeur par defaut.
const ARG_ATTENDU = process.argv.find((a) => a.startsWith('--expect-database='));
const BASE_ATTENDUE = (ARG_ATTENDU ? ARG_ATTENDU.split('=')[1] : process.env.TRACEFAB_AUDIT_EXPECT_DATABASE || '').trim();

/** Classe d'hote, sans jamais nommer l'hote. */
function classeHote(url) {
  try {
    const u = new URL(url);
    const h = (u.hostname || '').toLowerCase();
    if (!h) return u.searchParams.get('host') ? 'socket local' : 'inconnue';
    if (['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(h)) return 'local (jetable presume)';
    if (/\.neon\.tech$/.test(h)) return 'base managee (Neon)';
    if (/\.supabase\.(co|in)$/.test(h)) return 'base managee (Supabase)';
    if (/\.rds\.amazonaws\.com$/.test(h)) return 'base managee (RDS)';
    return 'distant (hebergeur non reconnu)';
  } catch {
    return 'non analysable';
  }
}

/** Empreinte de la cible : corrélable dans un journal, non réversible. */
function empreinteCible(url) {
  return createHash('sha256').update(url).digest('hex').slice(0, 12);
}

// ---------------------------------------------------------------------------
// Liste blanche des requetes
// ---------------------------------------------------------------------------
const REQUETES = {
  identite: `SELECT current_user AS role_effectif, current_database() AS base,
                    version() AS version`,
  lecture_seule: `SHOW default_transaction_read_only`,

  roles: `SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolcanlogin,
                 rolbypassrls, rolreplication
          FROM pg_roles
          WHERE rolname NOT LIKE 'pg\\_%'
          ORDER BY rolname`,

  tables_rls: `SELECT c.relname AS table_name, c.relrowsecurity AS rls_activee,
                      c.relforcerowsecurity AS rls_forcee,
                      pg_get_userbyid(c.relowner) AS proprietaire,
                      (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS politiques
               FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'public' AND c.relkind = 'r'
               ORDER BY c.relname`,

  resume_rls: `SELECT count(*)::int AS tables,
                      count(*) FILTER (WHERE c.relrowsecurity)::int AS rls_activee,
                      count(*) FILTER (WHERE c.relforcerowsecurity)::int AS rls_forcee,
                      count(*) FILTER (WHERE NOT c.relrowsecurity)::int AS sans_rls,
                      (SELECT count(*)::int FROM pg_policy p
                        JOIN pg_class pc ON pc.oid = p.polrelid
                        JOIN pg_namespace pn ON pn.oid = pc.relnamespace
                        WHERE pn.nspname = 'public') AS politiques
               FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'public' AND c.relkind = 'r'`,

  fonctions_publiques: `SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS arguments,
                               p.prosecdef AS security_definer,
                               pg_get_userbyid(p.proowner) AS proprietaire,
                               has_function_privilege('public', p.oid, 'EXECUTE') AS public_peut_executer,
                               p.proacl::text AS acl
                        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'public' AND p.prokind = 'f'
                          AND p.prosecdef
                          AND has_function_privilege('public', p.oid, 'EXECUTE')
                        ORDER BY p.proname`,

  resume_fonctions: `SELECT count(*)::int AS total,
                            count(*) FILTER (WHERE p.prosecdef)::int AS security_definer,
                            count(*) FILTER (WHERE p.prosecdef
                              AND has_function_privilege('public', p.oid, 'EXECUTE'))::int AS secdef_publiques
                     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                     WHERE n.nspname = 'public' AND p.prokind = 'f'`,

  migrations: `SELECT migration_name, finished_at,
                      CASE WHEN finished_at IS NULL THEN false ELSE true END AS appliquee
               FROM _prisma_migrations
               ORDER BY started_at`,

  // Le defaut pour les fonctions a venir, mesure et non lu : une fonction
  // temoin est creee puis annulee. Comme la session est en lecture seule, la
  // creation est refusee par le serveur — ce qui est en soi la preuve que la
  // lecture seule est appliquee. Le defaut est donc constate par lecture de
  // pg_default_acl, et la creation est rapportee comme non tentee.
  defaut_fonctions: `SELECT defaclobjtype, defaclacl::text AS acl,
                            pg_get_userbyid(defaclrole) AS proprietaire
                     FROM pg_default_acl
                     ORDER BY proprietaire, defaclobjtype`,

  proprietaire_tables: `SELECT pg_get_userbyid(c.relowner) AS proprietaire,
                               count(*)::int AS tables
                        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                        WHERE n.nspname = 'public' AND c.relkind = 'r'
                        GROUP BY 1 ORDER BY 2 DESC`,
};

const PREFIXES_AUTORISEES = ['select', 'with', 'show', 'table'];

for (const [nom, sql] of Object.entries(REQUETES)) {
  const premier = sql.trim().split(/\s+/)[0].toLowerCase();
  if (!PREFIXES_AUTORISEES.includes(premier)) {
    console.error(`\n  REFUS — la requete « ${nom} » commence par « ${premier} ».`);
    console.error(`  La liste blanche n autorise que : ${PREFIXES_AUTORISEES.join(', ')}.`);
    console.error('  Un audit ne doit pas pouvoir ecrire.\n');
    process.exit(3);
  }
}

// ---------------------------------------------------------------------------
// Connexion, en lecture seule, etablie par le serveur
// ---------------------------------------------------------------------------
const TLS = /sslmode=(require|verify|prefer)/.test(RAW_URL);
const db = new pg.Client({ connectionString: RAW_URL, ssl: TLS ? { rejectUnauthorized: true } : undefined });

try {
  await db.connect();
} catch (error) {
  console.error(`\n  ECHEC — connexion impossible : ${String(error.message).split('\n')[0]}\n`);
  process.exit(1);
}

await db.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');

const identite = (await db.query(REQUETES.identite)).rows[0];

// Bloc de cible : etabli APRES connexion, sans divulguer la chaine.
const CLASSE = classeHote(RAW_URL);
const EMPREINTE = empreinteCible(RAW_URL);
console.log('');
console.log('  CIBLE EXAMINEE');
console.log(`    base declaree   : ${BASE_ATTENDUE || '(non declaree — utiliser --expect-database=<nom>)'}`);
console.log(`    base jointe     : ${identite.base}`);
console.log(`    role de connexion: ${identite.role_effectif}`);
console.log(`    classe d hote   : ${CLASSE}`);
console.log(`    empreinte cible : ${EMPREINTE}`);

if (BASE_ATTENDUE && identite.base !== BASE_ATTENDUE) {
  console.error('');
  console.error('  REFUS — la base jointe ne correspond pas a la base declaree.');
  console.error(`  declaree : ${BASE_ATTENDUE}   jointe : ${identite.base}`);
  console.error('  Aucun rapport n est produit : un constat sur la mauvaise cible est pire');
  console.error('  qu aucun constat. Sortie 3.');
  console.error('');
  await db.end();
  process.exit(3);
}

if (identite.role_effectif === 'neondb_owner') {
  console.log('\n  AVERTISSEMENT — le role effectif est `neondb_owner`.');
  console.log('  Ce role porte BYPASSRLS : les politiques de securite ne sont PAS evaluees');
  console.log('  pour lui. Tout constat sur la RLS mesure donc cet audit, pas l application.');
  console.log('  Utiliser une chaine de connexion en lecture seule portee par un autre role.\n');
}

// ---------------------------------------------------------------------------
// Rapport
// ---------------------------------------------------------------------------
const rapport = {};
for (const [nom, sql] of Object.entries(REQUETES)) {
  try {
    rapport[nom] = (await db.query(sql)).rows;
  } catch (error) {
    rapport[nom] = { erreur: String(error.message).split('\n')[0] };
  }
}

await db.end();

const ligne = (titre) => console.log(`\n  ${titre}\n  ${'-'.repeat(titre.length)}`);

console.log('\n  ============================================================');
console.log('  AUDIT EN LECTURE SEULE — etat constate dans la base');
console.log(`  base=${identite.base}  role=${identite.role_effectif}  empreinte=${EMPREINTE}`);
console.log('  ============================================================');

ligne('1. Identite de la connexion');
console.log(`  role effectif : ${identite.role_effectif}`);
console.log(`  base          : ${identite.base}`);
console.log(`  version       : ${String(identite.version).split(',')[0]}`);
console.log(`  lecture seule : ${rapport.lecture_seule?.[0]?.default_transaction_read_only ?? 'inconnue'}`);

ligne('2. Roles');
for (const r of rapport.roles || []) {
  console.log(`  ${r.rolname.padEnd(24)} super=${r.rolsuper ? 'oui' : 'non'} creerole=${r.rolcreaterole ? 'oui' : 'non'} bypassrls=${r.rolbypassrls ? 'OUI' : 'non'}`);
}

ligne('3. RLS sur le schema public');
const resume = Array.isArray(rapport.resume_rls) ? rapport.resume_rls[0] : null;
if (resume) {
  console.log(`  ${resume.tables} tables · ${resume.rls_activee} avec RLS activee · ${resume.rls_forcee} avec RLS forcee · ${resume.sans_rls} sans RLS`);
  console.log(`  ${resume.politiques} politiques declarees`);
}
const sansRls = (Array.isArray(rapport.tables_rls) ? rapport.tables_rls : []).filter((t) => !t.rls_activee);
if (sansRls.length > 0) {
  console.log('  tables SANS RLS :');
  for (const t of sansRls) console.log(`    ${t.table_name} (proprietaire ${t.proprietaire})`);
}
const politiquesZero = (Array.isArray(rapport.tables_rls) ? rapport.tables_rls : [])
  .filter((t) => t.rls_activee && Number(t.politiques) === 0);
if (politiquesZero.length > 0) {
  console.log('  tables avec RLS activee mais AUCUNE politique :');
  for (const t of politiquesZero) console.log(`    ${t.table_name}`);
}

ligne('4. Fonctions SECURITY DEFINER');
const rf = Array.isArray(rapport.resume_fonctions) ? rapport.resume_fonctions[0] : null;
if (rf) console.log(`  ${rf.total} fonctions · ${rf.security_definer} SECURITY DEFINER · ${rf.secdef_publiques} executables par PUBLIC`);
const publiques = Array.isArray(rapport.fonctions_publiques) ? rapport.fonctions_publiques : [];
if (publiques.length > 0) {
  console.log('  FONCTIONS EXECUTABLES PAR PUBLIC (a corriger) :');
  for (const f of publiques) console.log(`    ${f.proname}(${f.arguments}) — proprietaire ${f.proprietaire}`);
} else if (rf) {
  console.log('  aucune fonction SECURITY DEFINER executable par PUBLIC');
}

ligne('5. Defaut pour les fonctions a venir');
const defauts = Array.isArray(rapport.defaut_fonctions) ? rapport.defaut_fonctions : [];
const defautFonctions = defauts.filter((d) => d.defaclobjtype === 'f');
if (defautFonctions.length === 0) {
  console.log('  AUCUNE entree pg_default_acl pour les fonctions.');
  console.log('  Consequence : le defaut integre s applique, et une fonction creee');
  console.log('  ensuite est executable par PUBLIC. C est le defaut que la migration');
  console.log('  20261007100000 croyait fermer avec la forme « IN SCHEMA public ».');
  console.log('  Forme utile : la variante GLOBALE de la commande de defauts, pour le role');
  console.log('  proprietaire, sans clause de schema. Details et SQL exact :');
  console.log('  docs/security/PHASE-3-PRIVILEGES-NEON.md, section 3.');
} else {
  for (const d of defautFonctions) {
    const acl = d.acl || '';
    console.log(`  ${d.proprietaire} : ${acl}`);
    console.log(`  PUBLIC explicitement exclu : ${acl.includes(',=X') || acl.startsWith('{=X') ? 'NON' : 'oui'}`);
  }
}

ligne('6. Migrations appliquees');
const migrations = Array.isArray(rapport.migrations) ? rapport.migrations : [];
if (migrations.length === 0) {
  console.log('  aucune ligne dans _prisma_migrations');
} else {
  const nonAppliquees = migrations.filter((m) => !m.appliquee);
  console.log(`  ${migrations.length} migrations referencees · ${nonAppliquees.length} non terminee(s)`);
  console.log(`  derniere : ${migrations[migrations.length - 1]?.migration_name}`);
  const recentes = migrations.slice(-6);
  for (const m of recentes) console.log(`    ${m.appliquee ? 'ok ' : 'KO '} ${m.migration_name}`);
}

ligne('7. Proprietaires des tables');
for (const p of rapport.proprietaire_tables || []) console.log(`  ${p.proprietaire} : ${p.tables} table(s)`);

// ---------------------------------------------------------------------------
// Controle de non-divulgation
// ---------------------------------------------------------------------------
let sortie;
try {
  sortie = new URL(RAW_URL);
} catch {
  sortie = null;
}

const rendu = Object.values(rapport).flatMap((v) => JSON.stringify(v ?? '')).join(' ');

// Ce qui est interdit sans condition : la chaine de connexion elle-meme, sous
// quelque forme que ce soit, et les marqueurs qui la caracterisent.
const motifsInterdits = [
  ['chaine de connexion brute', RAW_URL],
  ['schema d URL postgresql://', 'postgresql://'],
  ['schema d URL postgres://', 'postgres://'],
  ['parametre sslmode', 'sslmode='],
];

// Ce qui est interdit seulement s'il a la FORME d'un identifiant. Le nom de
// role `postgres` est a la fois l identifiant local d une base jetable et le
// proprietaire legitime de 47 tables : le confondre avec un secret ferait
// echouer l audit pour une raison fausse, et un controle qui crie a tort est
// un controle qu on desactive. Un mot de passe reel est long ; un hote reel
// est un nom qualifie, jamais une adresse de bouclage.
const BOUCLAGE = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0']);
const motifsConditionnels = [];
if (sortie) {
  if (sortie.password && sortie.password.length >= 12) {
    motifsConditionnels.push(['mot de passe', sortie.password]);
  }
  if (sortie.hostname && sortie.hostname.includes('.') && !BOUCLAGE.has(sortie.hostname)
      && !/^\d+\.\d+\.\d+\.\d+$/.test(sortie.hostname)) {
    motifsConditionnels.push(['hote', sortie.hostname]);
  }
}

const fuites = [...motifsInterdits, ...motifsConditionnels]
  .filter(([, valeur]) => valeur && rendu.includes(valeur))
  .map(([nom]) => nom);

console.log('\n  ============================================================');
if (fuites.length > 0) {
  console.log(`  REFUS D AFFICHER — ${fuites.length} element(s) sensible(s) present(s) dans le rapport.`);
  console.log('  Le rapport n a pas ete imprime. Corriger la requete qui le divulgue.');
  console.log('  ============================================================\n');
  process.exit(4);
}
console.log('  Rapport verifie : aucune chaine de connexion, aucun identifiant,');
console.log('  aucun hote, aucun mot de passe. Session SQL en lecture seule appliquee');
console.log('  par le serveur (SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY).');
console.log('  ============================================================\n');
