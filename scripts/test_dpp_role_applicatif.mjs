#!/usr/bin/env node
/**
 * LE PARCOURS DPP FONCTIONNE-T-IL AVEC LE ROLE APPLICATIF REEL, SOUS RLS ?
 *
 * POURQUOI CE SCRIPT EXISTE
 *
 * Toutes les autres suites de ce depot se connectent en proprietaire de la
 * base : elles prouvent que les fonctions se comportent bien, pas que
 * l'application y accede. Or `tracefab_app` ne porte ni BYPASSRLS ni privilege
 * d'ecriture directe sur les tables DPP. Une suite verte en superutilisateur
 * ne dit donc rien du chemin reel — c'est exactement le genre d'ecart qui ne
 * se voit qu'en production.
 *
 * CE QU'IL FAIT, ET AVEC QUELS DROITS
 *   Il ouvre une connexion avec `TF_RLS_APP_URL` (role applicatif seulement) et
 *   rejoue une sequence courte sur un dossier existant :
 *     1. SELECT sur `dpp_records` avec le locataire actif arme : ne voit que
 *        son organisation ;
 *     2. SELECT avec un autre locataire arme : ne voit rien de celui-ci ;
 *     3. ecriture directe (UPDATE dpp_records) : doit etre REFUSEE ;
 *     4. recalcul par la fonction : doit aboutir malgre l'absence d'ecriture
 *        directe (SECURITY DEFINER) ;
 *     5. visibilite publique : `tracefab_product_is_public` repond ;
 *     6. revue puis publication : doivent aboutir dans les memes conditions.
 *
 * CE QU'IL NE FAIT PAS
 *   Il ne cree ni organisation, ni produit : le role applicatif n'en a pas le
 *   droit, et fabriquer une fixture en superutilisateur pour la relire ensuite
 *   ne prouverait rien de plus que les autres suites. Il travaille sur un
 *   dossier DEJA present, designe par l'operateur.
 *
 * AUCUNE TRACE
 *   Les appels qui ecrivent (recalcul, revue) sont faits DANS une transaction
 *   toujours annulee. Le script verifie ensuite que le statut, la revue et le
 *   slug du dossier sont identiques a l'instant d'avant : un banc d'essai qui
 *   laisse une trace n'est pas un banc d'essai. C'est un recalcul SIMULE, pas
 *   le recalcul reel du parc, qui reste interdit sans approbation.
 *
 * LES GUC D'AUTHENTIFICATION
 *   `tracefab.user_id` et `tracefab.active_organization_id` sont normalement
 *   armes par l'API apres verification du jeton Clerk. Ce script les arme
 *   lui-meme : c'est un banc d'essai, pas un contournement de production. Il
 *   ne s'execute que sur une cible de test nommee, et refuse la production.
 *
 * CE QUE L'OPERATEUR DOIT FOURNIR, ET POURQUOI
 *   Le role applicatif ne peut pas DECOUVRIR de quoi il s'agit : `users` ne lui
 *   est pas lisible, `organization_memberships` non plus, et la RLS masque tout
 *   sans locataire arme. C'est le comportement voulu. Le banc d'essai recoit
 *   donc l'identite comme le ferait l'API apres verification du jeton :
 *
 *   USAGE
 *     TF_RLS_APP_URL=postgresql://tracefab_app:...@hote/neondb \
 *     TF_PRODUIT_TEST=<uuid produit> \
 *     TF_ORG_TEST=<uuid organisation marque> \
 *     TF_ACTEUR_TEST=<uuid utilisateur membre autorise> \
 *     [TF_AUTRE_ACTEUR_TEST=<uuid utilisateur NON membre>] \
 *       node scripts/test_dpp_role_applicatif.mjs
 *
 * CODES : 0 tout passe ; 1 au moins un controle echoue ; 2 usage ou non
 * applicable ; 3 cible refusee.
 */
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';
import { exigerCibleEcriture } from './lib/garde_cible_ecriture.mjs';

// GARDE DE CIBLE — remplace la liste noire d'hotes.
//
// Avant : un seul nom de production, ecrit en dur et surchargeable par
// `TF_HOTE_PRODUCTION`. Tout ce qui n'etait pas ce nom etait accepte, y compris
// une autre base Neon, une base locale qui n'est pas de test, ou une chaine
// portant `?host=`. Ce script ECRIT (`UPDATE` par le role applicatif) : la
// regle appliquee est desormais celle du reste du depot, REFUS PAR DEFAUT
// (`scripts/lib/require-throwaway-db.mjs`), plus la concordance entre
// `TF_RLS_APP_URL` et `DATABASE_URL` si les deux sont fournies, plus l'identite
// de cluster exigible par `TF_SYSID_ATTENDU`.
//
// Codes : 2 non execute (variable absente) ; 3 cible refusee — aucune ecriture.
const garde = await exigerCibleEcriture({
  variables: ['TF_RLS_APP_URL', 'DATABASE_URL'],
  requise: 'TF_RLS_APP_URL',
  purpose: 'test_dpp_role_applicatif — ecriture par le role applicatif',
});
const url = garde.url;
const hote = garde.verdict.database || '(base classee)';

const argProduit = process.argv.indexOf('--produit');
const produitImpose = argProduit > -1 ? process.argv[argProduit + 1] : process.env.TF_PRODUIT_TEST || null;

let echecs = 0;
const check = (libelle, condition, detail = '') => {
  if (condition) { console.log(`  ok    ${libelle}`); return; }
  echecs += 1; console.error(`  ECHEC ${libelle}${detail ? ` — ${detail}` : ''}`);
};

const client = new pg.Client({ connectionString: url, ssl: sslDepuisUrl(url), application_name: 'tracefab-banc-app' });
await client.connect();

console.log(`\nRole applicatif sous RLS — cible ${hote}\n${'-'.repeat(48)}`);
const { rows: [moi] } = await client.query(`
  SELECT current_user AS role,
         (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser,
         (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypassrls`);
console.log(`  role ${moi.role} · superutilisateur ${moi.superuser ? 'OUI' : 'non'} · BYPASSRLS ${moi.bypassrls ? 'OUI' : 'non'}`);
check('la connexion emploie bien le role applicatif', moi.role === 'tracefab_app', moi.role);
check('le role ne contourne pas la RLS', !moi.superuser && !moi.bypassrls);

const produit = process.env.TF_PRODUIT_TEST;
const org = process.env.TF_ORG_TEST;
const acteur = process.env.TF_ACTEUR_TEST;
if (!produit || !org || !acteur) {
  console.error('NON EXECUTE — TF_PRODUIT_TEST, TF_ORG_TEST et TF_ACTEUR_TEST sont obligatoires.');
  console.error('  Le role applicatif ne peut pas les decouvrir : c\'est la RLS qui le veut.');
  await client.end();
  process.exit(2);
}

// Le dossier doit exister pour cette organisation. On ne le devine pas : on le
// demande, puis on verifie que la RLS le rend visible avec le bon locataire.
await client.query("SELECT set_config('tracefab.user_id', $1, false)", [acteur]);
await client.query("SELECT set_config('tracefab.active_organization_id', $1, false)", [org]);
const { rows: [dossier] } = await client.query(`
  SELECT d.id AS dpp_id, d.product_id, d.readiness_status,
         (SELECT p.brand_organization_id FROM tracefab_products p WHERE p.id = d.product_id) AS org
    FROM dpp_records d
   WHERE d.product_id = $1
   ORDER BY d.computed_at DESC LIMIT 1`, [produit]);
const cible = dossier ? { ...dossier, acteur, org } : null;
if (!cible) {
  console.error(`  NON APPLICABLE — aucun dossier pour le produit ${produit} visible dans ce locataire.`);
  await client.end();
  process.exit(2);
}
if (cible.org && cible.org !== org) {
  console.error('  REFUS — le produit appartient a une autre organisation que celle declaree.');
  await client.end();
  process.exit(3);
}
console.log(`  dossier eprouve : ${cible.product_id} (${cible.readiness_status})`);

const armer = async (organisation) => {
  await client.query("SELECT set_config('tracefab.user_id', $1, false)", [acteur]);
  await client.query("SELECT set_config('tracefab.active_organization_id', $1, false)", [organisation]);
};

// 1. Locataire actif = celui du dossier : il voit.
await armer(org);
const { rows: [vu] } = await client.query(
  'SELECT count(*)::int AS n FROM dpp_records WHERE product_id = $1', [cible.product_id]);
check('avec le locataire actif, le dossier est visible', vu.n === 1, String(vu.n));

// 2. Isolation : un utilisateur qui n'est PAS membre de l'organisation du
//    dossier ne doit rien en voir.
//
//    Piege corrige ici : armer un AUTRE locataire ne suffit pas. Les politiques
//    de lecture s'appuient sur `tracefab_is_org_member(...)`, pas sur le
//    locataire actif — un membre legitime continue de voir toutes ses
//    organisations, et c'est le comportement voulu. Le controle n'a de sens
//    qu'avec un AUTRE UTILISATEUR, non membre.
const autreActeur = process.env.TF_AUTRE_ACTEUR_TEST || null;
if (autreActeur && autreActeur !== acteur) {
  await client.query("SELECT set_config('tracefab.user_id', $1, false)", [autreActeur]);
  const { rows: [cache] } = await client.query(
    'SELECT count(*)::int AS n FROM dpp_records WHERE product_id = $1', [produit]);
  check('un utilisateur non membre ne voit pas le dossier', cache.n === 0, String(cache.n));
  const { rows: [prod] } = await client.query(
    'SELECT count(*)::int AS n FROM tracefab_products WHERE id = $1', [produit]);
  check('il ne voit pas non plus le produit', prod.n === 0, String(prod.n));
} else {
  console.log('  (controle d\'isolation non joue : TF_AUTRE_ACTEUR_TEST non fourni ou identique)');
}

// 3. Ecriture directe : refusee par privilege, pas par convention.
await armer(cible.org);
let refus = null;
try {
  await client.query('BEGIN');
  await client.query("UPDATE dpp_records SET readiness_status = readiness_status WHERE id = $1", [cible.dpp_id]);
  await client.query('ROLLBACK');
} catch (e) {
  refus = e.message;
  await client.query('ROLLBACK').catch(() => {});
}
check('l\'ecriture directe sur dpp_records est refusee au role applicatif', refus !== null,
  'ecriture acceptee : le role a des droits qu\'il ne devrait pas avoir');

// Etat de reference pris AVANT toute ecriture, pour prouver l'absence de trace.
const etatDossier = async () => {
  const { rows: [r] } = await client.query(
    `SELECT readiness_status, reviewed_at, review_invalidation_reason,
            (SELECT public_slug FROM tracefab_products WHERE id = $1) AS slug
       FROM dpp_records WHERE product_id = $1 ORDER BY computed_at DESC LIMIT 1`, [produit]);
  return r;
};
await armer(org);
const avantEcritures = await etatDossier();

// 4. Recalcul par la fonction : aboutit malgre l'absence d'ecriture directe.
//    DANS une transaction qui sera annulee : aucune trace.
await client.query('BEGIN');
let recalcul = null;
try {
  const { rows: [r] } = await client.query(
    "SELECT * FROM tracefab_compute_dpp_readiness($1,'textile_readiness_mvp','1.0')", [cible.product_id]);
  recalcul = r;
} catch (e) { recalcul = { erreur: e.message }; }
check('le recalcul aboutit pour le role applicatif', Boolean(recalcul && !recalcul.erreur),
  String(recalcul && recalcul.erreur));
if (recalcul && !recalcul.erreur) {
  console.log(`        statut ${recalcul.readiness_status} · revue ${recalcul.reviewed_at ? 'presente' : 'aucune'}`);
}

// 5. Visibilite publique : la fonction repond sans privilege special.
let public_ = null;
try {
  const { rows: [r] } = await client.query('SELECT tracefab_product_is_public($1) AS v', [cible.product_id]);
  public_ = r.v;
} catch (e) { public_ = `erreur : ${e.message}`; }
check('la visibilite publique est interrogeable', typeof public_ === 'boolean', String(public_));
if (typeof public_ === 'boolean') console.log(`        visible publiquement : ${public_}`);

// 6. Revue puis publication : memes conditions.
//    Une revue n'est possible que si le dossier est pret ; on ne force rien :
//    si l'etat ne le permet pas, le refus est le comportement attendu.
let etapeRevue;
try {
  await client.query('SELECT tracefab_mark_dpp_ready_to_publish($1)', [cible.dpp_id]);
  etapeRevue = 'acceptee';
} catch (e) { etapeRevue = e.message; }
const revueAttendue = recalcul && !recalcul.erreur
  && ['data_ready', 'ready_to_publish', 'published'].includes(recalcul.readiness_status);
if (revueAttendue) {
  check('la revue aboutit pour le role applicatif', etapeRevue === 'acceptee', etapeRevue);
} else {
  check('la revue est refusee quand le dossier n\'est pas pret', etapeRevue !== 'acceptee', etapeRevue);
  console.log(`        refus obtenu : ${etapeRevue}`);
}

// 7. Aucune trace : tout ce qui precede est annule.
await client.query('ROLLBACK');
const apresEcritures = await etatDossier();
const inchange = JSON.stringify(avantEcritures) === JSON.stringify(apresEcritures);
check('les appels simules n\'ont laisse aucune trace',
  inchange, `avant ${JSON.stringify(avantEcritures)} / apres ${JSON.stringify(apresEcritures)}`);

console.log('');
if (echecs) {
  console.error(`Role applicatif : ${echecs} controle(s) en echec.`);
  await client.end();
  process.exit(1);
}
console.log('Role applicatif : OK — lecture bornee par le locataire, ecriture directe refusee, fonctions accessibles.');
await client.end();
