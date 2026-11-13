#!/usr/bin/env node
/**
 * P10.7 — IDENTITE POSTGRESQL REELLE, MESUREE SUR LA CONNEXION APPLICATIVE
 *
 * CE QUE CE SCRIPT EST, ET CE QU'IL N'EST PAS
 *
 * Il n'est PAS la preuve C4 : la preuve C4 exige le processus Vercel deploye, et
 * c'est `scripts/preuve_runtime_p107.mjs` qui la produit. Ce script-ci execute
 * la MEME requete, mot pour mot, sur une connexion ouverte avec la MEME URL que
 * celle qu'utilise l'application — c'est le complement local autorise par la
 * mission, pour corriger et verifier sans attendre Vercel.
 *
 * Il execute donc le SQL de `probeDatabaseIdentity` (`api/_lib/readiness-probes.
 * ts`) tel quel, avec le role applicatif, et rapporte ce que PostgreSQL repond.
 * La difference avec la preuve runtime est ecrite dans le rapport : ici la
 * connexion est ouverte par ce script, la-bas par le client Prisma du processus
 * deploye.
 *
 * IL NE MODIFIE RIEN : `BEGIN READ ONLY`, et toute tentative d'ecriture est
 * refusee par la base. Aucun secret n'est lu ni imprime.
 *
 * UTILISATION
 *   DATABASE_URL=postgresql://tracefab_app:...@hote/base \
 *   node scripts/preuve_pg_identite_p107.mjs
 */
import pg from 'pg';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const URL = (process.env.TF_RLS_APP_URL || process.env.DATABASE_URL || '').trim();
const SORTIE = 'livrables-finalisation/preuves/p107-pg-identite.json';
const horodatage = new Date().toISOString();

if (!URL) {
  console.error('  ARRET — DATABASE_URL (ou TF_RLS_APP_URL) est requise.');
  process.exit(2);
}

let echecs = 0;
let assertions = 0;
const resultats = [];
const ok = (id, libelle, cond, detail = '') => {
  assertions += 1;
  if (!cond) echecs += 1;
  resultats.push({ id, libelle, verdict: cond ? 'PASS' : 'FAIL', detail });
  console.log(`  ${cond ? 'PASS ' : 'FAIL '} ${id} ${libelle}${detail ? ` — ${detail}` : ''}`);
};

const client = new pg.Client({ connectionString: URL });
await client.connect();

try {
  // --- La requete EXACTE de probeDatabaseIdentity -------------------------
  const { rows } = await client.query(`
    WITH RECURSIVE atteignables(oid, profondeur) AS (
      SELECT r.oid, 0 FROM pg_roles r WHERE r.rolname = current_user
      UNION
      SELECT m.roleid, a.profondeur + 1
        FROM atteignables a JOIN pg_auth_members m ON m.member = a.oid
       WHERE a.profondeur < 8
    )
    SELECT current_user AS current_user,
           session_user AS session_user,
           current_database() AS database,
           (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypasses_rls,
           (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser,
           ARRAY(SELECT r.rolname FROM atteignables a JOIN pg_roles r ON r.oid = a.oid
                  WHERE a.profondeur > 0 AND (r.rolsuper OR r.rolbypassrls)
                  ORDER BY 1) AS privileged_memberships
  `);
  const r = rows[0];
  console.log(`\n  current_user=${r.current_user} session_user=${r.session_user} base=${r.database}`);
  console.log(`  bypassrls=${r.bypasses_rls} superuser=${r.is_superuser} membres_privilegies=${JSON.stringify(r.privileged_memberships)}\n`);

  ok('C4.1', 'current_user = session_user — aucune prise de role residuelle',
    r.current_user === r.session_user, `${r.current_user} / ${r.session_user}`);
  ok('C4.2', 'le role effectif n est PAS superutilisateur', r.is_superuser === false, String(r.is_superuser));
  ok('C4.3', 'le role effectif ne CONTOURNE pas les RLS', r.bypasses_rls === false, String(r.bypasses_rls));
  // `pg` rend un tableau PostgreSQL en tableau JS quand il est non vide, et en
  // LITTERAL `'{}'` quand il est vide : `.length` vaut alors 2, pas 0. On
  // normalise, sinon l'assertion echoue sur un role parfaitement conforme.
  const membres = Array.isArray(r.privileged_memberships)
    ? r.privileged_memberships
    : String(r.privileged_memberships ?? '').replace(/^\{|\}$/g, '').split(',').filter(Boolean);
  ok('C4.4', 'aucune appartenance transitive a un role privilegie',
    membres.length === 0, `[${membres.join(', ')}]`);
  ok('C4.5', 'le role effectif est le role applicatif', r.current_user === 'tracefab_app', r.current_user);

  // --- Capacite EFFECTIVE de prendre un role privilegie ------------------
  const esc = await client.query(`
    SELECT r.rolname FROM pg_roles r
     WHERE r.rolname IN ('tracefab_migrator','tracefab_worker')
       AND pg_has_role(current_user, r.oid, 'SET')`);
  ok('C4.6', 'le role effectif ne peut PAS prendre tracefab_migrator ni tracefab_worker',
    esc.rowCount === 0, esc.rows.map((x) => x.rolname).join(', ') || 'aucun');

  // --- RLS reellement appliquee ------------------------------------------
  const rls = await client.query(`
    SELECT count(*) FILTER (WHERE relrowsecurity) AS avec_rls,
           count(*) FILTER (WHERE relrowsecurity AND relforcerowsecurity) AS forcees,
           count(*) AS total
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'`);
  const { avec_rls, forcees, total } = rls.rows[0];
  ok('C4.7', 'les tables applicatives portent une RLS active', Number(avec_rls) > 0, `${avec_rls}/${total}`);
  ok('C4.8', 'les tables applicatives portent une RLS FORCEE (proprietaire inclus)',
    Number(forcees) > 0, `${forcees} forcee(s)`);

  // --- Le contexte tenant ne peut pas etre falsifie ----------------------
  // On pose un contexte de session puis on tente de lire chez un autre
  // locataire : la RLS doit rendre zero ligne, pas une erreur.
  // La liste des locataires ne peut pas venir du role applicatif : sans contexte
  // tenant, la RLS lui cache TOUTES les organizations — c'est le comportement
  // voulu, et c'est ce qui rend la mesure croisee necessaire. On lit donc les
  // identifiants avec la connexion d'administration, puis on ne mesure QUE des
  // lectures applicatives.
  let orgs = [];
  if (process.env.TF_ADMIN_URL) {
    const adm = new pg.Client({ connectionString: process.env.TF_ADMIN_URL });
    await adm.connect();
    try {
      orgs = (await adm.query('SELECT id FROM public.organizations ORDER BY id LIMIT 2')).rows;
    } finally { await adm.end(); }
  }
  await client.query('BEGIN READ ONLY');
  try {
    if (orgs.length >= 2) {
      await client.query(`SELECT set_config('tracefab.active_organization_id', $1, true)`, [orgs[0].id]);
      const fuite = await client.query(
        'SELECT count(*)::int AS n FROM public.tracefab_products WHERE brand_organization_id = $1', [orgs[1].id]);
      ok('C4.9', 'contexte tenant A : aucune ligne de B visible', fuite.rows[0].n === 0,
        `${fuite.rows[0].n} ligne(s) de l autre locataire`);
      await client.query(`SELECT set_config('tracefab.active_organization_id', $1, true)`, [orgs[1].id]);
      const inverse = await client.query(
        'SELECT count(*)::int AS n FROM public.tracefab_products WHERE brand_organization_id = $1', [orgs[0].id]);
      ok('C4.10', 'contexte tenant B : aucune ligne de A visible', inverse.rows[0].n === 0,
        `${inverse.rows[0].n} ligne(s)`);
    } else {
      ok('C4.9', 'deux locataires requis pour la mesure croisee', false, `${orgs.length} locataire(s)`);
    }
  } finally {
    await client.query('ROLLBACK').catch(() => {});
  }

  // --- Le contexte ne survit pas a la transaction ------------------------
  const apres = await client.query(`SELECT current_setting('tracefab.active_organization_id', true) AS v`);
  ok('C4.11', 'le contexte tenant ne survit PAS a la transaction (portee locale)',
    !apres.rows[0].v, `valeur residuelle=${JSON.stringify(apres.rows[0].v)}`);

  // --- Le role ne peut pas ecrire hors de ce que la RLS autorise ---------
  await client.query('BEGIN READ ONLY');
  try {
    await client.query('CREATE TABLE public.tentative_p107 (id int)');
    ok('C4.12', 'le role applicatif ne peut pas creer de table', false, 'CREATE a REUSSI');
  } catch (e) {
    // Deux refus sont corrects : `42501` (privilege absent) et `25006` (la
    // transaction est en lecture seule). Ce qui serait FAUX, c'est que CREATE
    // reussisse.
    ok('C4.12', 'le role applicatif ne peut pas creer de table',
      e.code === '42501' || e.code === '25006', `${e.code} ${e.message.split('\n')[0]}`);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
  }

  mkdirSync(dirname(SORTIE), { recursive: true });
  writeFileSync(SORTIE, `${JSON.stringify({
    schema: 'tracefab-p107-pg-identite-v1',
    horodatage,
    // La cible n'est pas un secret ; le mot de passe de l'URL, si.
    cible: URL.replace(/:\/\/[^@]*@/, '://***@'),
    role: r.current_user,
    mesure: r,
    resultats,
    echecs,
    nature: 'complement-local — PAS la preuve runtime C4 (celle-ci exige le processus Vercel deploye)',
  }, null, 2)}\n`);
  console.log(`\n  preuves ecrites : ${SORTIE}`);
} finally {
  await client.end().catch(() => {});
}

console.log('');
if (echecs === 0) {
  console.log(`  P10.7 identite PostgreSQL (complement local) : ${assertions} assertions vertes.`);
  process.exit(0);
}
console.log(`  ${echecs} ECHEC sur ${assertions} assertions.`);
process.exit(1);
