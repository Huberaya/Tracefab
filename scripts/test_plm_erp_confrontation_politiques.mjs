#!/usr/bin/env node
/**
 * PLM/ERP — affronter les QUATRE politiques observees en production aux DEUX
 * politiques canoniques, puis verifier que les gardes de la migration
 * `20261028150000_reconcile_plm_erp_sync_job_policies` acceptent cet etat reel
 * SANS supprimer autre chose que les deux politiques nommees.
 *
 * Perimetre STRICT : `plm_erp_sync_jobs`. Aucun acces reseau, aucune base
 * distante : tout se joue sur PGlite, sur la chaine reelle du depot.
 *
 * DISTINCTION DES NIVEAUX DE PREUVE — tenue dans tout le fichier :
 *   [MESURE]      observe par execution dans ce test ;
 *   [DEPOT]       etabli en lisant les fichiers du depot ;
 *   [RECONSTRUIT] la definition exacte des deux surnumeraires n'a PAS ete
 *                 relevee dans les artefacts du depot (les lectures de
 *                 production n'ont conserve que leurs NOMS). Le test les
 *                 reconstruit a partir de la description consignee
 *                 (insert : owner/admin/manager/contributor ; select : doublon
 *                 de la canonique), et couvre plusieurs variantes plausibles.
 *                 La requete de releve exact figure en fin de rapport.
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
const CANONIQUE_SRC = '20261006210000_plm_erp_gs1_interoperability';

const CANONIQUES = ['plm_sync_jobs_insert_brand', 'plm_sync_jobs_select_org'];
const SURNUMERAIRES = ['plm_erp_sync_jobs_insert_brand', 'plm_erp_sync_jobs_select_brand'];
// Ce que la lecture du 28/10 dit avoir trouve en production : exactement ces 4.
const OBSERVEES_PROD = [...SURNUMERAIRES, ...CANONIQUES].sort();

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

async function chaine({ arreterAvant = null } = {}) {
  const db = new PGlite({ extensions: { pgcrypto, uuid_ossp } });
  await db.waitReady;
  await db.exec(`
    CREATE ROLE tracefab_app LOGIN PASSWORD 'runtime'
      NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
    GRANT USAGE ON SCHEMA public TO tracefab_app;
  `);
  for (const d of dossiers) {
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

async function politiques(db, table = 'public.plm_erp_sync_jobs') {
  try {
    const { rows } = await db.query(`
      SELECT p.polname AS nom,
             p.polcmd   AS cmd,
             p.polpermissive AS permissive,
             pg_catalog.pg_get_expr(p.polqual, p.polrelid)      AS using_expr,
             pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) AS check_expr
        FROM pg_catalog.pg_policy p
       WHERE p.polrelid = $1::regclass
       ORDER BY 1`, [table]);
    return rows;
  } catch { return []; }
}
const noms = (ps) => ps.map((p) => p.nom).sort();
const meme = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const signature = (ps) => JSON.stringify([...ps].sort((x, y) => x.nom.localeCompare(y.nom)));

/** Etat de production tel que decrit : les 2 canoniques + les 2 surnumeraires. */
async function deriverProduction(db, { selectVariante = 'true' } = {}) {
  const usingSelect = selectVariante === 'duplicata'
    ? 'tracefab_is_org_member(brand_organization_id)'
    : 'true';
  await db.exec(`
    CREATE POLICY plm_erp_sync_jobs_insert_brand ON public.plm_erp_sync_jobs
      FOR INSERT TO PUBLIC WITH CHECK (
        tracefab_has_org_role(brand_organization_id,
          ARRAY['owner','admin','manager','contributor']::membership_role[]));
    CREATE POLICY plm_erp_sync_jobs_select_brand ON public.plm_erp_sync_jobs
      FOR SELECT TO PUBLIC USING (${usingSelect});
  `);
}

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
  } catch (e) { return { ok: false, code: e.code ?? 'refus', message: String(e.message) }; }
}

async function voirChez(db, orgId) {
  try {
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM plm_erp_sync_jobs WHERE brand_organization_id = $1`, [orgId]);
    return rows[0].n;
  } catch (e) { return `ERREUR ${e.code}`; }
}

const refusRls = (r) => !r.ok && /42501|row-level security|policy/i.test(String(r.code) + String(r.message ?? ''));

/** Joue la migration cible ; rend {ok, message} sans laisser la session cassee. */
async function jouerMigration(db) {
  try {
    await db.exec(lire(CIBLE));
    return { ok: true };
  } catch (e) {
    const message = String(e.message).split('\n')[0];
    try { await db.exec('ROLLBACK'); } catch { /* deja fermee */ }
    return { ok: false, message };
  }
}

// =========================================================================
console.log('1. Confrontation statique : 4 observees vs 2 canoniques  [DEPOT]');
{
  const src = lire(CANONIQUE_SRC);
  // La migration touche DEUX tables : on ne retient que celles de la cible.
  const creees = [...src.matchAll(/CREATE POLICY\s+(\w+)\s+ON\s+([\w.]+)/g)]
    .filter((m) => /plm_erp_sync_jobs$/.test(m[2]))
    .map((m) => m[1]);
  ok(`sur plm_erp_sync_jobs, ${CANONIQUE_SRC} ne cree que les 2 canoniques`,
    meme(creees, CANONIQUES), JSON.stringify(creees));
  ok('les autres CREATE POLICY de cette migration visent une AUTRE table',
    [...src.matchAll(/CREATE POLICY\s+(\w+)\s+ON\s+([\w.]+)/g)]
      .some((m) => !/plm_erp_sync_jobs$/.test(m[2])));

  const mig = lire(CIBLE);
  const drops = [...mig.matchAll(/DROP POLICY IF EXISTS\s+(\w+)\s+ON\s+([\w.]+)/g)]
    .map((m) => ({ nom: m[1], table: m[2] }));
  ok('la migration corrective nomme exactement 2 DROP', drops.length === 2,
    JSON.stringify(drops));
  ok('et ce sont EXACTEMENT les 2 surnumeraires', meme(drops.map((d) => d.nom), SURNUMERAIRES),
    JSON.stringify(drops.map((d) => d.nom)));
  ok('aucun DROP ne vise une canonique',
    drops.every((d) => !CANONIQUES.includes(d.nom)));
  ok('les 2 DROP visent la meme table, qualifiee public.',
    new Set(drops.map((d) => d.table)).size === 1);

  // Aucune migration du depot ne CREE les surnumeraires : la provenance est
  // hors depot, donc un DROP est durable (aucun deploiement ne les recree).
  const creationsHorsDepot = dossiers
    .filter((d) => existsSync(join(MIGRATIONS, d, 'migration.sql')))
    .filter((d) => SURNUMERAIRES.some((n) =>
      new RegExp(`CREATE POLICY\\s+${n}\\b`).test(lire(d))));
  ok('aucune migration du depot ne CREE les surnumeraires (provenance hors depot)',
    creationsHorsDepot.length === 0, JSON.stringify(creationsHorsDepot));

  ok('l ensemble observe (4) = canoniques (2) + surnumeraires (2), sans reste',
    meme(OBSERVEES_PROD, [...CANONIQUES, ...SURNUMERAIRES]));
}

// =========================================================================
console.log('\n2. Qualification sur base jetable : la correction ferme quoi ?  [MESURE]');
let signatureCanoniquesAvant = null;
let politiquesApres = null;
{
  const db = await chaine({ arreterAvant: CIBLE });
  await peupler(db);
  const canoniquesSeules = await politiques(db);
  ok('chaine du depot, avant derive : la table porte 2 politiques',
    noms(canoniquesSeules).length === 2, JSON.stringify(noms(canoniquesSeules)));
  ok('et ce sont les 2 canoniques attendues', meme(noms(canoniquesSeules), CANONIQUES),
    JSON.stringify(noms(canoniquesSeules)));
  const insertCanon = canoniquesSeules.find((p) => p.nom === 'plm_sync_jobs_insert_brand');
  ok('canonique : WITH CHECK nomme owner/admin/manager',
    /owner/.test(insertCanon.check_expr) && /admin/.test(insertCanon.check_expr)
    && /manager/.test(insertCanon.check_expr), insertCanon.check_expr);
  ok('canonique : WITH CHECK ne nomme PAS contributor',
    !/contributor/.test(insertCanon.check_expr), insertCanon.check_expr);

  await deriverProduction(db);
  const av = await politiques(db);
  ok('[RECONSTRUIT] etat de production : 4 politiques',
    noms(av).length === 4 && meme(noms(av), OBSERVEES_PROD), JSON.stringify(noms(av)));
  signatureCanoniquesAvant = signature(av.filter((p) => CANONIQUES.includes(p.nom)));

  await comme(db, U.contributor);
  ok('capacite en trop 1/2 : contributor INSERE (la canonique le refuse)',
    (await inserer(db, ORG_A, 'a1')).ok);
  const vuesB = await voirChez(db, ORG_B);
  ok('capacite en trop 2/2 : contributor VOIT les jobs de l autre organisation',
    vuesB === 1, `n=${vuesB}`);

  await comme(db, U.viewer);
  const vuesBViewer = await voirChez(db, ORG_B);
  ok('un simple viewer voit aussi les jobs de B (selection surnumeraire)',
    vuesBViewer === 1, `n=${vuesBViewer}`);

  // --- la migration corrective, sur cet etat -----------------------------
  await db.exec('RESET ROLE;');
  const r = await jouerMigration(db);
  ok('les gardes ACCEPTENT l etat reel a 4 politiques', r.ok, r.message);

  politiquesApres = await politiques(db);
  ok('apres migration : exactement 2 politiques', noms(politiquesApres).length === 2,
    JSON.stringify(noms(politiquesApres)));
  ok('apres migration : les 2 canoniques, et rien d autre',
    meme(noms(politiquesApres), CANONIQUES), JSON.stringify(noms(politiquesApres)));
  ok('la migration ne REECRIT pas les canoniques (definitions identiques avant/apres)',
    signature(politiquesApres) === signatureCanoniquesAvant);

  await comme(db, U.contributor);
  const insApres = await inserer(db, ORG_A, 'a2');
  ok('apres migration : contributor est REFUSE', refusRls(insApres), JSON.stringify(insApres));
  const vuesBApres = await voirChez(db, ORG_B);
  ok('apres migration : il ne voit plus les jobs de B', vuesBApres === 0, `n=${vuesBApres}`);

  await comme(db, U.owner);
  ok('apres migration : owner insere toujours', (await inserer(db, ORG_A, 'a3')).ok);
  await comme(db, U.manager);
  ok('apres migration : manager insere toujours', (await inserer(db, ORG_A, 'a4')).ok);
  await comme(db, U.ownerB);
  ok('apres migration : le proprietaire de B ne voit que B',
    (await voirChez(db, ORG_B)) >= 1 && (await voirChez(db, ORG_A)) === 0);
  await db.exec('RESET ROLE;');
  await db.close();
}

// =========================================================================
console.log('\n3. Variante « doublon » : et si select_brand etait benigné ?  [MESURE]');
{
  const db = await chaine({ arreterAvant: CIBLE });
  await peupler(db);
  await deriverProduction(db, { selectVariante: 'duplicata' });
  const av = await politiques(db);
  ok('etat a 4 politiques (variante duplicata)', noms(av).length === 4);
  await comme(db, U.contributor);
  const vuesB = await voirChez(db, ORG_B);
  const ins = await inserer(db, ORG_A, 'd1');
  // RESULTAT QUI COMPTE, et qui contredit l'hypothese du pire cas : si la
  // surnumeraire est bien un DOUBLON du predicat canonique, elle n'elargit
  // RIEN. L'exces d'acces vient alors de la SEULE politique d'insertion.
  ok('variante duplicata : le contributor ne voit PAS B (la surnumeraire n elargit rien)',
    vuesB === 0, `n=${vuesB}`);
  ok('variante duplicata : mais il INSERE quand meme (l exces vient de l INSERT)',
    ins.ok, JSON.stringify(ins));
  await db.exec('RESET ROLE;');
  const r = await jouerMigration(db);
  ok('variante duplicata : les gardes acceptent', r.ok, r.message);
  const ap = await politiques(db);
  ok('variante duplicata : 2 politiques, les canoniques',
    meme(noms(ap), CANONIQUES), JSON.stringify(noms(ap)));
  await comme(db, U.contributor);
  ok('variante duplicata : isolation inchangee (elle ne l etait pas ouverte)',
    (await voirChez(db, ORG_B)) === 0);
  const insApres = await inserer(db, ORG_A, 'd2');
  ok('variante duplicata : apres migration, contributor est refuse',
    refusRls(insApres), JSON.stringify(insApres));
  await db.exec('RESET ROLE;');
  await db.close();
}

// =========================================================================
console.log('\n4. Les gardes REFUSENT-elles, et sans rien supprimer ?  [MESURE]');
{
  // 4.1 la table elle-meme absente
  {
    const db = new PGlite({ extensions: { pgcrypto, uuid_ossp } });
    await db.waitReady;
    await db.exec(`
      CREATE ROLE tracefab_app LOGIN PASSWORD 'runtime'
        NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
      GRANT USAGE ON SCHEMA public TO tracefab_app;`);
    const r = await jouerMigration(db);
    ok('table absente : la migration REFUSE', !r.ok && /plm_erp_sync_jobs_absente/.test(r.message),
      r.message);
    await db.close();
  }

  // 4.2 a 4.6 : canoniques alterees. A chaque fois : refus ET surnumeraires intactes.
  const scenarios = [
    {
      // Le garde de NOMBRE ajoute le 29/10 s'evalue AVANT celui d'identite : il
      // refuse plus tot, avec un message moins specifique. On accepte les deux
      // motifs mais on exige le refus — et le controle « rien n'a ete supprime »
      // ci-dessous est ce qui compte vraiment.
      titre: 'canonique INSERT absente',
      attendu: /politique_canonique_insert_absente|nombre_ou_identite_politiques_inattendu/,
      preparer: (db) => db.exec(`DROP POLICY plm_sync_jobs_insert_brand ON public.plm_erp_sync_jobs;`),
    },
    {
      titre: 'canonique SELECT absente',
      attendu: /politique_canonique_select_absente|nombre_ou_identite_politiques_inattendu/,
      preparer: (db) => db.exec(`DROP POLICY plm_sync_jobs_select_org ON public.plm_erp_sync_jobs;`),
    },
    {
      titre: 'canonique INSERT rouverte a contributor',
      attendu: /politique_canonique_insert_inattendue|nombre_ou_identite_politiques_inattendu/,
      preparer: (db) => db.exec(`
        DROP POLICY plm_sync_jobs_insert_brand ON public.plm_erp_sync_jobs;
        CREATE POLICY plm_sync_jobs_insert_brand ON public.plm_erp_sync_jobs
          FOR INSERT TO PUBLIC WITH CHECK (
            tracefab_has_org_role(brand_organization_id,
              ARRAY['owner','admin','manager','contributor']::membership_role[]));`),
    },
    {
      titre: 'canonique INSERT sans manager',
      attendu: /politique_canonique_insert_inattendue|nombre_ou_identite_politiques_inattendu/,
      preparer: (db) => db.exec(`
        DROP POLICY plm_sync_jobs_insert_brand ON public.plm_erp_sync_jobs;
        CREATE POLICY plm_sync_jobs_insert_brand ON public.plm_erp_sync_jobs
          FOR INSERT TO PUBLIC WITH CHECK (
            tracefab_has_org_role(brand_organization_id,
              ARRAY['owner','admin']::membership_role[]));`),
    },
    {
      titre: 'canonique INSERT sans WITH CHECK (accepte tout)',
      attendu: /politique_canonique_insert_inattendue|nombre_ou_identite_politiques_inattendu/,
      preparer: (db) => db.exec(`
        DROP POLICY plm_sync_jobs_insert_brand ON public.plm_erp_sync_jobs;
        CREATE POLICY plm_sync_jobs_insert_brand ON public.plm_erp_sync_jobs
          FOR INSERT TO PUBLIC;`),
    },
  ];

  for (const s of scenarios) {
    const db = await chaine({ arreterAvant: CIBLE });
    await peupler(db);
    await deriverProduction(db);
    const avant = await politiques(db);
    await s.preparer(db);
    const r = await jouerMigration(db);
    ok(`${s.titre} : la migration REFUSE`, !r.ok && s.attendu.test(r.message), r.message);
    const apres = await politiques(db);
    ok(`${s.titre} : les surnumeraires sont INTACTES (echec ferme, aucune suppression)`,
      SURNUMERAIRES.every((n) => apres.some((p) => p.nom === n)),
      JSON.stringify(noms(apres)));
    ok(`${s.titre} : le nombre de politiques n a pas baisse`,
      apres.length >= avant.length - 1, `${avant.length} -> ${apres.length}`);
    await db.close();
  }
}

// =========================================================================
console.log('\n5. Ce que la severite depend d une donnee NON MESUREE  [CONSTAT]');
{
  console.log('  --    le predicat exact de plm_erp_sync_jobs_select_brand n est consigne');
  console.log('  --    nulle part dans les artefacts : la lecture de production n a garde');
  console.log('  --    que son NOM. Le commentaire de la migration le decrit comme un');
  console.log('  --    « doublon » de la canonique — auquel cas il n elargit rien, et');
  console.log('  --    retirer la seule insertion SUFFIT. Sous l hypothese inverse');
  console.log('  --    (USING (true), mesuree en section 2), retirer une seule politique');
  console.log('  --    ne suffit pas. Les DEUX cas sont couverts ici, et le correctif');
  console.log('  --    des deux est le meme : il est donc juste dans les deux cas.');
}

console.log('\n6. Une politique INATTENDUE : refus, ou survie ?  [MESURE]');
{
  const db = await chaine({ arreterAvant: CIBLE });
  await peupler(db);
  await deriverProduction(db);
  await db.exec(`
    CREATE POLICY plm_erp_sync_jobs_archive_select ON public.plm_erp_sync_jobs
      FOR SELECT TO PUBLIC USING (tracefab_is_org_member(brand_organization_id)
                                  AND job_reference LIKE 'archive-%');`);
  const avant = await politiques(db);
  ok('etat : 5 politiques, dont une inattendue', noms(avant).length === 5,
    JSON.stringify(noms(avant)));
  const signatureInattendue = JSON.stringify(avant.find((p) => p.nom === 'plm_erp_sync_jobs_archive_select'));

  const r = await jouerMigration(db);
  // LE CONTRAT A CHANGE le 29/10. Avant le garde de nombre, la migration
  // passait et laissait cette 5e politique en place (3 survivantes) : c'etait
  // la limite que ce test avait mesuree. Le garde ajoute refuse desormais tout
  // etat qui n'est ni « 2 canoniques » ni « 4 politiques connues ».
  ok('la migration REFUSE une 5e politique inattendue', !r.ok, r.message);
  ok('le refus est motive par le garde de nombre/identite',
    /nombre_ou_identite_politiques_inattendu/.test(r.message), r.message);
  const apres = await politiques(db);
  ok('RIEN n a ete supprime : les 5 politiques sont encore la', apres.length === 5,
    JSON.stringify(noms(apres)));
  ok('la politique inattendue est intacte, definition identique',
    JSON.stringify(apres.find((p) => p.nom === 'plm_erp_sync_jobs_archive_select')) === signatureInattendue,
    JSON.stringify(noms(apres)));
  ok('les 2 surnumeraires n ont PAS ete retirees par un echec partiel',
    SURNUMERAIRES.every((n) => apres.some((p) => p.nom === n)));
  await db.close();
}

// =========================================================================
console.log('\n7. Idempotence sur l etat reel, deuxieme passage  [MESURE]');
{
  const db = await chaine({ arreterAvant: CIBLE });
  await peupler(db);
  await deriverProduction(db);
  const r1 = await jouerMigration(db);
  ok('1er passage : accepte', r1.ok, r1.message);
  const sig1 = signature(await politiques(db));
  const r2 = await jouerMigration(db);
  ok('2e passage : accepte aussi (les surnumeraires ne sont plus la)', r2.ok, r2.message);
  ok('2e passage : aucun changement de politiques', signature(await politiques(db)) === sig1);
  await db.close();
}

// =========================================================================
console.log('\n--------------------------------------------');
if (echecs === 0) {
  console.log(`${verifies} verifications passees.`);
  console.log('Les 4 politiques observees se ramenent aux 2 canoniques ; les gardes');
  console.log('acceptent cet etat, refusent les etats divergents sans rien detruire,');
  console.log('et ne touchent jamais une politique qu elles ne nomment pas.');
  process.exit(0);
}
console.error(`${echecs} echec(s) sur ${verifies} verifications.`);
process.exit(1);
