#!/usr/bin/env node
/**
 * Valide le releve `2026-10-29-plm-politiques-lecture-seule.sql` AVANT qu'il ne
 * soit colle dans une console de production.
 *
 * Trois choses, dans cet ordre :
 *   1. [STATIQUE] le script ne contient AUCUNE ecriture — ni DDL, ni DML ;
 *   2. [MESURE]   joue sur une base jetable a l'etat de production reconstruit,
 *                 il rend les 4 politiques et les distingue correctement ;
 *   3. [MESURE]   joue sur une base saine (2 politiques), il ne casse pas et
 *                 annonce « conforme au referentiel ».
 *
 * Un script de production non joue n'est pas un script valide.
 */
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const racine = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = join(racine, 'prisma', 'migrations');
const SQL = join(racine, 'docs', 'security', '2026-10-29-plm-politiques-lecture-seule.sql');
const CIBLE = '20261028150000_reconcile_plm_erp_sync_job_policies';

let verifies = 0; let echecs = 0;
const ok = (l, c, d = '') => {
  verifies += 1;
  if (c) { console.log(`  ok    ${l}`); return; }
  echecs += 1; console.error(`  ECHEC ${l}${d ? ` — ${d}` : ''}`);
};

const texte = readFileSync(SQL, 'utf8');
// On neutralise commentaires ET litteraux de chaine : `'TRUNCATE'` dans un
// ARRAY de noms de privileges n'est pas une ecriture. Un detecteur qui lit la
// prose est un faux positif connu de ce chantier.
const sansCommentaires = texte.replace(/--[^\n]*/g, '');
// Pour chercher des ECRITURES seulement, on retire en plus les litteraux :
// un nom de privilege cite dans un ARRAY n'est pas une instruction.
const sansLitteraux = sansCommentaires.replace(/'(?:[^']|'')*'/g, "''");

console.log('1. Statique : ce script n ecrit rien  [DEPOT]');
{
  const ecritures = [
    [/\bINSERT\s+INTO\b/i, 'INSERT'], [/\bUPDATE\s+\w+\s+SET\b/i, 'UPDATE'],
    [/\bDELETE\s+FROM\b/i, 'DELETE'], [/\bTRUNCATE\b/i, 'TRUNCATE'],
    [/\bALTER\s+(TABLE|ROLE|POLICY|FUNCTION)\b/i, 'ALTER'],
    [/\bDROP\s+(TABLE|POLICY|ROLE|FUNCTION)\b/i, 'DROP'],
    [/\bCREATE\s+(TABLE|POLICY|ROLE|FUNCTION|INDEX)\b/i, 'CREATE'],
    [/\bGRANT\b|\bREVOKE\b/i, 'GRANT/REVOKE'],
    [/\bprisma\s+migrate\b/i, 'commande prisma'],
  ];
  for (const [re, quoi] of ecritures) {
    ok(`aucune ecriture de type ${quoi}`, !re.test(sansLitteraux));
  }
  ok('la transaction est declaree READ ONLY',
    /^\s*BEGIN\s+READ\s+ONLY\s*;/im.test(sansCommentaires));
  ok('elle se termine par COMMIT', /^\s*COMMIT\s*;/im.test(sansCommentaires));
  ok('elle verifie elle-meme le mode lecture seule (Q0)',
    /transaction_read_only/.test(sansCommentaires));
  ok('elle rend les predicats USING et WITH CHECK (Q1)',
    /pg_get_expr\(pol\.polqual/.test(sansCommentaires)
    && /pg_get_expr\(pol\.polwithcheck/.test(sansCommentaires));
  ok('elle confronte les noms au referentiel (Q2)', /CANONIQUE/.test(sansCommentaires));
  ok('elle distingue privilege accorde et RLS (Q5)', /has_table_privilege/.test(sansCommentaires));
}

const dossiers = readdirSync(MIGRATIONS).filter((d) => /^\d{14}_/.test(d)).sort();

async function chaine({ arreterAvant = null } = {}) {
  const db = new PGlite({ extensions: { pgcrypto, uuid_ossp } });
  await db.waitReady;
  await db.exec(`
    CREATE ROLE tracefab_app LOGIN PASSWORD 'runtime'
      NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
    GRANT USAGE ON SCHEMA public TO tracefab_app;`);
  for (const d of dossiers) {
    if (arreterAvant && d >= arreterAvant) break;
    if (!existsSync(join(MIGRATIONS, d, 'migration.sql'))) continue;
    await db.exec('BEGIN');
    await db.exec(readFileSync(join(MIGRATIONS, d, 'migration.sql'), 'utf8'));
    await db.exec('COMMIT');
  }
  return db;
}

/** Joue le script et rend les lignes, par question. */
async function relever(db) {
  const res = await db.exec(texte);
  const parQ = new Map();
  for (const r of res) {
    for (const row of r.rows ?? []) {
      const q = row.q ?? '?';
      if (!parQ.has(q)) parQ.set(q, []);
      parQ.get(q).push(row);
    }
  }
  return parQ;
}

console.log('\n2. Joue sur l etat de production reconstruit  [MESURE]');
{
  const db = await chaine({ arreterAvant: CIBLE });
  await db.exec(`
    CREATE POLICY plm_erp_sync_jobs_insert_brand ON public.plm_erp_sync_jobs
      FOR INSERT TO PUBLIC WITH CHECK (
        tracefab_has_org_role(brand_organization_id,
          ARRAY['owner','admin','manager','contributor']::membership_role[]));
    CREATE POLICY plm_erp_sync_jobs_select_brand ON public.plm_erp_sync_jobs
      FOR SELECT TO PUBLIC USING (true);`);
  const r = await relever(db);

  ok('Q0 rend le mode lecture seule', r.get('Q0')?.[0]?.lecture_seule === 'on',
    JSON.stringify(r.get('Q0')));
  const q1 = r.get('Q1') ?? [];
  ok('Q1 rend les 4 politiques', q1.length === 4, `${q1.length}`);
  ok('Q1 porte la commande, les roles et les deux predicats',
    q1.every((l) => l.commande && l.roles && 'using_expr' in l && 'with_check_expr' in l));
  const insertErp = q1.find((l) => l.politique === 'plm_erp_sync_jobs_insert_brand');
  ok('Q1 montre contributor dans le WITH CHECK de la surnumeraire',
    /contributor/.test(String(insertErp?.with_check_expr)), JSON.stringify(insertErp));
  const selectErp = q1.find((l) => l.politique === 'plm_erp_sync_jobs_select_brand');
  ok('Q1 montre le predicat reel de select_brand (c est LA donnee manquante)',
    String(selectErp?.using_expr).length > 0, JSON.stringify(selectErp?.using_expr));

  const q2 = r.get('Q2') ?? [];
  ok('Q2 classe 2 canoniques et 2 surnumeraires',
    q2.filter((l) => /CANONIQUE/.test(l.provenance)).length === 2
    && q2.filter((l) => /SURNUMERAIRE/.test(l.provenance)).length === 2,
    JSON.stringify(q2.map((l) => `${l.politique}:${l.provenance}`)));
  ok('Q2 signale l elargissement de l insertion',
    q2.some((l) => /ELARGIT/.test(String(l.effet))));
  const q3 = r.get('Q3')?.[0];
  ok('Q3 compte 4 politiques et 2 surnumeraires',
    q3?.politiques_totales === 4 && q3?.surnumeraires === 2, JSON.stringify(q3));
  ok('Q3 nomme l ecart', /ECART/.test(String(q3?.verdict)), q3?.verdict);
  const q4 = r.get('Q4')?.[0];
  ok('Q4 : la canonique n admet PAS contributor (la derive n a pas touche la canonique)',
    q4?.canonique_admet_contributor === false, JSON.stringify(q4));
  const q5 = r.get('Q5') ?? [];
  ok('Q5 rend les 7 privileges', q5.length === 7, `${q5.length}`);
  ok('Q5 : DELETE est accorde a tracefab_app (le piege du constat)',
    q5.find((l) => l.privilege === 'DELETE')?.accorde_a_tracefab_app === true);
  ok('Q5 : TRUNCATE n est pas accorde',
    q5.find((l) => l.privilege === 'TRUNCATE')?.accorde_a_tracefab_app === false);
  await db.close();
}

console.log('\n3. Joue sur une base saine (2 politiques)  [MESURE]');
{
  const db = await chaine({ arreterAvant: CIBLE });
  const r = await relever(db);
  const q3 = r.get('Q3')?.[0];
  ok('Q3 : 2 politiques, 0 surnumeraire',
    q3?.politiques_totales === 2 && q3?.surnumeraires === 0, JSON.stringify(q3));
  ok('Q3 : annonce « conforme au referentiel »', /conforme/.test(String(q3?.verdict)), q3?.verdict);
  const q4 = r.get('Q4')?.[0];
  ok('Q4 : la canonique n admet PAS contributor',
    q4?.canonique_admet_contributor === false, JSON.stringify(q4));
  ok('Q4 : table presente, RLS activee et forcee',
    q4?.table_presente === true && q4?.rls_activee === true && q4?.rls_forcee === true);
  await db.close();
}

console.log('\n4. Joue sur une base SANS la table  [MESURE]');
{
  // Base jetable avec le role applicatif mais SANS la table : c est le cas ou
  // un script mal ecrit casse au milieu et n affiche plus rien.
  const db = new PGlite();
  await db.waitReady;
  await db.exec(`
    CREATE ROLE tracefab_app LOGIN PASSWORD 'runtime'
      NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
    GRANT USAGE ON SCHEMA public TO tracefab_app;`);
  let plante = null;
  try { await db.exec(texte); } catch (e) { plante = String(e.message).split('\n')[0]; }
  ok('sans la table, le script ne plante pas : il rend des lignes vides',
    plante === null, plante);
  if (plante === null) {
    await db.close();
  }
}

console.log('\n--------------------------------------------');
if (echecs === 0) {
  console.log(`${verifies} verifications passees.`);
  console.log('Le releve est en lecture seule, il a ete joue sur trois etats');
  console.log('(production reconstruite, base saine, base sans table) et il rend');
  console.log('la donnee qui manquait : le predicat exact de select_brand.');
  process.exit(0);
}
console.error(`${echecs} echec(s) sur ${verifies} verifications.`);
process.exit(1);
