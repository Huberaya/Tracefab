#!/usr/bin/env node
/**
 * AUDIT DES PRIVILEGES ET DE LA RLS EFFECTIFS — lecture seule, aucune connexion
 * distante implicite : on mesure la base qu'on vous donne, rien d'autre.
 *
 * POURQUOI CE SCRIPT EXISTE
 *
 * Une migration qui contient `GRANT` ne prouve pas ce que la base accorde. Les
 * droits herites, les privileges par defaut, les fonctions SECURITY DEFINER et
 * les tables oubliees font diverger l'intention du code et l'etat reel. Le
 * 27/10/2026, la question posee etait precise : « quelle table publique n'a pas
 * la RLS activee ET forcee ? » — elle ne se repond pas en lisant le SQL, elle se
 * lit dans le catalogue.
 *
 * CE QU'IL MESURE
 *   1. pour chaque table du schema public : proprietaire, RLS activee, RLS
 *      FORCEE (le point qui decide si le proprietaire lui-meme est soumis aux
 *      politiques), et les droits de `tracefab_app` ;
 *   2. les tables accessibles en ecriture au role applicatif SANS RLS forcee —
 *      c'est la liste des fuites inter-organisations possibles ;
 *   3. les sequences et leurs droits ;
 *   4. les fonctions : SECURITY DEFINER, `search_path` fige, qui peut executer,
 *      et surtout celles executables par PUBLIC ;
 *   5. les privileges par defaut enregistres dans le catalogue ;
 *   6. les politiques RLS par table, avec leur commande et leur expression.
 *
 * CODES DE SORTIE
 *   0 aucune anomalie de la liste bloquante ;
 *   1 au moins une anomalie bloquante (ecriture possible sur une table sans RLS
 *     forcee, fonction SECURITY DEFINER sans search_path, ou PUBLIC executer) ;
 *   2 usage ou connexion impossible.
 *
 * Le script n'ecrit rien : uniquement des SELECT sur le catalogue.
 */
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';

const url = process.env.DATABASE_URL;
if (!url) { console.error('NON EXECUTE — DATABASE_URL obligatoire.'); process.exit(2); }
if (process.env.TF_EXIGER_LOCAL === 'oui' && !/@(127\.0\.0\.1|localhost)[:/]/.test(url)) {
  console.error('REFUS — TF_EXIGER_LOCAL=oui et la cible n\'est pas locale.');
  process.exit(2);
}
const ROLE_APP = process.env.TF_ROLE_APP || 'tracefab_app';
const argJson = process.argv.indexOf('--json');
const cheminJson = argJson > -1 ? process.argv[argJson + 1] : null;

const client = new pg.Client({ connectionString: url, ssl: sslDepuisUrl(url), application_name: 'tracefab-audit-privileges' });
await client.connect();

const bloquantes = [];
const remarques = [];
const titre = (t) => console.log(`\n${t}\n${'-'.repeat(t.length)}`);

// 1. Etat RLS des tables -----------------------------------------------------
titre('Tables du schema public — RLS et droits du role applicatif');
const { rows: tables } = await client.query(`
  SELECT c.relname AS table,
         pg_get_userbyid(c.relowner) AS proprietaire,
         c.relrowsecurity AS rls,
         c.relforcerowsecurity AS rls_forcee,
         COALESCE(bool_or(a.privilege_type = 'SELECT'), false) AS sel,
         COALESCE(bool_or(a.privilege_type = 'INSERT'), false) AS ins,
         COALESCE(bool_or(a.privilege_type = 'UPDATE'), false) AS upd,
         COALESCE(bool_or(a.privilege_type = 'DELETE'), false) AS del,
         (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS politiques
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN information_schema.role_table_grants a
           ON a.table_schema = 'public' AND a.table_name = c.relname AND a.grantee = $1
   WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
   GROUP BY c.oid, c.relname, c.relowner, c.relrowsecurity, c.relforcerowsecurity
   ORDER BY c.relname`, [ROLE_APP]);

const sansRls = tables.filter((t) => !t.rls);
const rlsNonForcee = tables.filter((t) => t.rls && !t.rls_forcee);
for (const t of tables) {
  const droits = [t.sel && 'S', t.ins && 'I', t.upd && 'U', t.del && 'D'].filter(Boolean).join('') || '—';
  const etat = !t.rls ? 'RLS ABSENTE' : (t.rls_forcee ? 'RLS forcee' : 'RLS non forcee');
  const marque = !t.rls && (t.ins || t.upd || t.del) ? 'ECHEC' : '     ';
  console.log(`  ${marque} ${t.table.padEnd(38)} ${droits.padEnd(4)} ${etat.padEnd(14)} politiques=${String(t.politiques).padStart(2)} prop=${t.proprietaire}`);
}

const ecritureSansRls = sansRls.filter((t) => t.ins || t.upd || t.del);
for (const t of ecritureSansRls) {
  bloquantes.push(`${ROLE_APP} peut ecrire sur « ${t.table} » qui n'a PAS la RLS activee`);
}
for (const t of sansRls) {
  if (!(t.ins || t.upd || t.del)) {
    remarques.push(`« ${t.table} » sans RLS ni droit d'ecriture pour ${ROLE_APP} : exposition de lecture seule via d'autres roles a verifier`);
  }
}

titre('Tables sans RLS forcee (le proprietaire echappe aux politiques)');
if (!rlsNonForcee.length) console.log('  (aucune)');
for (const t of rlsNonForcee) {
  console.log(`  ${t.table.padEnd(38)} proprietaire=${t.proprietaire}`);
  // Nuance : sans FORCE, un role PROPRIETAIRE contourne la RLS. Pour un role
  // non proprietaire comme tracefab_app, la RLS s'applique quand meme. Le vrai
  // risque depend donc de QUI se connecte, pas seulement de la table.
  remarques.push(`« ${t.table} » : RLS non FORCEE — tout role proprietaire (neondb_owner) contourne les politiques`);
}

// 2. Sequences ---------------------------------------------------------------
titre('Sequences');
const { rows: seqs } = await client.query(`
  SELECT c.relname AS sequence,
         has_sequence_privilege($1, c.oid, 'USAGE') AS usage,
         has_sequence_privilege($1, c.oid, 'UPDATE') AS maj
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'S' ORDER BY 1`, [ROLE_APP]);
const seqEcrire = seqs.filter((s) => s.maj || s.usage);
console.log(`  ${seqs.length} sequence(s) ; ${seqEcrire.length} accessible(s) par ${ROLE_APP}`);
for (const s of seqEcrire.slice(0, 12)) console.log(`    ${s.sequence} USAGE=${s.usage} UPDATE=${s.maj}`);

// 3. Fonctions ---------------------------------------------------------------
titre('Fonctions — SECURITY DEFINER, search_path, EXECUTE');
const { rows: fns } = await client.query(`
  SELECT p.proname,
         pg_get_userbyid(p.proowner) AS proprietaire,
         p.prosecdef AS security_definer,
         COALESCE(array_to_string(p.proconfig, ','), '') AS config,
         has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
         has_function_privilege($1, p.oid, 'EXECUTE') AS app_exec,
         pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prokind IN ('f','p')
   ORDER BY p.prosecdef DESC, p.proname`, [ROLE_APP]);
const definerSansSearchPath = fns.filter((f) => f.security_definer && !/search_path/.test(f.config));
const publicExec = fns.filter((f) => f.public_exec);
console.log(`  ${fns.length} fonction(s) · ${fns.filter((f) => f.security_definer).length} SECURITY DEFINER · ${publicExec.length} executable(s) par PUBLIC`);
if (definerSansSearchPath.length) {
  for (const f of definerSansSearchPath) {
    console.log(`  ECHEC SECURITY DEFINER sans search_path fige : ${f.proname}(${f.args})`);
    bloquantes.push(`fonction SECURITY DEFINER sans search_path fige : ${f.proname}`);
  }
} else {
  console.log('  ok    toute fonction SECURITY DEFINER fige son search_path');
}
for (const f of publicExec) {
  console.log(`  ECHEC executable par PUBLIC : ${f.proname}(${f.args}) necessaire=${!f.app_exec}`);
  bloquantes.push(`fonction executable par PUBLIC : ${f.proname}`);
}

// 4. Privileges par defaut ---------------------------------------------------
titre('Privileges par defaut (ACL par defaut du catalogue)');
const { rows: defauts } = await client.query(`
  SELECT pg_get_userbyid(d.defaclrole) AS createur,
         n.nspname AS schema,
         d.defaclobjtype AS objet,
         pg_get_userbyid(d.defaclrole) AS ignore,
         array_to_string(d.defaclacl, ' | ') AS acl
    FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace`);
if (!defauts.length) console.log('  (aucun)');
for (const d of defauts) console.log(`  ${d.createur} · ${d.schema || '(tous)'} · ${d.objet} · ${d.acl}`);
const defautsVersApp = defauts.filter((d) => /tracefab_app/.test(d.acl || ''));
if (defautsVersApp.length) {
  for (const d of defautsVersApp) {
    remarques.push(`privilège par défaut accordé à ${ROLE_APP} sur de futurs objets ${d.objet} (${d.schema || 'tous schémas'})`);
  }
}

// 5. Politiques RLS ----------------------------------------------------------
titre('Politiques RLS');
const { rows: pols } = await client.query(`
  SELECT tablename, policyname, cmd, roles::text AS roles, qual, with_check
    FROM pg_policies WHERE schemaname = 'public'
   ORDER BY tablename, policyname`);
const permissives = pols.filter((p) => /true/.test(p.qual || '') || /true/.test(p.with_check || ''));
console.log(`  ${pols.length} politique(s) sur ${new Set(pols.map((p) => p.tablename)).size} table(s)`);
for (const p of permissives) {
  console.log(`  ATTENTION politique permissive : ${p.tablename}.${p.policyname} cmd=${p.cmd} roles=${p.roles}`);
  remarques.push(`politique permissive sur ${p.tablename}.${p.policyname} (cmd ${p.cmd})`);
}

await client.end();

// Bilan ----------------------------------------------------------------------
titre('Bilan');
for (const b of bloquantes) console.error(`  BLOQUANT ${b}`);
for (const r of remarques) console.log(`  remarque ${r}`);
console.log(`\n  ${bloquantes.length} anomalie(s) bloquante(s), ${remarques.length} remarque(s).`);

if (cheminJson) {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { dirname, resolve } = await import('node:path');
  const chemin = resolve(process.cwd(), cheminJson);
  mkdirSync(dirname(chemin), { recursive: true });
  writeFileSync(chemin, JSON.stringify({ tables, sequences: seqs, fonctions: fns, politiques: pols, defauts, bloquantes, remarques }, null, 2));
  console.log(`  rapport JSON : ${cheminJson}`);
}
process.exit(bloquantes.length ? 1 : 0);
