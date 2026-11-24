#!/usr/bin/env node
/**
 * Preuve d'exécution PostgreSQL (PGlite) — durcissement P1 des demandes d'accès
 * au passeport fournisseur universel (`20261124120000_harden_supplier_passport_access_request`).
 *
 * Ce banc monte la chaîne complète des migrations du dépôt, exerce les appels
 * sous le rôle applicatif `tracefab_app` (`NOSUPERUSER NOBYPASSRLS`) et vérifie :
 *
 *   A. Comportement attendu (positif) :
 *      - un passeport explicitement public (`is_public = true` et
 *        `disclosure_confirmed_at IS NOT NULL`) accepte une demande d'accès NDA
 *        par `slug` public ;
 *      - l'arbitrage authentifié du fournisseur (`tracefab_review_passport_access`)
 *        avec son locataire actif armé passe la demande à `approved` et écrit
 *        une trace d'audit.
 *
 *   B. Fermeture des trois vecteurs d'attaque P1 (scénarios de contournement) :
 *      1. Passeport privé (`is_public = false`), divulgation non confirmée
 *         (`disclosure_confirmed_at IS NULL`) ou tentative par `share_token` :
 *         refus `passport_not_found_or_private` ;
 *      2. NDA refusé (`p_nda_accepted = false` ou `NULL`) :
 *         refus `nda_acceptance_required` côté base ;
 *      3. Absence d'oracle d'énumération d'utilisateurs et d'UUID interne :
 *         même lorsque `p_requester_email` est l'adresse réelle d'un dirigeant
 *         d'une marque active sur Tracefab, la réponse JSON publique ne contient
 *         ni `isExistingBrand` ni `supplierOrganizationId`, et la ligne créée
 *         porte `requester_organization_id IS NULL` ;
 *      4. Absence de liaison inter-organisations forcée sans consentement :
 *         lorsqu'un fournisseur approuve une demande usurpant l'adresse e-mail
 *         d'une marque cible `B` (ou d'une marque ayant précédemment suspendu /
 *         clôturé sa relation `ended`), aucune `brand_supplier_relationships`
 *         n'est créée ni réactivée, aucun `data_shares` n'est ouvert, et la
 *         ligne `organizations` de `B` reste strictement invisible au fournisseur
 *         sous RLS ;
 *      5. Garde de locataire actif sur `tracefab_review_passport_access` :
 *         sans tenant actif ou avec un autre tenant armé, l'arbitrage est refusé
 *         (`active_tenant_mismatch`).
 *
 *   C. Sensibilité par mutation (`TF_MUTATION_PASSEPORT_VULNERABLE=1`) :
 *      réinstalle les définitions historiques vulnérables de `20261006250000`
 *      avant les mesures ; le test DOIT rougir et échouer (sortie != 0).
 *      Un garde de sécurité qui ne rougit pas quand la vulnérabilité revient
 *      ne prouve rien.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { executerMigrationPglite } from './lib/pglite-worker-runner.mjs';

const MIGRATIONS = path.join(process.cwd(), 'prisma', 'migrations');
const MUTATION_VULNERABLE = process.env.TF_MUTATION_PASSEPORT_VULNERABLE === '1';

const ORG_SUPPLIER_PUB = '11111111-1111-4111-8111-111111111111';
const ORG_SUPPLIER_PRIV = '11111111-1111-4111-8111-111111111112';
const ORG_BRAND_VICTIM = '44444444-4444-4444-8444-444444444444';
const ORG_BRAND_ENDED  = '44444444-4444-4444-8444-444444444445';

const USER_SUPPLIER = '99999999-9999-4999-8999-999999999999';
const USER_VICTIM   = '55555555-5555-4555-8555-555555555555';
const USER_ENDED    = '55555555-5555-4555-8555-555555555556';

let assertions = 0;
let echecs = 0;
function verifier(condition, libelle, detail = '') {
  assertions += 1;
  if (condition) {
    console.log(`  ok    ${libelle}`);
  } else {
    echecs += 1;
    console.error(`  ECHEC ${libelle}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('\nPreuve PostgreSQL — durcissement des demandes d acces au passeport fournisseur\n');

const dossiers = fs.readdirSync(MIGRATIONS)
  .filter((d) => /^\d{14}_/.test(d) && fs.existsSync(path.join(MIGRATIONS, d, 'migration.sql')))
  .sort();

const db = new PGlite({ extensions: { pgcrypto, uuid_ossp } });
await db.waitReady;
await db.exec(`
  CREATE ROLE tracefab_app LOGIN PASSWORD 'runtime'
    NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
  GRANT USAGE ON SCHEMA public TO tracefab_app;
`);

for (const d of dossiers) {
  const sql = fs.readFileSync(path.join(MIGRATIONS, d, 'migration.sql'), 'utf8');
  await executerMigrationPglite(db, d, sql);
}

// Octrois SELECT runtime standard post-migrations (comme bootstrap_app_role.mjs)
await db.exec(`
  GRANT SELECT ON ALL TABLES IN SCHEMA public TO tracefab_app;
  REVOKE ALL PRIVILEGES ON TABLE public.tracefab_identity_cles FROM tracefab_app;
  REVOKE ALL PRIVILEGES ON TABLE public.tracefab_runtime_function_registry FROM tracefab_app;
`);

console.log(`  base jetable : ${dossiers.length} migrations appliquees, role tracefab_app (NOBYPASSRLS)\n`);

if (MUTATION_VULNERABLE) {
  console.log('  [MUTATION ACTIVE] Reinstallation des fonctions historiques vulnerables (20261006250000) + UPDATE/DELETE sur audit_logs\n');
  const sqlHistorique = fs.readFileSync(
    path.join(MIGRATIONS, '20261006250000_universal_supplier_passport', 'migration.sql'),
    'utf8',
  );
  const debut = sqlHistorique.indexOf('-- 6. Procédure Stockée : tracefab_get_public_supplier_passport');
  await db.exec(sqlHistorique.slice(debut));
  await db.exec(`
    REVOKE EXECUTE ON FUNCTION public.tracefab_get_public_supplier_passport(text) FROM PUBLIC;
    REVOKE EXECUTE ON FUNCTION public.tracefab_request_passport_access(text, text, text, text, text, boolean) FROM PUBLIC;
    REVOKE EXECUTE ON FUNCTION public.tracefab_review_passport_access(uuid, text) FROM PUBLIC;
    GRANT EXECUTE ON FUNCTION public.tracefab_get_public_supplier_passport(text) TO tracefab_app;
    GRANT EXECUTE ON FUNCTION public.tracefab_request_passport_access(text, text, text, text, text, boolean) TO tracefab_app;
    GRANT EXECUTE ON FUNCTION public.tracefab_review_passport_access(uuid, text) TO tracefab_app;
    GRANT UPDATE, DELETE ON TABLE public.audit_logs TO tracefab_app;
  `);
}

// Semer :
// - Fournisseur A avec un passeport public confirme + un passeport non confirme sur Fournisseur B
// - Marque victime B1 (aucune relation avec Fournisseur A)
// - Marque B2 ayant CLOTURE (`ended`) sa relation avec Fournisseur A
await db.exec(`
  INSERT INTO public.organizations (id, type, legal_name, status) VALUES
    ('${ORG_SUPPLIER_PUB}',  'supplier', 'Atelier Public Test', 'active'),
    ('${ORG_SUPPLIER_PRIV}', 'supplier', 'Atelier Prive Test',  'active'),
    ('${ORG_BRAND_VICTIM}',  'brand',    'Maison Victime Confidentielle', 'active'),
    ('${ORG_BRAND_ENDED}',   'brand',    'Maison Relation Cloturee',      'active');

  INSERT INTO public.users (id, clerk_user_id, email, full_name) VALUES
    ('${USER_SUPPLIER}', 'user_sup_pub',   'admin@atelier-public.example', 'Admin Fournisseur'),
    ('${USER_VICTIM}',   'user_victim_b1', 'ceo@maison-victime.example',   'CEO Victime'),
    ('${USER_ENDED}',    'user_ended_b2',  'sourcing@maison-ended.example','Sourcing Ended');

  INSERT INTO public.organization_memberships (organization_id, user_id, role, status) VALUES
    ('${ORG_SUPPLIER_PUB}',  '${USER_SUPPLIER}', 'owner', 'active'),
    ('${ORG_SUPPLIER_PRIV}', '${USER_SUPPLIER}', 'owner', 'active'),
    ('${ORG_BRAND_VICTIM}',  '${USER_VICTIM}',   'owner', 'active'),
    ('${ORG_BRAND_ENDED}',   '${USER_ENDED}',    'owner', 'active');

  INSERT INTO public.suppliers (id, organization_id, onboarding_status) VALUES
    ('22222222-2222-4222-8222-222222222221', '${ORG_SUPPLIER_PUB}',  'approved'),
    ('22222222-2222-4222-8222-222222222222', '${ORG_SUPPLIER_PRIV}', 'approved');

  INSERT INTO public.supplier_universal_passports (
    id, supplier_organization_id, share_token, slug, is_public, disclosure_confirmed_at
  ) VALUES
    ('33333333-3333-4333-8333-333333333331', '${ORG_SUPPLIER_PUB}',  'pass_secret_tok_pub',  'atelier-public-slug', true,  now()),
    ('33333333-3333-4333-8333-333333333332', '${ORG_SUPPLIER_PRIV}', 'pass_secret_tok_priv', 'atelier-prive-slug',  false, NULL);

  INSERT INTO public.brand_supplier_relationships (
    id, brand_organization_id, supplier_organization_id, status, ended_at
  ) VALUES (
    '77777777-7777-4777-8777-777777777777',
    '${ORG_BRAND_ENDED}',
    '${ORG_SUPPLIER_PUB}',
    'ended',
    now()
  );
`);

async function sousRoleApp(gucs, fn) {
  await db.exec('BEGIN; SET LOCAL ROLE tracefab_app;');
  for (const [k, v] of Object.entries(gucs)) {
    await db.query('SELECT set_config($1, $2, true)', [k, v]);
  }
  try {
    const out = await fn();
    await db.exec('COMMIT');
    return { ok: true, out };
  } catch (err) {
    await db.exec('ROLLBACK').catch(() => {});
    return { ok: false, error: err.message, code: err.code };
  }
}

// 1. Refus sur passeport prive (`is_public = false` / `disclosure_confirmed_at IS NULL`)
const tentativePrive = await sousRoleApp({}, () =>
  db.query(
    `SELECT public.tracefab_request_passport_access($1, $2, $3, $4, $5, $6) AS res`,
    ['atelier-prive-slug', 'acheteur@externe.example', 'Jean', 'Externe SAS', 'Bonjour', true],
  ),
);
verifier(
  !tentativePrive.ok && tentativePrive.error.includes('passport_not_found_or_private'),
  '1. passeport prive ou non confirme : demande anonyme refusee (passport_not_found_or_private)',
  tentativePrive.ok ? 'ACCEPTEE !' : tentativePrive.error,
);

// 2. Refus par `share_token` prive meme sur un passeport public
const tentativeShareToken = await sousRoleApp({}, () =>
  db.query(
    `SELECT public.tracefab_request_passport_access($1, $2, $3, $4, $5, $6) AS res`,
    ['pass_secret_tok_pub', 'acheteur@externe.example', 'Jean', 'Externe SAS', 'Bonjour', true],
  ),
);
verifier(
  !tentativeShareToken.ok && tentativeShareToken.error.includes('passport_not_found_or_private'),
  '2. share_token prive : refuse meme lorsque le passeport est public',
  tentativeShareToken.ok ? 'ACCEPTEE !' : tentativeShareToken.error,
);

// 3. Refus lorsque le NDA n'est pas accepte cote base
const tentativeSansNda = await sousRoleApp({}, () =>
  db.query(
    `SELECT public.tracefab_request_passport_access($1, $2, $3, $4, $5, $6) AS res`,
    ['atelier-public-slug', 'acheteur@externe.example', 'Jean', 'Externe SAS', 'Bonjour', false],
  ),
);
verifier(
  !tentativeSansNda.ok && tentativeSansNda.error.includes('nda_acceptance_required'),
  '3. p_nda_accepted = false : refuse cote SQL (nda_acceptance_required)',
  tentativeSansNda.ok ? 'ACCEPTEE !' : tentativeSansNda.error,
);

// 4. Demande nominale usurpant l'adresse e-mail d'une marque existante :
//    pas d'oracle `isExistingBrand`, pas de `supplierOrganizationId`, et `requester_organization_id IS NULL`
const demandeSpoofVictim = await sousRoleApp({}, () =>
  db.query(
    `SELECT public.tracefab_request_passport_access($1, $2, $3, $4, $5, $6) AS res`,
    ['atelier-public-slug', 'ceo@maison-victime.example', 'Usurpateur', 'Fausse Marque', 'Test', true],
  ),
);
verifier(demandeSpoofVictim.ok, '4a. passeport public confirme : demande NDA acceptee par slug public');

const payloadVictim = demandeSpoofVictim.ok ? demandeSpoofVictim.out.rows[0].res : {};
verifier(
  payloadVictim
    && typeof payloadVictim.requestId === 'string'
    && payloadVictim.status === 'pending'
    && !Object.hasOwn(payloadVictim, 'isExistingBrand')
    && !Object.hasOwn(payloadVictim, 'supplierOrganizationId'),
  '4b. reponse publique : ni oracle isExistingBrand ni UUID interne supplierOrganizationId',
  JSON.stringify(payloadVictim),
);

const ligneDemandeVictim = (await db.query(
  `SELECT requester_organization_id FROM public.supplier_passport_access_requests WHERE id = $1`,
  [payloadVictim.requestId],
)).rows[0];
verifier(
  ligneDemandeVictim && ligneDemandeVictim.requester_organization_id === null,
  '4c. base : requester_organization_id reste strictement NULL sur un appel non authentifie',
  JSON.stringify(ligneDemandeVictim),
);

// 5. Garde de locataire actif sur tracefab_review_passport_access
const revueSansTenant = await sousRoleApp(
  { 'tracefab.user_id': USER_SUPPLIER, 'tracefab.user_email': 'admin@atelier-public.example' },
  () => db.query(`SELECT * FROM public.tracefab_review_passport_access($1::uuid, 'approved')`, [payloadVictim.requestId]),
);
verifier(
  !revueSansTenant.ok && revueSansTenant.error.includes('active_tenant_mismatch'),
  '5. tracefab_review_passport_access sans locataire actif -> active_tenant_mismatch',
  revueSansTenant.ok ? 'ACCEPTEE !' : revueSansTenant.error,
);

// 6. Approbation par le fournisseur : AUCUNE creation de relation active ni visibilite de la marque victime
const revueApprouvee = await sousRoleApp(
  {
    'tracefab.user_id': USER_SUPPLIER,
    'tracefab.user_email': 'admin@atelier-public.example',
    'tracefab.active_organization_id': ORG_SUPPLIER_PUB,
  },
  async () => {
    const rev = await db.query(
      `SELECT * FROM public.tracefab_review_passport_access($1::uuid, 'approved')`,
      [payloadVictim.requestId],
    );
    const victimOrg = await db.query(
      `SELECT id FROM public.organizations WHERE id = $1`,
      [ORG_BRAND_VICTIM],
    );
    return { reviewed: rev.rows[0], victimVisibleCount: victimOrg.rows.length };
  },
);
verifier(
  revueApprouvee.ok && revueApprouvee.out.reviewed.status === 'approved',
  '6a. arbitrage fournisseur authentifie : statut passe a approved',
  revueApprouvee.ok ? revueApprouvee.out.reviewed.status : revueApprouvee.error,
);
verifier(
  revueApprouvee.ok && revueApprouvee.out.victimVisibleCount === 0,
  '6b. isolation RLS : la marque dont l e-mail a ete usurpe reste INVISIBLE au fournisseur apres approbation',
  revueApprouvee.ok ? `visible=${revueApprouvee.out.victimVisibleCount}` : revueApprouvee.error,
);

const relVictim = (await db.query(
  `SELECT count(*)::int AS n FROM public.brand_supplier_relationships WHERE brand_organization_id = $1`,
  [ORG_BRAND_VICTIM],
)).rows[0].n;
const sharesVictim = (await db.query(
  `SELECT count(*)::int AS n FROM public.data_shares WHERE grantee_organization_id = $1`,
  [ORG_BRAND_VICTIM],
)).rows[0].n;
verifier(
  relVictim === 0 && sharesVictim === 0,
  '6c. aucune brand_supplier_relationships ni data_shares creee sans consentement de la marque',
  `relationships=${relVictim}, shares=${sharesVictim}`,
);

// 7. Non-reactivation d'une relation precedemment cloturee (`ended`) par la marque B2
const demandeSpoofEnded = await sousRoleApp({}, () =>
  db.query(
    `SELECT public.tracefab_request_passport_access($1, $2, $3, $4, $5, $6) AS res`,
    ['atelier-public-slug', 'sourcing@maison-ended.example', 'Usurpateur 2', 'Ended Co', 'Re-open', true],
  ),
);
if (demandeSpoofEnded.ok) {
  await sousRoleApp(
    {
      'tracefab.user_id': USER_SUPPLIER,
      'tracefab.user_email': 'admin@atelier-public.example',
      'tracefab.active_organization_id': ORG_SUPPLIER_PUB,
    },
    () => db.query(
      `SELECT * FROM public.tracefab_review_passport_access($1::uuid, 'approved')`,
      [demandeSpoofEnded.out.rows[0].res.requestId],
    ),
  );
}
const statutRelationEnded = (await db.query(
  `SELECT status FROM public.brand_supplier_relationships WHERE id = '77777777-7777-4777-8777-777777777777'`,
)).rows[0]?.status;
verifier(
  statutRelationEnded === 'ended',
  '7. une relation cloturee (ended) par une marque ne peut pas etre reactivee unilateralement par le fournisseur',
  `status=${statutRelationEnded}`,
);

// 8. Consultation publique par share_token prive : refusee meme sur passeport public
const lectureShareToken = await sousRoleApp({}, () =>
  db.query(`SELECT public.tracefab_get_public_supplier_passport($1) AS res`, ['pass_secret_tok_pub']),
);
verifier(
  !lectureShareToken.ok && lectureShareToken.error.includes('passport_not_found_or_private'),
  '8. tracefab_get_public_supplier_passport refuse le share_token prive meme si le passeport est public',
  lectureShareToken.ok ? 'ACCEPTEE !' : lectureShareToken.error,
);

// 9. Defense en profondeur ACL sur public.audit_logs (append-only : INSERT oui, UPDATE/DELETE/TRUNCATE 42501)
const auditAcl = (await db.query(`
  SELECT has_table_privilege('tracefab_app', 'public.audit_logs', 'SELECT') AS s,
         has_table_privilege('tracefab_app', 'public.audit_logs', 'INSERT') AS i,
         has_table_privilege('tracefab_app', 'public.audit_logs', 'UPDATE') AS u,
         has_table_privilege('tracefab_app', 'public.audit_logs', 'DELETE') AS d,
         has_table_privilege('tracefab_app', 'public.audit_logs', 'TRUNCATE') AS t
`)).rows[0];
verifier(
  auditAcl.s === true && auditAcl.i === true && auditAcl.u === false && auditAcl.d === false && auditAcl.t === false,
  '9a. ACL audit_logs : tracefab_app a SELECT+INSERT mais ni UPDATE, ni DELETE, ni TRUNCATE',
  JSON.stringify(auditAcl),
);

const auditDeleteAttempt = await sousRoleApp(
  {
    'tracefab.user_id': USER_SUPPLIER,
    'tracefab.active_organization_id': ORG_SUPPLIER_PUB,
  },
  () => db.query(`DELETE FROM public.audit_logs WHERE false`),
);
const auditUpdateAttempt = await sousRoleApp(
  {
    'tracefab.user_id': USER_SUPPLIER,
    'tracefab.active_organization_id': ORG_SUPPLIER_PUB,
  },
  () => db.query(`UPDATE public.audit_logs SET action = action WHERE false`),
);
verifier(
  !auditDeleteAttempt.ok && auditDeleteAttempt.code === '42501'
    && !auditUpdateAttempt.ok && auditUpdateAttempt.code === '42501',
  '9b. execution audit_logs : UPDATE et DELETE echouent en 42501 (permission denied) avant meme la RLS',
  `delete=${auditDeleteAttempt.ok ? 'OK' : auditDeleteAttempt.code}, update=${auditUpdateAttempt.ok ? 'OK' : auditUpdateAttempt.code}`,
);

const auditInsertAttempt = await sousRoleApp(
  {
    'tracefab.user_id': USER_SUPPLIER,
    'tracefab.active_organization_id': ORG_SUPPLIER_PUB,
  },
  () => db.query(
    `INSERT INTO public.audit_logs (organization_id, actor_user_id, action, entity_type) VALUES ($1, $2, 'test.append_only', 'organizations')`,
    [ORG_SUPPLIER_PUB, USER_SUPPLIER],
  ),
);
verifier(
  auditInsertAttempt.ok,
  '9c. execution audit_logs : INSERT direct autorise dans le tenant actif',
  auditInsertAttempt.ok ? '' : auditInsertAttempt.error,
);

// 10. Verification catalogue : PUBLIC n'a EXECUTE sur aucune des 3 fonctions, search_path fige
const hygiene = (await db.query(`
  SELECT count(*) FILTER (
           WHERE has_function_privilege('public', p.oid, 'EXECUTE')
         )::int AS public_exec,
         count(*) FILTER (
           WHERE NOT ('search_path=pg_catalog, public' = ANY(coalesce(p.proconfig, ARRAY[]::text[])))
         )::int AS bad_search_path
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN (
       'tracefab_get_public_supplier_passport',
       'tracefab_request_passport_access',
       'tracefab_review_passport_access'
     )
`)).rows[0];
verifier(
  hygiene.public_exec === 0 && hygiene.bad_search_path === 0,
  '10. hygiene SQL : 0 EXECUTE PUBLIC et search_path = pg_catalog, public sur les 3 fonctions',
  JSON.stringify(hygiene),
);

await db.close();

console.log('');
if (echecs > 0) {
  console.error(`Preuve passeport fournisseur : ${echecs} echec(s) sur ${assertions} controles.`);
  process.exit(1);
}
console.log(`Preuve passeport fournisseur : OK (${assertions}/${assertions} controles conformes).`);
