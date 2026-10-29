#!/usr/bin/env node
/**
 * Appartenances de rôles : ce que chaque SENS accorde réellement.
 *
 * POURQUOI CE TEST EXISTE
 *
 * La lecture de production relève deux appartenances entre `neondb_owner` et
 * `tracefab_app`, avec des options différentes. Le sens de ces appartenances
 * décide de la valeur de TOUT le reste : `neondb_owner` porte `BYPASSRLS`. Si
 * `tracefab_app` était membre de `neondb_owner`, il hériterait de ce privilège
 * et la RLS lue table par table, politique par politique, serait sans effet.
 *
 * Une note de lecture ne tranche pas : « neondb_owner est membre de
 * tracefab_app » et « tracefab_app est membre de neondb_owner » se ressemblent
 * à l'écrit et n'ont rien à voir. Ce test les SÉPARE et mesure, sur PostgreSQL
 * réel, ce que chacune permet.
 *
 * CE QUI EST MESURÉ
 *
 *   1. `tracefab_app` membre de `neondb_owner` : l'héritage ne donne PAS
 *      BYPASSRLS (les attributs ne s'héritent pas) — mais `SET ROLE` le donne.
 *      C'est le cas dangereux, et par un autre chemin qu'on ne le croit.
 *   2. `neondb_owner` membre de `tracefab_app` → qu'est-ce que cela donne ?
 *      (le cas bénin : le rôle privilégié reçoit les droits du rôle faible)
 *   3. `inherit_option = false` → l'héritage est-il réellement coupé ?
 *   4. `SET ROLE` → l'appartenance sans INHERIT permet-elle quand même
 *      d'atteindre les privilèges du rôle ?
 *
 * CE QUE CE TEST N'ÉTABLIT PAS
 *
 *   Le sens réel en production. Il établit ce que chaque sens PRODUIRAIT, et
 *   fournit la requête qui lit le sens réel (docs/security/...-roles-production.sql).
 *
 *   npm run test:appartenances-roles
 */
const { PGlite } = await import('@electric-sql/pglite');
const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto');
const { uuid_ossp } = await import('@electric-sql/pglite/contrib/uuid_ossp');

let echecs = 0;
let verifies = 0;
const ok = (libelle, condition, detail = '') => {
  verifies += 1;
  if (condition) { console.log(`  ok    ${libelle}`); return; }
  echecs += 1;
  console.error(`  ECHEC ${libelle}${detail ? ` — ${detail}` : ''}`);
};

/** Le socle : une table sous RLS forcée, propriétaire = rôle d'administration. */
async function base() {
  const db = new PGlite({ extensions: { pgcrypto, uuid_ossp } });
  await db.waitReady;
  await db.exec(`
    -- Le fournisseur : propriétaire, BYPASSRLS. Ne se connecte pas (NOLOGIN)
    -- pour que le test ne puisse pas le prendre pour le rôle applicatif.
    CREATE ROLE neondb_owner NOLOGIN BYPASSRLS CREATEROLE CREATEDB;
    CREATE ROLE neon_service  NOLOGIN BYPASSRLS CREATEROLE CREATEDB;
    -- L'application : connexion, aucun privilège d'évasion.
    CREATE ROLE tracefab_app LOGIN PASSWORD 'runtime' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;

    -- Le DDL est fait par le superutilisateur du cluster jetable (PG 15+ a
    -- retire CREATE sur le schema public a PUBLIC), puis l objet est confie a
    -- neondb_owner : c est la proprietaire qui compte pour FORCE RLS.
    CREATE TABLE public.secrets (id int PRIMARY KEY, tenant uuid NOT NULL, val text);
    INSERT INTO public.secrets VALUES
      (1, 'aaaaaaaa-0000-0000-0000-000000000001', 'tenant A'),
      (2, 'bbbbbbbb-0000-0000-0000-000000000002', 'tenant B');
    ALTER TABLE public.secrets OWNER TO neondb_owner;
    ALTER TABLE public.secrets ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.secrets FORCE ROW LEVEL SECURITY;
    CREATE POLICY secrets_tenant ON public.secrets
      USING (tenant = NULLIF(current_setting('tracefab.tenant', true), '')::uuid);
    GRANT SELECT, INSERT ON public.secrets TO tracefab_app;
    GRANT USAGE ON SCHEMA public TO tracefab_app;
  `);
  return db;
}

/**
 * Combien de lignes `tracefab_app` voit-il, locataire A arme ?
 *
 * `db.query` refuse plusieurs instructions dans une requete preparee : on les
 * enchaine donc en instructions distinctes. `SET ROLE` et le GUC valent pour la
 * session, pas pour la transaction — mais on remet l etat a zero explicitement
 * pour que chaque mesure soit independante de la precedente.
 */
async function lignesVues(db) {
  await db.exec('RESET ROLE;');
  await db.exec('SET ROLE tracefab_app;');
  await db.exec("SET tracefab.tenant = 'aaaaaaaa-0000-0000-0000-000000000001';");
  try {
    const { rows } = await db.query('SELECT count(*)::int AS n FROM public.secrets');
    return rows[0].n;
  } finally {
    await db.exec('RESET ROLE;');
  }
}

/** `tracefab_app` peut-il LIRE sans RLS (donc voir le tenant B) ? */
async function contourne(db) {
  try {
    const n = await lignesVues(db);
    return { contourne: n > 1, n };
  } catch (e) {
    return { contourne: false, n: -1, message: String(e.message).split('\n')[0].slice(0, 90) };
  }
}

/* ==========================================================================
   0. Le socle : sans appartenance, la RLS tient
   ========================================================================== */

console.log('\n  0. Socle — aucune appartenance');

const temoin = await base();
{
  const r = await contourne(temoin);
  ok('sans appartenance, tracefab_app ne voit QUE son locataire (1 ligne)',
    r.n === 1, `n=${r.n} ${r.message || ''}`);
  const attr = await temoin.query(
    "SELECT rolbypassrls::text AS b FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_app'");
  ok('tracefab_app a rolbypassrls=false', attr.rows[0].b === 'false', attr.rows[0].b);
}

/* ==========================================================================
   1. LE CAS DANGEREUX : tracefab_app membre de neondb_owner
   ========================================================================== */

console.log('\n  1. Sens DANGEREUX — tracefab_app membre de neondb_owner');

{
  const db = await base();
  // PG 18 : `GRANT x TO y` se lit « y devient membre de x ».
  await db.exec('GRANT neondb_owner TO tracefab_app;');

  const attr = await db.query(
    "SELECT rolbypassrls::text AS b FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_app'");
  ok('tracefab_app garde rolbypassrls=false sur SA propre ligne',
    attr.rows[0].b === 'false', attr.rows[0].b);

  /**
   * NUANCE IMPORTANTE, ET ELLE CHANGE LA CONCLUSION OPERATIONNELLE.
   *
   * Les ATTRIBUTS de role — SUPERUSER, BYPASSRLS, CREATEROLE, CREATEDB — ne
   * s'heritent PAS par appartenance. Seuls les PRIVILEGES sur les objets
   * s'heritent. Un membre herite donc du droit de lire une table, jamais du
   * droit de contourner la RLS.
   *
   * Mesure : avec l'appartenance seule, `tracefab_app` voit toujours UNE ligne.
   * Ce n'est donc pas l'heritage qui est dangereux.
   */
  const r = await contourne(db);
  ok('l appartenance seule n accorde PAS BYPASSRLS par heritage (les attributs ne s heritent pas)',
    r.n === 1, `n=${r.n}`);

  /**
   * Mais l'appartenance autorise `SET ROLE neondb_owner`, et LA le role porte
   * son attribut : la RLS tombe. C'est le vrai chemin d'evasion, et il ne
   * demande aucun heritage.
   */
  await db.exec('RESET ROLE;');
  await db.exec('SET ROLE tracefab_app;');
  await db.exec('SET ROLE neondb_owner;');
  const parSetRole = (await db.query('SELECT count(*)::int AS n FROM public.secrets')).rows[0].n;
  await db.exec('RESET ROLE;');
  ok('mais SET ROLE neondb_owner donne BYPASSRLS : les deux locataires sont visibles',
    parSetRole === 2, `n=${parSetRole}`);
  console.log('        => le danger n est pas l heritage, c est la possibilite de SET ROLE');

  const membre = await db.query(`
    SELECT r.rolname AS role_fourni, m.rolname AS membre
      FROM pg_catalog.pg_auth_members am
      JOIN pg_catalog.pg_roles r ON r.oid = am.roleid
      JOIN pg_catalog.pg_roles m ON m.oid = am.member
     WHERE m.rolname = 'tracefab_app'`);
  ok('la requête de lecture nomme le sens sans ambiguïté',
    membre.rows.length === 1
    && membre.rows[0].role_fourni === 'neondb_owner'
    && membre.rows[0].membre === 'tracefab_app',
    JSON.stringify(membre.rows));

  await db.exec('REVOKE neondb_owner FROM tracefab_app;');
  const apres = await contourne(db);
  ok('révoquer l appartenance rétablit la RLS immédiatement',
    apres.n === 1, `n=${apres.n}`);
  await db.close();
}

/* ==========================================================================
   2. LE CAS BÉNIN : neondb_owner membre de tracefab_app
   ========================================================================== */

console.log('\n  2. Sens BÉNIN — neondb_owner membre de tracefab_app');

{
  const db = await base();
  await db.exec('GRANT tracefab_app TO neondb_owner;');

  const r = await contourne(db);
  ok('tracefab_app ne gagne RIEN : il voit toujours une seule ligne',
    r.n === 1, `n=${r.n}`);
  console.log('        (neondb_owner reçoit les droits de tracefab_app — il les avait déjà)');

  const attr = await db.query(
    "SELECT rolbypassrls::text AS b FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_app'");
  ok('tracefab_app reste rolbypassrls=false', attr.rows[0].b === 'false', attr.rows[0].b);
  await db.close();
}

/* ==========================================================================
   3. inherit_option = false coupe-t-il vraiment l'héritage ?
   ========================================================================== */

console.log('\n  3. inherit_option = false');

{
  const db = await base();
  await db.exec('GRANT neondb_owner TO tracefab_app WITH INHERIT FALSE;');
  const r = await contourne(db);
  ok('sans INHERIT, les privilèges du rôle fourni ne sont PAS hérités',
    r.n === 1, `n=${r.n} ${r.message || ''}`);

  // ... mais l'appartenance reste utilisable par SET ROLE.
  await db.exec('RESET ROLE;');
  // L'appartenance sans INHERIT ne donne pas les PRIVILEGES, mais elle autorise
  // SET ROLE : celui qui peut se connecter comme le role membre peut endosser
  // le role fourni et, de la, atteindre BYPASSRLS.
  await db.exec('RESET ROLE;');
  await db.exec('SET ROLE tracefab_app;');
  let setRole = null;
  let vues = null;
  try {
    await db.exec('SET ROLE neondb_owner;');
    setRole = true;
    const { rows } = await db.query('SELECT count(*)::int AS n FROM public.secrets');
    vues = rows[0].n;
  } catch (e) { setRole = false; }
  await db.exec('RESET ROLE;');
  ok('mais SET ROLE reste possible depuis le role membre — donc le danger demeure',
    setRole === true, 'SET ROLE a echoue');
  ok('et par SET ROLE, tracefab_app voit alors les deux locataires',
    vues === 2, `n=${vues}`);

  const opts = await db.query(`
    SELECT am.inherit_option::text AS i, am.set_option::text AS s, am.admin_option::text AS a,
           pg_catalog.pg_get_userbyid(am.grantor) AS grantor
      FROM pg_catalog.pg_auth_members am
      JOIN pg_catalog.pg_roles r ON r.oid = am.roleid
      JOIN pg_catalog.pg_roles m ON m.oid = am.member
     WHERE m.rolname = 'tracefab_app' AND r.rolname = 'neondb_owner'`);
  ok('les options sont lisibles séparément (admin / inherit / set)',
    opts.rows.length === 1
    && opts.rows[0].i === 'false'
    && opts.rows[0].s === 'true',
    JSON.stringify(opts.rows));
  await db.close();
}

/* ==========================================================================
   4. Ce que la lecture de production doit rendre, et pourquoi
   ========================================================================== */

console.log('\n  4. La lecture qui tranche (lecture seule)');

{
  const db = await base();
  const f = (await db.query("SELECT pg_catalog.pg_has_role('tracefab_app', 'neondb_owner', 'USAGE')::text AS x")).rows[0].x;
  ok('tracefab_has_privs_of_role distingue les deux sens (ici false, sans appartenance)',
    f === 'false', f);
  await db.exec('GRANT neondb_owner TO tracefab_app;');
  const g = (await db.query("SELECT pg_catalog.pg_has_role('tracefab_app', 'neondb_owner', 'USAGE')::text AS x")).rows[0].x;
  ok('et passe à true dès que le sens dangereux existe', g === 'true', g);
  await db.exec('REVOKE neondb_owner FROM tracefab_app;');
  const h = (await db.query("SELECT pg_catalog.pg_has_role('tracefab_app', 'neondb_owner', 'MEMBER')::text AS x")).rows[0].x;
  ok('pg_has_role MEMBER est faux après révocation', h === 'false', h);
  await db.close();
}

console.log('\n  --------------------------------------------');
if (echecs === 0) {
  console.log(`  ${verifies} verifications passees.`);
  console.log('  Le sens des appartenances est mesuré ; la lecture de production');
  console.log('  distingue les deux cas sans ambiguïté.');
  process.exit(0);
}
console.error(`  ${echecs} echec(s) sur ${verifies}.`);
process.exit(1);
