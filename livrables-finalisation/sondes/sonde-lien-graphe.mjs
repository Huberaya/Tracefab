#!/usr/bin/env node
/**
 * SONDE DE `tracefab_add_supply_chain_link` — appelle RÉELLEMENT la fonction,
 * puis vérifie les invariants de sécurité de la fonction.
 *
 * POURQUOI UN APPEL RÉEL
 *
 * Le défaut visé (`CASE` de littéraux affecté à une colonne ENUM) n'apparaît
 * ni au replay, ni à la lecture du catalogue : la migration s'applique, la
 * fonction existe, sa définition est valide. Seule l'exécution rend `42804`.
 *
 * CE QUE LA SONDE COUVRE
 *
 *   1. cas nominal          : lien sans preuve documentaire -> `declared`
 *   2. cas avec preuve      : lien avec document -> `documented`
 *   3. `p_metadata` NULL    : la fonction doit poser `{}`, pas NULL
 *   4. séquence négative    : refus `traceability_sequence_must_be_positive`
 *   5. séquence NULL        : accepté (colonne nullable)
 *   6. rôle insuffisant     : un membre `viewer` est refusé
 *   7. produit inexistant   : refus `traceability_brand_role_required`
 *   8. isolation de tenant  : un lien vers le produit d'une AUTRE organisation
 *                             est refusé, et rien n'est écrit
 *   9. préservation         : SECURITY DEFINER, `search_path` figé, propriétaire,
 *                             `prosecdef`, ACL EXECUTE de `tracefab_app` seul
 *  10. aucune écriture      : les refus laissent la table inchangée
 *
 * Elle n'écrit que dans la base jetable désignée par DATABASE_URL et supprime
 * ses données (identifiants fixes) dans l'ordre des dépendances.
 *
 * Usage :
 *   DATABASE_URL=… TF_PG_MODULE=… node sonde-lien-graphe.mjs --attendu=echec
 *   DATABASE_URL=… TF_PG_MODULE=… node sonde-lien-graphe.mjs --attendu=succes
 */
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL requis.');
  process.exit(2);
}
const attendu = (process.argv.find((a) => a.startsWith('--attendu=')) || '--attendu=succes').split('=')[1];
const pg = (await import(process.env.TF_PG_MODULE || 'pg')).default;

// Identifiants fixes : nettoyage déterministe, aucune donnée réelle.
const ORG_A = '00000000-0000-4000-8000-0000000000a1';
const ORG_B = '00000000-0000-4000-8000-0000000000b1';
const USER_A = '00000000-0000-4000-8000-0000000000a2';
const USER_VIEWER = '00000000-0000-4000-8000-0000000000a3';
const PROD_A = '00000000-0000-4000-8000-0000000000a4';
const PROD_B = '00000000-0000-4000-8000-0000000000b4';
const NODE_A1 = '00000000-0000-4000-8000-0000000000a5';
const NODE_A2 = '00000000-0000-4000-8000-0000000000a6';
const NODE_B1 = '00000000-0000-4000-8000-0000000000b5';
const NODE_B2 = '00000000-0000-4000-8000-0000000000b6';
const DOC_A = '00000000-0000-4000-8000-0000000000a7';

const admin = new pg.Client({ connectionString: url });
await admin.connect();
const resultats = [];
let code = 0;

/** Appelle la fonction sous la session applicative d'un utilisateur donné. */
async function appeler(userId, args) {
  await admin.query('RESET ROLE');
  await admin.query(`SELECT set_config('tracefab.user_id', $1, false)`, [userId]);
  await admin.query('SET ROLE tracefab_app');
  try {
    const { rows } = await admin.query(
      // `returns supply_chain_links` : le type composite revient sous forme de
      // litteral `(...)` avec le pilote `pg`. `to_jsonb` rend les champs
      // lisibles par nom, sans changer la valeur retournee par la fonction.
      `SELECT to_jsonb(public.tracefab_add_supply_chain_link($1,$2,$3,$4,$5,$6,$7,$8,$9)) AS lien`,
      args,
    );
    return { ok: true, lien: rows[0].lien };
  } catch (e) {
    return {
      ok: false, sqlstate: e.code, message: e.message,
      where: e.where ?? null,
    };
  } finally {
    await admin.query('RESET ROLE');
  }
}

async function compterLiens(produit) {
  const { rows } = await admin.query(
    'SELECT count(*)::int AS n FROM public.supply_chain_links WHERE product_id = $1', [produit],
  );
  return rows[0].n;
}

function verifier(nom, condition, detail) {
  resultats.push({ nom, ok: condition, detail });
  if (!condition) code = 1;
  console.log(`${condition ? 'OK  ' : 'ECHEC'} ${nom}${detail ? ` — ${detail}` : ''}`);
}

try {
  // ------------------------------------------------------------------ données
  await admin.query(
    `INSERT INTO public.organizations (id, type, legal_name, country_code) VALUES
       ($1,'brand','Sonde Lien A','FR'), ($2,'brand','Sonde Lien B','FR')
     ON CONFLICT (id) DO NOTHING`, [ORG_A, ORG_B]);
  await admin.query(
    `INSERT INTO public.users (id, clerk_user_id, email, full_name) VALUES
       ($1,'sonde_lien_a','sonde-lien-a@example.invalid','Sonde A'),
       ($2,'sonde_lien_v','sonde-lien-v@example.invalid','Sonde Viewer')
     ON CONFLICT (id) DO NOTHING`, [USER_A, USER_VIEWER]);
  await admin.query(
    `INSERT INTO public.organization_memberships (organization_id, user_id, role, status) VALUES
       ($1,$2,'owner','active'), ($1,$3,'viewer','active')
     ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role, status = 'active'`,
    [ORG_A, USER_A, USER_VIEWER]);
  await admin.query(
    `INSERT INTO public.tracefab_products (id, brand_organization_id, reference, name, status)
     VALUES ($1,$2,'SONDE-LIEN-A','Produit sonde A','active'),
            ($3,$4,'SONDE-LIEN-B','Produit sonde B','active')
     ON CONFLICT (id) DO NOTHING`, [PROD_A, ORG_A, PROD_B, ORG_B]);
  await admin.query(
    // Un noeud `process` exige EXACTEMENT une reference non nulle
    // (`tracefab_validate_supply_chain_node`) : un code de procede distinct par
    // noeud, sinon le trigger refuse en `traceability_node_requires_exactly_one_reference`.
    `INSERT INTO public.supply_chain_nodes (id, graph_product_id, node_type, label, process_code)
     VALUES ($1,$2,'process','Etape A1','sonde_a1'), ($3,$2,'process','Etape A2','sonde_a2'),
            ($4,$5,'process','Etape B1','sonde_b1'), ($6,$5,'process','Etape B2','sonde_b2')
     ON CONFLICT (id) DO NOTHING`,
    [NODE_A1, PROD_A, NODE_A2, NODE_B1, PROD_B, NODE_B2]);
  await admin.query(
    // Contraintes du trigger `tracefab_validate_document_location` : bucket
    // `tracefab-private`, chemin prefixe par l'organisation proprietaire.
    `INSERT INTO public.documents (id, owner_organization_id, storage_bucket, storage_path, original_filename, content_type, byte_size)
     VALUES ($1,$2,'tracefab-private',$3 || '/sonde/lien.pdf','lien.pdf','application/pdf',1024)
     ON CONFLICT (id) DO NOTHING`, [DOC_A, ORG_A, ORG_A]);

  const base = await compterLiens(PROD_A);
  const baseB = await compterLiens(PROD_B);

  // ------------------------------------------------------- 1. cas nominal
  const r1 = await appeler(USER_A,
    [PROD_A, NODE_A1, NODE_A2, 'next_step', 1, null, null, null, '{"sonde":true}']);
  verifier('cas nominal : lien cree', r1.ok,
    r1.ok ? `statut=${r1.lien.status}` : `${r1.sqlstate} ${r1.message} @ ${r1.where}`);
  if (r1.ok) verifier('cas nominal : statut declared', r1.lien.status === 'declared', `recu=${r1.lien.status}`);

  // ------------------------------------------------ 2. cas avec preuve
  const r2 = await appeler(USER_A,
    [PROD_A, NODE_A1, NODE_A2, 'supplied_by', 2, null, null, DOC_A, null]);
  verifier('avec preuve documentaire : statut documented',
    r2.ok && r2.lien.status === 'documented',
    r2.ok ? `statut=${r2.lien.status}` : `${r2.sqlstate} ${r2.message} @ ${r2.where}`);
  if (r2.ok) verifier('metadata NULL -> {} (pas NULL)',
    r2.lien.metadata !== null && JSON.stringify(r2.lien.metadata) === '{}',
    `metadata=${JSON.stringify(r2.lien.metadata)}`);

  // ------------------------------------- 3 bis. type de lien non autorise
  const r3b = await appeler(USER_A, [PROD_A, NODE_A1, NODE_A2, 'type_invalide', 7, null, null, null, null]);
  verifier('type de lien non autorise refuse',
    !r3b.ok && r3b.sqlstate === '22P02', `${r3b.sqlstate} ${String(r3b.message).slice(0, 70)}`);

  // ------------------------------------------------ 4. séquence négative
  const r4 = await appeler(USER_A, [PROD_A, NODE_A1, NODE_A2, 'next_step', -1, null, null, null, null]);
  verifier('sequence negative refusee',
    !r4.ok && /traceability_sequence_must_be_positive/.test(r4.message), r4.message);

  // ------------------------------------------------ 5. séquence NULL
  const r5 = await appeler(USER_A, [PROD_A, NODE_A2, NODE_A1, 'next_step', null, null, null, null, null]);
  verifier('sequence NULL acceptee', r5.ok, r5.ok ? `seq=${r5.lien.sequence_number}` : `${r5.sqlstate}`);

  // ------------------------------------------------ 6. rôle insuffisant
  const r6 = await appeler(USER_VIEWER, [PROD_A, NODE_A1, NODE_A2, 'next_step', 3, null, null, null, null]);
  verifier('membre viewer refuse',
    !r6.ok && /traceability_brand_role_required/.test(r6.message), r6.message);

  // ------------------------------------------------ 7. produit inexistant
  const r7 = await appeler(USER_A,
    ['00000000-0000-4000-8000-00000000dead', NODE_A1, NODE_A2, 'next_step', 4, null, null, null, null]);
  verifier('produit inexistant refuse', !r7.ok && r7.sqlstate === 'P0001', r7.message);

  // ------------------------------------------------ 8. isolation de tenant
  const r8 = await appeler(USER_A, [PROD_B, NODE_B1, NODE_B2, 'next_step', 5, null, null, null, null]);
  verifier('lien sur produit d une autre organisation refuse',
    !r8.ok && /traceability_brand_role_required/.test(r8.message), r8.message);

  // ------------------------------------------------ 10. aucune écriture
  const finB = await compterLiens(PROD_B);
  verifier('aucun lien ecrit sur l autre tenant', finB === baseB, `${baseB} -> ${finB}`);
  const finA = await compterLiens(PROD_A);
  const attendusA = base + (r1.ok ? 1 : 0) + (r2.ok ? 1 : 0) + (r5.ok ? 1 : 0);
  verifier('exactement les liens attendus sur le tenant A', finA === attendusA, `${finA} attendus ${attendusA}`);

  // ------------------------------------------------ 9. invariants de sécurité
  const { rows: [meta] } = await admin.query(
    `SELECT p.prosecdef, p.proowner::regrole::text AS proprietaire, p.proconfig,
            pg_catalog.pg_get_userbyid(p.proowner) AS proprietaire_nom
       FROM pg_catalog.pg_proc p
      WHERE p.oid = 'public.tracefab_add_supply_chain_link(uuid,uuid,uuid,supply_chain_link_type,integer,date,date,uuid,jsonb)'::regprocedure`);
  verifier('SECURITY DEFINER preserve', meta.prosecdef === true, `prosecdef=${meta.prosecdef}`);
  verifier('search_path fige a public',
    Array.isArray(meta.proconfig) && meta.proconfig.some((c) => /search_path=public/.test(c)),
    JSON.stringify(meta.proconfig));
  verifier('proprietaire = role de migration (postgres au banc)',
    ['postgres', 'neondb_owner'].includes(meta.proprietaire_nom), `proprietaire=${meta.proprietaire_nom}`);

  const { rows: [acl] } = await admin.query(
    `SELECT has_function_privilege('tracefab_app',
        'public.tracefab_add_supply_chain_link(uuid,uuid,uuid,supply_chain_link_type,integer,date,date,uuid,jsonb)', 'EXECUTE') AS app_ok,
        has_function_privilege('tracefab_worker',
        'public.tracefab_add_supply_chain_link(uuid,uuid,uuid,supply_chain_link_type,integer,date,date,uuid,jsonb)', 'EXECUTE') AS worker_ok`);
  verifier('EXECUTE accorde a tracefab_app', acl.app_ok === true, `app=${acl.app_ok}`);
  console.log(`     (informatif) EXECUTE pour tracefab_worker : ${acl.worker_ok}`);

  const { rows: [pub] } = await admin.query(
    `SELECT count(*)::int AS n
       FROM pg_catalog.pg_proc p,
            LATERAL pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) acl
      WHERE p.oid = 'public.tracefab_add_supply_chain_link(uuid,uuid,uuid,supply_chain_link_type,integer,date,date,uuid,jsonb)'::regprocedure
        AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'`);
  verifier('pas d EXECUTE pour PUBLIC', pub.n === 0, `${pub.n} grant(s) PUBLIC`);

  await admin.query('RESET ROLE');
} finally {
  // -------------------------------------------------------------- nettoyage
  await admin.query('RESET ROLE').catch(() => {});
  await admin.query('DELETE FROM public.supply_chain_links WHERE product_id = ANY($1)', [[PROD_A, PROD_B]]).catch(() => {});
  await admin.query('DELETE FROM public.supply_chain_nodes WHERE graph_product_id = ANY($1)', [[PROD_A, PROD_B]]).catch(() => {});
  await admin.query('DELETE FROM public.documents WHERE id = $1', [DOC_A]).catch(() => {});
  await admin.query('DELETE FROM public.tracefab_products WHERE id = ANY($1)', [[PROD_A, PROD_B]]).catch(() => {});
  await admin.query('DELETE FROM public.organization_memberships WHERE organization_id = ANY($1)', [[ORG_A, ORG_B]]).catch(() => {});
  await admin.query('DELETE FROM public.users WHERE id = ANY($1)', [[USER_A, USER_VIEWER]]).catch(() => {});
  await admin.query('DELETE FROM public.organizations WHERE id = ANY($1)', [[ORG_A, ORG_B]]).catch(() => {});
  await admin.end();
}

const nominaux = resultats.filter((r) => /cas nominal|avec preuve|sequence NULL/.test(r.nom));
const defaut = nominaux.some((r) => !r.ok && /42P10|42804/.test(r.detail || ''));
console.log(`\nechecs : ${resultats.filter((r) => !r.ok).length}/${resultats.length}`);
console.log(`defaut ENUM 42804 present : ${resultats.some((r) => /42804/.test(r.detail || '')) ? 'OUI' : 'non'}`);

if (attendu === 'echec') {
  const okAttendu = code !== 0 && resultats.some((r) => /42804/.test(r.detail || ''));
  console.log(okAttendu ? 'VERDICT : defaut 42804 reproduit, conforme a l attendu'
    : 'VERDICT : defaut 42804 NON reproduit (attendu : echec 42804)');
  process.exit(okAttendu ? 0 : 1);
}
console.log(code === 0 ? 'VERDICT : fonction conforme sur tous les cas testes'
  : 'VERDICT : ecart mesure');
process.exit(code);
