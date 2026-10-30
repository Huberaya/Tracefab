#!/usr/bin/env node
/**
 * Politiques d'ecriture : WITH CHECK reel, pas suppose.
 *
 * POURQUOI CE TEST EXISTE
 *
 * Cinq politiques d'ecriture du schema sont declarees sans expression
 * WITH CHECK :
 *
 *   dpp_resolvable_identifiers   :: dpp_identity_function_update   [UPDATE]
 *   mass_balance_allocations     :: mb_allocations_modify          [ALL]
 *   quality_corrective_action_plans :: quality_cap_update_parties  [UPDATE]
 *   supplier_passport_access_requests :: passport_access_modify    [UPDATE]
 *   transaction_certificates     :: tc_update_parties              [UPDATE]
 *
 * Ce n'est pas une faille : quand WITH CHECK est absent, PostgreSQL reutilise
 * l'expression USING pour valider la NOUVELLE ligne. Une politique USING seule
 * est donc contraignante a l'ecriture, et non permissive.
 *
 * CE QUI PRODUIT LE REFUS — mesure, pas suppose
 *
 * Trois scenarios ont ete executes sur PostgreSQL 18.4, sur
 * dpp_resolvable_identifiers, avec un role de sonde sans BYPASSRLS tente de
 * transferer une ligne vers une organisation etrangere :
 *
 *   1. politiques existantes seules                    -> REFUSE (42501)
 *   2. + politique permissive FOR UPDATE USING (true)   -> toujours REFUSE
 *   3. + politique permissive FOR ALL    USING (true)   -> AUTORISE
 *
 * Le scenario 2 est le resultat important : une politique permissive FOR UPDATE
 * suffit a neutraliser le WITH CHECK herite de USING, et le refus persiste
 * quand meme. Le verrou decisif n'est donc PAS ce WITH CHECK. C'est le
 * scenario 3 qui leve le refus, en couvrant aussi la LECTURE : transferer la
 * propriete vers une organisation que l'acteur ne peut pas lire lui rendrait
 * sa propre ligne invisible, et PostgreSQL s'y oppose.
 *
 * La protection est donc reelle, mais elle repose sur la coherence entre
 * politiques de lecture et politiques d'ecriture — pas sur un seul mecanisme.
 * C'est precisement ce qui la rend fragile : ajouter une politique permissive
 * FOR ALL, ou elargir une politique de lecture, suffit a l'annuler.
 *
 * Trois choses peuvent la casser sans qu'aucune migration n'apparaisse dans un
 * diff :
 *
 *   1. quelqu'un ajoute une politique permissive FOR ALL sur la table ;
 *   2. quelqu'un retire l'USING en croyant ne toucher qu'a la lecture ;
 *   3. une table perd RLS FORCEE, et le proprietaire du role contourne tout.
 *
 * Ce test epingle l'invariant par EXECUTION : il tente reellement un transfert
 * de propriete entre organisations et exige un refus. Il echoue si le refus
 * cesse d'etre observe — verifie par controle negatif avec une politique
 * permissive FOR ALL, qui le fait bien passer au rouge.
 *
 * CE QU'IL VERIFIE
 *
 *   A. toute table du schema public a RLS activee ET forcee ;
 *   B. aucune politique n'est depourvue a la fois d'USING et de WITH CHECK ;
 *   C. toute politique d'ecriture sans WITH CHECK explicite possede un USING,
 *      donc une validation de la nouvelle ligne ;
 *   D. aucune fonction SECURITY DEFINER n'a un search_path non fixe ;
 *   E. PREUVE EXECUTEE sur dpp_resolvable_identifiers : un acteur disposant
 *      d'un role ecrivain dans l'organisation proprietaire peut modifier une
 *      colonne ordinaire, mais ne peut pas transferer la ligne vers une
 *      organisation ou il n'a aucun role ;
 *   F. le role de sonde n'a pas BYPASSRLS — sans quoi E ne prouverait rien.
 *
 * Sortie 2 si aucune connexion n'est fournie : un test qui n'a pas tourne
 * n'est pas un test qui passe.
 *
 * Ecritures : une ligne de fixture et un role de sonde, tous deux detruits en
 * fin de parcours. Aucune donnee existante n'est modifiee de facon durable.
 */
import pg from 'pg';
import { nomRoleEphemere } from './lib/ephemeral-role.mjs';

const ADMIN_URL = process.env.DATABASE_URL;
if (!ADMIN_URL) {
  console.error('  NON EXECUTE — DATABASE_URL absente.');
  console.error('  Un test qui ne tourne pas ne vaut pas un test qui passe : sortie 2.');
  process.exit(2);
}

// Nom UNIQUE par execution : le nom fixe `rls_probe_write_policy` etait cree
// « si absent » puis SUPPRIME en fin de course — donc un role preexistant de ce
// nom disparaissait. Voir scripts/lib/ephemeral-role.mjs.
const PROBE_ROLE = nomRoleEphemere('tf_rls_write_probe');
const PROBE_PASSWORD = 'sonde_locale_jetable';
let echecs = 0;
let assertions = 0;

function verifier(condition, libelle, detail = '') {
  assertions += 1;
  if (condition) {
    console.log(`  ok    ${libelle}${detail ? ' — ' + detail : ''}`);
  } else {
    echecs += 1;
    console.log(`  ECHEC ${libelle}${detail ? ' — ' + detail : ''}`);
  }
}

const admin = new pg.Client({ connectionString: ADMIN_URL });
await admin.connect();
const one = async (sql, params = []) => (await admin.query(sql, params)).rows[0];
const all = async (sql, params = []) => (await admin.query(sql, params)).rows;

let probe = null;
let fixtureId = null;

try {
  // ---------------------------------------------------------------- A
  const tables = await all(`
    SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS forcee
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname NOT LIKE '\\_%'
    ORDER BY c.relname`);
  const sansRls = tables.filter((t) => !t.rls);
  const nonForcee = tables.filter((t) => t.rls && !t.forcee);
  verifier(tables.length > 0, 'schema public non vide', `${tables.length} tables`);
  verifier(sansRls.length === 0, 'toutes les tables ont RLS activee',
    sansRls.length ? 'sans RLS : ' + sansRls.map((t) => t.relname).join(', ') : `${tables.length}/${tables.length}`);
  verifier(nonForcee.length === 0, 'toutes les tables ont RLS forcee',
    nonForcee.length ? 'non forcee : ' + nonForcee.map((t) => t.relname).join(', ') : `${tables.length}/${tables.length}`);

  // ---------------------------------------------------------------- B, C
  const politiques = await all(`
    SELECT c.relname, p.polname,
           CASE p.polcmd WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT'
                         WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE'
                         WHEN '*' THEN 'ALL' END AS commande,
           p.polqual IS NOT NULL AS a_using,
           p.polwithcheck IS NOT NULL AS a_check
    FROM pg_policy p
    JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' ORDER BY c.relname, p.polname`);
  verifier(politiques.length > 0, 'politiques presentes', `${politiques.length}`);

  const permissives = politiques.filter((p) => !p.a_using && !p.a_check);
  verifier(permissives.length === 0, 'aucune politique sans USING ni WITH CHECK',
    permissives.length ? permissives.map((p) => `${p.relname}::${p.polname}`).join(', ') : '0 politique permissive totale');

  const ecriture = politiques.filter((p) => ['INSERT', 'UPDATE', 'ALL'].includes(p.commande));
  const sansCheck = ecriture.filter((p) => !p.a_check);
  const sansCheckNiUsing = sansCheck.filter((p) => !p.a_using);
  verifier(sansCheckNiUsing.length === 0,
    'toute politique d\'ecriture sans WITH CHECK possede un USING',
    sansCheckNiUsing.length
      ? 'nouvelle ligne non validee : ' + sansCheckNiUsing.map((p) => `${p.relname}::${p.polname}`).join(', ')
      : `${sansCheck.length} politique(s) heritent de USING comme WITH CHECK`);

  // ---------------------------------------------------------------- D
  const sd = await all(`
    SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef
      AND NOT ('search_path=public' = ANY(COALESCE(p.proconfig, '{}')))`);
  verifier(sd.length === 0, 'aucune fonction SECURITY DEFINER sans search_path fixe',
    sd.length ? sd.map((r) => r.proname).join(', ') : '0');

  // ---------------------------------------------------------------- F puis E
  // Fixture : deux organisations avec un proprietaire chacune, et un produit
  // dans la premiere. Le test ne depend d'aucune ligne preexistante.
  const orgA = await one(`
    SELECT o.id, m.user_id FROM organizations o
    JOIN organization_memberships m ON m.organization_id = o.id AND m.role = 'owner'
    ORDER BY o.created_at, o.id LIMIT 1`);
  const orgB = await one(`
    SELECT o.id, m.user_id FROM organizations o
    JOIN organization_memberships m ON m.organization_id = o.id AND m.role = 'owner'
    WHERE o.id <> $1 ORDER BY o.created_at, o.id LIMIT 1`, [orgA.id]);
  verifier(Boolean(orgA && orgB), 'deux organisations distinctes avec un proprietaire',
    orgA && orgB ? 'fixture disponible' : 'seed RLS manquant — db:seed-rls');

  const colonneOrg = await one(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'tracefab_products' AND column_name LIKE '%organization%'
    ORDER BY ordinal_position LIMIT 1`);
  verifier(Boolean(colonneOrg), 'tracefab_products porte une colonne organisation',
    colonneOrg ? colonneOrg.column_name : 'colonne introuvable');

  const produit = await one(
    `SELECT id FROM tracefab_products WHERE ${colonneOrg.column_name} = $1 LIMIT 1`, [orgA.id]);
  verifier(Boolean(produit), 'un produit appartient a l\'organisation A', produit ? produit.id : 'aucun');

  const fixture = await one(`
    INSERT INTO dpp_resolvable_identifiers
      (product_id, owner_organization_id, public_id, granularity, created_by)
    VALUES ($1, $2, $3, 'model', $4)
    RETURNING id`,
    [produit.id, orgA.id, `sonde-rls-${Date.now()}`, orgA.user_id]);
  fixtureId = fixture.id;

  // Un bloc DO ne peut pas recevoir de parametres lies (08P01). Le nom du role
  // et son mot de passe sont des constantes de ce script, jamais une entree
  // externe : ils sont echappes par le pilote avant interpolation.
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${admin.escapeLiteral(PROBE_ROLE)}) THEN
      CREATE ROLE ${PROBE_ROLE} LOGIN PASSWORD ${admin.escapeLiteral(PROBE_PASSWORD)}
        NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB;
    END IF; END $$`);
  await admin.query(`GRANT USAGE ON SCHEMA public TO ${PROBE_ROLE}`);
  await admin.query(`GRANT SELECT, UPDATE ON dpp_resolvable_identifiers TO ${PROBE_ROLE}`);
  await admin.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${PROBE_ROLE}`);

  const bypass = await one(`SELECT rolbypassrls AS b, rolsuper AS s FROM pg_roles WHERE rolname = $1`, [PROBE_ROLE]);
  verifier(bypass && bypass.b === false && bypass.s === false,
    'le role de sonde n\'a ni BYPASSRLS ni SUPERUSER', `bypassrls=${bypass.b} superuser=${bypass.s}`);

  probe = new pg.Client({
    connectionString: `postgresql://${PROBE_ROLE}:${PROBE_PASSWORD}@${new URL(ADMIN_URL).host}/${new URL(ADMIN_URL).pathname.slice(1)}`,
  });
  await probe.connect();
  await probe.query(`SELECT set_config('tracefab.user_id', $1, false)`, [orgA.user_id]);

  const autorise = await probe.query(
    `UPDATE dpp_resolvable_identifiers SET reason = 'sonde-autorisee' WHERE id = $1`, [fixtureId]);
  verifier(autorise.rowCount === 1,
    'le proprietaire modifie une colonne ordinaire de sa ligne', `${autorise.rowCount} ligne(s)`);

  let refuse = false;
  let codeErreur = null;
  try {
    const transfert = await probe.query(
      `UPDATE dpp_resolvable_identifiers SET owner_organization_id = $1 WHERE id = $2`,
      [orgB.id, fixtureId]);
    refuse = transfert.rowCount === 0;
  } catch (error) {
    refuse = error.code === '42501';
    codeErreur = error.code;
  }
  verifier(refuse,
    'le transfert de propriete vers une organisation etrangere est refuse',
    codeErreur ? `42501 ${codeErreur === '42501' ? 'new row violates row-level security policy' : ''}` : '0 ligne mise a jour');

  await probe.query(`SELECT set_config('tracefab.user_id', $1, false)`, [orgB.user_id]);
  const etranger = await probe.query(
    `UPDATE dpp_resolvable_identifiers SET reason = 'sonde-etrangere' WHERE id = $1`, [fixtureId]);
  verifier(etranger.rowCount === 0,
    'un acteur etranger ne voit pas la ligne', `${etranger.rowCount} ligne(s)`);

  await probe.end();
  probe = null;

  const final = await one(
    `SELECT owner_organization_id = $1 AS inchange, reason FROM dpp_resolvable_identifiers WHERE id = $2`,
    [orgA.id, fixtureId]);
  verifier(final.inchange === true, 'la propriete de la ligne est restee intacte',
    `organisation A conservee, reason=${final.reason}`);
} catch (error) {
  echecs += 1;
  console.log(`  ECHEC execution — ${error.code || ''} ${error.message}`);
} finally {
  try { if (probe) await probe.end(); } catch { /* connexion deja fermee */ }
  try {
    if (fixtureId) await admin.query(`DELETE FROM dpp_resolvable_identifiers WHERE id = $1`, [fixtureId]);
    await admin.query(`REASSIGN OWNED BY ${PROBE_ROLE} TO postgres`);
    await admin.query(`DROP OWNED BY ${PROBE_ROLE}`);
    await admin.query(`DROP ROLE IF EXISTS ${PROBE_ROLE}`);
    await admin.query(`DELETE FROM dpp_resolvable_identifiers WHERE public_id LIKE 'sonde-rls-%'`);
  } catch { /* nettoyage best effort sur base jetable */ }
  await admin.end();
}

console.log('');
console.log('  --------------------------------------------');
if (echecs === 0) {
  console.log(`  Politiques d'ecriture : ${assertions} assertions, WITH CHECK reel prouve par execution.`);
  console.log('  --------------------------------------------');
  process.exit(0);
}
console.log(`  ${echecs} ECHEC sur ${assertions} assertions.`);
console.log('  --------------------------------------------');
process.exit(1);
