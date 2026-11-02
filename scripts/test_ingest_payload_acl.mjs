#!/usr/bin/env node
/**
 * Chantier A (P10.2) — preuves d'accès à `tracefab_ingest_plm_erp_payload`.
 *
 * POURQUOI CE TEST
 *
 * La fonction est SECURITY DEFINER : elle s'exécute avec les droits de son
 * propriétaire, donc la RLS est contournée à l'intérieur. Deux défauts se
 * cumulaient avant P10.2 :
 *
 *   1. son corps n'avait AUCUNE garde de rôle : le seul rempart était l'ACL ;
 *   2. l'identité venait de `tracefab.user_id`, un GUC que le client pose
 *      lui-même — y compris quand la valeur désigne un utilisateur d'une AUTRE
 *      organisation.
 *
 * La migration `20261030140000_ingest_payload_role_guard_and_acl` ajoute une
 * garde sur le rôle de SESSION (seul élément authentifié par PostgreSQL) et
 * épingle le `search_path`. Ce script vérifie le résultat sur un vrai cluster,
 * par le vrai chemin d'exécution (rôle applicatif + GUC transactionnel), pas
 * en SQL direct sous superutilisateur.
 *
 * CE QU'IL MESURE
 *
 *   A1  rôle non autorisé                 → refus (ingest_role_not_allowed)
 *   A1b ACL : sans GRANT explicite        → refus (insufficient_privilege)
 *   A2  rôle autorisé sans identité       → refus (authentication_required)
 *   A3  GUC falsifié par un intrus        → refus, la garde passe avant
 *   A4  identité d'une autre organisation → refus (brand_product_role_required)
 *   A5  rôle technique autorisé           → succès, résumé rendu
 *   A6  écriture dans l'organisation juste → produit + identifiant + job créés
 *   A7  écriture inter-organisations      → refus ET zéro ligne chez la victime
 *   A8  ACL après migrations              → PUBLIC absent, search_path épinglé,
 *                                          aucune migration postérieure ne
 *                                          rétablit l'exposition
 *
 * CE QU'IL NE FAIT PAS
 *
 *   — il n'applique pas les migrations : il vérifie leur RÉSULTAT. En CI, il
 *     tourne après `prisma migrate deploy`.
 *   — il ne teste pas l'application Next.js : le client Prisma n'est pas
 *     générable hors ligne (binaries.prisma.sh inaccessible). Le protocole est
 *     reproduit instruction pour instruction depuis
 *     `api/_lib/context.ts:99` et `api/_lib/plm-erp/ingestor.ts:75`.
 *
 * PRÉREQUIS : une base JETABLE déjà migrée, désignée par DATABASE_URL.
 * La garde d'import refuse tout autre cible : ce script crée des rôles, des
 * organisations et des utilisateurs.
 *
 * Sorties : 0 tout est conforme · 1 au moins une assertion échoue.
 */
import './lib/garde_import.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';

const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const URL_PROPRIETAIRE = process.env.DATABASE_URL;

let vertes = 0;
const rouges = [];
function verifier(libelle, condition, detail) {
  if (condition) {
    vertes += 1;
    console.log(`  ok    ${libelle}`);
  } else {
    rouges.push(libelle);
    console.log(`  ECHEC ${libelle}${detail ? ` — ${detail}` : ''}`);
  }
}

const SIGNATURE = 'public.tracefab_ingest_plm_erp_payload(uuid,text,jsonb,uuid)';
const MARQUEUR = 'P102';

// Mot de passe des rôles de sonde : la base est jetable, il n'ouvre rien
// d'autre qu'elle. Il est tiré au hasard à chaque exécution et n'est jamais
// journalisé.
const MDP_SONDE = randomBytes(18).toString('hex');
const ROLE_INTRUS = 'tf_p102_intrus';
const ROLE_APP_PROBE = 'tf_p102_app_probe';

/** URL vers la même base avec un autre couple rôle/mot de passe. */
function urlAvecRole(url, role, motDePasse) {
  const u = new URL(url);
  u.username = encodeURIComponent(role);
  u.password = encodeURIComponent(motDePasse);
  return u.toString();
}

/** Ouvre une connexion d'erreur attendue ; rend {ok, code, message}. */
async function attendreRefus(fn) {
  try {
    const valeur = await fn();
    return { ok: false, resultat: valeur };
  } catch (e) {
    return { ok: true, code: e.code || '', message: e.message || String(e) };
  }
}

async function ouvrir(url) {
  const c = new pg.Client({ connectionString: url, ssl: sslDepuisUrl(url) });
  await c.connect();
  return c;
}

/**
 * Le protocole EXACT du chemin applicatif :
 *   BEGIN  → set_config('tracefab.user_id', $1, true)  (context.ts:99)
 *          → SELECT tracefab_ingest_plm_erp_payload(...) (ingestor.ts:75)
 *   COMMIT / ROLLBACK
 */
async function appelerParCheminApplicatif(client, { userId, organizationId, payload, integrationId = null }) {
  await client.query('BEGIN');
  try {
    if (userId !== undefined) {
      await client.query(`SELECT set_config('tracefab.user_id', $1, true)`, [userId]);
    }
    const { rows } = await client.query(
      `SELECT tracefab_ingest_plm_erp_payload($1::uuid, $2, $3::jsonb, $4::uuid) AS summary`,
      [organizationId, 'generic_csv', JSON.stringify(payload), integrationId],
    );
    await client.query('COMMIT');
    return rows[0].summary;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

const admin = await ouvrir(URL_PROPRIETAIRE);
let intrus = null;
const nettoyage = [];

try {
  console.log('\n  PRÉREQUIS — la base doit être migrée et porter la garde');
  {
    const r = await admin.query(
      `SELECT count(*)::int n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
        WHERE ns.nspname = 'public' AND p.proname = 'tracefab_ingest_plm_erp_payload'`,
    );
    verifier('la fonction existe', r.rows[0].n === 1);
    const def = await admin.query(
      `SELECT pg_get_functiondef(oid) AS corps FROM pg_proc WHERE oid = $1::regprocedure`, [SIGNATURE],
    );
    verifier('la migration 20261030140000 est appliquée (garde présente)',
      /ingest_role_not_allowed/.test(def.rows[0]?.corps || ''));
    if (rouges.length > 0) throw new Error('prérequis non satisfaits : rien de plus ne serait mesurable');
  }

  console.log('\n  FIXTURES — deux organisations « brand », deux propriétaires, deux rôles de sonde');
  const marqueur = `${MARQUEUR}-${Date.now()}`;
  const orgA = (await admin.query(
    `INSERT INTO organizations (type, legal_name, display_name, status)
     VALUES ('brand', $1, 'P10.2 brand A', 'active') RETURNING id`, [`A ${marqueur}`])).rows[0].id;
  const orgB = (await admin.query(
    `INSERT INTO organizations (type, legal_name, display_name, status)
     VALUES ('brand', $1, 'P10.2 brand B', 'active') RETURNING id`, [`B ${marqueur}`])).rows[0].id;
  const userA = (await admin.query(
    `INSERT INTO users (clerk_user_id, email, full_name) VALUES ($1, $2, 'P10.2 A') RETURNING id`,
    [`p102_a_${marqueur}`, `a_${marqueur}@exemple.test`])).rows[0].id;
  const userB = (await admin.query(
    `INSERT INTO users (clerk_user_id, email, full_name) VALUES ($1, $2, 'P10.2 B') RETURNING id`,
    [`p102_b_${marqueur}`, `b_${marqueur}@exemple.test`])).rows[0].id;
  for (const [org, user] of [[orgA, userA], [orgB, userB]]) {
    await admin.query(
      `INSERT INTO organization_memberships (organization_id, user_id, role, status, joined_at)
       VALUES ($1, $2, 'owner', 'active', now())`, [org, user]);
  }
  nettoyage.push(async () => {
    await admin.query(`DELETE FROM tracefab_products WHERE brand_organization_id = ANY($1::uuid[])`, [[orgA, orgB]]);
    await admin.query(`DELETE FROM organization_memberships WHERE organization_id = ANY($1::uuid[])`, [[orgA, orgB]]);
    await admin.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[orgA, orgB]]);
    await admin.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[userA, userB]]);
  });

  // Rôle intrus : peut se connecter, n'est ni superutilisateur ni membre du
  // rôle applicatif, et ne doit RIEN pouvoir écrire.
  // Reprise d'une execution interrompue : un role de sonde precedent ne doit
  // pas faire echouer le test. On le nettoie avant de le recreer.
  for (const role of [ROLE_INTRUS, ROLE_APP_PROBE]) {
    await admin.query(`REVOKE ALL ON SCHEMA public FROM ${role}`).catch(() => {});
    await admin.query(`DROP OWNED BY ${role}`).catch(() => {});
    await admin.query(`REVOKE tracefab_app FROM ${role}`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${role}`);
  }
  await admin.query(`CREATE ROLE ${ROLE_INTRUS} LOGIN PASSWORD '${MDP_SONDE}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
  nettoyage.push(async () => { await admin.query(`DROP ROLE IF EXISTS ${ROLE_INTRUS}`); });

  // Rôle de sonde applicatif : simple LOGIN, non superutilisateur, MEMBRE de
  // `tracefab_app`. Il emprunte le chemin d'autorisation prévu sans qu'on ait
  // à toucher au mot de passe du vrai rôle applicatif.
  await admin.query(`DROP ROLE IF EXISTS ${ROLE_APP_PROBE}`);
  await admin.query(`CREATE ROLE ${ROLE_APP_PROBE} LOGIN PASSWORD '${MDP_SONDE}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
  await admin.query(`GRANT tracefab_app TO ${ROLE_APP_PROBE}`);
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${ROLE_APP_PROBE}`);
  nettoyage.push(async () => {
    // Un role ne se supprime pas tant qu il detient un privilege : on retire
    // d abord ce qui a ete accorde, puis le role.
    await admin.query(`REVOKE ALL ON SCHEMA public FROM ${ROLE_APP_PROBE}`).catch(() => {});
    await admin.query(`REVOKE tracefab_app FROM ${ROLE_APP_PROBE}`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${ROLE_APP_PROBE}`);
  });

  const intrusUrl = urlAvecRole(URL_PROPRIETAIRE, ROLE_INTRUS, MDP_SONDE);
  const probeUrl = urlAvecRole(URL_PROPRIETAIRE, ROLE_APP_PROBE, MDP_SONDE);
  const payload = {
    products: [{
      reference: `REF-${MARQUEUR}-1`,
      name: 'T-shirt de test P10.2',
      sku: `SKU-${MARQUEUR}-1`,
      category: 'Apparel',
      gtin: '0123456789012',
    }],
  };

  console.log('\n  A1 — rôle non autorisé : refus');
  {
    // ACL d'abord : sans droit, le refus vient de PostgreSQL lui-même.
    const sansGrant = await ouvrir(intrusUrl);
    try {
      const r = await attendreRefus(() => appelerParCheminApplicatif(sansGrant,
        { userId: userA, organizationId: orgA, payload }));
      verifier('A1b sans GRANT, l appel est refusé par le catalogue (insufficient_privilege)',
        r.ok && r.code === '42501', r.ok ? `code=${r.code}` : 'appel ACCEPTÉ');
    } finally {
      await sansGrant.end();
    }

    // Puis on LUI ACCORDE EXECUTE : c'est l'hypothèse « l'ACL a fuité ». La
    // garde de rôle doit alors refuser seule. C'est le cœur du correctif : le
    // corps de la fonction ne dépend plus de l'ACL pour se protéger.
    await admin.query(`GRANT EXECUTE ON FUNCTION ${SIGNATURE} TO ${ROLE_INTRUS}`);
    nettoyage.push(async () => {
      await admin.query(`REVOKE EXECUTE ON FUNCTION ${SIGNATURE} FROM ${ROLE_INTRUS}`).catch(() => {});
    });

    intrus = await ouvrir(intrusUrl);
    const r = await attendreRefus(() => appelerParCheminApplicatif(intrus,
      { userId: userA, organizationId: orgA, payload }));
    verifier('A1 même avec EXECUTE accordé, la garde refuse le rôle non autorisé',
      r.ok && /ingest_role_not_allowed/.test(r.message), r.ok ? r.message : 'appel ACCEPTÉ');

    const avant = await admin.query(`SELECT count(*)::int n FROM tracefab_products WHERE brand_organization_id = $1`, [orgA]);
    verifier('A1 aucune écriture n a eu lieu pour le rôle non autorisé', avant.rows[0].n === 0, `n=${avant.rows[0].n}`);
  }

  console.log('\n  A2 — rôle autorisé, aucune identité : refus');
  {
    const c = await ouvrir(probeUrl);
    try {
      const r = await attendreRefus(() => appelerParCheminApplicatif(c,
        { organizationId: orgA, payload }));
      verifier('A2 sans tracefab.user_id : authentication_required',
        r.ok && /authentication_required/.test(r.message), r.ok ? r.message : 'appel ACCEPTÉ');
    } finally {
      await c.end();
    }
  }

  console.log('\n  A3 — GUC falsifié par un intrus : refus');
  {
    // L'intrus se donne l'identité EXACTE d'un propriétaire légitime. Avant
    // P10.2 c'était suffisant : aucune garde de rôle, et l'identité venait du
    // seul GUC. Le GUC est toujours falsifiable ; il n'est simplement plus la
    // seule barrière.
    const r = await attendreRefus(() => appelerParCheminApplicatif(intrus,
      { userId: userA, organizationId: orgA, payload }));
    verifier('A3 le GUC falsifié ne suffit pas : ingest_role_not_allowed',
      r.ok && /ingest_role_not_allowed/.test(r.message), r.ok ? r.message : 'appel ACCEPTÉ');
    const apres = await admin.query(`SELECT count(*)::int n FROM tracefab_products WHERE brand_organization_id = $1`, [orgA]);
    verifier('A3 aucune écriture malgré le GUC falsifié', apres.rows[0].n === 0, `n=${apres.rows[0].n}`);

    // Le GRANT temporaire n'existait que pour éprouver la garde : on le retire
    // pour que A8 mesure l'ACL réelle du dépôt, pas celle de la sonde.
    await admin.query(`REVOKE EXECUTE ON FUNCTION ${SIGNATURE} FROM ${ROLE_INTRUS}`);
    await admin.query(`DROP OWNED BY ${ROLE_INTRUS}`).catch(() => {});
    const controle = await admin.query(`
      SELECT count(*)::int n FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
       WHERE p.oid = $1::regprocedure AND a.privilege_type = 'EXECUTE'
         AND a.grantee::regrole::text = $2`, [SIGNATURE, ROLE_INTRUS]);
    verifier('A3 le GRANT de sonde a bien été retiré', controle.rows[0].n === 0);
  }

  console.log('\n  A4 — identité d une autre organisation : refus');
  {
    const c = await ouvrir(probeUrl);
    try {
      // userB est owner de B, pas de A : l'identité est authentique mais ne
      // porte aucun droit sur A.
      const r = await attendreRefus(() => appelerParCheminApplicatif(c,
        { userId: userB, organizationId: orgA, payload }));
      verifier('A4 identité de B sur l organisation A : brand_product_role_required',
        r.ok && /brand_product_role_required/.test(r.message), r.ok ? r.message : 'appel ACCEPTÉ');
    } finally {
      await c.end();
    }
  }

  console.log('\n  A5 — rôle technique autorisé : succès');
  let resume = null;
  {
    const c = await ouvrir(probeUrl);
    try {
      resume = await appelerParCheminApplicatif(c, { userId: userA, organizationId: orgA, payload });
      verifier('A5 l appel aboutit et rend un résumé', Boolean(resume && typeof resume === 'object'),
        JSON.stringify(resume || null).slice(0, 120));
    } catch (e) {
      verifier('A5 l appel aboutit et rend un résumé', false, e.message);
    } finally {
      await c.end();
    }
  }

  console.log('\n  A6 — écriture dans l organisation autorisée : succès');
  {
    const p = await admin.query(
      `SELECT id, reference, created_by FROM tracefab_products
        WHERE brand_organization_id = $1 AND reference = $2`, [orgA, `REF-${MARQUEUR}-1`]);
    verifier('A6 le produit est écrit dans l organisation A', p.rows.length === 1,
      `${p.rows.length} ligne(s)`);
    verifier('A6 le produit porte l identité applicative attendue (created_by)',
      p.rows[0] && String(p.rows[0].created_by) === String(userA), p.rows[0]?.created_by);

    const id = await admin.query(
      `SELECT identifier_value FROM product_identifiers WHERE product_id = $1 AND identifier_type = 'gtin'`,
      [p.rows[0]?.id]);
    verifier('A6 l identifiant GTIN est écrit', id.rows.length === 1 && id.rows[0].identifier_value === '0123456789012');

    verifier('A6 le résumé annonce un produit créé', Number(resume?.productsCreated) === 1,
      `productsCreated=${resume?.productsCreated}`);
  }

  console.log('\n  A7 — écriture inter-organisations : refus');
  {
    const avant = await admin.query(`SELECT count(*)::int n FROM tracefab_products WHERE brand_organization_id = $1`, [orgB]);
    const c = await ouvrir(probeUrl);
    try {
      const r = await attendreRefus(() => appelerParCheminApplicatif(c, {
        userId: userA,
        organizationId: orgB,
        payload: { products: [{ reference: `REF-${MARQUEUR}-INTRUS`, name: 'Doit être refusé' }] },
      }));
      verifier('A7 userA propriétaire de A ne peut pas écrire dans B',
        r.ok && /brand_product_role_required/.test(r.message), r.ok ? r.message : 'appel ACCEPTÉ');
      const apres = await admin.query(`SELECT count(*)::int n FROM tracefab_products WHERE brand_organization_id = $1`, [orgB]);
      verifier('A7 aucune ligne n a été créée chez l organisation B',
        apres.rows[0].n === avant.rows[0].n && apres.rows[0].n === 0,
        `${avant.rows[0].n} avant, ${apres.rows[0].n} après`);

      const fuite = await admin.query(`SELECT count(*)::int n FROM tracefab_products WHERE reference = $1`,
        [`REF-${MARQUEUR}-INTRUS`]);
      const jobs = await admin.query(`SELECT count(*)::int n FROM plm_erp_sync_jobs WHERE brand_organization_id = $1`, [orgB]);
      verifier('A7 aucune trace résiduelle (produit ni job) chez la victime',
        fuite.rows[0].n === 0 && jobs.rows[0].n === 0, `produits=${fuite.rows[0].n} jobs=${jobs.rows[0].n}`);
    } finally {
      await c.end();
    }
  }

  console.log('\n  A9 — le propriétaire de la fonction reste autorisé (runtime actuel)');
  // POURQUOI CE CAS EXISTE (P10.3)
  //
  // Le runtime de production ne se connecte pas encore avec `tracefab_app` :
  // il utilise le rôle PROPRIÉTAIRE de la base, celui des migrations
  // (documenté dans `.github/workflows/ci.yml`). Ce rôle n'est ni
  // superutilisateur ni membre de `tracefab_app`. La garde de P10.2, dans sa
  // première version, le REFUSAIT : mesure sur base jetable avec un rôle au
  // profil identique (NOSUPERUSER BYPASSRLS, propriétaire, hors
  // `tracefab_app`) → `ingest_role_not_allowed` sur l'appel nominal. Appliquer
  // cette version aurait coupé l'ingestion au déploiement.
  //
  // La branche « propriétaire » n'élargit rien : ce rôle peut déjà ALTER et
  // DROP la fonction, et il possède les tables qu'elle écrit.
  const ROLE_PROPRIO = 'tf_p103_proprietaire';
  let proprietaireInitial = null;
  {
    const r0 = await admin.query(
      `SELECT pg_get_userbyid(p.proowner) AS proprietaire FROM pg_proc p WHERE p.oid = $1::regprocedure`,
      [SIGNATURE]);
    proprietaireInitial = r0.rows[0].proprietaire;

    // Reprise d'une exécution interrompue.
    await admin.query(`REVOKE ALL ON SCHEMA public FROM ${ROLE_PROPRIO}`).catch(() => {});
    await admin.query(`DROP OWNED BY ${ROLE_PROPRIO}`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${ROLE_PROPRIO}`);
    await admin.query(`CREATE ROLE ${ROLE_PROPRIO} LOGIN PASSWORD '${MDP_SONDE}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
    nettoyage.push(async () => {
      await admin.query(`ALTER FUNCTION public.tracefab_ingest_plm_erp_payload(UUID, TEXT, JSONB, UUID) OWNER TO "${proprietaireInitial}"`).catch(() => {});
      await admin.query(`REVOKE ALL ON SCHEMA public FROM ${ROLE_PROPRIO}`).catch(() => {});
      await admin.query(`DROP OWNED BY ${ROLE_PROPRIO}`).catch(() => {});
      await admin.query(`DROP ROLE IF EXISTS ${ROLE_PROPRIO}`);
    });

    // Ce que la propriété donne en production : l'accès aux tables et aux
    // fonctions utilitaires. On le reproduit ici, sur une base jetable.
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${ROLE_PROPRIO}`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE_PROPRIO}`);
    await admin.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ROLE_PROPRIO}`);
    // Toutes les fonctions utilitaires : en production, le propriétaire les
    // possède, donc en a l'EXECUTE par propriété. On reproduit ce point.
    await admin.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${ROLE_PROPRIO}`);
    await admin.query(`ALTER FUNCTION public.tracefab_ingest_plm_erp_payload(UUID, TEXT, JSONB, UUID) OWNER TO ${ROLE_PROPRIO}`);

    const c = await ouvrir(urlAvecRole(URL_PROPRIETAIRE, ROLE_PROPRIO, MDP_SONDE));
    try {
      const r = await appelerParCheminApplicatif(c, {
        userId: userA,
        organizationId: orgA,
        payload: { products: [{ reference: `REF-${MARQUEUR}-PROPRIO`, name: 'Ingestion par le propriétaire' }] },
      });
      verifier('A9 le propriétaire (non superutilisateur, hors tracefab_app) est autorisé',
        Boolean(r && typeof r === 'object'), JSON.stringify(r || null).slice(0, 120));
    } catch (e) {
      verifier('A9 le propriétaire (non superutilisateur, hors tracefab_app) est autorisé', false, e.message);
    } finally {
      await c.end();
    }

    const p = await admin.query(
      `SELECT count(*)::int n FROM tracefab_products WHERE brand_organization_id = $1 AND reference = $2`,
      [orgA, `REF-${MARQUEUR}-PROPRIO`]);
    verifier('A9 l écriture du propriétaire aboutit dans la bonne organisation', p.rows[0].n === 1, `n=${p.rows[0].n}`);
  }

  console.log('\n  A10 — propriété retirée : le même rôle est de nouveau refusé');
  {
    await admin.query(`ALTER FUNCTION public.tracefab_ingest_plm_erp_payload(UUID, TEXT, JSONB, UUID) OWNER TO "${proprietaireInitial}"`);
    // L'EXECUTE est conservé : ce qui doit refuser, c'est la GARDE, pas l'ACL.
    await admin.query(`GRANT EXECUTE ON FUNCTION ${SIGNATURE} TO ${ROLE_PROPRIO}`);
    const c = await ouvrir(urlAvecRole(URL_PROPRIETAIRE, ROLE_PROPRIO, MDP_SONDE));
    try {
      const r = await attendreRefus(() => appelerParCheminApplicatif(c, {
        userId: userA,
        organizationId: orgA,
        payload: { products: [{ reference: `REF-${MARQUEUR}-PLUSPROPRIO`, name: 'Doit être refusé' }] },
      }));
      verifier('A10 sans la propriété, le rôle est refusé par la garde',
        r.ok && /ingest_role_not_allowed/.test(r.message), r.ok ? r.message : 'appel ACCEPTÉ');
    } finally {
      await c.end();
    }
    const p = await admin.query(`SELECT count(*)::int n FROM tracefab_products WHERE reference = $1`,
      [`REF-${MARQUEUR}-PLUSPROPRIO`]);
    verifier('A10 aucune écriture n a eu lieu après retrait de la propriété', p.rows[0].n === 0, `n=${p.rows[0].n}`);

    const proprietaireApres = (await admin.query(
      `SELECT pg_get_userbyid(p.proowner) AS proprietaire FROM pg_proc p WHERE p.oid = $1::regprocedure`,
      [SIGNATURE])).rows[0].proprietaire;
    verifier('A10 le propriétaire de la fonction est restauré',
      proprietaireApres === proprietaireInitial, `${proprietaireApres} ≠ ${proprietaireInitial}`);

    // Remise à l'état du dépôt : l'ACL mesurée par A8 doit être celle des
    // migrations, pas celle des sondes de ce test.
    await admin.query(`REVOKE EXECUTE ON FUNCTION ${SIGNATURE} FROM ${ROLE_PROPRIO}`);
    await admin.query(`REVOKE ALL ON SCHEMA public FROM ${ROLE_PROPRIO}`).catch(() => {});
    await admin.query(`DROP OWNED BY ${ROLE_PROPRIO}`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${ROLE_PROPRIO}`);
    const restants = await admin.query(`
      SELECT DISTINCT a.grantee::regrole::text AS role_name
        FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
       WHERE p.oid = $1::regprocedure AND a.privilege_type = 'EXECUTE'
         AND a.grantee <> 0
         AND a.grantee::regrole::text NOT IN ('tracefab_app', pg_get_userbyid(p.proowner))`,
      [SIGNATURE]);
    verifier('A10 l ACL est revenue à l état des migrations', restants.rows.length === 0,
      restants.rows.map((r) => r.role_name).join(', '));
  }

  console.log('\n  A8 — ACL après toutes les migrations');
  {
    const pub = await admin.query(`SELECT has_function_privilege('public', $1::regprocedure, 'EXECUTE') AS peut`, [SIGNATURE]);
    verifier('A8 PUBLIC n a pas EXECUTE', pub.rows[0].peut === false);

    const autres = await admin.query(`
      SELECT DISTINCT a.grantee::regrole::text AS role_name
        FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
       WHERE p.oid = $1::regprocedure AND a.privilege_type = 'EXECUTE'
         AND a.grantee <> 0
         AND a.grantee::regrole::text NOT IN ('tracefab_app', pg_get_userbyid(p.proowner))`,
      [SIGNATURE]);
    verifier('A8 seuls le propriétaire et tracefab_app détiennent EXECUTE',
      autres.rows.length === 0, autres.rows.map((r) => r.role_name).join(', '));

    const app = await admin.query(`SELECT has_function_privilege('tracefab_app', $1::regprocedure, 'EXECUTE') AS peut`, [SIGNATURE]);
    verifier('A8 le rôle applicatif conserve EXECUTE (le chemin réel n est pas cassé)', app.rows[0].peut === true);

    const def = await admin.query(
      `SELECT prosecdef, array_to_string(proconfig, ',') AS config FROM pg_proc WHERE oid = $1::regprocedure`, [SIGNATURE]);
    verifier('A8 la fonction reste SECURITY DEFINER', def.rows[0].prosecdef === true);
    verifier('A8 search_path est épinglé (pg_catalog en tête)',
      /search_path=pg_catalog/.test(def.rows[0].config || ''), def.rows[0].config);

    // Aucune migration POSTÉRIEURE ne doit rétablir l'exposition. On lit les
    // dossiers triés : tout ce qui vient après 20261030140000 est inspecté.
    const dossiers = readdirSync(join(RACINE, 'prisma', 'migrations'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d{14}_/.test(e.name))
      .map((e) => e.name)
      .sort()
      .filter((n) => n.slice(0, 14) > '20261030140000');
    const retablissements = [];
    for (const d of dossiers) {
      const corps = readFileSync(join(RACINE, 'prisma', 'migrations', d, 'migration.sql'), 'utf8');
      const motif = new RegExp(
        `GRANT\\s+EXECUTE\\s+ON\\s+FUNCTION\\s+(?:public\\.)?tracefab_ingest_plm_erp_payload[^;]*TO\\s+(?:PUBLIC|tracefab_app)`, 'i');
      if (motif.test(corps)) retablissements.push(d);
      if (new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+(?:public\\.)?tracefab_ingest_plm_erp_payload`, 'i').test(corps)) {
        // Une redéfinition est permise, mais elle doit conserver la garde.
        if (!/ingest_role_not_allowed/.test(corps)) retablissements.push(`${d} (redéfinition sans garde)`);
      }
    }
    verifier(`A8 aucune des ${dossiers.length} migration(s) postérieure(s) ne rétablit l exposition`,
      retablissements.length === 0, retablissements.join(', '));
  }
} catch (e) {
  console.log(`\n  INTERRUPTION — ${e.message}`);
  rouges.push(`interruption : ${e.message}`);
} finally {
  if (intrus) await intrus.end().catch(() => {});
  for (const etape of nettoyage.reverse()) {
    try { await etape(); } catch (e) { console.log(`  (nettoyage) ${e.message}`); }
  }
  await admin.end().catch(() => {});
}

console.log('\n  --------------------------------------------');
console.log(`  ${vertes}/${vertes + rouges.length} assertions vertes`);
if (rouges.length > 0) {
  console.log(`  en échec : ${rouges.join(' · ')}\n`);
  process.exit(1);
}
console.log('  ok — la fonction est fermée, le chemin applicatif fonctionne.\n');
process.exit(0);
