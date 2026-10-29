#!/usr/bin/env node
/**
 * PLM/ERP — le correctif des politiques, prouve par execution.
 *
 * Perimetre STRICT : `plm_erp_sync_jobs` et rien d'autre.
 *
 * CE QUE LE CATALOGUE DE PRODUCTION PORTE (lecture du 28/10) :
 *   plm_erp_sync_jobs_insert_brand   surnumerai re   owner/admin/manager/CONTRIBUTOR
 *   plm_erp_sync_jobs_select_brand   surnumerai re   USING (true)
 *   plm_sync_jobs_insert_brand       canonique       owner/admin/manager
 *   plm_sync_jobs_select_org         canonique       tracefab_is_org_member(...)
 *
 * LE PIEGE QUE CE TEST MESURE EXPLICITEMENT
 *
 * Les politiques permissives se combinent par OR. Retirer la seule politique
 * d'insertion trop large ne suffit donc PAS si une autre politique conserve le
 * meme acces. Ce test le demontre en trois temps plutot que de l'affirmer :
 *
 *   - etat A (production) : contributor insere, et voit les jobs d'une AUTRE
 *     organisation ;
 *   - etat B (correctif PARTIEL : on retire la seule insertion) : contributor
 *     n'insere plus, MAIS la lecture inter-organisations reste ouverte —
 *     retirer une politique n'a pas suffi ;
 *   - etat C (migration complete) : les deux acces sont fermes.
 *
 * Puis, parce qu'un correctif de politiques peut en laisser une qu'on n'a pas
 * nommee, le test ne se contente pas de verifier les QUATRE noms connus : il
 * balaye TOUTES les politiques de la table et exige qu'aucune permissive ne
 * soit hors du referentiel (c'est-a-dire qu'aucune n'echappe aux deux
 * predicats de tenant).
 *
 * Enfin : idempotence (la migration est rejouee, et doit l'etre sans effet), et
 * privileges EFFECTIFS du role applicatif — notamment le fait que le droit
 * d'INSERT existe bel et bien, et que c'est la RLS, et elle seule, qui arrete.
 */
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const racine = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = join(racine, 'prisma', 'migrations');
const CIBLE = '20261028150000_reconcile_plm_erp_sync_job_policies';

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
const U = {
  owner: '11111111-0000-0000-0000-000000000001',
  admin: '11111111-0000-0000-0000-000000000002',
  manager: '11111111-0000-0000-0000-000000000003',
  contributor: '11111111-0000-0000-0000-000000000004',
  viewer: '11111111-0000-0000-0000-000000000005',
  ownerB: '11111111-0000-0000-0000-00000000000b',
};

const dossiers = readdirSync(MIGRATIONS).filter((d) => /^\d{14}_/.test(d)).sort();
const lire = (d) => readFileSync(join(MIGRATIONS, d, 'migration.sql'), 'utf8');

/**
 * La chaine complete du depot, jouee telle quelle jusqu'a la cible incluse.
 *
 * On part de la VRAIE chaine — pas d'un schema simplifie — parce que le point
 * a prouver est que la migration fonctionne sur le schema reel, avec ses deux
 * fonctions de tenant, ses types enum et ses politiques canoniques.
 */
async function chaine({ arreterAvant = null, sauter = [] } = {}) {
  const db = new PGlite({ extensions: { pgcrypto, uuid_ossp } });
  await db.waitReady;
  await db.exec(`
    CREATE ROLE tracefab_app LOGIN PASSWORD 'runtime'
      NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
    GRANT USAGE ON SCHEMA public TO tracefab_app;
  `);
  for (const d of dossiers) {
    if (sauter.includes(d)) continue;
    if (arreterAvant && d >= arreterAvant) break;
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

/** Cree les deux organisations, leurs membres, et un job preexistant chez B. */
async function peupler(db) {
  await db.exec(`
    INSERT INTO organizations (id, type, legal_name)
      VALUES ('${ORG_A}', 'brand', 'Org A'), ('${ORG_B}', 'brand', 'Org B');
    INSERT INTO users (id, clerk_user_id, email, full_name)
      SELECT v::uuid, 'clerk_' || v, v || '@exemple.test', 'Utilisateur ' || left(v, 8)
        FROM unnest(ARRAY['${U.owner}','${U.admin}','${U.manager}',
                          '${U.contributor}','${U.viewer}','${U.ownerB}']) AS v;
    INSERT INTO organization_memberships (organization_id, user_id, role, status) VALUES
      ('${ORG_A}', '${U.owner}',       'owner',       'active'),
      ('${ORG_A}', '${U.admin}',       'admin',       'active'),
      ('${ORG_A}', '${U.manager}',     'manager',     'active'),
      ('${ORG_A}', '${U.contributor}', 'contributor', 'active'),
      ('${ORG_A}', '${U.viewer}',      'viewer',      'active'),
      ('${ORG_B}', '${U.ownerB}',      'owner',       'active');
    INSERT INTO plm_erp_sync_jobs (brand_organization_id, source_system, job_reference)
      VALUES ('${ORG_B}', 'gs1', 'job-B-preexistant');
  `);
}

/** Toutes les politiques de la table, avec leur commande et leurs expressions. */
async function politiques(db) {
  const { rows } = await db.query(`
    SELECT p.polname                                        AS nom,
           p.polcmd                                        AS cmd,
           p.polpermissive                                 AS permissive,
           pg_catalog.pg_get_expr(p.polqual, p.polrelid)   AS using_expr,
           pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) AS check_expr
      FROM pg_catalog.pg_policy p
     WHERE p.polrelid = 'public.plm_erp_sync_jobs'::regclass
     ORDER BY 1`);
  return rows;
}

/**
 * Une politique est « gardee » si elle s'appuie sur l'un des deux predicats de
 * tenant du depot. Sinon elle n'exprime aucune restriction d'organisation.
 */
const GARDEE = (p) => {
  const t = `${p.using_expr ?? ''} ${p.check_expr ?? ''}`;
  return /tracefab_is_org_member|tracefab_has_org_role/.test(t);
};

/** Endosse le role applicatif avec l'identite d'un utilisateur. */
async function comme(db, userId) {
  await db.exec('RESET ROLE;');
  await db.exec('SET ROLE tracefab_app;');
  await db.exec(`SET tracefab.user_id = '${userId}';`);
}

async function inserer(db, orgId, ref) {
  try {
    await db.query(
      `INSERT INTO plm_erp_sync_jobs (brand_organization_id, source_system, job_reference)
       VALUES ($1, 'gs1', $2)`, [orgId, ref]);
    return { ok: true };
  } catch (e) { return { ok: false, code: e.code ?? 'refus' }; }
}

async function voirChez(db, orgId) {
  try {
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM plm_erp_sync_jobs WHERE brand_organization_id = $1`, [orgId]);
    return rows[0].n;
  } catch (e) { return `ERREUR ${e.code}`; }
}

const refusRls = (r) => !r.ok && /42501|row-level security|policy/i.test(String(r.code));

// =========================================================================
console.log('1. Le correctif PARTIEL ne suffit pas — la combinaison par OR');
{
  const db = await chaine({ arreterAvant: CIBLE });
  await peupler(db);
  // La derive de production, telle que lue : les deux surnumeraires.
  await db.exec(`
    CREATE POLICY plm_erp_sync_jobs_insert_brand ON public.plm_erp_sync_jobs
      FOR INSERT TO PUBLIC WITH CHECK (
        tracefab_has_org_role(brand_organization_id,
          ARRAY['owner','admin','manager','contributor']::membership_role[]));
    CREATE POLICY plm_erp_sync_jobs_select_brand ON public.plm_erp_sync_jobs
      FOR SELECT TO PUBLIC USING (true);
  `);
  const av = await politiques(db);
  ok('etat A : la table porte QUATRE politiques', av.length === 4,
    JSON.stringify(av.map((p) => p.nom)));

  await comme(db, U.contributor);
  ok('etat A : contributor INSERE (la fuite est reelle)', (await inserer(db, ORG_A, 'a1')).ok);
  const vuesB = await voirChez(db, ORG_B);
  ok('etat A : il VOIT les jobs de l organisation B', vuesB === 1, `n=${vuesB}`);

  // --- Correctif partiel : on ne retire QUE la politique d'insertion -------
  await db.exec('RESET ROLE;');
  await db.exec('DROP POLICY plm_erp_sync_jobs_insert_brand ON public.plm_erp_sync_jobs;');
  await comme(db, U.contributor);
  const apresPartiel = await inserer(db, ORG_A, 'a2');
  ok('etat B : contributor n insere plus — le correctif partiel agit', refusRls(apresPartiel),
    JSON.stringify(apresPartiel));
  const vuesBApres = await voirChez(db, ORG_B);
  ok('etat B : MAIS il voit toujours les jobs de B — retirer une politique n a pas suffi',
    vuesBApres === 1, `n=${vuesBApres}`);
  await db.close();
}

// =========================================================================
console.log('\n2. La migration complete : les deux acces sont fermes');
{
  const db = await chaine({ arreterAvant: CIBLE });
  await peupler(db);
  await db.exec(`
    CREATE POLICY plm_erp_sync_jobs_insert_brand ON public.plm_erp_sync_jobs
      FOR INSERT TO PUBLIC WITH CHECK (
        tracefab_has_org_role(brand_organization_id,
          ARRAY['owner','admin','manager','contributor']::membership_role[]));
    CREATE POLICY plm_erp_sync_jobs_select_brand ON public.plm_erp_sync_jobs
      FOR SELECT TO PUBLIC USING (true);
  `);
  await db.exec('RESET ROLE;');
  let erreur = null;
  try { await db.exec(lire(CIBLE)); } catch (e) { erreur = `${e.code} ${e.message}`; }
  ok('la migration s applique sur la chaine reelle', erreur === null, erreur ?? '');

  // --- Exigence 4 : absence des surnumeraires, presence des attendues -----
  const ap = await politiques(db);
  const noms = ap.map((p) => p.nom).sort();
  console.log(`        politiques apres migration : ${JSON.stringify(noms)}`);
  ok('EXIGENCE — les deux surnumeraires sont ABSENTES',
    !noms.includes('plm_erp_sync_jobs_insert_brand')
    && !noms.includes('plm_erp_sync_jobs_select_brand'), JSON.stringify(noms));
  ok('EXIGENCE — les deux attendues sont PRESENTES',
    noms.includes('plm_sync_jobs_insert_brand') && noms.includes('plm_sync_jobs_select_org'),
    JSON.stringify(noms));
  ok('il reste exactement DEUX politiques', ap.length === 2, JSON.stringify(noms));

  // --- Exigence 4 bis : aucune permissive RESIDUELLE, par balayage --------
  // On ne verifie pas « les quatre noms connus » : on verifie que TOUTE
  // politique restante s'appuie sur un predicat de tenant. Une politique
  // ajoutee plus tard, sous un autre nom, tomberait ici.
  const nonGardees = ap.filter((p) => p.permissive === true || p.permissive === 't').filter((p) => !GARDEE(p));
  ok('EXIGENCE — aucune politique permissive hors referentiel (balayage, pas liste de noms)',
    nonGardees.length === 0,
    JSON.stringify(nonGardees.map((p) => `${p.nom} using=${p.using_expr} check=${p.check_expr}`)));
  const insertCanonique = ap.find((p) => p.nom === 'plm_sync_jobs_insert_brand');
  ok('la canonique INSERT n a AUCUNE clause USING (elle ne filtre pas en lecture)',
    insertCanonique?.using_expr === null, insertCanonique?.using_expr);
  ok('sa clause WITH CHECK exige owner/admin/manager et exclut contributor',
    /owner/.test(insertCanonique?.check_expr ?? '') && /admin/.test(insertCanonique?.check_expr ?? '')
    && /manager/.test(insertCanonique?.check_expr ?? '')
    && !/contributor/.test(insertCanonique?.check_expr ?? ''), insertCanonique?.check_expr);
  const selectCanonique = ap.find((p) => p.nom === 'plm_sync_jobs_select_org');
  ok('la canonique SELECT borne au tenant et n a AUCUN WITH CHECK',
    /tracefab_is_org_member/.test(selectCanonique?.using_expr ?? '')
    && selectCanonique?.check_expr === null, selectCanonique?.using_expr);

  // --- Exigence 4 : refus et acceptations, par ecriture REELLE ------------
  await comme(db, U.contributor);
  ok('EXIGENCE — contributor est REFUSE a l insertion',
    refusRls(await inserer(db, ORG_A, 'c1')));
  ok('EXIGENCE — contributor ne voit aucun job de B',
    (await voirChez(db, ORG_B)) === 0, String(await voirChez(db, ORG_B)));

  await comme(db, U.viewer);
  ok('viewer est REFUSE a l insertion', refusRls(await inserer(db, ORG_A, 'v1')));

  for (const [role, id] of [['owner', U.owner], ['admin', U.admin], ['manager', U.manager]]) {
    await comme(db, id);
    ok(`EXIGENCE — ${role} INSERE sans difficulte`, (await inserer(db, ORG_A, `job-${role}`)).ok);
  }

  // --- Exigence 4 : isolation, identifiant d organisation fourni par le client
  await comme(db, U.owner);
  ok('EXIGENCE — un owner de A ne peut pas inserer chez B',
    refusRls(await inserer(db, ORG_B, 'ecrit-depuis-A')));
  ok('EXIGENCE — un owner de A ne lit aucun job de B', (await voirChez(db, ORG_B)) === 0);
  await comme(db, U.ownerB);
  ok('EXIGENCE — symetrie : un owner de B ne lit aucun job de A', (await voirChez(db, ORG_A)) === 0);
  ok('B insere chez lui sans difficulte', (await inserer(db, ORG_B, 'job-B-propre')).ok);
  await db.close();
}

// =========================================================================
console.log('\n3. Idempotence — la migration rejouee ne change rien');
{
  const db = await chaine({ arreterAvant: CIBLE });
  await peupler(db);
  await db.exec(`
    CREATE POLICY plm_erp_sync_jobs_insert_brand ON public.plm_erp_sync_jobs
      FOR INSERT TO PUBLIC WITH CHECK (
        tracefab_has_org_role(brand_organization_id,
          ARRAY['owner','admin','manager','contributor']::membership_role[]));
    CREATE POLICY plm_erp_sync_jobs_select_brand ON public.plm_erp_sync_jobs
      FOR SELECT TO PUBLIC USING (true);
  `);
  await db.exec('RESET ROLE;');
  await db.exec(lire(CIBLE));
  const apres1 = await politiques(db);

  // Deuxieme execution, telle quelle. Les DROP portent IF EXISTS : la
  // migration doit passer sans erreur, et laisser le catalogue identique.
  let erreur2 = null;
  try { await db.exec(lire(CIBLE)); } catch (e) { erreur2 = `${e.code} ${e.message}`; }
  ok('le rejeu ne leve AUCUNE erreur', erreur2 === null, erreur2 ?? '');
  const apres2 = await politiques(db);
  ok('le catalogue est IDENTIQUE apres rejeu (meme nombre, memes noms)',
    JSON.stringify(apres1.map((p) => p.nom)) === JSON.stringify(apres2.map((p) => p.nom)),
    `${JSON.stringify(apres1.map((p) => p.nom))} vs ${JSON.stringify(apres2.map((p) => p.nom))}`);
  ok('et les DEFINITIONS sont identiques aussi',
    JSON.stringify(apres1.map((p) => [p.nom, p.using_expr, p.check_expr]))
    === JSON.stringify(apres2.map((p) => [p.nom, p.using_expr, p.check_expr])));

  const apres3 = await (async () => { await db.exec(lire(CIBLE)); return politiques(db); })();
  ok('troisieme execution : toujours identique (idempotence stable)',
    JSON.stringify(apres3.map((p) => p.nom)) === JSON.stringify(apres1.map((p) => p.nom)));
  await db.close();
}

// =========================================================================
console.log('\n4. Les gardes fail-closed : la migration refuse de detruire a tort');
{
  // (a) Sur une base NEUVE, sans derive : rien a retirer, aucune erreur.
  const neuve = await chaine();
  await peupler(neuve);
  await neuve.exec('RESET ROLE;');
  let e = null;
  try { await neuve.exec(lire(CIBLE)); } catch (err) { e = `${err.code} ${err.message}`; }
  ok('sur une base neuve (aucune derive), elle passe et ne retire rien', e === null, e ?? '');
  ok('les deux canoniques sont intactes', (await politiques(neuve)).length === 2);
  await neuve.close();

  // (b) Politique canonique INSERT absente : refus AVANT tout DROP.
  const sansInsert = await chaine({ arreterAvant: CIBLE });
  await peupler(sansInsert);
  await sansInsert.exec('RESET ROLE;');
  await sansInsert.exec('DROP POLICY plm_sync_jobs_insert_brand ON public.plm_erp_sync_jobs;');
  await sansInsert.exec(`
    CREATE POLICY plm_erp_sync_jobs_insert_brand ON public.plm_erp_sync_jobs
      FOR INSERT TO PUBLIC WITH CHECK (true);`);
  const avant = (await politiques(sansInsert)).map((p) => p.nom).sort();
  let refus = null;
  try { await sansInsert.exec(lire(CIBLE)); } catch (err) {
    refus = err.code ?? 'refus';
    // La migration ouvre BEGIN puis leve : sans ROLLBACK, la transaction reste
    // avortee et TOUTES les mesures suivantes echoueraient en 25P02 — on
    // mesurerait un etat de session, pas l etat de la base.
    try { await sansInsert.exec('ROLLBACK'); } catch { /* deja fermee */ }
  }
  ok('canonique INSERT absente : la migration REFUSE', refus !== null, String(refus));
  const apres = (await politiques(sansInsert)).map((p) => p.nom).sort();
  ok('et elle n a RIEN supprime (le refus precede le DROP)',
    JSON.stringify(avant) === JSON.stringify(apres), `${JSON.stringify(avant)} vs ${JSON.stringify(apres)}`);
  ok('la surnumeraire est toujours la : la base reste dans son etat, pas a moitie corrigee',
    apres.includes('plm_erp_sync_jobs_insert_brand'));
  await sansInsert.close();

  // (c) Table absente : refus, pas de DROP silencieux.
  const sansTable = await chaine({ arreterAvant: CIBLE });
  await sansTable.exec('RESET ROLE;');
  await sansTable.exec('DROP TABLE plm_erp_sync_jobs;');
  let refus2 = null;
  try { await sansTable.exec(lire(CIBLE)); } catch (err) {
    refus2 = err.code ?? 'refus';
    try { await sansTable.exec('ROLLBACK'); } catch { /* deja fermee */ }
  }
  ok('table absente : la migration REFUSE', refus2 !== null, String(refus2));
  await sansTable.close();
}

// =========================================================================
console.log('\n5. Privileges EFFECTIFS de tracefab_app sur la table');
{
  const db = await chaine();
  await peupler(db);
  const { rows } = await db.query(`
    SELECT p AS privilege,
           pg_catalog.has_table_privilege('tracefab_app', 'public.plm_erp_sync_jobs', p) AS app,
           pg_catalog.has_table_privilege('public', 'public.plm_erp_sync_jobs', p) AS public_role
      FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p`);
  for (const r of rows) console.log(`        ${r.privilege.padEnd(9)} app=${r.app} public=${r.public_role}`);

  const priv = Object.fromEntries(rows.map((r) => [r.privilege, r.app === true || r.app === 't']));
  ok('tracefab_app detient SELECT (lecture bornee par la RLS)', priv.SELECT === true);
  ok('tracefab_app detient INSERT', priv.INSERT === true);
  ok('tracefab_app detient UPDATE', priv.UPDATE === true);
  /**
   * CORRECTION D'UNE INTUITION — le privilege DELETE EST present.
   *
   * `20261006210000` n'accorde a PUBLIC que SELECT/INSERT/UPDATE, mais
   * `20261019160000_retablir_dml_tables_ecrites_directement` reaccorde
   * INSERT, UPDATE, DELETE a `tracefab_app` sur cette table. L'hypothese
   * « pas de privilege DELETE » etait donc fausse, et une assertion ecrite
   * dessus aurait echoue — ou pire, aurait ete affaiblie pour passer.
   *
   * Ce n'est pas pour autant une faille : la table est en RLS FORCEE et
   * AUCUNE politique ne couvre DELETE. En PostgreSQL, une commande sans
   * politique applicable est refusee par defaut. C'est donc la RLS qui
   * refuse, et ce test le MESURE au lieu de le deduire du privilege.
   */
  ok('tracefab_app DETIENT DELETE (reaccorde par 20261019160000)', priv.DELETE === true);
  ok('et pourtant aucune politique ne couvre DELETE', !(await politiques(db)).some((p) => p.cmd === 'd'));
  ok('TRUNCATE n est pas accorde', priv.TRUNCATE === false);

  /**
   * LE POINT QUI COMPTE : le privilege d'INSERT existe. Ce n'est donc PAS le
   * GRANT qui empeche un contributor d'ecrire — c'est la RLS, et elle seule.
   * Si la RLS tombait, le droit d'ecrire serait deja la. Ce test le prouve
   * plutot que de le supposer : on verifie que le privilege est present, puis
   * que l'ecriture est malgre tout refusee.
   */
  await comme(db, U.contributor);
  ok('aveuglement : le privilege present + l ecriture refusee => c est bien la RLS qui garde',
    priv.INSERT === true && refusRls(await inserer(db, ORG_A, 'preuve-1')));

  /**
   * LE DELETE, ET UNE NUANCE DE SEMANTIQUE QUI COMPTE.
   *
   * J'avais ecrit cette assertion en attendant une erreur 42501. Elle a echoue :
   * la commande passe. Ce n'est pas que la RLS soit absente — c'est que la RLS
   * ne se comporte pas de la meme facon selon la clause :
   *
   *   - `USING` (SELECT, et la partie lecture de UPDATE/DELETE) FILTRE : les
   *     lignes sont invisibles, la commande reussit et affecte 0 ligne. Aucune
   *     erreur. Un rapport qui conclurait « pas d'erreur donc pas de
   *     protection » se tromperait ;
   *   - `WITH CHECK` (INSERT, et la partie ecriture de UPDATE) REJETTE : erreur
   *     42501. Un rapport qui conclurait « pas d'erreur donc pas de protection »
   *     aurait raison.
   *
   * La mesure utile pour un DELETE n'est donc pas le code d'erreur, c'est
   * L'EFFET : la ligne doit etre toujours la. Et comme il n'existe aucune
   * politique DELETE, aucune ligne n'est jamais visible pour cette commande.
   */
  // Les deux comptages sont faits sous le MEME role (le proprietaire du
  // cluster, qui n'est pas soumis a la RLS) : compter sous `tracefab_app`
  // donnerait 0 avant et 0 apres pour la seule raison que la RLS filtre, et
  // la comparaison ne dirait rien sur l effet du DELETE.
  await db.exec('RESET ROLE;');
  const avantDelete = (await db.query(
    `SELECT count(*)::int AS n FROM plm_erp_sync_jobs`)).rows[0].n;
  await comme(db, U.owner);
  let deleteErreur = null;
  try {
    await db.query(`DELETE FROM plm_erp_sync_jobs WHERE brand_organization_id = $1`, [ORG_B]);
  } catch (e) { deleteErreur = e.code ?? 'refus'; }
  await db.exec('RESET ROLE;');
  const apresDelete = (await db.query(
    `SELECT count(*)::int AS n FROM plm_erp_sync_jobs`)).rows[0].n;
  ok('un DELETE ne supprime RIEN (aucune politique DELETE : la RLS filtre, sans erreur)',
    apresDelete === avantDelete, `avant=${avantDelete} apres=${apresDelete} erreur=${deleteErreur}`);
  console.log(`        (DELETE sans erreur=${deleteErreur === null} : c'est la semantique USING, pas une absence de garde)`);

  // Et la RLS est active ET forcee : sans FORCE, le proprietaire echapperait.
  const rls = (await db.query(
    `SELECT relrowsecurity, relforcerowsecurity FROM pg_catalog.pg_class
      WHERE oid = 'public.plm_erp_sync_jobs'::regclass`)).rows[0];
  ok('RLS activee', rls.relrowsecurity === true);
  ok('RLS FORCEE (le proprietaire lui-meme est soumis)', rls.relforcerowsecurity === true);
  await db.close();
}

console.log('\n--------------------------------------------');
if (echecs > 0) {
  console.error(`${echecs} echec(s) sur ${verifies}.`);
  process.exit(1);
}
console.log(`${verifies} verifications passees.`);
console.log('Politiques, refus, acceptations, isolation, idempotence et privileges prouves.');
