#!/usr/bin/env node
/**
 * Contexte de locataire actif — preuve par execution en PostgreSQL.
 *
 * POURQUOI CE TEST EXISTE
 *
 * Incident Production du 2026-10-17 : un administrateur Clerk membre de Ginger
 * et de Tracefab Recette Production voyait, depuis Ginger, le produit brouillon
 * RECETTE-DPP-20261017 qui n'appartient qu'au tenant de recette.
 *
 * `test_neon_cross_tenant.mjs` prouve deja la RLS : deux locataires ne voient
 * pas les memes lignes. Ce defaut-la n'etait PAS une faille de RLS. La RLS
 * repondait correctement a la question posee — « cet utilisateur est-il
 * membre ? » — et la route posait la mauvaise question : elle filtrait sur
 * l'UNION des organisations du compte au lieu d'un locataire actif.
 *
 * RLS et bornage tenant sont deux controles distincts :
 *
 *   RLS                 : l'utilisateur a-t-il le droit de voir cette ligne ?
 *   locataire actif     : cette ligne appartient-elle au tenant affiche ?
 *
 * Un compte mono-organisation rend les deux identiques. C'est exactement
 * pourquoi le defaut a passe tous les tests existants.
 *
 * CE QUE CE TEST VERIFIE
 *
 *   1. `tracefab_active_organization_id()` vaut NULL hors contexte arme ;
 *   2. arme dans une transaction, il rend exactement la valeurarmee ;
 *   3. `tracefab_in_active_tenant()` est FAUSSE quand rien n'est arme — un
 *      oubli d'armement ne peut pas elargir un filtre ;
 *   4. `tracefab_require_active_tenant()` leve `organization_id_required`, le
 *      message meme que renvoie l'API ;
 *   5. la requete EXACTE de `accessibleProduct()` rend le produit de A sous le
 *      locataire A, et rien sous le locataire B — alors que l'utilisateur est
 *      membre des deux et que la RLS seule laisserait passer ;
 *   6. le GUC ne survit pas a la transaction : une connexion rendue au pool ne
 *      peut pas porter le locataire d'une requete precedente ;
 *   7. les trois fonctions sont fermees a PUBLIC et ouvertes a tracefab_app.
 *
 * Le point 5 est le coeur : c'est la difference mesurable entre l'ancien
 * comportement et le nouveau, sur un utilisateur reellement membre des deux
 * organisations.
 *
 * IL NE PASSE PAS QUAND IL NE PEUT PAS S'EXECUTER : sans DATABASE_URL
 * (proprietaire, pour la fixture) ou TF_RLS_APP_URL (role soumis a la RLS),
 * sortie 2. Un test qui n'a pas tourne n'est pas un test qui passe.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const URL_PROPRIO = process.env.DATABASE_URL;
const URL_APP = process.env.TF_RLS_APP_URL;

if (!URL_PROPRIO || !URL_APP) {
  console.log('  NON EXECUTE — il manque DATABASE_URL et/ou TF_RLS_APP_URL.');
  console.log('  TF_RLS_APP_URL doit pointer un role SANS BYPASSRLS (ex. tracefab_app).');
  console.log('  Un test qui ne tourne pas ne vaut pas un test qui passe : sortie 2.');
  process.exit(2);
}

const cli = (u) => new pg.Client({
  connectionString: u,
  ssl: /sslmode=(require|verify-full|verify-ca)/.test(u) ? { rejectUnauthorized: false } : false,
});

let echecs = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const ko = (m) => {
  console.log(`  ECHEC ${m}`);
  // Le log du job est heberge hors de l'API : l'annotation est le seul
  // canal de diagnostic lisible depuis api.github.com.
  console.log(`::error::active-tenant base — ${m}`);
  echecs += 1;
};

const suffixe = randomUUID().slice(0, 8);
const userMulti = randomUUID();
const orgGinger = randomUUID();
const orgRecette = randomUUID();
const prodRecette = randomUUID();

const proprio = cli(URL_PROPRIO);
await proprio.connect();
const app = cli(URL_APP);
await app.connect();

try {
  /* -- 0. le role de test ne doit pas contourner la RLS ------------------- */
  const { rows: [role] } = await app.query('select rolname, rolbypassrls from pg_roles where rolname = current_user');
  if (!role) { ko('role applicatif introuvable'); throw new Error('role introuvable'); }
  if (role.rolbypassrls) { ko(`${role.rolname} porte BYPASSRLS : rien de ce qui suit ne mesure la RLS`); }
  else ok(`le role ${role.rolname} ne porte pas BYPASSRLS`);

  /* -- fixture : UN utilisateur, DEUX organisations, produit chez B ------- */
  await proprio.query(
    `insert into users (id, clerk_user_id, email, full_name) values ($1, $2, $3, 'Admin Multi-Tenant')`,
    [userMulti, `mt_${suffixe}`, `mt-${suffixe}@example.test`]);
  await proprio.query(
    `insert into organizations (id, type, legal_name, display_name, status, created_by) values
       ($1, 'brand', 'Ginger', 'Ginger', 'active', $3),
       ($2, 'brand', 'Tracefab Recette Production', 'Tracefab Recette Production', 'active', $3)`,
    [orgGinger, orgRecette, userMulti]);
  await proprio.query(
    `insert into organization_memberships (organization_id, user_id, role, status) values
       ($1, $3, 'admin', 'active'), ($2, $3, 'admin', 'active')`,
    [orgGinger, orgRecette, userMulti]);
  // Brouillon, sans public_slug : la lecture publique ne peut rien expliquer.
  await proprio.query(
    `insert into tracefab_products (id, brand_organization_id, reference, name, status, version, created_by)
     values ($1, $2, 'RECETTE-DPP-20261017', 'Produit synthetique de recette', 'draft', 1, $3)`,
    [prodRecette, orgRecette, userMulti]);
  ok('fixture : un utilisateur admin de deux organisations, produit brouillon chez B uniquement');

  /* -- 1. hors contexte, aucun locataire --------------------------------- */
  {
    const { rows: [r] } = await app.query('select tracefab_active_organization_id() as active');
    if (r.active === null) ok('hors contexte arme, tracefab_active_organization_id() vaut NULL');
    else ko(`hors contexte, attendu NULL, obtenu ${r.active}`);
  }

  /* -- 2. arme dans une transaction, valeur exacte ------------------------ */
  {
    await app.query('begin');
    await app.query(`select set_config('tracefab.active_organization_id', $1, true)`, [orgRecette]);
    const { rows: [r] } = await app.query('select tracefab_active_organization_id() as active');
    await app.query('commit');
    if (r.active === orgRecette) ok('arme en transaction, le GUC rend exactement le locataire arme');
    else ko(`arme, attendu ${orgRecette}, obtenu ${r.active}`);
  }

  /* -- 3. rien d'arme -> tracefab_in_active_tenant est fausse ------------- */
  {
    const { rows: [r] } = await app.query('select tracefab_in_active_tenant($1::uuid) as inside', [orgRecette]);
    if (r.inside === false) ok('sans locataire arme, tracefab_in_active_tenant() est fausse — un oubli n elargit rien');
    else ko('sans locataire arme, tracefab_in_active_tenant() a rendu vrai : un oubli d armement elargirait le filtre');
  }

  /* -- 4. la garde leve le message de l'API ------------------------------- */
  {
    let message = null;
    try { await app.query('select tracefab_require_active_tenant()'); }
    catch (error) { message = error.message; }
    if (message && message.includes('organization_id_required')) {
      ok('tracefab_require_active_tenant() leve organization_id_required, le message meme de l API');
    } else {
      ko(`attendu organization_id_required, obtenu ${message}`);
    }
  }

  /* -- 5. LE POINT DECISIF : accessibleProduct sous les deux tenants ------ */
  const accessibleProductQuery = `
    select id, brand_organization_id as owner_organization_id
    from tracefab_products
    where id = $1::uuid
      and tracefab_can_access_org(brand_organization_id)
      and tracefab_in_active_tenant(brand_organization_id)
    limit 1`;

  const asTenant = async (organizationId) => {
    await app.query('begin');
    await app.query(`select set_config('tracefab.user_id', $1, true)`, [userMulti]);
    await app.query(`select set_config('tracefab.user_email', 'mt@example.test', true)`);
    await app.query(`select set_config('tracefab.active_organization_id', $1, true)`, [organizationId]);
    const { rows } = await app.query(accessibleProductQuery, [prodRecette]);
    await app.query('commit');
    return rows;
  };

  {
    // L'utilisateur EST membre des deux organisations : la RLS seule laisse
    // passer dans les deux cas. Seul le locataire actif fait la difference.
    const fromRecette = await asTenant(orgRecette);
    const fromGinger = await asTenant(orgGinger);

    if (fromRecette.length === 1 && fromRecette[0].owner_organization_id === orgRecette) {
      ok('sous le locataire de recette, accessibleProduct rend le produit de recette');
    } else {
      ko(`sous le locataire de recette, attendu 1 ligne, obtenu ${fromRecette.length}`);
    }

    if (fromGinger.length === 0) {
      ok('sous Ginger, accessibleProduct ne rend PAS le produit de recette — le defaut du 2026-10-17');
    } else {
      ko(`sous Ginger, accessibleProduct a rendu ${fromGinger.length} ligne(s) : le produit de recette fuit`);
    }
  }

  /* -- 5b. sans locataire arme, la meme requete ne rend rien -------------- */
  {
    await app.query('begin');
    await app.query(`select set_config('tracefab.user_id', $1, true)`, [userMulti]);
    const { rows } = await app.query(accessibleProductQuery, [prodRecette]);
    await app.query('commit');
    if (rows.length === 0) ok('sans locataire arme, accessibleProduct ne rend rien — fail-closed');
    else ko(`sans locataire arme, accessibleProduct a rendu ${rows.length} ligne(s)`);
  }

  /* -- 6. le GUC ne survit pas a la transaction --------------------------- */
  {
    await app.query('begin');
    await app.query(`select set_config('tracefab.active_organization_id', $1, true)`, [orgRecette]);
    await app.query('commit');
    const { rows: [r] } = await app.query('select tracefab_active_organization_id() as active');
    if (r.active === null) ok('le locataire ne survit pas a la transaction : aucune fuite via le pool de connexions');
    else ko(`apres commit, le GUC vaut encore ${r.active} : une connexion reutilisee heriterait du locataire precedent`);
  }

  /* -- 7. privileges des fonctions --------------------------------------- */
  {
    const { rows } = await app.query(`
      select p.proname,
             has_function_privilege('public', p.oid, 'execute') as public_exec
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in ('tracefab_active_organization_id', 'tracefab_in_active_tenant', 'tracefab_require_active_tenant')`);
    const ouvertes = rows.filter((r) => r.public_exec);
    if (rows.length === 3 && ouvertes.length === 0) {
      ok('les trois fonctions du contexte sont fermees a PUBLIC');
    } else {
      ko(`${rows.length}/3 fonctions trouvees, ${ouvertes.length} executable(s) par PUBLIC`);
    }
  }
} catch (error) {
  ko(`erreur inattendue : ${error.message}`);
  console.log(`::error::active-tenant base — pile : ${String(error.stack).split('\n').slice(0, 4).join(' | ')}`);
} finally {
  await app.end().catch(() => {});
  await proprio.end().catch(() => {});
}

console.log('');
if (echecs > 0) {
  console.error(`Contexte de locataire actif en base : ${echecs} echec(s).`);
  process.exit(1);
}
console.log('Contexte de locataire actif en base : arme, borne, fail-closed, et etanche entre transactions.');
