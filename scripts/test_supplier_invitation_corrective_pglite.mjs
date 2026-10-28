#!/usr/bin/env node
/**
 * `supplier_portal` — invitation d'un `owner` : ce que le SYSTEME fait, pas ce
 * qu'une fonction isolee ferait.
 *
 * CE QUE J'AI CORRIGE DANS CE TEST, ET POURQUOI
 *
 * La version precedente montait un schema ecrit a la main : les deux tables, et
 * une seule fonction de validation. Elle concluait que la regle du depot ouvrait
 * deux contournements — elevation d'un `admin` en `owner`, et reutilisation
 * d'une relation d'un autre couple.
 *
 * C'etait FAUX, et le montage en etait la cause. La chaine reelle pose un
 * SECOND declencheur, `invitations_validate_relationship` (migration initiale
 * 20260923130000), dont la fonction `tracefab_validate_invitation_relationship`
 * exige deja :
 *
 *     r.id = NEW.relationship_id AND r.supplier_organization_id = NEW.organization_id
 *
 * Il tire avant le notre (ordre alphabetique des declencheurs) et refuse les deux
 * cas. Les « contournements » n'existaient que dans un schema ou ce declencheur
 * avait ete oublie.
 *
 * Ce test mesure donc desormais sur la CHAINE COMPLETE. Il etablit :
 *
 *   1. les deux declencheurs sont presents, et lequel refuse quoi ;
 *   2. le seul ecart reel production / depot est : l'onboarding (refuse en
 *      production) et les relations terminees (acceptees par le depot) ;
 *   3. le correctif ouvre l'onboarding et ferme les relations terminees ;
 *   4. le controle d'appartenance ajoute est une REDONDANCE assumee : sur la
 *      chaine complete il ne change rien, mais sans l'autre declencheur il
 *      devient la seule barriere. C'est mesure dans les deux sens.
 *
 *   npm run test:supplier-invitation-corrective
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = path.join(root, 'prisma/migrations');
const FIXTURE_PROD = path.join(root, 'scripts/fixtures/empreintes-production-20261028/supplier_portal.sql');
const CORRECTIVE = '20261028140000_supplier_invitation_owner_relationship_scope';

let PGlite, pgcrypto, uuid_ossp;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  ({ pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto'));
  ({ uuid_ossp } = await import('@electric-sql/pglite/contrib/uuid_ossp'));
} catch {
  console.error('ECHEC  @electric-sql/pglite introuvable — executer `npm ci`.');
  process.exit(1);
}

let echecs = 0;
let verifies = 0;
const ok = (libelle, condition, detail = '') => {
  verifies += 1;
  if (condition) { console.log(`  ok    ${libelle}`); return; }
  echecs += 1;
  console.error(`  ECHEC ${libelle}${detail ? ` — ${detail}` : ''}`);
};

const LIRE = (d) => fs.readFileSync(path.join(MIGRATIONS, d, 'migration.sql'), 'utf8');
const dossiers = fs.readdirSync(MIGRATIONS).filter((d) => /^\d{14}_/.test(d)).sort();

/** Extrait la definition de la fonction de validation d'un fichier de migration. */
function corpsFonction(sql) {
  const m = sql.match(/CREATE OR REPLACE FUNCTION tracefab_validate_member_invitation_role\(\)[\s\S]*?\$\$;/);
  return m ? m[0] : null;
}

/* --- Identifiants fixes : deux couples d organisations, plus un tiers ----- */

const MARQUE_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const FOURNISSEUR_A = 'aaaaaaaa-0000-0000-0000-000000000002';
const MARQUE_B = 'bbbbbbbb-0000-0000-0000-000000000001';
const FOURNISSEUR_B = 'bbbbbbbb-0000-0000-0000-000000000002';
const REL_A = 'cccccccc-0000-0000-0000-00000000000a';
const REL_A_ENDED = 'cccccccc-0000-0000-0000-00000000000b';
const REL_B = 'cccccccc-0000-0000-0000-00000000000c';

/**
 * Base de travail : la CHAINE COMPLETE du depot, moins la migration corrective.
 * C'est l'etat que la production atteindrait si elle avait la regle du depot —
 * deux declencheurs compris.
 */
async function baseChaine({ avecCorrective = false } = {}) {
  const db = new PGlite({ extensions: { pgcrypto, uuid_ossp } });
  await db.waitReady;
  await db.exec(`
    CREATE ROLE tracefab_app LOGIN PASSWORD 'runtime' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
    GRANT USAGE ON SCHEMA public TO tracefab_app;
  `);
  for (const d of dossiers) {
    if (d === CORRECTIVE && !avecCorrective) continue;
    await db.exec(LIRE(d));
  }
  await db.exec(`
    INSERT INTO organizations (id, type, legal_name) VALUES
      ('${MARQUE_A}', 'brand', 'Marque A'),
      ('${FOURNISSEUR_A}', 'supplier', 'Fournisseur A'),
      ('${MARQUE_B}', 'brand', 'Marque B'),
      ('${FOURNISSEUR_B}', 'supplier', 'Fournisseur B');
    INSERT INTO users (id, clerk_user_id, email, full_name) VALUES
      ('dddddddd-0000-0000-0000-000000000001', 'clerk-sonde', 'sonde@exemple.invalid', 'Sonde');
    INSERT INTO brand_supplier_relationships (id, brand_organization_id, supplier_organization_id, status) VALUES
      ('${REL_A}',       '${MARQUE_A}', '${FOURNISSEUR_A}', 'invited'),
      -- Contrainte d unicite sur le couple : la relation terminee doit viser un
      -- AUTRE couple que la relation active, sinon l insertion echoue avant
      -- d atteindre le moindre declencheur.
      ('${REL_A_ENDED}', '${MARQUE_A}', '${FOURNISSEUR_B}', 'ended'),
      ('${REL_B}',       '${MARQUE_B}', '${FOURNISSEUR_B}', 'active');
  `);
  return db;
}

/** Remplace le corps de la fonction de role, comme le ferait une migration. */
async function installerCorps(db, corps) {
  await db.exec(corps);
  await db.exec(`
    DROP TRIGGER IF EXISTS organization_invitations_validate_role ON organization_invitations;
    CREATE TRIGGER organization_invitations_validate_role
      BEFORE INSERT OR UPDATE ON organization_invitations
      FOR EACH ROW EXECUTE FUNCTION tracefab_validate_member_invitation_role();
  `);
}

/** Tente une invitation reelle et rend 'accepte' ou le nom de l'exception. */
const MOTIFS = /^(owner_role_not_invitable|invitation_relationship_not_found|invitation_relationship_organization_mismatch|invitation_relationship_ended|invitation_relationship_mismatch|share_relationship_mismatch)/;
async function inviter(db, { role, organisation, relation }) {
  const rel = relation === null ? 'null' : `'${relation}'`;
  try {
    await db.query(
      `INSERT INTO organization_invitations
         (organization_id, email, target_role, relationship_id, token_hash, invited_by, expires_at)
       VALUES ($1, $2, $3, ${rel}, md5(random()::text), $4, now() + interval '1 day')`,
      [organisation, `sonde-${Math.random().toString(16).slice(2)}@exemple.invalid`, role,
        'dddddddd-0000-0000-0000-000000000001']);
    return 'accepte';
  } catch (e) {
    const m = String(e.message).match(MOTIFS);
    return m ? m[1] : `erreur:${String(e.message).slice(0, 70)}`;
  }
}

const CAS = {
  onboarding: { role: 'owner', organisation: FOURNISSEUR_A, relation: REL_A },
  ownerSansRelation: { role: 'owner', organisation: FOURNISSEUR_A, relation: null },
  ownerCoteMarque: { role: 'owner', organisation: MARQUE_A, relation: REL_A },
  relationAutreOrg: { role: 'owner', organisation: FOURNISSEUR_A, relation: REL_B },
  relationTerminee: { role: 'owner', organisation: FOURNISSEUR_B, relation: REL_A_ENDED },
  adminAvecRelation: { role: 'admin', organisation: FOURNISSEUR_A, relation: REL_A },
  viewerSansRelation: { role: 'viewer', organisation: FOURNISSEUR_A, relation: null },
};

async function jouerTous(db) {
  const r = {};
  for (const [nom, c] of Object.entries(CAS)) r[nom] = await inviter(db, c);
  return r;
}

const corpsProd = corpsFonction(fs.readFileSync(FIXTURE_PROD, 'utf8'));
const corpsDepot = corpsFonction(LIRE('20261005090000_supplier_portal_advanced_hardening'));
const corpsCorrectif = corpsFonction(LIRE(CORRECTIVE));

/* ==========================================================================
   1. La chaine reelle, et ses deux declencheurs
   ========================================================================== */

console.log('\n  1. La chaine reelle : deux declencheurs, pas un');

const db = await baseChaine();
const decls = await db.query(`
  SELECT t.tgname, p.proname, t.tgtype::int AS portee
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
   WHERE t.tgrelid = 'organization_invitations'::regclass AND NOT t.tgisinternal
   ORDER BY t.tgname`);
ok('deux declencheurs gardent `organization_invitations`', decls.rows.length === 2,
  JSON.stringify(decls.rows.map((r) => r.tgname)));
ok('`invitations_validate_relationship` tire AVANT `organization_invitations_validate_role`',
  decls.rows[0]?.tgname === 'invitations_validate_relationship',
  JSON.stringify(decls.rows.map((r) => r.tgname)));

const corpsAutre = (await db.query(`
  SELECT pg_catalog.pg_get_functiondef(p.oid) AS def
    FROM pg_catalog.pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'tracefab_validate_invitation_relationship'`)).rows[0]?.def ?? '';
ok('l autre declencheur verifie deja la relation contre l organisation de l invitation',
  /supplier_organization_id\s*=\s*NEW\.organization_id/.test(corpsAutre));

/* ==========================================================================
   2. Production, depot, correctif — sur la chaine complete
   ========================================================================== */

console.log('\n  2. Trois versions, jouees sur la chaine complete');

await installerCorps(db, corpsProd);
const rProd = await jouerTous(db);
console.log(`        production : ${JSON.stringify(rProd)}`);

await installerCorps(db, corpsDepot);
const rDepot = await jouerTous(db);
console.log(`        depot      : ${JSON.stringify(rDepot)}`);

const doc = LIRE(CORRECTIVE);
const appliquee = await installerCorps(db, corpsCorrectif).then(() => 'ok').catch((e) => String(e.message));
ok('le corps correctif s installe', appliquee === 'ok', appliquee);
const rCorrectif = await jouerTous(db);
console.log(`        correctif  : ${JSON.stringify(rCorrectif)}`);

ok('PRODUCTION : l onboarding fournisseur est REFUSE — c est le defaut',
  rProd.onboarding === 'owner_role_not_invitable', rProd.onboarding);
ok('PRODUCTION : aucune invitation d owner ne passe, quel que soit le cas',
  Object.entries(rProd).filter(([k]) => k.startsWith('owner') || k === 'onboarding' || k === 'relationTerminee')
    .every(([, v]) => v !== 'accepte'),
  JSON.stringify(rProd));

ok('DEPOT : l onboarding est ACCEPTE — la regle du depot repare le parcours',
  rDepot.onboarding === 'accepte', rDepot.onboarding);
ok('DEPOT : owner sans relation reste REFUSE', rDepot.ownerSansRelation === 'owner_role_not_invitable',
  rDepot.ownerSansRelation);
ok('DEPOT : owner cote marque est REFUSE — par le SECOND declencheur, pas par celui-ci',
  rDepot.ownerCoteMarque === 'invitation_relationship_mismatch', rDepot.ownerCoteMarque);
ok('DEPOT : relation d un autre couple est REFUSEE — par le SECOND declencheur',
  rDepot.relationAutreOrg === 'invitation_relationship_mismatch', rDepot.relationAutreOrg);
ok('DEPOT : une relation TERMINEE est acceptee — c est le seul trou reel',
  rDepot.relationTerminee === 'accepte', rDepot.relationTerminee);

ok('CORRECTIF : l onboarding est ACCEPTE', rCorrectif.onboarding === 'accepte', rCorrectif.onboarding);
ok('CORRECTIF : owner sans relation reste REFUSE',
  rCorrectif.ownerSansRelation === 'owner_role_not_invitable', rCorrectif.ownerSansRelation);
ok('CORRECTIF : owner cote marque est REFUSE',
  rCorrectif.ownerCoteMarque.startsWith('invitation_relationship'), rCorrectif.ownerCoteMarque);
ok('CORRECTIF : relation d un autre couple est REFUSEE',
  rCorrectif.relationAutreOrg.startsWith('invitation_relationship'), rCorrectif.relationAutreOrg);
ok('CORRECTIF : relation TERMINEE est REFUSEE — le trou du depot est ferme',
  rCorrectif.relationTerminee === 'invitation_relationship_ended', rCorrectif.relationTerminee);
ok('CORRECTIF : admin + relation reste ACCEPTE (le declencheur ne vise que owner)',
  rCorrectif.adminAvecRelation === 'accepte', rCorrectif.adminAvecRelation);
ok('CORRECTIF : viewer sans relation reste ACCEPTE',
  rCorrectif.viewerSansRelation === 'accepte', rCorrectif.viewerSansRelation);
ok('CORRECTIF : aucune recuperation de decision par rapport au depot, sauf relation terminee',
  Object.keys(CAS).filter((k) => (rDepot[k] === 'accepte') !== (rCorrectif[k] === 'accepte'))
    .join(',') === 'relationTerminee',
  Object.keys(CAS).filter((k) => (rDepot[k] === 'accepte') !== (rCorrectif[k] === 'accepte')).join(','));

/* ==========================================================================
   3. Qui refuse quoi — attribution, pas supposition
   ========================================================================== */

console.log('\n  3. Attribution des refus : quel declencheur agit');

await db.exec('DROP TRIGGER invitations_validate_relationship ON organization_invitations;');
await installerCorps(db, corpsDepot);
const sansAutre = await jouerTous(db);
console.log(`        depot sans l autre declencheur : ${JSON.stringify(sansAutre)}`);
ok('sans l autre declencheur, la regle du depot LAISSE PASSER owner cote marque',
  sansAutre.ownerCoteMarque === 'accepte', sansAutre.ownerCoteMarque);
ok('sans l autre declencheur, elle LAISSE PASSER une relation d un autre couple',
  sansAutre.relationAutreOrg === 'accepte', sansAutre.relationAutreOrg);

await installerCorps(db, corpsCorrectif);
const correctifSansAutre = await jouerTous(db);
console.log(`        correctif sans l autre declencheur : ${JSON.stringify(correctifSansAutre)}`);
ok('le controle d appartenance du correctif, SEUL, refuse owner cote marque',
  correctifSansAutre.ownerCoteMarque === 'invitation_relationship_organization_mismatch',
  correctifSansAutre.ownerCoteMarque);
ok('le controle d appartenance du correctif, SEUL, refuse une relation d un autre couple',
  correctifSansAutre.relationAutreOrg === 'invitation_relationship_organization_mismatch',
  correctifSansAutre.relationAutreOrg);
ok('=> ce controle est une REDONDANCE sur la chaine complete, et une barriere reelle sans l autre',
  rCorrectif.ownerCoteMarque === 'invitation_relationship_mismatch'
  && correctifSansAutre.ownerCoteMarque === 'invitation_relationship_organization_mismatch');

/* ==========================================================================
   4. Mutations du correctif
   ========================================================================== */

console.log('\n  4. Le test mord-il ? Deux mutations');

const sansAppartenance = corpsCorrectif.replace(
  /IF v_relation\.supplier_organization_id IS DISTINCT FROM NEW\.organization_id THEN[\s\S]*?END IF;/, '');
ok('la mutation « sans controle d appartenance » a bien retire du code',
  sansAppartenance !== corpsCorrectif && sansAppartenance.length < corpsCorrectif.length);

const sansStatut = corpsCorrectif.replace(
  /IF v_relation\.status = 'ended' THEN[\s\S]*?END IF;/, '');
ok('la mutation « sans controle de statut » a bien retire du code',
  sansStatut !== corpsCorrectif && sansStatut.length < corpsCorrectif.length);

const dbM = await baseChaine();

await installerCorps(dbM, sansStatut);
const rSansStatut = await jouerTous(dbM);
ok('SANS le controle de statut : la relation terminee redevient ACCEPTEE',
  rSansStatut.relationTerminee === 'accepte', rSansStatut.relationTerminee);
ok('=> l assertion sur la relation terminee depend bien de ce controle',

  true);

await installerCorps(dbM, sansAppartenance);
const rSansApp = await jouerTous(dbM);
ok('SANS le controle d appartenance, la chaine complete ne change RIEN (redundance mesuree)',
  JSON.stringify(rSansApp) === JSON.stringify(rCorrectif),
  `${JSON.stringify(rSansApp)}`);

await dbM.exec('DROP TRIGGER invitations_validate_relationship ON organization_invitations;');
const rSansAppSansAutre = await jouerTous(dbM);
ok('SANS les deux, owner cote marque et relation d un autre couple passent : le trou serait reel',
  rSansAppSansAutre.ownerCoteMarque === 'accepte' && rSansAppSansAutre.relationAutreOrg === 'accepte',
  JSON.stringify(rSansAppSansAutre));

/* ==========================================================================
   5. Idempotence, declencheur, privileges
   ========================================================================== */

console.log('\n  5. Idempotence et privileges');

let rejeu = 'ok';
try { await dbM.exec(doc); } catch (e) { rejeu = String(e.message); }
ok('la migration corrective entiere se rejoue sans erreur', rejeu === 'ok', rejeu.slice(0, 200));

const declCorrectif = await dbM.query(`
  SELECT p.proname, t.tgtype::int AS portee
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
   WHERE t.tgname = 'organization_invitations_validate_role'`);
ok('le declencheur existe, unique, et pointe sur la fonction corrigee',
  declCorrectif.rows.length === 1
  && declCorrectif.rows[0].proname === 'tracefab_validate_member_invitation_role',
  JSON.stringify(declCorrectif.rows));
ok('il garde exactement sa portee historique (BEFORE INSERT OR UPDATE FOR EACH ROW = 23)',
  declCorrectif.rows[0]?.portee === 23, `${declCorrectif.rows[0]?.portee}`);

const secdef = await dbM.query(`
  SELECT p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '') AS config
    FROM pg_catalog.pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = 'tracefab_validate_member_invitation_role'`);
ok('la fonction reste SECURITY DEFINER avec un search_path fixe',
  secdef.rows[0]?.prosecdef === true && /search_path/.test(secdef.rows[0]?.config ?? ''),
  JSON.stringify(secdef.rows[0]));
ok('aucun GRANT ni REVOKE dans la migration corrective',
  !/\b(GRANT|REVOKE)\b/i.test(doc.replace(/--[^\n]*/g, '')));

await db.close();
await dbM.close();

/* ==========================================================================
   6. Chaine complete
   ========================================================================== */

console.log('\n  6. Chaine complete des migrations');

ok('la migration corrective est la DERNIERE de la chaine',
  dossiers[dossiers.length - 1] === CORRECTIVE, dossiers[dossiers.length - 1]);
ok('aucune migration historique n a ete renumerotee (64 au total)', dossiers.length === 64, `${dossiers.length}`);

const dbC = await baseChaine({ avecCorrective: true });
const creees = await dbC.query(`
  SELECT count(*)::int AS n FROM pg_catalog.pg_tables
   WHERE schemaname = 'public' AND tablename IN ('organization_invitations','brand_supplier_relationships')`);
ok('les 64 migrations s appliquent sur une base vierge', creees.rows[0].n === 2, `${creees.rows[0].n}`);

const final = await dbC.query(`
  SELECT pg_catalog.pg_get_functiondef(p.oid) AS def
    FROM pg_catalog.pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = 'tracefab_validate_member_invitation_role'`);
ok('la chaine finale porte le controle d appartenance de relation',
  /supplier_organization_id IS DISTINCT FROM NEW\.organization_id/.test(final.rows[0]?.def ?? ''));
ok('la chaine finale porte le controle de statut',
  /status = 'ended'/.test(final.rows[0]?.def ?? ''));
await dbC.close();

console.log('\n  --------------------------------------------');
if (echecs === 0) {
  console.log(`  ${verifies} verifications passees.`);
  console.log('  Onboarding preserve, relation terminee fermee.');
  console.log('  Redondance du controle d appartenance : mesuree dans les deux sens.\n');
  process.exit(0);
}
console.log(`  ${echecs} echec(s) sur ${verifies}.`);
process.exit(1);
