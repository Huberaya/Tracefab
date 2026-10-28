#!/usr/bin/env node
/**
 * Test bloquant : les champs calcules d'un produit ne sont pas falsifiables.
 *
 * CE QU'IL EMPECHE DE REVENIR
 *
 * `tracefab_app` detenait INSERT/UPDATE/DELETE au niveau TABLE sur
 * `tracefab_products`. Le declencheur `products_validate_brand_ownership`
 * protegeait les champs calcules (version, data_completion, data_readiness,
 * data_ready_at) derriere deux GUC de session — `tracefab.internal_product_revision`
 * et `tracefab.internal_product_readiness_update`. Un GUC etant positionnable
 * par n'importe quel role, le role runtime pouvait reecrire la version d'un
 * produit et son etat de readiness. Mesure d'origine, base jetable, 28/10/2026 :
 *   version sans GUC -> REFUS P0001 ; GUC pose -> ACCEPTE.
 *
 * CE TEST ECHOUE SUR LE CODE VULNERABLE, ET PAS SEULEMENT IL PASSE SUR LE
 * CORRECTIF : la propriete 2 (GUC forge) tombe des que l'ecriture des champs
 * calcules redevient possible. C'est ce qui en fait une non-regression.
 *
 * IL EPROUVE AUSSI QUE LA CORRECTION N'A RIEN CASSE : les champs non calcules
 * restent modifiables, l'INSERT reste possible — c'est ce dont depend l'import
 * en masse — et la revision produit (fonction SECURITY DEFINER) fonctionne.
 *
 * Variables :
 *   TF_RLS_APP_URL  connexion du role applicatif (sans BYPASSRLS) — obligatoire
 *   DATABASE_URL    connexion d'administration, pour la fixture — obligatoire
 * Sortie 0 = conforme, 1 = regression, 2 = environnement incomplet (NON EXECUTE).
 */
import pg from 'pg';

const APP_URL = process.env.TF_RLS_APP_URL;
const ADMIN_URL = process.env.DATABASE_URL;

if (!APP_URL || !ADMIN_URL) {
  console.log('NON EXECUTE — TF_RLS_APP_URL et DATABASE_URL sont obligatoires.');
  process.exit(2);
}

const echecs = [];
const ok = (condition, libelle, detail) => {
  if (condition) console.log(`  ok    ${libelle}`);
  else {
    console.log(`  ECHEC ${libelle}${detail ? ` — ${detail}` : ''}`);
    echecs.push(libelle);
  }
};

const admin = new pg.Client({ connectionString: ADMIN_URL });
const app = new pg.Client({ connectionString: APP_URL });
await admin.connect();
await app.connect();

const contexte = async (userId, email, organizationId) => {
  for (const [cle, valeur] of [
    ['tracefab.user_id', userId],
    ['tracefab.user_email', email],
    ['tracefab.active_organization_id', organizationId],
  ]) {
    await app.query(`select set_config($1, $2, true)`, [cle, valeur]);
  }
};

/** Execute puis annule : la base reste intacte, quel que soit le resultat. */
const essai = async (fn) => {
  await app.query('BEGIN');
  try {
    const resultat = await fn();
    return { accepte: true, rowCount: resultat?.rowCount ?? 0 };
  } catch (error) {
    return { accepte: false, code: error.code, message: String(error.message).split('\n')[0] };
  } finally {
    await app.query('ROLLBACK');
  }
};

let produit;
try {
  // --- fixture : un produit d'une organisation dont l'appelant est membre ---
  const fixture = await admin.query(
    `select m.organization_id, m.user_id, u.email
       from organization_memberships m join users u on u.id = m.user_id
      where m.status = 'active'
        and exists (select 1 from tracefab_products p where p.brand_organization_id = m.organization_id)
      limit 1`,
  );
  if (fixture.rowCount === 0) {
    console.log('NON EXECUTE — aucune organisation brand avec produit et membre.');
    process.exit(2);
  }
  const { organization_id: orgId, user_id: userId, email } = fixture.rows[0];
  produit = (await admin.query(
    `select id, version from tracefab_products where brand_organization_id = $1 limit 1`,
    [orgId],
  )).rows[0];

  // --- 0. privilèges : plus d'écriture au niveau table ---------------------
  const droits = (await admin.query(
    `select has_table_privilege('tracefab_app', 'tracefab_products', 'INSERT') AS ins_table,
            has_table_privilege('tracefab_app', 'tracefab_products', 'UPDATE') AS upd_table,
            has_table_privilege('tracefab_app', 'tracefab_products', 'DELETE') AS del_table,
            has_column_privilege('tracefab_app', 'tracefab_products', 'name', 'UPDATE') AS upd_name,
            has_column_privilege('tracefab_app', 'tracefab_products', 'version', 'UPDATE') AS upd_version,
            has_column_privilege('tracefab_app', 'tracefab_products', 'data_readiness', 'UPDATE') AS upd_readiness,
            has_column_privilege('tracefab_app', 'tracefab_products', 'data_completion', 'UPDATE') AS upd_completion,
            has_column_privilege('tracefab_app', 'tracefab_products', 'data_ready_at', 'UPDATE') AS upd_ready_at`,
  )).rows[0];
  ok(droits.ins_table === false && droits.upd_table === false && droits.del_table === false,
    '0a. aucune ecriture au niveau table sur tracefab_products',
    JSON.stringify(droits));
  ok(droits.upd_name === true, '0b. la colonne metier « name » reste modifiable');
  ok(droits.upd_version === false, '0c. la colonne calculee « version » est hors de portee');
  ok(droits.upd_readiness === false && droits.upd_completion === false && droits.upd_ready_at === false,
    '0d. les trois autres colonnes calculees sont hors de portee');

  // --- 1. champ calcule sans GUC : refuse ----------------------------------
  await app.query('BEGIN');
  await contexte(userId, email, orgId);
  const sansGuc = await (async () => {
    try {
      await app.query(`update tracefab_products set version = version + 1 where id = $1`, [produit.id]);
      return { accepte: true };
    } catch (error) {
      return { accepte: false, code: error.code };
    } finally {
      await app.query('ROLLBACK');
    }
  })();
  ok(sansGuc.accepte === false, '1. champ calcule refuse sans GUC', `accepte=${sansGuc.accepte}`);

  // --- 2. GUC forge : refuse (c'est la propriete qui manquait) -------------
  await app.query('BEGIN');
  await contexte(userId, email, orgId);
  const pose = await (async () => {
    try {
      await app.query(`select set_config('tracefab.internal_product_revision', 'true', true)`);
      return true;
    } catch {
      return false;
    }
  })();
  let gucForge;
  try {
    await app.query(`update tracefab_products set version = version + 1 where id = $1`, [produit.id]);
    gucForge = { accepte: true };
  } catch (error) {
    gucForge = { accepte: false, code: error.code };
  } finally {
    await app.query('ROLLBACK');
  }
  ok(pose, '2a. le role applicatif peut toujours poser le GUC (temoin : la garde ne doit pas en dependre)');
  ok(gucForge.accepte === false, '2b. champ calcule refuse MEME avec le GUC forge', `accepte=${gucForge.accepte}`);

  // --- 3. non-regression : un champ non calcule reste modifiable -----------
  const libre = await essai(() => app.query(
    `update tracefab_products set name = name where id = $1`, [produit.id],
  ).then(async (r) => { await contexte(userId, email, orgId); return r; }));
  ok(libre.accepte === true, '3. un champ non calcule reste modifiable par l application', libre.message);

  // --- 4. non-regression : l'import en masse peut toujours inserer ---------
  // `bulk-importer.ts` ecrit directement la table pour les champs metier.
  await app.query('BEGIN');
  await contexte(userId, email, orgId);
  let insertion;
  try {
    await app.query(
      `insert into tracefab_products (brand_organization_id, reference, name, category, status)
       values ($1, $2, 'Produit de controle', 'textile', 'draft')`,
      [orgId, `ESS-${Date.now()}`],
    );
    insertion = { accepte: true };
  } catch (error) {
    insertion = { accepte: false, code: error.code, message: String(error.message).split('\n')[0] };
  } finally {
    await app.query('ROLLBACK');
  }
  ok(insertion.accepte === true, '4. l INSERT d un produit reste possible (import en masse preserve)', insertion.message);

  // --- 5. non-regression : la revision produit (SECURITY DEFINER) fonctionne
  await app.query('BEGIN');
  await contexte(userId, email, orgId);
  let revision;
  try {
    await app.query(`select tracefab_start_product_revision($1)`, [produit.id]);
    revision = { accepte: true };
  } catch (error) {
    revision = { accepte: false, code: error.code, message: String(error.message).split('\n')[0] };
  } finally {
    await app.query('ROLLBACK');
  }
  ok(revision.accepte === true, '5. la revision produit via SECURITY DEFINER fonctionne toujours', revision.message);

  // --- 6. etat final : aucune ecriture n'a survecu ------------------------
  const final = await admin.query(`select version from tracefab_products where id = $1`, [produit.id]);
  ok(Number(final.rows[0].version) === Number(produit.version), '6. la version du produit est inchangee',
    `version=${final.rows[0].version}`);
} finally {
  await app.end().catch(() => {});
  await admin.end().catch(() => {});
}

console.log(`\n  Champs calcules produit : ${echecs.length === 0 ? 'OK' : `${echecs.length} echec(s)`}.`);
process.exit(echecs.length === 0 ? 0 : 1);
