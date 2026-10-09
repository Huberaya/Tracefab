#!/usr/bin/env node
/**
 * Provisionnement des utilisateurs et isolation, EXECUTES avec le role
 * applicatif reel.
 *
 * POURQUOI CE TEST EXISTE
 *
 * `requireClerkUser` provisionnait l'utilisateur par un `prisma.user.upsert`
 * place AVANT tout armement de contexte — `withTracefabUserContext` n'arrive
 * qu'ensuite, pour la requete metier. Or les politiques de `users` sont :
 *
 *   users_insert_worker  INSERT  CHECK (tracefab.worker_context = 'true')
 *   users_select_self    SELECT  USING (id = tracefab_current_user_id())
 *   users_worker_select  SELECT  USING (tracefab.worker_context = 'true')
 *
 * et la table porte FORCE ROW LEVEL SECURITY, donc meme son proprietaire y est
 * soumis. Sous `tracefab_app` (NOBYPASSRLS), la premiere connexion echouait
 * donc sur « new row violates row-level security policy for table "users" »,
 * et la reconnexion d'un utilisateur deja provisionne n'allait pas mieux : la
 * lecture prealable ne voyait rien, donc l'upsert tentait un INSERT qui butait
 * a son tour.
 *
 * Le defaut etait invisible tant que l'application tournait sous un role
 * privilegie. Ce test s'execute donc sous le role runtime, sans privilege de
 * contournement, et refuse de se declarer vert autrement.
 *
 *   TF_RLS_APP_URL=postgresql://tracefab_app:...@host/base npm run test:rls:auth
 */

import pg from 'pg';

const URL_APP = process.env.TF_RLS_APP_URL;
if (!URL_APP) {
  console.error('  TF_RLS_APP_URL manquant — URL du role applicatif tracefab_app.');
  process.exit(1);
}

let echecs = 0;
const ok = (cond, message) => {
  console.log(`  ${cond ? 'ok   ' : 'ECHEC'} ${message}`);
  if (!cond) echecs += 1;
};

const db = new pg.Client({ connectionString: URL_APP });
await db.connect();

/** Joue un bloc dans une transaction et rend {ok, erreur}. */
async function essai(instructions) {
  try {
    await db.query('BEGIN');
    let dernier = null;
    for (const [sql, params] of instructions) dernier = await db.query(sql, params);
    await db.query('COMMIT');
    return { ok: true, res: dernier };
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    return { ok: false, erreur: e.message.split('\n')[0] };
  }
}

const ARME_WORKER = ["SELECT set_config('tracefab.worker_context','true',true)"];
const CLERK_ID = 'user_chantier1a_' + Date.now();
const EMAIL = `provisionnement.${Date.now()}@chantier1a.test`;

try {
  // --- 0. le role ne doit pas pouvoir contourner la RLS ---
  console.log('\n  0. role d\'execution');
  const who = await db.query(
    "SELECT current_user AS r, (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS bypass, "
    + "(SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS super");
  const { r, bypass, super: sup } = who.rows[0];
  ok(bypass === false && sup === false,
    `role ${r} — rolbypassrls=${bypass}, rolsuper=${sup}`);
  if (bypass || sup) {
    console.log('\n  Un role privilegie rendrait toute la suite sans valeur. Arret.\n');
    process.exit(1);
  }

  // --- 1. NEGATIF : hors contexte, le provisionnement est refuse ---
  console.log('\n  1. negatif — hors contexte (le defaut d\'origine)');
  const sansContexte = await essai([[
    'INSERT INTO users (id, clerk_user_id, email, full_name, created_at, updated_at) '
    + 'VALUES (gen_random_uuid(), $1, $2, $3, now(), now())', [CLERK_ID, EMAIL, 'Provision']]]);
  ok(!sansContexte.ok, `INSERT refuse hors contexte : ${sansContexte.erreur || 'ACCEPTE — fuite'}`);
  ok(/row-level security/i.test(sansContexte.erreur || ''),
    'le refus vient bien de la RLS, pas d\'une autre contrainte');

  const lectureSansContexte = await db.query('SELECT count(*)::int AS n FROM users');
  ok(lectureSansContexte.rows[0].n === 0,
    `hors contexte, users ne rend aucune ligne (${lectureSansContexte.rows[0].n})`);

  // --- 2. POSITIF : premiere connexion sous contexte worker ---
  console.log('\n  2. positif — premiere connexion (contexte worker)');
  const premiere = await essai([
    [ARME_WORKER[0]],
    ['INSERT INTO users (id, clerk_user_id, email, full_name, created_at, updated_at) '
      + 'VALUES (gen_random_uuid(), $1, $2, $3, now(), now()) RETURNING id', [CLERK_ID, EMAIL, 'Provision']],
  ]);
  ok(premiere.ok, `provisionnement accepte : ${premiere.ok ? 'INSERT' : premiere.erreur}`);
  const idCree = premiere.ok ? premiere.res.rows[0].id : null;

  // --- 3. POSITIF : reconnexion d'un utilisateur deja provisionne ---
  console.log('\n  3. positif — reconnexion (upsert en UPDATE)');
  const relecture = await essai([
    [ARME_WORKER[0]],
    ['SELECT id FROM users WHERE clerk_user_id = $1', [CLERK_ID]],
  ]);
  ok(relecture.ok && relecture.res.rowCount === 1,
    `l'utilisateur existant est retrouve (${relecture.ok ? relecture.res.rowCount : relecture.erreur} ligne)`);
  const maj = await essai([
    [ARME_WORKER[0]],
    ['UPDATE users SET full_name = $2, updated_at = now() WHERE clerk_user_id = $1', [CLERK_ID, 'Provision MAJ']],
  ]);
  ok(maj.ok && maj.res.rowCount === 1, `mise a jour acceptee (${maj.ok ? maj.res.rowCount : maj.erreur})`);

  // --- 4. le drapeau worker ne survit pas a la transaction ---
  console.log('\n  4. le contexte ne fuit pas (connexion poolee)');
  const apres = await db.query("SELECT current_setting('tracefab.worker_context', true) AS v");
  ok(!apres.rows[0].v || apres.rows[0].v !== 'true',
    `hors transaction, worker_context = ${JSON.stringify(apres.rows[0].v)}`);
  const relectureHors = await db.query('SELECT count(*)::int AS n FROM users');
  ok(relectureHors.rows[0].n === 0,
    `la table redevient invisible immediatement apres (${relectureHors.rows[0].n} ligne)`);

  // --- 5. contexte utilisateur : chacun ne voit que lui-meme ---
  console.log('\n  5. contexte utilisateur — portee de la lecture');
  const locataires = await essai([
    [ARME_WORKER[0]],
    ["SELECT id, email FROM users WHERE email LIKE '%@rls.fixture.test' ORDER BY email"],
  ]);
  if (!locataires.ok || locataires.res.rowCount < 2) {
    ok(false, 'fixture a deux locataires absente — lancer scripts/seed_rls_fixture.mjs');
  } else {
    const [a, b] = locataires.res.rows;
    const vu = async (id, email) => {
      await db.query('BEGIN');
      await db.query("SELECT set_config('tracefab.user_id', $1, true)", [id]);
      await db.query("SELECT set_config('tracefab.user_email', $1, true)", [email]);
      const res = await db.query('SELECT id, email FROM users');
      await db.query('COMMIT');
      return res.rows;
    };
    const vuA = await vu(a.id, a.email);
    ok(vuA.length === 1 && vuA[0].id === a.id,
      `${a.email} ne voit que lui-meme (${vuA.length} ligne)`);
    const vuB = await vu(b.id, b.email);
    ok(vuB.length === 1 && vuB[0].id === b.id,
      `${b.email} ne voit que lui-meme (${vuB.length} ligne)`);
    ok(vuA[0].id !== vuB[0].id, 'les deux contextes rendent bien des lignes differentes');

    // --- 6. NEGATIF : ecrire la ligne d'autrui ---
    console.log('\n  6. negatif — modifier l\'utilisateur d\'autrui');
    await db.query('BEGIN');
    await db.query("SELECT set_config('tracefab.user_id', $1, true)", [a.id]);
    await db.query("SELECT set_config('tracefab.user_email', $1, true)", [a.email]);
    const ecriture = await db.query('UPDATE users SET full_name = $2 WHERE id = $1', [b.id, 'PIRATE']);
    await db.query('ROLLBACK');
    ok(ecriture.rowCount === 0,
      `${a.email} modifie ${ecriture.rowCount} ligne(s) de ${b.email} — attendu 0`);

    // --- 7. NEGATIF : isolation inter-organisations sur les produits ---
    console.log('\n  7. negatif — isolation inter-organisations');
    const produitsDe = async (id, email) => {
      await db.query('BEGIN');
      await db.query("SELECT set_config('tracefab.user_id', $1, true)", [id]);
      await db.query("SELECT set_config('tracefab.user_email', $1, true)", [email]);
      const res = await db.query('SELECT id, brand_organization_id FROM tracefab_products');
      await db.query('COMMIT');
      return res.rows;
    };
    const pA = await produitsDe(a.id, a.email);
    const pB = await produitsDe(b.id, b.email);
    const idsA = new Set(pA.map((x) => x.id));
    const communs = pB.filter((x) => idsA.has(x.id));
    ok(pA.length > 0 && pB.length > 0,
      `chaque locataire voit ses produits (${pA.length} / ${pB.length})`);
    ok(communs.length === 0,
      `aucun produit visible des deux cotes (${communs.length} en commun)`);
    const orgsA = new Set(pA.map((x) => x.brand_organization_id));
    ok(orgsA.size === 1, `les produits vus par ${a.email} relevent d'une seule organisation`);
  }

  // menage de la ligne de test
  if (idCree) {
    await essai([[ARME_WORKER[0]], ['DELETE FROM users WHERE id = $1', [idCree]]]);
  }
} finally {
  await db.end();
}

console.log(echecs
  ? `\n  ${echecs} echec(s).\n`
  : '\n  Provisionnement et isolation prouves sous le role applicatif reel.\n');
process.exit(echecs ? 1 : 0);
