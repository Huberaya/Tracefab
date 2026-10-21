#!/usr/bin/env node
/**
 * Disponibilité de tracefab_app pour la bascule — STRICTEMENT EN LECTURE SEULE.
 *
 * Contrairement a scripts/test_tracefab_app_readiness.mjs, ce script n'emet
 * AUCUNE ecriture : ni INSERT, ni UPDATE, ni DELETE, ni transaction. Il n'y a
 * donc rien a derouler, et aucune sequence ne s'increment.
 *
 * Il interroge le catalogue PostgreSQL au sujet d'un role cible (tracefab_app
 * par defaut) sans avoir a se connecter sous ce role : aucune nouvelle
 * credential n'est necessaire.
 *
 * Affiche l'hote AVANT toute connexion utile. Aucune chaine de connexion,
 * aucun mot de passe n'est jamais affiche.
 *
 * Sortie : 0 = pret pour la bascule, 1 = obstacle constate, 2 = non execute.
 */
import process from 'node:process';
import pg from 'pg';
import { APP_ROLE, TABLES_ECRITURE_DIRECTE, TABLE_WRITE_PRIVILEGES } from './lib/tracefab_app_role.mjs';
import { RUNTIME_FUNCTION_NAMES } from './lib/tracefab_runtime_functions.mjs';

const url = process.env.DATABASE_URL;
if (!url) {
  console.log('\n  NON EXECUTE — DATABASE_URL est absente.\n');
  process.exit(2);
}

const cible = process.env.TF_CIBLE_ROLE || APP_ROLE;
const { hostname: hote, pathname } = new URL(url);

console.log('');
console.log('  Disponibilité du rôle applicatif — lecture seule');
console.log('');
console.log(`  hote verifie : ${hote}`);
console.log(`  base         : ${pathname.replace(/^\//, '')}`);
console.log(`  role cible   : ${cible}`);
console.log('  Confirmez l hôte avant de lire la suite : c est le seul moyen');
console.log('  de savoir quelle base répond.');
console.log('');
console.log('  Aucune ecriture : ce script n interroge que le catalogue.');
console.log('');

const client = new pg.Client({ connectionString: url });
let obstacles = 0;
// Un ecart a la liste declaree n'est pas un obstacle : une cible qui n'a pas
// encore recu les migrations le montre legitimement. Il est signale, compte,
// et n'influe pas sur le code de sortie.
let ecarts = 0;

try {
  await client.connect();

  // 0. Le role existe-t-il, et quelle est sa posture ?
  const role = await client.query(
    `SELECT rolname, rolsuper, rolbypassrls, rolcanlogin
     FROM pg_roles WHERE rolname = $1`,
    [cible]
  );
  if (role.rows.length === 0) {
    console.log(`  ECHEC — le role ${cible} n existe pas sur cette base.`);
    console.log('');
    process.exit(1);
  }
  const r = role.rows[0];
  console.log(`  1. posture du role`);
  console.log(`     superuser   : ${r.rolsuper}`);
  console.log(`     bypassrls   : ${r.rolbypassrls}`);
  console.log(`     peut se connecter : ${r.rolcanlogin}`);
  if (r.rolbypassrls) {
    console.log('     OBSTACLE : ce role contourne la RLS, la bascule n apporterait rien.');
    obstacles++;
  }
  if (!r.rolcanlogin) {
    console.log('     OBSTACLE : ce role ne peut pas se connecter.');
    obstacles++;
  }
  console.log('');

  // 1. Privileges sur chaque table du schema public.
  //    _prisma_migrations est exclue : c'est la table de journal de Prisma,
  //    reservee au role de migration. L'application ne doit pas y toucher.
  const tables = await client.query(
    `SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
     ORDER BY tablename`
  );
  const noms = tables.rows.map((x) => x.tablename);
  console.log(`  2. privileges sur ${noms.length} tables publiques`);
  console.log('     (_prisma_migrations exclue : reservee au role de migration)');

  // La politique d'ecriture declaree par le depot est TABLES_ECRITURE_DIRECTE
  // (scripts/lib/tracefab_app_role.mjs), la meme liste que celle accordee par le
  // provisioning et verifiee par test:tables-ecriture-directe. Ce script la
  // compare a l'etat MESURE au lieu de supposer un jeu de tables : une base
  // restee en arriere des migrations montre un ecart, et cet ecart doit etre
  // nomme, pas masque derriere un qualificatif vague.
  const declares = new Set(TABLES_ECRITURE_DIRECTE);

  const manquants = { SELECT: [], INSERT: [], UPDATE: [], DELETE: [] };
  const avecDml = [];
  for (const t of noms) {
    const ok = await client.query(
      `SELECT has_table_privilege($1, $2, 'SELECT')  AS s,
              has_table_privilege($1, $2, 'INSERT')  AS i,
              has_table_privilege($1, $2, 'UPDATE')  AS u,
              has_table_privilege($1, $2, 'DELETE')  AS d`,
      [cible, t]
    );
    const r = ok.rows[0];
    if (!r.s) manquants.SELECT.push(t);
    if (!r.i) manquants.INSERT.push(t);
    if (!r.u) manquants.UPDATE.push(t);
    if (!r.d) manquants.DELETE.push(t);
    if (r.i || r.u || r.d) avecDml.push(t);
  }

  const horsListe = avecDml.filter((t) => !declares.has(t));
  const sansDml = TABLES_ECRITURE_DIRECTE.filter((t) => noms.includes(t) && !avecDml.includes(t));
  const absentes = TABLES_ECRITURE_DIRECTE.filter((t) => !noms.includes(t));

  console.log(`     SELECT  absent sur ${manquants.SELECT.length} table(s)`);
  for (const p of ['INSERT', 'UPDATE', 'DELETE']) {
    // L'absence est inattendue seulement si ce verbe précis est requis pour
    // cette table. La simple présence de la table dans l'allowlist ne signifie
    // plus qu'elle doit accepter les trois verbes DML.
    const inattendus = manquants[p].filter((t) => (TABLE_WRITE_PRIVILEGES[t] || []).includes(p));
    const attendus = manquants[p].filter((t) => !(TABLE_WRITE_PRIVILEGES[t] || []).includes(p));
    console.log(`     ${p.padEnd(7)} absent sur ${String(manquants[p].length).padStart(3)} table(s)`
      + ` — ${attendus.length} attendue(s) en lecture seule, ${inattendus.length} inattendue(s)`
      + (inattendus.length ? ' : ' + inattendus.slice(0, 6).join(', ') + (inattendus.length > 6 ? ', …' : '') : ''));
  }
  console.log(`     ecriture directe mesuree sur ${avecDml.length} table(s)`
    + ` — la liste declaree en compte ${TABLES_ECRITURE_DIRECTE.length}`);
  if (horsListe.length) {
    console.log(`     ECART : DML accorde hors liste declaree sur ${horsListe.length} table(s) : `
      + horsListe.slice(0, 8).join(', ') + (horsListe.length > 8 ? ', …' : ''));
    ecarts++;
  }
  if (sansDml.length) {
    console.log(`     ECART : ${sansDml.length} table(s) de la liste declaree sans DML : `
      + sansDml.slice(0, 8).join(', ') + (sansDml.length > 8 ? ', …' : '')
      + ' — verifier si la cible est a jour des migrations.');
    ecarts++;
  }
  if (absentes.length) {
    console.log(`     ECART : ${absentes.length} table(s) de la liste declaree absente(s) de la cible : `
      + absentes.slice(0, 8).join(', '));
    ecarts++;
  }
  // Seul SELECT est indispensable partout. L'absence d'ecriture sur les tables
  // hors liste declaree est le comportement voulu, pas un obstacle ; un ecart a
  // la liste est signale sans bloquer, car il peut provenir d'une cible qui n'a
  // pas encore recu les migrations.
  if (manquants.SELECT.length) {
    console.log('     OBSTACLE : SELECT absent sur ' + manquants.SELECT.slice(0, 8).join(', '));
    obstacles++;
  }
  console.log('');

  // 2. RLS active ET forcee : sans FORCE, le proprietaire de table la contourne.
  const rls = await client.query(
    `SELECT count(*)::int total,
            count(*) FILTER (WHERE relrowsecurity)::int active,
            count(*) FILTER (WHERE relforcerowsecurity)::int forcee
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND c.relname <> '_prisma_migrations'`
  );
  const R = rls.rows[0];
  console.log(`  3. RLS sur les tables`);
  console.log(`     tables : ${R.total} | RLS active : ${R.active} | forcee : ${R.forcee}`);
  if (R.active !== R.total || R.forcee !== R.total) {
    console.log('     OBSTACLE : RLS non active ou non forcee partout.');
    obstacles++;
  }
  const politiques = await client.query(
    `SELECT count(*)::int n FROM pg_policies p
     JOIN pg_class c ON c.relname = p.tablename
     JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = p.schemaname`
  );
  console.log(`     politiques : ${politiques.rows[0].n}`);
  console.log('');

  // 3. EXECUTE : le runtime doit pouvoir appeler l'allowlist explicite, et
  // ne doit pas pouvoir appeler les fonctions SECURITY DEFINER hors allowlist.
  const fns = await client.query(
    `SELECT p.oid AS oid, n.nspname || '.' || p.proname AS nom, p.proname AS proname
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind = 'f'
       AND p.proname = ANY($1::text[])
     ORDER BY 2`,
    [RUNTIME_FUNCTION_NAMES]
  );
  const presentes = new Set(fns.rows.map((f) => f.proname));
  const fonctionsAbsentes = RUNTIME_FUNCTION_NAMES.filter((name) => !presentes.has(name));
  console.log(`  4. EXECUTE sur ${fns.rows.length}/${RUNTIME_FUNCTION_NAMES.length} fonctions de l'allowlist runtime`);
  if (fonctionsAbsentes.length) {
    console.log(`     OBSTACLE : fonctions allowlist absentes : ${fonctionsAbsentes.slice(0, 8).join(', ')}`);
    obstacles++;
  }

  const sansExecute = [];
  for (const f of fns.rows) {
    const ok = await client.query(
      `SELECT has_function_privilege($1, $2::oid, 'EXECUTE') AS ok`,
      [cible, f.oid]
    );
    if (!ok.rows[0].ok) sansExecute.push(f.nom);
  }
  console.log(`     sans EXECUTE sur allowlist : ${sansExecute.length}${sansExecute.length ? ' — ' + sansExecute.slice(0, 6).join(', ') : ''}`);
  if (sansExecute.length) {
    console.log('     OBSTACLE : une fonction runtime autorisée est inaccessible.');
    obstacles++;
  }

  const horsAllowlist = await client.query(
    `SELECT p.oid AS oid, n.nspname || '.' || p.proname AS nom
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prosecdef = true
       AND p.proname <> ALL($1::text[])
     ORDER BY 2`,
    [RUNTIME_FUNCTION_NAMES]
  );
  const ouvertsHorsAllowlist = [];
  for (const f of horsAllowlist.rows) {
    const ok = await client.query(
      `SELECT has_function_privilege($1, $2::oid, 'EXECUTE') AS ok`,
      [cible, f.oid]
    );
    if (ok.rows[0].ok) ouvertsHorsAllowlist.push(f.nom);
  }
  console.log(`     SECURITY DEFINER hors allowlist encore executables : ${ouvertsHorsAllowlist.length}${ouvertsHorsAllowlist.length ? ' — ' + ouvertsHorsAllowlist.slice(0, 6).join(', ') : ''}`);
  if (ouvertsHorsAllowlist.length) {
    console.log('     OBSTACLE : des fonctions SECURITY DEFINER hors allowlist restent appelables.');
    obstacles++;
  }
  console.log('');
  // 5. USAGE sur les sequences : sans lui, les INSERT echouent en 42501.
  const seq = await client.query(
    `SELECT count(*)::int total FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'S'`
  );
  let sansUsage = 0;
  const sequences = await client.query(
    `SELECT c.relname FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'S'`
  );
  for (const s of sequences.rows) {
    const ok = await client.query(`SELECT has_sequence_privilege($1, $2, 'USAGE') AS ok`, [cible, s.relname]);
    if (!ok.rows[0].ok) sansUsage++;
  }
  console.log(`  5. USAGE sur ${seq.rows[0].total} sequence(s)`);
  console.log(`     sans USAGE : ${sansUsage}`);
  if (sansUsage) {
    console.log('     OBSTACLE : des INSERT echoueraient faute d USAGE sur sequence.');
    obstacles++;
  }
  console.log('');

  if (obstacles === 0 && ecarts === 0) {
    console.log('  VERDICT : le role est pret pour la bascule. Rien ne s y oppose');
    console.log('  cote privileges. Cela ne dispense pas d un test d isolation en');
    console.log('  ecriture sur une branche enfant : ce script ne verifie que le');
    console.log('  catalogue, jamais le comportement reel des politiques.');
  } else if (obstacles === 0) {
    console.log(`  VERDICT : aucun obstacle cote privileges, mais ${ecarts} ecart(s)`);
    console.log('  a la liste declaree. Les nommer et les classer avant toute');
    console.log('  conclusion : un ecart peut venir d une cible en retard de');
    console.log('  migrations, pas d un privilege accorde a tort.');
  } else {
    console.log(`  VERDICT : ${obstacles} obstacle(s) avant bascule`);
    if (ecarts) console.log(`  et ${ecarts} ecart(s) a la liste declaree.`);
  }
} catch (erreur) {
  console.log(`  ECHEC — ${erreur.code ?? erreur.message}`);
  obstacles = -1;
} finally {
  await client.end();
}

console.log('');
process.exit(obstacles === 0 ? 0 : 1);
