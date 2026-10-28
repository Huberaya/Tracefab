#!/usr/bin/env node
/**
 * Correctif `supplier_portal` : prouver le defaut, le corriger, et PROUVER que
 * la correction ne peut pas etre contournee.
 *
 * POURQUOI CE TEST EXISTE
 *
 * La production refuse l'invitation d'un `owner` portant un `relationship_id`
 * (onboarding fournisseur) parce qu'elle a execute une version plus stricte de
 * `tracefab_validate_member_invitation_role` que celle du depot.
 *
 * Mais la regle du depot — `NEW.relationship_id IS NULL` — ne verifie RIEN sur
 * la relation : n'importe quel identifiant non nul ouvre la porte. Or
 * `tracefab_app` ecrit `organization_invitations` en direct et la politique
 * `invitations_insert_admin` autorise tout `admin` de l'organisation visee.
 * Deux contournements en decoulent, et ce test les mesure :
 *
 *   - un `admin` invite un `owner` dans SA PROPRE organisation en presentant
 *     une relation quelconque (elevation de privileges) ;
 *   - une relation appartenant a DEUX AUTRES organisations est acceptee
 *     (reutilisation inter-organisations).
 *
 * CE QU'IL PROUVE, DANS CET ORDRE
 *   1. le defaut de production : owner + relation est refuse ;
 *   2. les deux contournements de la regle du depot ;
 *   3. apres migration : l'onboarding passe, et chaque contournement est ferme ;
 *   4. les roles non-`owner` ne sont pas affectes ;
 *   5. l'idempotence, le declencheur, l'absence de GRANT ;
 *   6. la chaine complete des 64 migrations.
 *
 * CHAQUE CAS NEGATIF ECHOUE SI LE CONTROLE DISPARAIT : c'est le point de ce
 * fichier. Un test qui passerait aussi sans le controle ne prouverait rien.
 *
 *   npm run test:supplier-invitation-corrective
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = path.join(root, 'prisma/migrations');
const CORRECTIVE = '20261028140000_supplier_invitation_owner_relationship_scope';
const FIXTURE_PROD = path.join(root, 'scripts/fixtures/empreintes-production-20261028/supplier_portal.sql');

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

/** Extrait la definition de la fonction de validation d'un fichier de migration. */
function corpsFonction(sql) {
  const m = sql.match(/CREATE OR REPLACE FUNCTION tracefab_validate_member_invitation_role\(\)[\s\S]*?\$\$;/);
  return m ? m[0] : null;
}

/* --- Identifiants fixes : deux couples d organisations ------------------- */

const MARQUE_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const FOURNISSEUR_A = 'aaaaaaaa-0000-0000-0000-000000000002';
const MARQUE_B = 'bbbbbbbb-0000-0000-0000-000000000001';
const FOURNISSEUR_B = 'bbbbbbbb-0000-0000-0000-000000000002';
const REL_A = 'cccccccc-0000-0000-0000-00000000000a'; // A : marque A -> fournisseur A
const REL_A_ENDED = 'cccccccc-0000-0000-0000-00000000000b';
const REL_B = 'cccccccc-0000-0000-0000-00000000000c'; // B : marque B -> fournisseur B

async function base() {
  const db = new PGlite({ extensions: { pgcrypto, uuid_ossp } });
  await db.waitReady;
  await db.exec(`
    CREATE TYPE membership_role AS ENUM
      ('owner','admin','manager','contributor','auditor','viewer','supplier_user');
    CREATE TYPE relationship_status AS ENUM ('invited','active','suspended','ended');

    CREATE TABLE brand_supplier_relationships (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      brand_organization_id uuid NOT NULL,
      supplier_organization_id uuid NOT NULL,
      status relationship_status NOT NULL DEFAULT 'invited',
      CHECK (brand_organization_id <> supplier_organization_id)
    );

    CREATE TABLE organization_invitations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL,
      target_role membership_role NOT NULL,
      relationship_id uuid REFERENCES brand_supplier_relationships(id),
      email text NOT NULL DEFAULT 'x@example.test'
    );

    INSERT INTO brand_supplier_relationships (id, brand_organization_id, supplier_organization_id, status)
    VALUES ('${REL_A}', '${MARQUE_A}', '${FOURNISSEUR_A}', 'invited'),
           ('${REL_A_ENDED}', '${MARQUE_A}', '${FOURNISSEUR_A}', 'ended'),
           ('${REL_B}', '${MARQUE_B}', '${FOURNISSEUR_B}', 'active');
  `);
  return db;
}

async function installer(db, corps) {
  await db.exec(corps);
  await db.exec(`
    DROP TRIGGER IF EXISTS organization_invitations_validate_role ON organization_invitations;
    CREATE TRIGGER organization_invitations_validate_role
      BEFORE INSERT OR UPDATE ON organization_invitations
      FOR EACH ROW EXECUTE FUNCTION tracefab_validate_member_invitation_role();
  `);
}

/** Tente une invitation et rend 'accepte' ou le nom de l'exception. */
async function inviter(db, { role, organisation, relation }) {
  const rel = relation === null ? 'null' : `'${relation}'`;
  try {
    await db.exec(`INSERT INTO organization_invitations (organization_id, target_role, relationship_id)
                   VALUES ('${organisation}', '${role}', ${rel})`);
    return 'accepte';
  } catch (e) {
    const m = String(e.message);
    const nom = m.match(/^(owner_role_not_invitable|invitation_relationship_not_found|invitation_relationship_organization_mismatch|invitation_relationship_ended)/);
    return nom ? nom[1] : `erreur:${m.slice(0, 80)}`;
  }
}

/* Les six cas qui comptent, joues sur chaque version. */
const CAS = {
  onboarding: { role: 'owner', organisation: FOURNISSEUR_A, relation: REL_A },
  ownerSansRelation: { role: 'owner', organisation: FOURNISSEUR_A, relation: null },
  ownerCoteMarque: { role: 'owner', organisation: MARQUE_A, relation: REL_A },
  relationAutreOrg: { role: 'owner', organisation: FOURNISSEUR_A, relation: REL_B },
  relationTerminee: { role: 'owner', organisation: FOURNISSEUR_A, relation: REL_A_ENDED },
  adminAvecRelation: { role: 'admin', organisation: FOURNISSEUR_A, relation: REL_A },
  viewerSansRelation: { role: 'viewer', organisation: FOURNISSEUR_A, relation: null },
};

async function jouerTous(db) {
  const r = {};
  for (const [nom, c] of Object.entries(CAS)) r[nom] = await inviter(db, c);
  return r;
}

/* ==========================================================================
   1. Etat de production et regle du depot : defauts mesures
   ========================================================================== */

console.log('\n  1. Production et regle du depot : ce que chacune laisse passer');

const corpsProd = corpsFonction(fs.readFileSync(FIXTURE_PROD, 'utf8'));
const corpsDepot = corpsFonction(LIRE('20261005090000_supplier_portal_advanced_hardening'));
const corpsCorrectif = corpsFonction(LIRE(CORRECTIVE));
ok('les trois corps de fonction sont extraits',
  corpsProd && corpsDepot && corpsCorrectif);
ok('le corps du depot differe de celui de production', corpsProd !== corpsDepot);
ok('le corps correctif differe de celui du depot', corpsCorrectif !== corpsDepot);

const dbProd = await base();
await installer(dbProd, corpsProd);
const rProd = await jouerTous(dbProd);
await dbProd.close();

const dbDepot = await base();
await installer(dbDepot, corpsDepot);
const rDepot = await jouerTous(dbDepot);
await dbDepot.close();

console.log(`        production : ${JSON.stringify(rProd)}`);
console.log(`        depot      : ${JSON.stringify(rDepot)}`);

ok('DEFANT DE PRODUCTION : owner + relation fournisseur est REFUSE',
  rProd.onboarding === 'owner_role_not_invitable', rProd.onboarding);
ok('DEFANT DE LA REGLE DU DEPOT : un owner cote MARQUE est accepte (elevation)',
  rDepot.ownerCoteMarque === 'accepte', rDepot.ownerCoteMarque);
ok('DEFANT DE LA REGLE DU DEPOT : une relation d un AUTRE couple est acceptee (inter-organisations)',
  rDepot.relationAutreOrg === 'accepte', rDepot.relationAutreOrg);
ok('DEFANT DE LA REGLE DU DEPOT : une relation TERMINEE est acceptee',
  rDepot.relationTerminee === 'accepte', rDepot.relationTerminee);
ok('les deux versions refusent owner sans relation',
  rProd.ownerSansRelation === 'owner_role_not_invitable'
  && rDepot.ownerSansRelation === 'owner_role_not_invitable');

/* ==========================================================================
   2. Le correctif, sur les six cas
   ========================================================================== */

console.log('\n  2. Apres migration corrective');

const doc = LIRE(CORRECTIVE);
const db = await base();
await installer(db, corpsProd);
// La migration est jouee EN ENTIER, pas seulement le corps de la fonction :
// une migration dont on n'execute qu'un morceau n'est pas la migration.
let appliquee = 'ok';
try { await db.exec(doc); } catch (e) { appliquee = String(e.message); }
ok('la migration corrective s applique', appliquee === 'ok', appliquee.slice(0, 200));

const r = await jouerTous(db);
console.log(`        correctif  : ${JSON.stringify(r)}`);

ok('ONBOARDING PRESERVE : owner + relation fournisseur est ACCEPTE',
  r.onboarding === 'accepte', r.onboarding);
ok('owner sans relation reste REFUSE',
  r.ownerSansRelation === 'owner_role_not_invitable', r.ownerSansRelation);
ok('NEGATIF : owner cote MARQUE est REFUSE',
  r.ownerCoteMarque === 'invitation_relationship_organization_mismatch', r.ownerCoteMarque);
ok('NEGATIF : relation d un AUTRE couple est REFUSEE (isolation inter-organisations)',
  r.relationAutreOrg === 'invitation_relationship_organization_mismatch', r.relationAutreOrg);
ok('NEGATIF : relation TERMINEE est REFUSEE',
  r.relationTerminee === 'invitation_relationship_ended', r.relationTerminee);
ok('admin + relation reste ACCEPTE (le declencheur ne vise que owner)',
  r.adminAvecRelation === 'accepte', r.adminAvecRelation);
ok('viewer sans relation reste ACCEPTE', r.viewerSansRelation === 'accepte',
  r.viewerSansRelation);
// Comparer les messages ne dirait rien : deux refus de motifs differents sont
// deux refus. Ce qui compte est la DECISION, accepte ou refuse.
const decision = (v) => (v === 'accepte' ? 'accepte' : 'refuse');
const changements = Object.keys(CAS).filter((k) => decision(rProd[k]) !== decision(r[k]));
ok('le correctif ne change la DECISION que sur un cas : l onboarding fournisseur',
  changements.join(',') === 'onboarding', changements.join(',') || '(aucun)');
ok('sur tous les autres cas, la decision reste celle de la production',
  Object.keys(CAS).filter((k) => k !== 'onboarding')
    .every((k) => decision(rProd[k]) === decision(r[k])));

// Et face a la regle du depot, le correctif FERME des cas sans en ouvrir d'autre.
const ouvertsParLeCorrectif = Object.keys(CAS)
  .filter((k) => decision(rDepot[k]) === 'refuse' && decision(r[k]) === 'accepte');
ok('le correctif n ouvre aucun cas que la regle du depot fermait',
  ouvertsParLeCorrectif.length === 0, ouvertsParLeCorrectif.join(','));

/* ==========================================================================
   3. Le controle est-il indispensable ? On le retire.
   ========================================================================== */

console.log('\n  3. Controle negatif : sans le controle de relation, le test doit rougir');

// On rejoue le corps correctif en supprimant le seul controle d'appartenance.
const sansControle = corpsCorrectif.replace(
  /IF v_relation\.supplier_organization_id IS DISTINCT FROM NEW\.organization_id THEN[\s\S]*?END IF;/,
  '-- controle d appartenance retire',
);
ok('le controle d appartenance est bien present dans le correctif',
  sansControle !== corpsCorrectif);

const dbSans = await base();
await installer(dbSans, sansControle);
const rSans = await jouerTous(dbSans);
await dbSans.close();
ok('SANS le controle : owner cote marque redevient accepte',
  rSans.ownerCoteMarque === 'accepte', rSans.ownerCoteMarque);
ok('SANS le controle : relation d un autre couple redevient acceptee',
  rSans.relationAutreOrg === 'accepte', rSans.relationAutreOrg);
ok('=> le test echouerait : les assertions negatives dependent du controle',
  rSans.ownerCoteMarque !== r.ownerCoteMarque && rSans.relationAutreOrg !== r.relationAutreOrg);

// Idem pour le controle de statut.
const sansStatut = corpsCorrectif.replace(
  /IF v_relation\.status = 'ended' THEN[\s\S]*?END IF;/,
  '-- controle de statut retire',
);
const dbStatut = await base();
await installer(dbStatut, sansStatut);
const rStatut = await jouerTous(dbStatut);
await dbStatut.close();
ok('SANS le controle de statut : relation terminee redevient acceptee',
  rStatut.relationTerminee === 'accepte', rStatut.relationTerminee);

/* ==========================================================================
   4. Idempotence, declencheur, privileges
   ========================================================================== */

console.log('\n  4. Idempotence et privileges');

let rejeu = 'ok';
try { await db.exec(doc); } catch (e) { rejeu = String(e.message); }
ok('la migration se rejoue sans erreur', rejeu === 'ok', rejeu.slice(0, 200));
ok('le comportement est inchange apres rejeu',
  (await inviter(db, CAS.onboarding)) === 'accepte');
ok('un contournement reste ferme apres rejeu',
  (await inviter(db, CAS.relationAutreOrg)) === 'invitation_relationship_organization_mismatch');

const decl = await db.query(`
  SELECT p.proname FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
   WHERE t.tgname = 'organization_invitations_validate_role'`);
ok('le declencheur existe et pointe sur la fonction corrigee',
  decl.rows.length === 1 && decl.rows[0].proname === 'tracefab_validate_member_invitation_role',
  JSON.stringify(decl.rows));
// Reposer le declencheur pourrait elargir sa portee (DELETE, TRUNCATE...) :
// on verifie qu il garde exactement le tir historique, BEFORE INSERT OR UPDATE
// FOR EACH ROW. tgtype = ROW(1) + BEFORE(2) + INSERT(4) + UPDATE(16) = 23.
const tir = await db.query(`SELECT tgtype::int t FROM pg_catalog.pg_trigger
                             WHERE tgname = 'organization_invitations_validate_role'`);
ok('le declencheur garde exactement sa portee historique (BEFORE INSERT OR UPDATE, FOR EACH ROW)',
  tir.rows.length === 1 && tir.rows[0].t === 23, JSON.stringify(tir.rows));
ok('le declencheur n a pas ete duplique',
  (await db.query(`SELECT count(*)::int n FROM pg_catalog.pg_trigger
                    WHERE tgname = 'organization_invitations_validate_role'`)).rows[0].n === 1);

const secdef = await db.query(`
  SELECT p.prosecdef, has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'tracefab_validate_member_invitation_role'`);
ok('la fonction reste SECURITY DEFINER', secdef.rows[0]?.prosecdef === true,
  JSON.stringify(secdef.rows[0]));
ok('aucun GRANT ni REVOKE dans la migration corrective',
  !/\b(GRANT|REVOKE)\b/i.test(doc.replace(/--[^\n]*/g, '')));
await db.close();

/* ==========================================================================
   5. Chaine complete
   ========================================================================== */

console.log('\n  5. Chaine complete des migrations');

const dossiers = fs.readdirSync(MIGRATIONS).filter((d) => /^\d{14}_/.test(d)).sort();
ok('la migration corrective est la DERNIERE de la chaine',
  dossiers[dossiers.length - 1] === CORRECTIVE, dossiers[dossiers.length - 1]);
ok('aucune migration historique n a ete renumerotee (64 au total)',
  dossiers.length === 64, `${dossiers.length}`);

{
  const db2 = new PGlite({ extensions: { pgcrypto, uuid_ossp } });
  await db2.waitReady;
  await db2.exec(`
    CREATE ROLE tracefab_app LOGIN PASSWORD 'runtime' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
    GRANT USAGE ON SCHEMA public TO tracefab_app;
  `);
  let appliquees = 0;
  let erreur = null;
  for (const d of dossiers) {
    try {
      await db2.exec(fs.readFileSync(path.join(MIGRATIONS, d, 'migration.sql'), 'utf8'));
      appliquees += 1;
    } catch (e) { erreur = `${d} : ${e.message}`; break; }
  }
  ok('les 64 migrations s appliquent sur une base vierge',
    erreur === null && appliquees === 64, erreur || `${appliquees}/64`);

  const def = (await db2.query(`
    SELECT pg_catalog.pg_get_functiondef(p.oid) AS d
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'tracefab_validate_member_invitation_role'`)).rows[0]?.d || '';
  ok('la chaine finale porte le controle d appartenance de relation',
    /supplier_organization_id IS DISTINCT FROM NEW\.organization_id/.test(def),
    def.slice(0, 120));
  ok('la chaine finale porte le controle de statut',
    /invitation_relationship_ended/.test(def));
  await db2.close();
}

console.log('\n  --------------------------------------------');
if (echecs > 0) {
  console.error(`  ${echecs} echec(s) sur ${verifies}.`);
  process.exit(1);
}
console.log(`  ${verifies} verifications passees.`);
console.log('  Onboarding preserve, elevations et reutilisation inter-organisations fermees.');
console.log('  Les cas negatifs dependent du controle : le retirer fait rougir le test.\n');
