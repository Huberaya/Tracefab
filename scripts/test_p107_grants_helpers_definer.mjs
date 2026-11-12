#!/usr/bin/env node
/**
 * P10.7 — controle NEGATIF du droit d'execution entre fonctions SECURITY DEFINER.
 *
 * POURQUOI CETTE SUITE EXISTE
 *
 * Le 2026-11-12, l'etape 45 du job `base-de-donnees` (« Parcours fournisseur »)
 * a echoue en CI sur `expected SQL error invitation_email_mismatch`. Cause
 * reelle : `tracefab_accept_organization_invitation` est SECURITY DEFINER et
 * proprietaire `tracefab_migrator` ; elle appelle
 * `tracefab_current_user_email()`, proprietaire `tracefab_worker`, dont
 * `tracefab_migrator` n'avait pas EXECUTE. Le corps s'executant avec les
 * privileges du PROPRIETAIRE, l'appel tombait en
 *
 *     42501 permission denied for function tracefab_current_user_email
 *
 * au lieu du refus metier attendu.
 *
 * CE QUI EST MESURE, ET DANS QUEL ORDRE
 *
 *   1. l'etat livre : les deux fonctions appelantes rendent leur refus METIER
 *      (P0001) et non un 42501 de privilege ;
 *   2. le controle negatif : on REVOQUE le GRANT, on relance les deux appels,
 *      et on exige que le 42501 REAPPARAISSE. Sans cela, la suite mesurerait
 *      un `OK` qui ne doit rien au correctif ;
 *   3. restauration : on reaccorde, on revérifie le refus metier. La base est
 *      laissee exactement dans l'etat ou on l'a trouvee.
 *
 * L'etape 2 est celle qui distingue « la fonction marche » de « le GRANT est
 * necessaire ». Un correctif sans controle negatif ne prouve rien.
 *
 * Sorties : 0 vert · 1 echec · 2 non execute.
 */
import pg from 'pg';
import { randomUUID } from 'node:crypto';

const CHAINE = process.env.DATABASE_URL;
if (!CHAINE) {
  console.error('NON EXECUTE — DATABASE_URL absente.');
  process.exit(2);
}
const hote = new URL(CHAINE).hostname;
if (!['localhost', '127.0.0.1', '::1'].includes(hote)) {
  console.error(`NON EXECUTE — hote « ${hote} » refuse : cette suite accorde et revoque des privileges.`);
  process.exit(2);
}

let echecs = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const verif = (c, m, obs) => (c ? ok(m) : (echecs += 1, console.log(`  ECHEC ${m} — observe : ${obs}`)));

const admin = new pg.Client({ connectionString: CHAINE });
await admin.connect();

/* Le role qui subit la mesure : tracefab_app, celui du runtime. Il doit
 * exister ; sinon la suite ne peut rien affirmer et le dit. */
const app = await admin.query("SELECT 1 FROM pg_roles WHERE rolname = 'tracefab_app'");
if (!app.rowCount) {
  console.error('NON EXECUTE — role tracefab_app absent : lancer le bootstrap avant.');
  await admin.end();
  process.exit(2);
}

// Connexion applicative : l'URL applicative est fournie par la CI, ou deduite
// du mot de passe de bootstrap. Aucun repli silencieux sur le proprietaire.
const motDePasseApp = process.env.TF_APP_PASSWORD;
let connApp = null;
if (process.env.TF_RLS_APP_URL) connApp = process.env.TF_RLS_APP_URL;
else if (motDePasseApp) {
  const u = new URL(CHAINE);
  u.username = 'tracefab_app';
  u.password = motDePasseApp;
  connApp = u.toString();
}
if (!connApp) {
  console.error('NON EXECUTE — TF_RLS_APP_URL (ou TF_APP_PASSWORD) obligatoire : la mesure se fait sous le role applicatif.');
  await admin.end();
  process.exit(2);
}

/**
 * Appelle une fonction sous le role applicatif et rend {code, message}.
 * Aucune ecriture : les deux cibles echouent avant tout DML.
 */
async function appelSousRoleApp(sqlLiteral, parametres) {
  const c = new pg.Client({ connectionString: connApp });
  await c.connect();
  try {
    await c.query('BEGIN');
    // Le contexte est celui du parcours reel : sans `tracefab.user_id`, les
    // deux fonctions s'arretent sur `authentication_required` AVANT d'atteindre
    // le helper, et le controle negatif ne mesurerait rien. Identite posee dans
    // la transaction, donc annulee par le ROLLBACK du finally.
    await c.query("SELECT set_config('tracefab.user_id', $1, true)", [idUtilisateur]);
    await c.query("SELECT set_config('tracefab.user_email', $1, true)", [emailUtilisateur]);
    const r = await c.query(sqlLiteral, parametres);
    return { code: null, rows: r.rowCount };
  } catch (e) {
    return { code: e.code, message: String(e.message).split('\n')[0] };
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    await c.end();
  }
}

/* --- Le decor : un utilisateur qui EXISTE, et une invitation vivante --------
 *
 * Le controle negatif doit ATTEINDRE le helper. Or les deux fonctions
 * l'appellent apres des controles qui exigent un etat reel :
 *   - l'acceptation cherche d'abord une invitation non acceptee et non expiree
 *     (sinon `invalid_or_expired_invitation`, et le helper n'est jamais lu) ;
 *   - l'auto-onboarding insere une organisation dont `created_by` doit
 *     referencer un utilisateur existant (sinon 23503).
 * Les deux sont donc mis en place ici, puis retires a la fin.
 */
const MARQUEUR = 'p107-controle-negatif';
const idUtilisateur = randomUUID();
const emailUtilisateur = `${MARQUEUR}@example.test`;
const idOrganisation = randomUUID();
const empreinteInvitation = randomUUID().replace(/-/g, '').padEnd(64, '0').slice(0, 64);
// L'invitation vise un AUTRE email : c'est ce qui fait lever
// `invitation_email_mismatch` — le refus metier attendu — au lieu de laisser
// l'acceptation reussir et d'ecrire en base.
const emailInvite = `invite-${MARQUEUR}@example.test`;

async function nettoyerDecor() {
  // L'invitation porte une FK `invited_by` vers l'utilisateur : elle doit
  // partir AVANT lui, quel que soit l'identifiant du run precedent.
  await admin.query(
    `DELETE FROM public.organization_invitations
      WHERE invited_by IN (SELECT id FROM public.users WHERE clerk_user_id = $1)
         OR organization_id = $2`,
    [`clerk_${MARQUEUR}`, idOrganisation]).catch(() => {});
  await admin.query('DELETE FROM public.organization_memberships WHERE organization_id = $1', [idOrganisation]).catch(() => {});
  await admin.query('DELETE FROM public.organizations WHERE id = $1', [idOrganisation]).catch(() => {});
  await admin.query('DELETE FROM public.users WHERE id = $1', [idUtilisateur]).catch(() => {});
  await admin.query('DELETE FROM public.users WHERE clerk_user_id = $1', [`clerk_${MARQUEUR}`]).catch(() => {});
}

// Idempotence : un run interrompu a pu laisser le decor. On le retire avant de
// le reposer, sinon l'unicite de clerk_user_id fait echouer la MISE EN PLACE —
// et l'echec masquerait la mesure.
await nettoyerDecor();
await admin.query(
  'INSERT INTO public.users (id, clerk_user_id, email, full_name) VALUES ($1, $2, $3, $4)',
  [idUtilisateur, `clerk_${MARQUEUR}`, emailUtilisateur, 'Controle Negatif']);
await admin.query(
  `INSERT INTO public.organizations (id, type, legal_name, display_name, country_code, created_by)
   VALUES ($1, 'brand', $2, $2, 'FR', $3)`,
  [idOrganisation, MARQUEUR, idUtilisateur]);
await admin.query(
  `INSERT INTO public.organization_invitations
     (organization_id, email, target_role, token_hash, expires_at, invited_by)
   VALUES ($1, $2, 'viewer', $3, now() + interval '1 hour', $4)`,
  [idOrganisation, emailInvite, empreinteInvitation, idUtilisateur]);

const appelAcceptation = () => appelSousRoleApp(
  'SELECT * FROM public.tracefab_accept_organization_invitation($1)', [empreinteInvitation]);

// Signature exacte de l'auto-onboarding fournisseur (migration
// 20261006180000_supplier_self_onboarding) : legal_name, display_name,
// country_code, profile_summary, contact_name, contact_phone, activity_types.
const appelOnboarding = () => appelSousRoleApp(
  `SELECT * FROM public.tracefab_register_supplier_organization(
     'Controle Negatif', 'Controle Negatif', 'FR', NULL, NULL, NULL, '{}'::text[])`, []);

const MIGRATOR = 'tracefab_migrator';

/* ========================================================================== *
 *  1. Etat livre : refus metier, jamais 42501
 * ========================================================================== */
console.log('\n  1. etat livre — refus metier (P0001), pas de refus de privilege');

const a1 = await appelAcceptation();
verif(a1.code !== '42501', 'acceptation d invitation : pas de 42501', `${a1.code} ${a1.message || ''}`);
verif(a1.code === 'P0001', 'acceptation d invitation : refus metier P0001', `${a1.code} ${a1.message || ''}`);

// L'auto-onboarding, lui, n'a pas de refus metier a opposer a un utilisateur
// valide : il aboutit. Ce qui compte est qu'il ATTEIGNE son corps et rende la
// main — jamais un 42501. L'insertion est annulee par le ROLLBACK de
// `appelSousRoleApp` : aucune donnee ne reste.
const o1 = await appelOnboarding();
verif(o1.code !== '42501',
  'auto-onboarding fournisseur : pas de 42501 (le helper est atteint)',
  `${o1.code} ${o1.message || ''}`);

/* ========================================================================== *
 *  2. Controle NEGATIF : sans le GRANT, le 42501 doit revenir
 * ========================================================================== */
console.log('\n  2. controle negatif — le GRANT retire doit faire revenir le 42501');

await admin.query(`REVOKE EXECUTE ON FUNCTION public.tracefab_current_user_email() FROM ${MIGRATOR}`);

const a2 = await appelAcceptation();
verif(a2.code === '42501', 'acceptation d invitation : 42501 reproduit sans le GRANT', `${a2.code} ${a2.message || ''}`);

const o2 = await appelOnboarding();
verif(o2.code === '42501', 'auto-onboarding fournisseur : 42501 reproduit sans le GRANT', `${o2.code} ${o2.message || ''}`);

/* ========================================================================== *
 *  3. Restauration de l'etat livre
 * ========================================================================== */
console.log('\n  3. restauration du GRANT et retour au refus metier');

await admin.query(`GRANT EXECUTE ON FUNCTION public.tracefab_current_user_email() TO ${MIGRATOR}`);

const a3 = await appelAcceptation();
verif(a3.code === 'P0001', 'acceptation d invitation : refus metier retabli', `${a3.code} ${a3.message || ''}`);
const o3 = await appelOnboarding();
verif(o3.code !== '42501', 'auto-onboarding fournisseur : 42501 toujours absent', `${o3.code} ${o3.message || ''}`);

const publicExec = await admin.query(`
  SELECT count(*)::int n
    FROM pg_proc p,
         pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
   WHERE p.proname = 'tracefab_current_user_email'
     AND p.pronamespace = 'public'::regnamespace
     AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'`);
verif(Number(publicExec.rows[0].n) === 0, 'PUBLIC reste sans EXECUTE sur le helper', `entreess=${publicExec.rows[0].n}`);

// `has_function_privilege(role, regprocedure, text)` : la 3e forme exige un
// regprocedure, pas une chaine. `to_regprocedure` la convertit sans lever.
const migratorExec = await admin.query(
  "SELECT has_function_privilege($1, to_regprocedure('public.tracefab_current_user_email()'), 'EXECUTE') AS n",
  [MIGRATOR]);
verif(migratorExec.rows[0].n === true, `${MIGRATOR} detient EXECUTE sur le helper`, String(migratorExec.rows[0].n));

await nettoyerDecor();
await admin.end();

console.log(echecs ? `\n${echecs} echec(s) — le droit d'execution entre fonctions definer n'est pas etabli.`
                   : '\nControle negatif complet : etat livre sans 42501, 42501 reproduit sans le GRANT, etat retabli.');
process.exit(echecs ? 1 : 0);
