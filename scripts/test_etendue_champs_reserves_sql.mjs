#!/usr/bin/env node
/**
 * Le SQL d'etendue des champs reserves : jouable, en lecture seule, et il mord.
 *
 * `docs/security/2026-10-29-etendue-champs-reserves-lecture-seule.sql` sera
 * colle en production. Trois proprietes doivent etre prouvees AVANT :
 *
 *   1. il est en LECTURE SEULE pour de vrai — `BEGIN READ ONLY` refusant une
 *      ecriture au niveau du moteur, pas une simple convention de redaction ;
 *   2. il s'execute, et rend le nombre de lignes annonce ;
 *   3. il DISTINGUE l'etat lu en production de l'etat corrige. Un script qui
 *      rend la meme chose dans les deux cas ne dit rien de l'un ni de l'autre.
 *
 * Le point 1 est mesure, pas affirme : une ecriture est tentee DANS la
 * transaction en lecture seule, et doit echouer. Sinon le garde-fou n'existe
 * pas, et le script rassure a tort la personne qui le colle.
 */
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ici = dirname(fileURLToPath(import.meta.url));
const racine = join(ici, '..');
const FICHIER = join(racine, 'docs', 'security', '2026-10-29-etendue-champs-reserves-lecture-seule.sql');
const MIGRATIONS = join(racine, 'prisma', 'migrations');

let verifies = 0;
let echecs = 0;
const ok = (libelle, condition, detail = '') => {
  verifies += 1;
  if (condition) { console.log(`  ok    ${libelle}`); return; }
  echecs += 1;
  console.error(`  ECHEC ${libelle}${detail ? ` — ${detail}` : ''}`);
};

const ECARTS = [
  '20261010120000_publication_explicite',
  '20261017120000_active_tenant_context',
  '20261021170000_dpp_readiness_truthful_gates',
  '20261027100000_dpp_quality_gate_requires_assessment',
  '20261027130000_dpp_review_preservation_and_publication_coherence',
  '20261028120000_runtime_function_registry',
  '20261028120100_worker_identity_not_forgeable',
  '20261028120200_document_reserved_fields_internal_only',
  '20261028130000_product_computed_fields_column_scoped',
  '20261028140000_supplier_owner_relationship_scope',
  '20261028140000_supplier_invitation_owner_relationship_scope',
  '20261028150000_reconcile_plm_erp_sync_job_policies',
];
const ANNULEES = ['20261010120000_publication_explicite', '20261017120000_active_tenant_context'];

const dossierMigrations = readdirSync(MIGRATIONS).filter((d) => /^\d{14}_/.test(d)).sort();
const lire = (d) => readFileSync(join(MIGRATIONS, d, 'migration.sql'), 'utf8');

/**
 * Les requetes SELECT du fichier.
 *
 * Delimitees par les LIGNES qui valent exactement `BEGIN READ ONLY;` et
 * `COMMIT;` — pas par la premiere occurrence du texte. Le fichier MENTIONNE ces
 * deux instructions dans ses commentaires (mode d'emploi), et une recherche de
 * sous-chaine tombait dedans : l'extraction ne rendait qu'une requete tronquee.
 * Lecon deja apprise sur ce chantier : analyser le code, pas la prose.
 */
function requetes() {
  const lignes = readFileSync(FICHIER, 'utf8').split('\n');
  const debut = lignes.findIndex((l) => l.trim() === 'BEGIN READ ONLY;');
  const fin = lignes.findIndex((l, i) => l.trim() === 'COMMIT;' && i > debut);
  if (debut < 0 || fin < 0) throw new Error('delimiteurs BEGIN READ ONLY / COMMIT introuvables');
  return lignes.slice(debut + 1, fin)
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n')
    .split(';').map((q) => q.trim()).filter(Boolean);
}

const sql = requetes();
console.log(`Requetes lues entre BEGIN READ ONLY et COMMIT : ${sql.length}`);

async function base({ corrige }) {
  const db = new PGlite({ extensions: { pgcrypto, uuid_ossp } });
  await db.waitReady;
  await db.exec(`
    CREATE ROLE tracefab_app LOGIN NOSUPERUSER NOBYPASSRLS;
    GRANT USAGE ON SCHEMA public TO tracefab_app;
  `);
  const exclus = corrige ? [] : ECARTS.filter((d) => !ANNULEES.includes(d));
  for (const d of dossierMigrations) {
    if (exclus.includes(d)) continue;
    if (!existsSync(join(MIGRATIONS, d, 'migration.sql'))) continue;
    try {
      await db.exec('BEGIN'); await db.exec(lire(d)); await db.exec('COMMIT');
    } catch (e) {
      try { await db.exec('ROLLBACK'); } catch { /* deja fermee */ }
      throw new Error(`${d} : ${String(e.message).split('\n')[0]}`);
    }
  }
  return db;
}

/** Joue une requete DANS une transaction en lecture seule, comme le fichier. */
async function enLectureSeule(db, requete) {
  await db.exec('BEGIN READ ONLY;');
  try {
    const { rows } = await db.query(requete);
    return rows.map((r) => r.ligne);
  } finally {
    try { await db.exec('COMMIT'); } catch { try { await db.exec('ROLLBACK'); } catch { /* */ } }
  }
}

// --- 1. Lecture seule, mesuree ------------------------------------------
console.log('\n1. `BEGIN READ ONLY` refuse-t-il vraiment une ecriture ?');
{
  const db = await base({ corrige: true });
  let refus = null;
  await db.exec('BEGIN READ ONLY;');
  try {
    await db.exec("CREATE TABLE _interdit (id int)");
    refus = 'ACCEPTE';
  } catch (e) { refus = e.code ?? 'refuse'; }
  try { await db.exec('ROLLBACK'); } catch { /* */ }
  ok('une ecriture DANS la transaction en lecture seule echoue (25006)',
    refus === '25006', String(refus));
  ok('la table n a pas ete creee', (await db.query(
    `SELECT count(*)::int AS n FROM pg_catalog.pg_class WHERE relname = '_interdit'`)).rows[0].n === 0);

  const lecture = await enLectureSeule(db, 'SELECT 1 AS ligne');
  ok('une lecture, elle, passe', lecture.length === 1);
  await db.close();
}

// --- 2. Le fichier s'execute, nombre de lignes annonce -------------------
console.log('\n2. Chaque requete du fichier s execute (etat corrige)');
const attendus = [
  ['Q0 session', 1],
  ['Q1 inventaire des tables', 4],
  ['Q2 etendue', null], // variable : c'est le FAIT mesure
  ['Q3 verdict', 1],
  ['Q4 worker', 1],
  ['Q5 noms supposes', 1],
];
let sortieCorrigee = [];
{
  const db = await base({ corrige: true });
  for (const [i, [nom, attendu]] of attendus.entries()) {
    let lignes = null; let erreur = null;
    try { lignes = await enLectureSeule(db, sql[i]); } catch (e) { erreur = e.message; }
    if (attendu === null) {
      ok(`${nom} : s execute (${lignes?.length ?? '?'} ligne(s) — le compte est le fait mesure)`,
        erreur === null, erreur ?? '');
    } else {
      ok(`${nom} : ${attendu} ligne(s)`, erreur === null && lignes?.length === attendu,
        erreur ?? `n=${lignes?.length}`);
    }
    if (lignes) for (const l of lignes.slice(0, 6)) console.log(`        ${l}`);
    if (lignes && lignes.length > 6) console.log(`        … et ${lignes.length - 6} autre(s)`);
    if (i === 4) sortieCorrigee = lignes ?? [];
  }
  await db.close();
}

// --- 3. L'etat LU (production) et l'etat CORRIGE donnent-ils autre chose ? 
console.log('\n3. Test par mutation : etat lu en production vs etat corrige');
{
  const prod = await base({ corrige: false });
  const q2prod = await enLectureSeule(prod, sql[2]);
  const q3prod = await enLectureSeule(prod, sql[3]);
  const q4prod = await enLectureSeule(prod, sql[4]);
  await prod.close();
  console.log(`        [production] Q3 : ${q3prod[0]}`);
  console.log(`        [production] Q4 : ${q4prod[0]}`);
  console.log(`        [production] Q2 : ${q2prod.length} colonnes ecrivables`);

  const corr = await base({ corrige: true });
  const q2corr = await enLectureSeule(corr, sql[2]);
  const q3corr = await enLectureSeule(corr, sql[3]);
  const q4corr = await enLectureSeule(corr, sql[4]);
  await corr.close();
  console.log(`        [corrige]   Q3 : ${q3corr[0]}`);
  console.log(`        [corrige]   Q4 : ${q4corr[0]}`);
  console.log(`        [corrige]   Q2 : ${q2corr.length} colonnes ecrivables`);

  ok('Q3 differe entre les deux etats', q3prod[0] !== q3corr[0]);
  ok('Q4 differe entre les deux etats', q4prod[0] !== q4corr[0]);
  ok('sur l etat lu, aucune politique n est indexee sur le role worker (0)',
    /politiques_current_user=0/.test(q4prod[0]), q4prod[0]);
  ok('sur l etat corrige, les 11 politiques le sont', /politiques_current_user=11/.test(q4corr[0]), q4corr[0]);
  /**
   * La lecture du 29/10 dit « tracefab_app a UPDATE sur documents.status ».
   * La mesure est PLUS PRECISE : le droit n'est pas accorde colonne par
   * colonne, il est accorde sur la TABLE entiere — `has_column_privilege`
   * rend vrai dans les deux cas, mais le second est plus grave, parce qu'il
   * couvre toute colonne presente et future. Les deux etats sont acceptes
   * comme « ecrivable », et celui de la production doit etre le plus large.
   */
  ok('sur l etat lu, documents.status est ecrivable (constat du 29/10)',
    /documents_status=(oui|TABLE-OUVERTE)/.test(q3prod[0]), q3prod[0]);
  ok('et le droit est en fait au niveau TABLE, plus large que la lecture ne le disait',
    /documents_status=TABLE-OUVERTE/.test(q3prod[0]), q3prod[0]);
  ok('sur l etat corrige, plus de TABLE-OUVERTE : le droit est vraiment borne',
    !/TABLE-OUVERTE/.test(q3corr[0]), q3corr[0]);
  ok('sur l etat corrige, documents_status et products_version sont fermes',
    /documents_status=non/.test(q3corr[0]) && /products_version=non/.test(q3corr[0]), q3corr[0]);
  ok('sur l etat corrige, aucune colonne de documents n est ecrivable',
    !q2corr.some((l) => l.includes('|documents|')), JSON.stringify(q2corr.filter((l) => l.includes('|documents|'))));
  ok('sur l etat corrige, `version` n apparait dans aucune ligne de Q2',
    !q2corr.some((l) => /\|version\|/.test(l)), JSON.stringify(q2corr.filter((l) => /\|version\|/.test(l))));
  ok('mais les colonnes metier de tracefab_products restent ecrivables',
    q2corr.some((l) => l.includes('|tracefab_products|name|')), `${q2corr.length} lignes`);
  ok('sur l etat lu, `version` EST ecrivable (le defaut existait bien)',
    q2prod.some((l) => /\|version\|/.test(l)));
}

// --- 4. Les noms supposes : la reponse doit etre « aucune », pas un vide --
console.log('\n4. Q5 tranche la question des quatre noms');
{
  const db = await base({ corrige: true });
  const q5 = await enLectureSeule(db, sql[5]);
  await db.close();
  ok('Q5 rend `trouvees=0` et `detail=aucune`, meme sur une base corrigee',
    /trouvees=0/.test(q5[0]) && /detail=aucune/.test(q5[0]), q5[0]);
  console.log('      => les quatre noms de la liste initiale ne designent rien :');
  console.log('         ils ne peuvent pas servir de critere de conformite.');
}

console.log('\n--------------------------------------------');
if (echecs > 0) {
  console.error(`${echecs} echec(s) sur ${verifies}.`);
  process.exit(1);
}
console.log(`${verifies} verifications passees.`);
console.log('Le SQL d etendue est en lecture seule REELLE, jouable, et il distingue les deux etats.');
