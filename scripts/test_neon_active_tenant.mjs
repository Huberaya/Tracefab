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
  ssl: /sslmode=(require|verify-full|verify-ca)/.test(u) ? { rejectUnauthorized: true } : false,
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
const dppRecette = randomUUID();
const pefRecette = randomUUID();
const greenClaimRecette = randomUUID();
const dppClaimRecette = randomUUID();
const dppIdentityRecette = randomUUID();
const materialRecette = randomUUID();
const tcRecette = randomUUID();
let linkRecette = null;

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
  await proprio.query(
    'insert into dpp_records (id, product_id, product_version, requirement_profile_key, requirement_profile_version) values ($1, $2, 1, $3, $4)',
    [dppRecette, prodRecette, 'textile_dpp', '1']);
  await proprio.query(
    'insert into product_pef_assessments (id, product_id, brand_organization_id) values ($1, $2, $3)',
    [pefRecette, prodRecette, orgRecette]);
  await proprio.query(
    'insert into product_green_claims (id, product_id, brand_organization_id, claim_text) values ($1, $2, $3, $4)',
    [greenClaimRecette, prodRecette, orgRecette, 'Synthetic confidential green claim']);
  await proprio.query(
    'insert into dpp_claims (id, product_id, owner_organization_id, claim_key, statement) values ($1, $2, $3, $4, $5)',
    [dppClaimRecette, prodRecette, orgRecette, 'tenant.isolation.claim', 'Synthetic private DPP claim']);
  await proprio.query(
    'insert into dpp_resolvable_identifiers (id, product_id, owner_organization_id, public_id, granularity) values ($1, $2, $3, $4, $5)',
    [dppIdentityRecette, prodRecette, orgRecette, `tf-${suffixe}-private`, 'model']);
  await proprio.query(
    'insert into materials (id, owner_organization_id, material_type, name, composition, created_by) values ($1, $2, $3, $4, $5::jsonb, $6)',
    [materialRecette, orgRecette, 'fiber', 'Synthetic shared cotton', '{}', userMulti]);
  await proprio.query(
    'insert into product_materials (product_id, material_id, material_role, percentage, unit, product_version) values ($1, $2, $3, $4, $5, $6)',
    [prodRecette, materialRecette, 'main', 100, '%', 1]);
  await proprio.query(
    `insert into transaction_certificates
      (id, tc_number, standard, issuer_name, seller_organization_id, buyer_organization_id,
       certified_material_name, total_certified_weight_kg, issue_date, created_by)
     values ($1, $2, 'GOTS', 'Synthetic test issuer', $3, $4, 'Synthetic cotton', 100, CURRENT_DATE, $5)`,
    [tcRecette, `MT-${suffixe}`, orgRecette, orgGinger, userMulti]);
  ok('fixture : utilisateur multi-org avec produit, DPP, PEF, claims, identité et composition chez B uniquement');

  /* -- événement DPP créé par la fonction SECURITY DEFINER sous le tenant B -- */
  let dppEventRecette = null;
  {
    await app.query('begin');
    await app.query(`select set_config('tracefab.user_id', $1, true)`, [userMulti]);
    await app.query(`select set_config('tracefab.user_email', $1, true)`, [`mt-${suffixe}@example.test`]);
    await app.query(`select set_config('tracefab.active_organization_id', $1, true)`, [orgRecette]);
    const { rows: [event] } = await app.query(
      `select (tracefab_add_dpp_event($1::uuid, 'passport_created', 'Synthetic private DPP event')).id as id`,
      [prodRecette]);
    dppEventRecette = event.id;
    await app.query('commit');
    ok('la fonction SECURITY DEFINER crée un événement DPP dans le tenant actif B');
  }

  /* -- les fonctions SECURITY DEFINER refusent le produit d'un autre tenant -- */
  const assertTenantGuard = async (label, query, params) => {
    await app.query('begin');
    await app.query(`select set_config('tracefab.user_id', $1, true)`, [userMulti]);
    await app.query(`select set_config('tracefab.user_email', $1, true)`, [`mt-${suffixe}@example.test`]);
    await app.query(`select set_config('tracefab.active_organization_id', $1, true)`, [orgGinger]);
    try {
      await app.query(query, params);
      await app.query('rollback');
      ko(`${label} a accepté le produit du tenant B depuis le tenant A`);
    } catch (error) {
      await app.query('rollback').catch(() => {});
      if (String(error.message).includes('active_tenant_mismatch')) ok(`${label} refuse le tenant B depuis le tenant A`);
      else ko(`${label} : attendu active_tenant_mismatch, obtenu ${error.message}`);
    }
  };

  /* Créer un lien réel sous B pour tester aussi la garde update_supply_chain_link,
     dont le résolveur doit retrouver le produit depuis l'identifiant du lien. */
  {
    await app.query('begin');
    await app.query(`select set_config('tracefab.user_id', $1, true)`, [userMulti]);
    await app.query(`select set_config('tracefab.user_email', $1, true)`, [`mt-${suffixe}@example.test`]);
    await app.query(`select set_config('tracefab.active_organization_id', $1, true)`, [orgRecette]);
    const { rows: nodeTypes } = await proprio.query(
      "select unnest(enum_range(null::node_type))::text as value");
    const { rows: linkTypes } = await proprio.query(
      "select unnest(enum_range(null::supply_chain_link_type))::text as value");
    const productNodeType = nodeTypes.find((x) => x.value === 'product')?.value;
    const materialNodeType = nodeTypes.find((x) => x.value === 'material')?.value;
    const linkType = linkTypes[0]?.value;
    if (!productNodeType || !materialNodeType || !linkType) throw new Error('supply_chain_fixture_enum_missing');

    const { rows: [source] } = await app.query(
      `select (tracefab_create_supply_chain_node(
        $1::uuid, $2::node_type, $3::text, $4::uuid, null::uuid,
        $5::uuid, null::uuid, null::text, '{}'::jsonb, null::uuid, null::date
      )).id as id`,
      [prodRecette, productNodeType, 'Synthetic product node', orgRecette, prodRecette]);
    const { rows: [target] } = await app.query(
      `select (tracefab_create_supply_chain_node(
        $1::uuid, $2::node_type, $3::text, null::uuid, null::uuid,
        null::uuid, $4::uuid, null::text, '{}'::jsonb, null::uuid, null::date
      )).id as id`,
      [prodRecette, materialNodeType, 'Synthetic material node', materialRecette]);
    const { rows: [link] } = await app.query(
      `select (tracefab_add_supply_chain_link(
        $1::uuid, $2::uuid, $3::uuid, $4::supply_chain_link_type,
        1, null::date, null::date, null::uuid, '{}'::jsonb
      )).id as id`,
      [prodRecette, source.id, target.id, linkType]);
    linkRecette = link.id;
    await app.query(
      `select tracefab_update_supply_chain_link($1::uuid, 2, null::date, null::date, null::uuid, '{}'::jsonb)`,
      [linkRecette]);
    await app.query(
      'select tracefab_allocate_tc_quantity($1::uuid, $2::uuid, 1::numeric)',
      [tcRecette, prodRecette]);
    await app.query('commit');
    ok('parcours positifs : nœuds/liens créés et modifiés, TC alloué sous le tenant B');
  }

  await assertTenantGuard('tracefab_add_dpp_claim',
    'select tracefab_add_dpp_claim($1::uuid, $2, $3)',
    [prodRecette, `negative.${suffixe}`, 'Synthetic negative claim']);
  await assertTenantGuard('tracefab_add_dpp_event',
    `select tracefab_add_dpp_event($1::uuid, 'passport_created', 'Synthetic negative event')`,
    [prodRecette]);
  await assertTenantGuard('tracefab_create_dpp_identity',
    'select tracefab_create_dpp_identity($1::uuid, $2, $3)',
    [prodRecette, `negative-${suffixe}`, 'model']);
  await assertTenantGuard('tracefab_replace_dpp_identity',
    'select tracefab_replace_dpp_identity($1::uuid, $2, $3)',
    [dppIdentityRecette, `replacement-${suffixe}`, 'negative tenant test']);
  await assertTenantGuard('tracefab_add_product_identifier',
    `select tracefab_add_product_identifier($1::uuid, 'internal', $2)`,
    [prodRecette, `negative-${suffixe}`]);
  await assertTenantGuard('tracefab_update_product_identifier',
    'select tracefab_update_product_identifier($1::uuid, $2::uuid, $3, false)',
    [prodRecette, randomUUID(), `negative-${suffixe}`]);
  await assertTenantGuard('tracefab_audit_product_green_claims',
    'select tracefab_audit_product_green_claims($1::uuid)',
    [prodRecette]);
  await assertTenantGuard('tracefab_link_dpp_claim_evidence',
    'select tracefab_link_dpp_claim_evidence($1::uuid, $2::uuid)',
    [dppClaimRecette, randomUUID()]);
  await assertTenantGuard('tracefab_add_product_material',
    'select tracefab_add_product_material($1::uuid, $2::uuid, $3, $4, $5)',
    [prodRecette, materialRecette, 'main', 50, '%']);
  await assertTenantGuard('tracefab_update_product_material',
    'select tracefab_update_product_material($1::uuid, $2::uuid, $3, $4, $5, $6)',
    [prodRecette, materialRecette, 'main', 1, 50, '%']);

  // Les fonctions exposées par les autres parcours produit/DPP/PEF doivent
  // refuser le même produit B avant toute lecture ou mutation métier.
  await assertTenantGuard('tracefab_compute_dpp_readiness',
    'select tracefab_compute_dpp_readiness($1::uuid, $2, $3)',
    [prodRecette, 'textile_dpp', '1']);
  await assertTenantGuard('tracefab_compute_product_quality',
    'select tracefab_compute_product_quality($1::uuid, $2)',
    [prodRecette, 'active-tenant-negative']);
  await assertTenantGuard('tracefab_calculate_product_pef',
    'select tracefab_calculate_product_pef($1::uuid, null::numeric, null::text)',
    [prodRecette]);
  await assertTenantGuard('tracefab_get_product_traceability',
    'select tracefab_get_product_traceability($1::uuid)',
    [prodRecette]);
  await assertTenantGuard('tracefab_mark_dpp_ready_to_publish',
    'select tracefab_mark_dpp_ready_to_publish($1::uuid)',
    [dppRecette]);
  await assertTenantGuard('tracefab_set_dpp_publication',
    'select tracefab_set_dpp_publication($1::uuid, $2, null::text)',
    [prodRecette, 'suspend']);
  await assertTenantGuard('tracefab_start_product_revision',
    'select tracefab_start_product_revision($1::uuid)',
    [prodRecette]);
  await assertTenantGuard('tracefab_reconcile_mass_balance',
    'select tracefab_reconcile_mass_balance($1::uuid, 0)',
    [prodRecette]);
  await assertTenantGuard('tracefab_create_product',
    'select tracefab_create_product($1::uuid, $2, $3, $4, $5)',
    [orgRecette, 'NEGATIVE-TENANT', 'Synthetic negative product', null, null]);
  await assertTenantGuard('tracefab_update_product_data',
    `select tracefab_update_product_data(
      $1::uuid, null::text, null::text, null::text, null::text, null::text,
      null::text, null::text, null::text[], null::varchar(2), null::varchar(2),
      null::numeric, null::jsonb
    )`,
    [prodRecette]);
  await assertTenantGuard('tracefab_allocate_tc_quantity',
    'select tracefab_allocate_tc_quantity($1::uuid, $2::uuid, 1::numeric)',
    [tcRecette, prodRecette]);
  await assertTenantGuard('tracefab_update_supply_chain_link',
    `select tracefab_update_supply_chain_link($1::uuid, null::integer, null::date, null::date, null::uuid, '{}'::jsonb)`,
    [linkRecette]);
  await assertTenantGuard('tracefab_bind_schema',
    'select tracefab_bind_schema($1, $2, $3, $4::uuid)',
    ['tenant-negative-schema', '1', 'product', prodRecette]);

  await assertTenantGuard('tracefab_create_data_request',
    'select tracefab_create_data_request($1::uuid, $2::uuid, null::uuid, $3, $4, $5, null::date, null::text)',
    [orgRecette, orgGinger, 'Synthetic negative request', 'textile_supplier_questionnaire', '1']);
  await assertTenantGuard('tracefab_create_supply_chain_node',
    `select tracefab_create_supply_chain_node($1::uuid, null::node_type, null::text, null::uuid, null::uuid, null::uuid, null::uuid, null::text, '{}'::jsonb, null::uuid, null::date)`,
    [prodRecette]);
  await assertTenantGuard('tracefab_update_supply_chain_node',
    `select tracefab_update_supply_chain_node($1::uuid, $2::uuid, null::text, '{}'::jsonb, null::uuid, null::date)`,
    [prodRecette, randomUUID()]);
  await assertTenantGuard('tracefab_delete_supply_chain_node',
    'select tracefab_delete_supply_chain_node($1::uuid, $2::uuid)',
    [prodRecette, randomUUID()]);
  await assertTenantGuard('tracefab_add_supply_chain_link',
    `select tracefab_add_supply_chain_link($1::uuid, $2::uuid, $3::uuid, null::supply_chain_link_type, null::integer, null::date, null::date, null::uuid, '{}'::jsonb)`,
    [prodRecette, randomUUID(), randomUUID()]);
  await assertTenantGuard('tracefab_delete_supply_chain_link',
    'select tracefab_delete_supply_chain_link($1::uuid, $2::uuid)',
    [prodRecette, randomUUID()]);

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

  /* -- 3. le predicat d'autorisation est un BOOLEEN TOTAL ----------------- */
  /*
   * C'est le defaut precise par la revue : un predicat d'autorisation qui rend
   * NULL au lieu de faux est un predicat a trois valeurs. Il reste sur dans un
   * WHERE, mais il trompe `= false`, `IS FALSE`, `NOT x`, un CASE WHEN, un
   * `IF` plpgsql et toute assertion de test. Chaque etat est donc evalue sous
   * ses trois formes : la valeur, son caractere NULL, et sa composition avec
   * `vrai AND x` / `faux OR x` / `NOT x`.
   */
  const VERDICTS = `
    select
      tracefab_in_active_tenant($1::uuid)              as meme,
      tracefab_in_active_tenant($2::uuid)              as autre,
      tracefab_in_active_tenant(null::uuid)            as uuid_absent,
      tracefab_in_active_tenant($1::uuid) is null      as meme_est_null,
      tracefab_in_active_tenant($2::uuid) is null      as autre_est_null,
      tracefab_in_active_tenant(null::uuid) is null    as uuid_absent_est_null,
      (true  and tracefab_in_active_tenant($1::uuid))           as vrai_et_meme,
      (false or  tracefab_in_active_tenant($1::uuid))           as faux_ou_meme,
      (true  and tracefab_in_active_tenant($2::uuid))           as vrai_et_autre,
      (false or  tracefab_in_active_tenant($2::uuid))           as faux_ou_autre,
      (true  and tracefab_in_active_tenant(null::uuid))         as vrai_et_uuid_absent,
      (false or  tracefab_in_active_tenant(null::uuid))         as faux_ou_uuid_absent,
      (not tracefab_in_active_tenant($1::uuid))                 as non_meme,
      (not tracefab_in_active_tenant($2::uuid))                 as non_autre,
      (not tracefab_in_active_tenant(null::uuid))               as non_uuid_absent`;

  const BOOLEENNES = ['meme', 'autre', 'uuid_absent', 'vrai_et_meme', 'faux_ou_meme',
    'vrai_et_autre', 'faux_ou_autre', 'vrai_et_uuid_absent', 'faux_ou_uuid_absent',
    'non_meme', 'non_autre', 'non_uuid_absent'];

  // locataireArme = null signifie « contexte absent » : transaction ouverte,
  // aucun set_config. C'est l'etat d'une surface qui a oublie de nommer.
  const verdicts = async (locataireArme) => {
    await app.query('begin');
    if (locataireArme) {
      await app.query(`select set_config('tracefab.active_organization_id', $1, true)`, [locataireArme]);
    }
    const { rows: [r] } = await app.query(VERDICTS, [orgRecette, orgGinger]);
    await app.query('commit');
    return r;
  };

  const attendre = (contexte, r, attendus) => {
    for (const [cle, voulu] of Object.entries(attendus)) {
      if (r[cle] === voulu) ok(`${contexte} — ${cle} === ${voulu}`);
      else ko(`${contexte} — ${cle} : attendu ${voulu}, obtenu ${r[cle]}${r[cle] === null ? ' (NULL : predicat a trois valeurs)' : ''}`);
    }
  };

  {
    // 3a. CONTEXTE ABSENT : rien d'arme. Tout est faux, rien n'est NULL, et
    // `vrai AND x` ne doit pas heriter d'un NULL.
    const r = await verdicts(null);
    attendre('contexte absent', r, {
      meme: false, autre: false, uuid_absent: false,
      meme_est_null: false, autre_est_null: false, uuid_absent_est_null: false,
      vrai_et_meme: false, faux_ou_meme: false,
      vrai_et_autre: false, faux_ou_autre: false,
      vrai_et_uuid_absent: false, faux_ou_uuid_absent: false,
      non_meme: true, non_autre: true, non_uuid_absent: true,
    });
  }

  {
    // 3b. LOCATAIRE ARME sur B : la ressource de B est vraie, celle de A fausse,
    // un UUID absent reste faux (et non NULL).
    const r = await verdicts(orgRecette);
    attendre('locataire arme sur B', r, {
      meme: true, autre: false, uuid_absent: false,
      vrai_et_meme: true, faux_ou_meme: true,
      vrai_et_autre: false, faux_ou_autre: false,
      vrai_et_uuid_absent: false, faux_ou_uuid_absent: false,
      non_meme: false, non_autre: true, non_uuid_absent: true,
    });
  }

  {
    // 3c. LOCATAIRE ARME sur A, ressource chez B : c'est le cas inter-tenant.
    // `vrai AND x` doit etre faux, `faux OR x` doit etre faux, `NOT x` vrai.
    const r = await verdicts(orgGinger);
    attendre('locataire arme sur A, ressource chez B', r, {
      meme: false, autre: true, uuid_absent: false,
      vrai_et_meme: false, faux_ou_meme: false,
      vrai_et_autre: true, faux_ou_autre: true,
      vrai_et_uuid_absent: false, faux_ou_uuid_absent: false,
      non_meme: true, non_autre: false, non_uuid_absent: true,
    });
  }

  {
    // 3d. Aucun etat ne doit produire un booleen NULL, quel que soit le contexte.
    const tous = [await verdicts(null), await verdicts(orgRecette), await verdicts(orgGinger)];
    const nuls = [];
    tous.forEach((r, i) => {
      for (const cle of BOOLEENNES) if (r[cle] === null) nuls.push(`contexte ${i} : ${cle}`);
    });
    if (nuls.length === 0) ok('aucun des 3 contextes ne rend un booleen NULL sur les 12 compositions');
    else ko(`booleens a trois valeurs : ${nuls.join(', ')}`);
  }

  /* -- 3e. MUTATION NEGATIVE : l'ancienne definition rendait NULL ---------- */
  /*
   * Preuve que le test ci-dessus echoue reellement si COALESCE disparait. On
   * reinstalle le corps d'origine (sans COALESCE) sur la connexion proprietaire,
   * dans une transaction qu'on annule aussitot : le catalogue revient a la
   * definition corrigee. PostgreSQL rend le DDL transactionnel, donc cette
   * mutation ne laisse aucune trace sur la base jetable.
   */
  {
    await proprio.query('begin');
    await proprio.query(`
      create or replace function tracefab_in_active_tenant(p_organization_id UUID)
      returns boolean language sql stable as $mut$
        select p_organization_id is not null
           and p_organization_id = tracefab_active_organization_id();
      $mut$`);
    // L'entree doit etre un UUID NON NUL. Avec un UUID NULL, `NULL IS NOT NULL`
    // vaut faux, et `faux AND NULL` vaut faux : le defaut ne se manifesterait
    // pas. Le NULL n'apparait que quand l'organisation est fournie et qu'aucun
    // locataire n'est arme — exactement l'etat d'une surface qui a oublie.
    const { rows: [mute] } = await proprio.query(
      `select tracefab_in_active_tenant($1::uuid) as v,
              tracefab_in_active_tenant($1::uuid) is null as est_null`, [orgRecette]);
    await proprio.query('rollback');

    if (mute.v === null && mute.est_null === true) {
      ok('mutation negative : sans COALESCE, organisation fournie + contexte absent rend NULL — 3a/3d echoueraient donc bien');
    } else {
      ko(`mutation negative inefficace : attendu NULL, obtenu ${mute.v} — la preuve ne porte sur rien`);
    }

    // La restauration doit etre effective, sinon tout ce qui suit est faux.
    const { rows: [apres] } = await app.query(
      `select tracefab_in_active_tenant($1::uuid) as v,
              tracefab_in_active_tenant($1::uuid) is null as est_null`, [orgRecette]);
    if (apres.v === false && apres.est_null === false) {
      ok('apres rollback de la mutation, la definition corrigee est revenue : faux, et non NULL');
    } else {
      ko(`rollback insuffisant : obtenu ${apres.v} (NULL=${apres.est_null})`);
    }
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
    const directProducts = await app.query('select id from tracefab_products where id = $1::uuid', [prodRecette]);
    const directDpp = await app.query('select id from dpp_records where id = $1::uuid', [dppRecette]);
    const directPef = await app.query('select id from product_pef_assessments where id = $1::uuid', [pefRecette]);
    const directGreenClaims = await app.query('select id from product_green_claims where id = $1::uuid', [greenClaimRecette]);
    const directDppClaims = await app.query('select id from dpp_claims where id = $1::uuid', [dppClaimRecette]);
    const directDppEvents = await app.query('select id from dpp_lifecycle_events where id = $1::uuid', [dppEventRecette]);
    const directDppIdentities = await app.query('select id from dpp_resolvable_identifiers where id = $1::uuid', [dppIdentityRecette]);
    const directProductMaterials = await app.query('select material_id from product_materials where product_id = $1::uuid and material_id = $2::uuid', [prodRecette, materialRecette]);
    const materialVisible = await app.query('select tracefab_material_visible_via_product($1::uuid) as visible', [materialRecette]);
    await app.query('commit');
    return { rows, directProducts: directProducts.rows, directDpp: directDpp.rows, directPef: directPef.rows, directGreenClaims: directGreenClaims.rows, directDppClaims: directDppClaims.rows, directDppEvents: directDppEvents.rows, directDppIdentities: directDppIdentities.rows, directProductMaterials: directProductMaterials.rows, materialVisible: materialVisible.rows };
  };

  {
    // L'utilisateur EST membre des deux organisations : la RLS seule laisse
    // passer dans les deux cas. Seul le locataire actif fait la difference.
    const fromRecette = await asTenant(orgRecette);
    const fromGinger = await asTenant(orgGinger);

    if (fromRecette.rows.length === 1 && fromRecette.rows[0].owner_organization_id === orgRecette
      && fromRecette.directProducts.length === 1 && fromRecette.directDpp.length === 1 && fromRecette.directPef.length === 1 && fromRecette.directGreenClaims.length === 1 && fromRecette.directDppClaims.length === 1 && fromRecette.directDppEvents.length === 1 && fromRecette.directDppIdentities.length === 1 && fromRecette.directProductMaterials.length === 1 && fromRecette.materialVisible[0]?.visible === true) {
      ok('sous le locataire de recette, accessibleProduct rend le produit de recette');
    } else {
      ko(`sous le locataire de recette, attendu 1 ligne, obtenu ${fromRecette.length}`);
    }

    if (fromGinger.rows.length === 0 && fromGinger.directProducts.length === 0
      && fromGinger.directDpp.length === 0 && fromGinger.directPef.length === 0 && fromGinger.directGreenClaims.length === 0 && fromGinger.directDppClaims.length === 0 && fromGinger.directDppEvents.length === 0 && fromGinger.directDppIdentities.length === 0 && fromGinger.directProductMaterials.length === 0 && fromGinger.materialVisible[0]?.visible === false) {
      ok('sous Ginger, la RLS directe bloque produit, DPP, PEF, claims, événements, identités et composition — sans filtre applicatif');
    } else {
      ko('fuite inter-tenant : produit=' + fromGinger.directProducts.length + ', DPP=' + fromGinger.directDpp.length + ', PEF=' + fromGinger.directPef.length + ', green_claims=' + fromGinger.directGreenClaims.length + ', dpp_claims=' + fromGinger.directDppClaims.length + ', dpp_events=' + fromGinger.directDppEvents.length + ', dpp_identities=' + fromGinger.directDppIdentities.length);
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
