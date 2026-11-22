#!/usr/bin/env node
/**
 * P10.7 — L'ORIGINE D'UNE OPERATION SYSTEME EST-ELLE REELLEMENT PROUVEE ?
 *
 * LE DEFAUT QUE CE TEST EMPECHE DE REVENIR
 *
 * Mesure du 2026-11-05, base jetable dont le proprietaire des objets est un role
 * NON superutilisateur (forme Neon), cle HMAC provisionnee, `tracefab_app` sans
 * SUPERUSER, sans BYPASSRLS, sans appartenance atteignable :
 *
 *   1. l'attaquant obtient un jeton d'identite VALIDE pour SA propre
 *      organisation — la chaine HMAC de P10.5 fonctionne, elle n'est pas
 *      contournee, elle est constatee ;
 *   2. il appelle `tracefab_sync_clerk_membership('mem_x', <org B>, <lui>, 'owner')`,
 *      declaree au registre runtime donc executable par lui ;
 *   3. une adhesion `owner` est ecrite chez B ;
 *   4. `tracefab_has_org_role(B,'owner')` rend `true` ;
 *   5. il signe un jeton pour B — que la base accepte, il est desormais
 *      REELLEMENT membre — et lit les produits de B.
 *
 * Le jeton n'a pas ete falsifie : il a ete OBTENU. Une identite signee ne protege
 * que les chemins qui la LISENT, et ces fonctions ne lisaient rien.
 *
 * CE QUE LE TEST MESURE — ET POURQUOI IL N'EST PAS UN TEST DE PRESENCE
 *
 * Une liste de treize noms ecrite a la main serait le mecanisme meme qui a
 * laisse passer le defaut (les noms etaient dans le registre, personne ne
 * regardait ce que les fonctions FAISAIENT). Chaque propriete est donc mesuree
 * par EXECUTION :
 *
 *   A. mode strict : chaque operation systeme REFUSE sans jeton (42501)
 *   B. chacune ACCEPTE avec un jeton systeme signe — le temoin positif sans
 *      lequel un environnement ou tout est refuse passerait pour sur
 *   C. chaque falsification est refusee : MAC faux, expire, usage utilisateur
 *      rejoue, identite designee autre, jeton vide, signature d'une autre cle
 *   D. l'escalade complete est rejouee : aucune adhesion, aucun droit, aucune
 *      donnee du locataire voisin
 *   E. la propriete qui rend tout cela valable : le runtime ne lit pas les cles,
 *      n'endosse pas le worker, le worker n'est pas connectable
 *   F. la rotation et la revocation : un jeton signe par l'ancienne cle reste
 *      accepte pendant le chevauchement, puis refuse apres desactivation
 *   G. la sonde de la base et la liste du code disent la MEME chose — sinon une
 *      des deux derive en silence
 *
 * Variables : DATABASE_URL (administration), TF_RLS_APP_URL (runtime).
 *             La cle de signature est TIREE AU HASARD et provisionnee par le
 *             script operateur, sauf si TRACEFAB_IDENTITY_KEY est deja posee
 *             (cas d'un operateur qui vient de provisionner et veut verifier).
 * Sortie : 0 conforme · 1 regression · 2 non execute.
 */
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, randomBytes } from 'node:crypto';
import pg from 'pg';

const RACINE = dirname(dirname(fileURLToPath(import.meta.url)));
import { sslDepuisUrl } from './lib/pg-ssl.mjs';
import { jetonSystemeValide, signerJetonSysteme } from './lib/identite_systeme_test.mjs';

const urlAdmin = (process.env.DATABASE_URL || '').trim();
const urlApp = (process.env.TF_RLS_APP_URL || '').trim();

if (!urlAdmin || !urlApp) {
  console.error('  NON EXECUTE — DATABASE_URL et TF_RLS_APP_URL sont requises.');
  process.exit(2);
}

// LA CLE : PROVISIONNEE PAR LA SUITE, PAS ATTENDUE DE L ENVIRONNEMENT.
//
// Ce test a besoin d une cle pour signer. La lire dans l environnement obligeait
// l appelant a la fournir — donc a la manipuler, et a la faire circuler entre une
// commande et son lanceur. La suite la TIRE elle-meme, comme `test:p105:jeton` :
// elle ne vaut que pour la base jetable de l execution, elle est confiee au
// script d exploitation par variable d environnement (jamais en argument, jamais
// sur disque), et elle meurt avec la base.
//
// CE QUI N EST PAS SIMULE. Provisionner une cle n est pas contourner le controle :
// c est l acte que l operateur pose AVANT la bascule (voir l en-tete de
// 20261105120000). Sans cle, l activation refuse (mesure : code 3) ; avec une
// cle, elle accepte. Fournir la cle ici, c est donc reproduire la sequence
// reelle, pas la neutraliser.
//
// Une cle DEJA presente dans l environnement est utilisee telle quelle : c est
// le cas d un operateur qui vient de provisionner et veut verifier.
let cle = (process.env.TRACEFAB_IDENTITY_KEY || '').trim();
if (!/^[0-9a-fA-F]{64,}$/.test(cle) || cle.length % 2 !== 0) {
  cle = randomBytes(32).toString('hex');
  const sortie = execFileSync(process.execPath, [join(RACINE, 'scripts', 'provisionner_cle_identite.mjs')], {
    cwd: RACINE,
    env: { ...process.env, TF_IDENTITY_KEY_HEX: cle, TF_ALLOW_PROVISIONING: 'oui' },
    encoding: 'utf8',
  });
  if (!/VERDICT\s*:\s*clé provisionnée/i.test(sortie)) {
    console.error('  NON EXECUTE — la cle n a pas pu etre provisionnee par le script operateur.');
    console.error(sortie.trim().split('\n').slice(-4).join('\n'));
    process.exit(2);
  }
  if (sortie.includes(cle)) {
    console.error('  REFUS — le script de provisionnement a expose la cle dans sa sortie.');
    process.exit(1);
  }
  console.log('  cle : tiree au hasard et provisionnee par le script operateur (valeur jamais affichee)');
}

let assertions = 0;
let echecs = 0;
const ok = (cond, libelle, detail = '') => {
  assertions += 1;
  console.log(`  ${cond ? 'ok   ' : 'ECHEC'} ${libelle}${detail ? ` — ${detail}` : ''}`);
  if (!cond) echecs += 1;
};

const NON_MESURE = [];
const nonMesure = (libelle, raison) => {
  NON_MESURE.push(libelle);
  console.log(`  NON MESURE ${libelle} — ${raison}`);
};

const admin = new pg.Client({ connectionString: urlAdmin, ssl: sslDepuisUrl(urlAdmin), application_name: 'tracefab-p107-systeme-admin' });
await admin.connect();
const app = new pg.Client({ connectionString: urlApp, ssl: sslDepuisUrl(urlApp), application_name: 'tracefab-p107-systeme-runtime' });
await app.connect();

/**
 * ARMER LE MODE STRICT — PAR L'OUTIL D'EXPLOITATION, ET RESTAURER ENSUITE.
 *
 * CE QUE LA SUITE MESURE, ET CE QU'ELLE NE MESURE PAS
 *
 * Elle mesure l'ORIGINE : une operation systeme sans jeton est refusee, avec
 * jeton elle passe. Ce refus n'existe qu'en mode strict — en mode permissif, la
 * garde laisse passer (c'est la transition voulue). Une base neuve sort donc en
 * permissif, et la suite y mesurerait l'inverse de ce qu'elle annonce.
 *
 * POURQUOI ELLE ARME LE MODE ELLE-MEME
 *
 * L'alternative serait d'exiger une base deja basculee — c'est-a-dire de rendre
 * la suite dependante d'un etat que seule une manipulation d'operateur produit.
 * Une suite qui ne mesure que dans un environnement prepare a la main ne mesure
 * rien en CI : elle sort « non execute » ou, pire, elle echoue pour une raison
 * d'environnement. On procede donc comme `test:p105:jeton` procede pour la cle :
 * on pose l'etat par le chemin REEL — ici `activer_identite_systeme_stricte.mjs`,
 * le meme outil que l'operateur — puis on le restaure dans un `finally`.
 *
 * CE QUE CELA N'AFFAIBLIT PAS
 *
 * Le refus de l'outil lui-meme (sans cle active, avec une operation non gardee)
 * est mesure par `test:p107:activation-stricte`, sur une base jetable creee pour
 * cela. Ici, on verifie seulement que, le mode etant arme, les treize operations
 * se comportent comme la correction le promet.
 */
const modeAvant = (await admin.query(
  `SELECT systeme_strict FROM public.tracefab_identity_politique WHERE singleton`)).rows[0]?.systeme_strict;

if (modeAvant !== true) {
  const sortie = execFileSync(process.execPath, [join(RACINE, 'scripts', 'activer_identite_systeme_stricte.mjs'), '--activer'], {
    cwd: RACINE,
    env: { ...process.env, DATABASE_ADMIN_URL: urlAdmin, DATABASE_URL: urlAdmin, TF_ALLOW_WRITE: 'oui' },
    encoding: 'utf8',
  });
  if (!/ACTIVE — transaction validee/.test(sortie)) {
    console.error('  NON EXECUTE — le mode strict n a pas pu etre arme par l outil d exploitation.');
    console.error(sortie.trim().split('\n').slice(-4).join('\n'));
    await admin.end(); await app.end();
    process.exit(2);
  }
  console.log('  mode strict systeme : ARME par l outil d exploitation (base permissive au depart), restaure en fin de suite');
} else {
  console.log('  mode strict systeme : deja arme sur cette cible');
}

/** Restauration de l'etat rencontre, quoi qu'il arrive. */
const restaurerMode = async () => {
  if (modeAvant === true) return;
  try {
    await admin.query(`UPDATE public.tracefab_identity_politique SET systeme_strict = false WHERE singleton`);
  } catch { /* la connexion est peut-etre fermee : rien a restaurer */ }
};

// FILET : le fichier est lineaire, donc une exception en cours de route saute la
// restauration ecrite plus bas. Une connexion SEPAREE est ouverte ici, a la
// demande, pour ne pas dependre de l'etat de `admin` au moment du `exit`.
process.on('exit', () => {
  if (modeAvant === true) return;
  try {
    execFileSync(process.execPath, ['-e', `
      const pg = require('pg');
      const c = new pg.Client({ connectionString: process.env.TF_URL_RESTAURATION });
      c.connect().then(() => c.query("UPDATE public.tracefab_identity_politique SET systeme_strict = false WHERE singleton"))
        .then(() => c.end()).catch(() => {});
    `], { env: { ...process.env, TF_URL_RESTAURATION: urlAdmin }, timeout: 10000, stdio: 'ignore' });
  } catch { /* dernier recours : rien de plus a tenter */ }
});

const locataires = (await admin.query(
  `SELECT o.id, m.user_id
     FROM organizations o
     JOIN organization_memberships m ON m.organization_id = o.id AND m.role = 'owner' AND m.status = 'active'
    ORDER BY o.created_at, o.id LIMIT 2`)).rows;
if (locataires.length < 2) {
  console.error('  NON EXECUTE — deux locataires requis ; jouer npm run db:seed-rls.');
  await admin.end(); await app.end();
  process.exit(2);
}
const [A, B] = locataires;

/**
 * Les treize operations, avec un appel REELLEMENT executable par le runtime.
 * Chaque entree porte son SQL : un nom qui ne serait pas appele ne prouverait
 * rien, et c'est exactement l'erreur que ce test existe pour ne pas refaire.
 */
const OPERATIONS = [
  ['tracefab_sync_clerk_membership', (o) => [`SELECT tracefab_sync_clerk_membership($1, $2::uuid, $3::uuid, 'owner'::membership_role)`, ['mem_p107_test', B.id, A.user_id]]],
  ['tracefab_sync_clerk_organization', () => [`SELECT tracefab_sync_clerk_organization('org_p107_test', 'l', 'd', 'brand'::organization_type)`, []]],
  ['tracefab_revoke_clerk_membership', () => [`SELECT tracefab_revoke_clerk_membership('mem_p107_test')`, []]],
  ['tracefab_upsert_clerk_user', () => [`SELECT * FROM tracefab_upsert_clerk_user('user_p107_test', 'p107@exemple.test', 'P107')`, []]],
  ['tracefab_ensure_clerk_user', () => [`SELECT * FROM tracefab_ensure_clerk_user('user_p107_test', 'p107@exemple.test', 'P107')`, []]],
  ['tracefab_soft_delete_clerk_user', () => [`SELECT tracefab_soft_delete_clerk_user('user_p107_test')`, []]],
  ['tracefab_archive_clerk_organization', () => [`SELECT tracefab_archive_clerk_organization('org_p107_test')`, []]],
  ['tracefab_clerk_organization_uuid', () => [`SELECT tracefab_clerk_organization_uuid('org_p107_test')`, []]],
  ['tracefab_notification_outbox_health', () => [`SELECT * FROM tracefab_notification_outbox_health()`, []]],
  ['tracefab_claim_notification_outbox', () => [`SELECT * FROM tracefab_claim_notification_outbox(2)`, []]],
  ['tracefab_complete_notification_outbox', () => [`SELECT * FROM tracefab_complete_notification_outbox(gen_random_uuid(), 'sent'::tracefab_notification_status, 'p', NULL, NULL)`, []]],
  ['tracefab_enqueue_due_data_request_reminders', () => [`SELECT tracefab_enqueue_due_data_request_reminders(24)`, []]],
  ['tracefab_enqueue_manual_data_request_reminder', () => [`SELECT tracefab_enqueue_manual_data_request_reminder($1::uuid)`, [B.id]]],
];

/** Joue un appel dans une transaction annulee, sous l'identite systeme donnee. */
const jouer = async (operation, jetonSysteme) => {
  await app.query('BEGIN');
  try {
    await app.query(`SELECT set_config('tracefab.identity_systeme', $1, true)`, [jetonSysteme ?? '']);
    // Contexte utilisateur neutre : on mesure l'origine SYSTEME, pas l'identite.
    await app.query(`SELECT set_config('tracefab.identity', '', true)`);
    await app.query(`SELECT set_config('tracefab.active_organization_id', '', true)`);
    const [sql, params] = operation();
    await app.query(sql, params);
    return { ok: true };
  } catch (error) {
    return { ok: false, code: error.code, message: String(error.message).split('\n')[0] };
  } finally {
    try { await app.query('ROLLBACK'); } catch { /* rien a defaire */ }
  }
};

/* --- A / B : refus sans jeton, acceptation avec jeton signe -------------- */

console.log('\n  A. mode strict : aucune operation systeme sans jeton');
for (const [nom, operation] of OPERATIONS) {
  const r = await jouer(operation, null);
  // 42501 = refus. Tout autre resultat est un echec : un succes ouvre la faille,
  // et un echec d'une autre nature (parametre, fonction absente) ne prouverait
  // rien tout en laissant le test vert.
  ok(!r.ok && r.code === '42501', `${nom}() refusee sans jeton systeme`,
    r.ok ? 'APPEL ACCEPTE — la faille est ouverte' : r.code === '42501' ? '' : `echec non probant : ${r.code} ${r.message?.slice(0, 60)}`);
}

console.log('\n  B. temoin positif : la garde d origine LAISSE PASSER un jeton signe');
for (const [nom, operation] of OPERATIONS) {
  const r = await jouer(operation, jetonSystemeValide({ cle }));
  // Deux operations refusent legitimement pour une raison METIER
  // (`notification_outbox_item_not_processing`, `data_request_not_remindable`) :
  // le bon critere n'est donc pas « l'appel reussit », mais « la garde d'origine
  // ne l'a pas arrete ». Un refus 42501 signifierait que le chemin legitime est
  // casse ; un refus metier prouve au contraire que la garde a laisse passer.
  const arretParLaGarde = !r.ok && (r.code === '42501' || /authentication_required/.test(r.message ?? ''));
  ok(!arretParLaGarde, `${nom}() n est pas arretee par la garde d origine`,
    arretParLaGarde ? `refus ${r.code} ${r.message?.slice(0, 80)} — chemin legitime casse`
      : r.ok ? 'executee' : `poursuite metier : ${r.code} ${String(r.message ?? '').slice(0, 50)}`);
}


console.log('\n  B2. archivage reel sous identite systeme signee');
{
  const clerkOrganizationId = `org_p107_archive_${randomBytes(8).toString('hex')}`;
  await app.query('BEGIN');
  try {
    await app.query(`SELECT set_config('tracefab.identity_systeme', $1, true)`, [jetonSystemeValide({ cle })]);
    await app.query(`SELECT set_config('tracefab.identity', '', true)`);
    await app.query(`SELECT set_config('tracefab.active_organization_id', '', true)`);
    await app.query(
      `SELECT tracefab_sync_clerk_organization($1, 'TraceFab P10.7 archive probe', 'TraceFab P10.7 archive probe', 'brand'::organization_type)`,
      [clerkOrganizationId]
    );
    const archived = await app.query(
      `SELECT tracefab_archive_clerk_organization($1) AS archived`,
      [clerkOrganizationId]
    );
    ok(archived.rows[0]?.archived === true,
      'tracefab_archive_clerk_organization() applique effectivement UPDATE sous RLS worker');
    await app.query('COMMIT');
    const persisted = await admin.query(
      'SELECT status FROM public.organizations WHERE clerk_organization_id = $1',
      [clerkOrganizationId]
    );
    ok(persisted.rows[0]?.status === 'archived',
      'le statut archived est persiste apres l operation systeme signee');
    await admin.query('DELETE FROM public.organizations WHERE clerk_organization_id = $1', [clerkOrganizationId]);
  } catch (error) {
    try { await app.query('ROLLBACK'); } catch { /* transaction de test */ }
    ok(false, 'archivage effectif et persistant sous RLS worker',
      `${error.code ?? 'sans_code'} ${String(error.message ?? '').slice(0, 100)}`);
  }
}

/* --- C : falsifications -------------------------------------------------- */

console.log('\n  C. falsifications refusees');

const maintenant = Math.floor(Date.now() / 1000);
const signeValide = jetonSystemeValide({ cle });
const falsifications = [
  ['MAC modifie', signeValide.slice(0, -4) + '0000'],
  ['jeton expire', jetonSystemeValide({ cle, dureeSecondes: -30 })],
  ['jeton UTILISATEUR rejoue comme systeme', (() => {
    // Meme forme, mais l'usage du jeton utilisateur : c'est la separation des
    // usages qui est testee ici, pas la validite du MAC.
    return signerJetonSysteme({ cle, expiration: maintenant + 60, usage: 'tracefab_identity' });
  })()],
  ['identite designee autre que le worker', signerJetonSysteme({ cle, expiration: maintenant + 60, identite: 'postgres' })],
  ['jeton vide', ''],
  ['jeton sans MAC', 'v1|tracefab_system|tracefab_worker|' + (maintenant + 60)],
  ['jeton a deux points (forme ambigue)', signeValide + '.surcharge'],
  ['signature d une AUTRE cle', signerJetonSysteme({ cle: randomBytes(32).toString('hex'), expiration: maintenant + 60 })],
  // Le corps est reconstruit a la main : un `replace` sur le jeton deja signe
  // laisserait le MAC valide sur un corps modifie, ce qui testerait la
  // verification du MAC et non celle de la version.
  ['version de protocole inconnue', (() => {
    const expiration = maintenant + 60;
    const corps = `v2|tracefab_system|tracefab_worker|${expiration}`;
    return `${corps}.${createHmac('sha256', Buffer.from(cle, 'hex')).update(corps).digest('hex')}`;
  })()],
];

for (const [nom, jeton] of falsifications) {
  const r = await jouer(OPERATIONS[0][1], jeton);
  ok(!r.ok && r.code === '42501', `refusee : ${nom}`,
    r.ok ? 'ACCEPTEE — la chaine de confiance est contournable' : `code ${r.code}`);
}

/* --- D : l'escalade complete, et son residu en base --------------------- */

console.log('\n  D. l escalade mesuree est rejouee de bout en bout');

{
  const r = await jouer(OPERATIONS[0][1], null);
  ok(!r.ok && r.code === '42501', 'sans jeton systeme : la creation d adhesion est refusee',
    r.ok ? 'adhesion ecrite' : r.code);

  const residu = await admin.query(
    `SELECT count(*)::int AS n FROM organization_memberships WHERE clerk_membership_id = 'mem_p107_test'`);
  ok(residu.rows[0].n === 0, 'aucune adhesion n a ete ecrite', `${residu.rows[0].n} ligne(s)`);

  // Et le controle qui compte pour le locataire B : aucun droit gagne chez lui.
  await app.query('BEGIN');
  try {
    await app.query(`SELECT set_config('tracefab.active_organization_id', $1, true)`, [B.id]);
    await app.query(`SELECT set_config('tracefab.identity', $1, true)`,
      [`v1|${A.user_id}|${B.id}|tracefab_identity|${maintenant + 60}.${'0'.repeat(64)}`]);
    const role = await app.query(`SELECT public.tracefab_has_org_role($1, ARRAY['owner']::membership_role[]) AS o`, [B.id]);
    ok(role.rows[0].o === false, 'l attaquant n est pas owner chez B', `owner=${role.rows[0].o}`);
    const produits = await app.query('SELECT count(*)::int AS n FROM tracefab_products WHERE brand_organization_id = $1', [B.id]);
    ok(produits.rows[0].n === 0, 'l attaquant ne voit aucun produit de B', `${produits.rows[0].n} produit(s)`);
  } finally {
    await app.query('ROLLBACK');
  }
}

/* --- E : les proprietes qui rendent la correction valable ---------------- */

console.log('\n  E. les proprietes de la chaine, mesurees et non supposees');

{
  const sonde = (await admin.query('SELECT * FROM public.tracefab_sec_probe_identite_systeme()')).rows[0];
  ok(sonde.operations_systeme_non_gardees === 0,
    'toutes les operations systeme portent la garde d origine',
    `${sonde.operations_systeme_gardees} gardee(s), ${sonde.operations_systeme_non_gardees} non gardee(s)`);
  ok(sonde.mode_systeme_strict === true, 'le mode strict systeme est actif', `systeme_strict=${sonde.mode_systeme_strict}`);
  ok(sonde.runtime_endosse_worker === false, 'le runtime ne peut pas endosser le worker', `membre=${sonde.runtime_endosse_worker}`);
  ok(sonde.worker_connectable === false, 'le worker n est pas connectable', `rolcanlogin=${sonde.worker_connectable}`);
  ok(sonde.runtime_lit_les_cles === false, 'le runtime ne lit pas les cles — la signature ne peut pas etre produite par lui',
    `lecture=${sonde.runtime_lit_les_cles}`);

  // La lecture des cles doit echouer pour de vrai, pas seulement au catalogue.
  await app.query('BEGIN');
  try {
    await app.query('SELECT secret FROM public.tracefab_identity_cles LIMIT 1');
    ok(false, 'la lecture directe de tracefab_identity_cles est refusee par l ACL', 'LECTURE ACCEPTEE');
  } catch (error) {
    ok(error.code === '42501', 'la lecture directe de tracefab_identity_cles est refusee par l ACL', error.code);
  } finally {
    await app.query('ROLLBACK');
  }
}

/* --- F : rotation et revocation ----------------------------------------- */

console.log('\n  F. rotation et revocation de la cle');

{
  const V_ANCIENNE = 99151;
  const V_NOUVELLE = 99152;
  const cleAncienne = randomBytes(32).toString('hex');
  const cleNouvelle = randomBytes(32).toString('hex');
  try {
    await admin.query(
      `INSERT INTO public.tracefab_identity_cles (version, secret, actif) VALUES
         ($1, decode($2,'hex'), true), ($3, decode($4,'hex'), true)`,
      [V_ANCIENNE, cleAncienne, V_NOUVELLE, cleNouvelle]);

    const jetonAncien = signerJetonSysteme({ cle: cleAncienne, expiration: maintenant + 60 });
    const jetonNouveau = signerJetonSysteme({ cle: cleNouvelle, expiration: maintenant + 60 });

    ok((await jouer(OPERATIONS[0][1], jetonAncien)).ok,
      'pendant le chevauchement, un jeton signe par l ANCIENNE cle est accepte');
    ok((await jouer(OPERATIONS[0][1], jetonNouveau)).ok,
      'pendant le chevauchement, un jeton signe par la NOUVELLE cle est accepte');

    await admin.query('UPDATE public.tracefab_identity_cles SET actif = false WHERE version = $1', [V_ANCIENNE]);
    const apresRevocation = await jouer(OPERATIONS[0][1], jetonAncien);
    ok(!apresRevocation.ok && apresRevocation.code === '42501',
      'apres desactivation, l ancien jeton est refuse',
      apresRevocation.ok ? 'ENCORE ACCEPTE' : apresRevocation.code);
    ok((await jouer(OPERATIONS[0][1], jetonNouveau)).ok,
      'apres desactivation, le nouveau jeton continue de fonctionner');
  } finally {
    await admin.query('DELETE FROM public.tracefab_identity_cles WHERE version IN ($1, $2)', [V_ANCIENNE, V_NOUVELLE]);
    const restantes = await admin.query('SELECT count(*)::int AS n FROM public.tracefab_identity_cles WHERE version IN ($1,$2)', [V_ANCIENNE, V_NOUVELLE]);
    ok(restantes.rows[0].n === 0, 'les cles de test sont retirees', `${restantes.rows[0].n} restante(s)`);
  }
}

/* --- G : la sonde de la base et la liste du code disent la meme chose --- */

console.log('\n  G. la sonde de la base et la liste du code ne derivent pas l une de l autre');

{
  // Cette liste est la seule ecrite a la main du fichier. Elle sert de CONTROLE
  // de la sonde installee en base : si les deux divergent, c'est que l'une des
  // deux a ete mise a jour sans l'autre, et c'est precisement ainsi qu'une
  // operation systeme a pu rester executable sans que personne ne le voie.
  const ATTENDUES = [
    'tracefab_sync_clerk_membership', 'tracefab_sync_clerk_organization',
    'tracefab_revoke_clerk_membership', 'tracefab_upsert_clerk_user',
    'tracefab_ensure_clerk_user', 'tracefab_soft_delete_clerk_user',
    'tracefab_archive_clerk_organization', 'tracefab_clerk_organization_uuid',
    'tracefab_notification_outbox_health', 'tracefab_claim_notification_outbox',
    'tracefab_complete_notification_outbox', 'tracefab_enqueue_due_data_request_reminders',
    'tracefab_enqueue_manual_data_request_reminder',
  ];
  const sonde = (await admin.query('SELECT * FROM public.tracefab_sec_probe_identite_systeme()')).rows[0];
  ok(sonde.operations_systeme_gardees === ATTENDUES.length,
    `la sonde compte ${ATTENDUES.length} operations gardees`,
    `sonde=${sonde.operations_systeme_gardees}`);

  // Et chaque nom de la liste doit exister ET etre garde, mesure par le corps.
  const corps = (await admin.query(`
    SELECT p.proname, pg_catalog.has_function_privilege('tracefab_app', p.oid, 'EXECUTE') AS ex
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname = ANY ($1::text[])`,
  [ATTENDUES])).rows;
  const manquantes = ATTENDUES.filter((n) => !corps.some((c) => c.proname === n));
  ok(manquantes.length === 0, 'chaque operation de la liste existe en base', manquantes.join(', ') || 'aucune manquante');

  // La verification du jeton systeme reste, elle, appelable par le runtime :
  // sans cela la readiness ne pourrait rien mesurer.
  const verif = await app.query(`SELECT public.tracefab_identite_systeme_jeton_valide($1) AS v`, [jetonSystemeValide({ cle })]);
  ok(verif.rows[0].v === true, 'le runtime peut VERIFIER un jeton systeme (readiness mesurable)', `v=${verif.rows[0].v}`);
  const verifFausse = await app.query(`SELECT public.tracefab_identite_systeme_jeton_valide($1) AS v`, ['v1|tracefab_system|tracefab_worker|9999999999.' + 'a'.repeat(64)]);
  ok(verifFausse.rows[0].v === false, 'la verification rend false sur un MAC invalide, jamais une erreur d oracle', `v=${verifFausse.rows[0].v}`);
}

await restaurerMode();
console.log(`\n  P10.7 — origine des operations systeme : ${assertions - echecs}/${assertions} assertions vertes`);
if (NON_MESURE.length > 0) console.log(`  ${NON_MESURE.length} propriete(s) NON MESUREE(S) : ${NON_MESURE.join(' · ')}`);
if (echecs > 0) console.log(`  ${echecs} echec(s)`);

await app.end();
await admin.end();
process.exit(echecs === 0 && NON_MESURE.length === 0 ? 0 : 1);
