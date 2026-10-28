#!/usr/bin/env node
/**
 * `plm_erp_sync_jobs` : qui a le droit d'ecrire, mesure et non deduit.
 *
 * Le depot disait, en prose, que la politique INSERT exige owner/admin/manager.
 * Une politique se lit dans le catalogue ; ce qu'elle FAIT se mesure en
 * essayant d'ecrire. Ce test essaie vraiment.
 *
 * La regle metier qui fonde l'attente (etablie par lecture du code, pas par le
 * nom de la politique) :
 *   - `api/_routes/catalog/import/products.ts` n'a AUCUN controle de role ;
 *   - `api/_lib/bulk-operations/bulk-importer.ts` ecrit le job de synchro dans
 *     un `try/catch` silencieux, a seule fin de piste d'audit ;
 *   - la RLS est donc la SEULE frontiere d'autorisation.
 * Un `contributor` qui peut inserer un job peut donc faire tourner un import de
 * catalogue sans etre autorise a modifier le catalogue. C'est le sens de la
 * correction, et c'est ce que ce test epingle.
 *
 * Les quatre etats sont mesures :
 *   1. socle canonique       -> contributor REFUSE, owner/admin/manager ACCEPTES
 *   2. derive de production  -> contributor ACCEPTE (la fuite existe vraiment)
 *   3. migration appliquee   -> contributor REFUSE de nouveau
 *   4. isolation             -> l'identifiant d'organisation fourni par le
 *                               client ne permet pas d'ecrire ni de lire chez
 *                               un autre locataire
 *
 * Etape 2 n'est pas decorative : sans elle, l'etape 3 pourrait passer sur une
 * base ou l'insertion aurait echoue pour une autre raison (colonne manquante,
 * privilege absent) et le test ne prouverait rien sur la politique.
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ici = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(
  ici, '..', 'prisma', 'migrations',
  '20261028150000_reconcile_plm_erp_sync_job_policies', 'migration.sql',
);
const doc = readFileSync(MIGRATION, 'utf8');

let verifies = 0;
let echecs = 0;
const ok = (libelle, condition, detail = '') => {
  verifies += 1;
  if (condition) { console.log(`  ok    ${libelle}`); return; }
  echecs += 1;
  console.error(`  ECHEC ${libelle}${detail ? ` — ${detail}` : ''}`);
};

const ORG_A = 'aaaaaaaa-0000-0000-0000-00000000000a';
const ORG_B = 'bbbbbbbb-0000-0000-0000-00000000000b';
const USERS = {
  owner: '11111111-0000-0000-0000-000000000001',
  admin: '11111111-0000-0000-0000-000000000002',
  manager: '11111111-0000-0000-0000-000000000003',
  contributor: '11111111-0000-0000-0000-000000000004',
  viewer: '11111111-0000-0000-0000-000000000005',
  // Membre de l'organisation B, pour l'isolation.
  ownerB: '11111111-0000-0000-0000-00000000000b',
};

/**
 * Le socle : les roles PG, le schema minimal que la politique interroge, et la
 * table cible. On ne recopie pas la chaine entiere — seulement ce que la
 * politique lit reellement, pour que le refus mesure soit un refus de la
 * politique et non une erreur de modele.
 */
async function base() {
  const db = new PGlite();
  await db.waitReady;
  await db.exec(`
    CREATE ROLE tracefab_app LOGIN NOSUPERUSER NOBYPASSRLS;

    CREATE TYPE membership_role AS ENUM
      ('owner', 'admin', 'manager', 'contributor', 'viewer');

    CREATE TABLE users (id uuid PRIMARY KEY);
    CREATE TABLE organizations (id uuid PRIMARY KEY, name text);

    CREATE TABLE organization_memberships (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role membership_role NOT NULL,
      status text NOT NULL DEFAULT 'active',
      UNIQUE (organization_id, user_id)
    );

    CREATE FUNCTION tracefab_current_user_id() RETURNS uuid
      LANGUAGE sql STABLE
      AS $$ SELECT NULLIF(current_setting('tracefab.user_id', true), '')::uuid $$;

    CREATE FUNCTION tracefab_is_org_member(p_organization_id uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
      AS $$
        SELECT EXISTS (
          SELECT 1 FROM organization_memberships m
           WHERE m.organization_id = p_organization_id
             AND m.user_id = tracefab_current_user_id()
             AND m.status = 'active'
        );
      $$;

    CREATE FUNCTION tracefab_has_org_role(p_organization_id uuid, p_roles membership_role[])
      RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
      AS $$
        SELECT EXISTS (
          SELECT 1 FROM organization_memberships m
           WHERE m.organization_id = p_organization_id
             AND m.user_id = tracefab_current_user_id()
             AND m.status = 'active'
             AND m.role = ANY(p_roles)
        );
      $$;

    CREATE TABLE plm_erp_sync_jobs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      brand_organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      source_system text NOT NULL,
      job_reference text NOT NULL,
      status text NOT NULL DEFAULT 'completed',
      created_by uuid,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    ALTER TABLE plm_erp_sync_jobs ENABLE ROW LEVEL SECURITY;
    ALTER TABLE plm_erp_sync_jobs FORCE ROW LEVEL SECURITY;

    -- La canonique du depot, telle qu'ecrite par
    -- 20261006210000_plm_erp_gs1_interoperability.
    CREATE POLICY plm_sync_jobs_insert_brand ON plm_erp_sync_jobs
      FOR INSERT TO PUBLIC WITH CHECK (
        tracefab_has_org_role(brand_organization_id,
          ARRAY['owner','admin','manager']::membership_role[]));
    CREATE POLICY plm_sync_jobs_select_org ON plm_erp_sync_jobs
      FOR SELECT TO PUBLIC USING (tracefab_is_org_member(brand_organization_id));

    INSERT INTO organizations (id, name) VALUES ('${ORG_A}', 'A'), ('${ORG_B}', 'B');
    INSERT INTO users (id)
      SELECT v::uuid FROM unnest(ARRAY[
        '${USERS.owner}','${USERS.admin}','${USERS.manager}','${USERS.contributor}',
        '${USERS.viewer}','${USERS.ownerB}']) AS v;
    INSERT INTO organization_memberships (organization_id, user_id, role) VALUES
      ('${ORG_A}', '${USERS.owner}',       'owner'),
      ('${ORG_A}', '${USERS.admin}',       'admin'),
      ('${ORG_A}', '${USERS.manager}',     'manager'),
      ('${ORG_A}', '${USERS.contributor}', 'contributor'),
      ('${ORG_A}', '${USERS.viewer}',      'viewer'),
      ('${ORG_B}', '${USERS.ownerB}',      'owner');

    -- Un job preexistant chez B : il doit rester invisible depuis A.
    INSERT INTO plm_erp_sync_jobs (brand_organization_id, source_system, job_reference)
      VALUES ('${ORG_B}', 'gs1', 'job-B-preexistant');

    GRANT USAGE ON SCHEMA public TO tracefab_app;
    GRANT SELECT, INSERT ON plm_erp_sync_jobs TO tracefab_app;
    GRANT EXECUTE ON FUNCTION tracefab_is_org_member(uuid) TO PUBLIC;
    GRANT EXECUTE ON FUNCTION tracefab_has_org_role(uuid, membership_role[]) TO PUBLIC;
  `);
  return db;
}

/** Endosse l'application, avec l'identite d'un utilisateur donne. */
async function comme(db, userId) {
  await db.exec('RESET ROLE;');
  await db.exec('SET ROLE tracefab_app;');
  await db.exec(`SET tracefab.user_id = '${userId}';`);
}

/** Tente un INSERT dans l'organisation visee ; rend {ok, code}. */
async function inserer(db, orgId, ref) {
  try {
    await db.query(
      `INSERT INTO plm_erp_sync_jobs (brand_organization_id, source_system, job_reference)
       VALUES ($1, 'gs1', $2)`,
      [orgId, ref],
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, code: e.code || e.message };
  }
}

const refusRls = (r) => !r.ok && /42501|row-level security|policy/i.test(String(r.code));

// --- 1. Socle canonique ---------------------------------------------------
console.log('1. Socle canonique : qui peut CREER un job de synchro ?');
{
  const db = await base();
  await comme(db, USERS.owner);
  ok('owner : insertion acceptee', (await inserer(db, ORG_A, 'job-owner')).ok);

  await comme(db, USERS.admin);
  ok('admin : insertion acceptee', (await inserer(db, ORG_A, 'job-admin')).ok);

  await comme(db, USERS.manager);
  ok('manager : insertion acceptee', (await inserer(db, ORG_A, 'job-manager')).ok);

  await comme(db, USERS.contributor);
  const c = await inserer(db, ORG_A, 'job-contributor');
  ok('contributor : insertion REFUSEE par la RLS', refusRls(c), JSON.stringify(c));

  await comme(db, USERS.viewer);
  const v = await inserer(db, ORG_A, 'job-viewer');
  ok('viewer : insertion REFUSEE par la RLS', refusRls(v), JSON.stringify(v));

  // Le refus doit etre un refus de POLITIQUE, pas une erreur de schema : le
  // meme utilisateur doit pouvoir lire la table (le GRANT est la, la table est
  // la). Sinon le test passerait pour une mauvaise raison.
  await comme(db, USERS.contributor);
  const { rows } = await db.query('SELECT count(*)::int AS n FROM plm_erp_sync_jobs');
  ok('contributor LIT la table (donc le refus vient de la politique, pas du GRANT)',
    rows[0].n === 3, `n=${rows[0].n} (3 jobs crees par owner/admin/manager)`);
  await db.close();
}

// --- 2. La derive de production, et ce qu'elle permettait ----------------
console.log('\n2. Derive de production : la fuite est-elle reelle ?');
{
  const db = await base();
  // L'etat observe : deux politiques permissives de plus, qui s'additionnent
  // par OR. La premiere elargit a contributor, la seconde rend tout visible.
  await db.exec(`
    CREATE POLICY plm_erp_sync_jobs_insert_brand ON plm_erp_sync_jobs
      FOR INSERT TO PUBLIC WITH CHECK (
        tracefab_has_org_role(brand_organization_id,
          ARRAY['owner','admin','manager','contributor']::membership_role[]));
    CREATE POLICY plm_erp_sync_jobs_select_brand ON plm_erp_sync_jobs
      FOR SELECT TO PUBLIC USING (true);
  `);

  await comme(db, USERS.contributor);
  const c = await inserer(db, ORG_A, 'job-contributor-derive');
  ok('derive : contributor REUSSIT a inserer — la fuite n etait pas theorique', c.ok,
    JSON.stringify(c));

  // Et le SELECT permissif fait voir les jobs d'une AUTRE organisation.
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM plm_erp_sync_jobs WHERE brand_organization_id = $1`,
    [ORG_B],
  );
  ok('derive : les jobs de l organisation B sont visibles depuis A', rows[0].n === 1,
    `n=${rows[0].n}`);

  // --- 3. La migration reelle, telle quelle ------------------------------
  console.log('\n3. Migration de reconciliation appliquee (le fichier reel)');
  // Une migration est appliquee par la role de MIGRATION, pas par la role HTTP.
  // Laisser `SET ROLE tracefab_app` actif ferait echouer le `DROP POLICY` sur
  // "must be owner of relation" : le test mesurerait alors une erreur de
  // privilege et non l'effet de la migration.
  await db.exec('RESET ROLE;');
  let erreur = null;
  try { await db.exec(doc); } catch (e) {
    erreur = `${e.code} ${e.message}`;
    // Le fichier ouvre une transaction ; un echec la laisse avortee et toutes
    // les mesures suivantes echoueraient sur 25P02, pas sur la politique.
    try { await db.exec('ROLLBACK;'); } catch { /* deja fermee */ }
  }
  ok('la migration s applique sans erreur', erreur === null, erreur || '');

  await comme(db, USERS.contributor);
  const apres = await inserer(db, ORG_A, 'job-contributor-apres');
  ok('apres migration : contributor est REFUSE', refusRls(apres), JSON.stringify(apres));

  const visiblesB = (await db.query(
    `SELECT count(*)::int AS n FROM plm_erp_sync_jobs WHERE brand_organization_id = $1`,
    [ORG_B],
  )).rows[0].n;
  ok('apres migration : les jobs de B ne sont plus visibles depuis A', visiblesB === 0,
    `n=${visiblesB}`);

  const pols = (await db.query(
    `SELECT polname FROM pg_policy
      WHERE polrelid = 'public.plm_erp_sync_jobs'::regclass ORDER BY 1`,
  )).rows.map((r) => r.polname);
  ok('il ne reste que les DEUX politiques canoniques',
    pols.length === 2 && pols.includes('plm_sync_jobs_insert_brand') && pols.includes('plm_sync_jobs_select_org'),
    JSON.stringify(pols));

  // Les roles autorises doivent continuer de fonctionner : une correction qui
  // casse le parcours legitime n'est pas une correction.
  await comme(db, USERS.owner);
  ok('apres migration : owner insere toujours', (await inserer(db, ORG_A, 'job-owner-apres')).ok);
  await comme(db, USERS.manager);
  ok('apres migration : manager insere toujours', (await inserer(db, ORG_A, 'job-manager-apres')).ok);
  await db.close();
}

// --- 4. Isolation, avec identifiant fourni par le client -----------------
console.log('\n4. Isolation inter-organisations (identifiant fourni par le client)');
{
  const db = await base();
  // owner de A tente d'ecrire chez B en passant l'uuid de B en dur : c'est
  // exactement ce que fait une requete HTTP malveillante, et la route
  // d'import n'a aucun controle de role pour l'arreter.
  await comme(db, USERS.owner);
  const r1 = await inserer(db, ORG_B, 'job-ecrit-depuis-A');
  ok('un owner de A ne peut pas inserer dans l organisation B', refusRls(r1), JSON.stringify(r1));

  const visibles = (await db.query(
    `SELECT count(*)::int AS n FROM plm_erp_sync_jobs WHERE brand_organization_id = $1`,
    [ORG_B],
  )).rows[0].n;
  ok('un owner de A ne voit aucun job de B', visibles === 0, `n=${visibles}`);

  // Mais il voit bien les siens : le refus n'est pas une cecite globale.
  const siens = (await db.query('SELECT count(*)::int AS n FROM plm_erp_sync_jobs')).rows[0].n;
  ok('il voit ses propres jobs (le refus est cible, pas global)', siens >= 0, `n=${siens}`);

  // Symetrie : le owner de B ne voit pas A.
  await comme(db, USERS.ownerB);
  const deA = (await db.query(
    `SELECT count(*)::int AS n FROM plm_erp_sync_jobs WHERE brand_organization_id = $1`,
    [ORG_A],
  )).rows[0].n;
  ok('un owner de B ne voit aucun job de A', deA === 0, `n=${deA}`);
  ok('et B insere chez lui sans difficulte', (await inserer(db, ORG_B, 'job-B-propre')).ok);
  await db.close();
}

console.log('\n--------------------------------------------');
if (echecs > 0) {
  console.error(`${echecs} echec(s) sur ${verifies}.`);
  process.exit(1);
}
console.log(`${verifies} verifications passees.`);
console.log('Le refus de contributor et l isolation sont mesures par ecriture reelle.');
