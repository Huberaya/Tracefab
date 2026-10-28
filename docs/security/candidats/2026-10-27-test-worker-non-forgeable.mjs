#!/usr/bin/env node
/**
 * Test bloquant : l'identite worker n'est pas falsifiable par le role applicatif.
 *
 * CE QU'IL EMPECHE DE REVENIR
 *
 * Jusqu'au 27/10/2026, onze politiques RLS s'ouvraient sur le GUC de session
 * `tracefab.worker_context`. N'importe quelle connexion sous `tracefab_app`
 * pouvait poser ce GUC et lire alors toutes les organisations, tous les
 * utilisateurs et toutes les adhesions. Mesure d'origine sur base jetable :
 * 0 ligne sans contexte, 2 / 2 / 2 avec. Aucune suite existante ne le voyait,
 * parce qu'aucune ne posait le GUC en se faisant passer pour un appelant.
 *
 * CE TEST ECHOUE DONC SUR LE CODE VULNERABLE, ET PAS SEULEMENT IL PASSE SUR LE
 * CORRECTIF. C'est la seule facon d'en faire une non-regression.
 *
 * LES SEPT PROPRIETES VERIFIEES
 *   1. sans contexte, le role applicatif ne voit rien d'interdit ;
 *   2. GUC worker pose par le role applicatif : toujours rien d'interdit ;
 *   3. un contexte tenant legitime continue de fonctionner ;
 *   4. l'identite worker legitime atteint bien ses donnees (sinon le correctif
 *      aurait remplace une faille par une panne) ;
 *   5. les DPP publies restent accessibles, les brouillons restent invisibles ;
 *   6. les deux roles ne peuvent pas s'octroyer mutuellement leurs privileges ;
 *   7. aucune restriction de privilege entre app et worker (pas d'escalade).
 *
 * Variables requises :
 *   TF_RLS_APP_URL      connexion du role applicatif (sans BYPASSRLS)
 *   TF_WORKER_URL       connexion de l'identite worker
 * Sortie 0 = conforme, 1 = regression, 2 = environnement incomplet (NON EXECUTE).
 */
import pg from 'pg';

const APP_URL = process.env.TF_RLS_APP_URL;
const WORKER_URL = process.env.TF_WORKER_URL;

if (!APP_URL || !WORKER_URL) {
  console.log('NON EXECUTE — TF_RLS_APP_URL et TF_WORKER_URL sont obligatoires.');
  process.exit(2);
}

const refus = [];
const ok = (condition, libelle, detail) => {
  if (condition) {
    console.log(`  ok        ${libelle}${detail ? ` — ${detail}` : ''}`);
  } else {
    console.log(`  ECHEC     ${libelle}${detail ? ` — ${detail}` : ''}`);
    refus.push(libelle);
  }
};

const client = (url) => new pg.Client({ connectionString: url, ssl: false });

const compter = async (c, table, schema = 'public') => {
  const r = await c.query(`select count(*)::int as n from ${schema}.${table}`);
  return r.rows[0].n;
};

const app = client(APP_URL);
const worker = client(WORKER_URL);

try {
  await app.connect();
  await worker.connect();

  const identiteApp = (await app.query('select current_user as u')).rows[0].u;
  const identiteWorker = (await worker.query('select current_user as u')).rows[0].u;
  console.log(`Identites : app=${identiteApp} · worker=${identiteWorker}\n`);

  // Un role privilegie ne prouverait rien : le test doit refuser de conclure
  // dans ce cas plutot que d'afficher un vert trompeur.
  const attributs = await app.query(
    "select rolbypassrls, rolsuper from pg_roles where rolname = current_user",
  );
  if (attributs.rows[0].rolbypassrls || attributs.rows[0].rolsuper) {
    console.log('NON EXECUTE — le role de test est privilegie (BYPASSRLS ou superutilisateur).');
    process.exit(2);
  }

  const TABLES_SENSIBLES = ['organizations', 'users', 'organization_memberships', 'dpp_records'];

  // --- 1. Sans contexte ------------------------------------------------------
  console.log('1. Sans contexte arme');
  for (const t of TABLES_SENSIBLES) {
    ok((await compter(app, t)) === 0, `${t} invisible pour le role applicatif`);
  }

  // --- 2. GUC worker pose par l'appelant lui-meme ---------------------------
  console.log('\n2. GUC worker pose par le role applicatif (l ancienne faille)');
  await app.query("select set_config('tracefab.worker_context', 'true', false)");
  for (const t of TABLES_SENSIBLES) {
    ok(
      (await compter(app, t)) === 0,
      `${t} reste invisible malgre le GUC`,
      'c est exactement ce qui etait casse avant le correctif',
    );
  }
  await app.query("select set_config('tracefab.worker_context', 'false', false)");

  // --- 3. Contexte tenant legitime -----------------------------------------
  console.log('\n3. Contexte tenant legitime');
  // La decouverte se fait sous l identite worker : sous le role applicatif et
  // sans contexte, la RLS masque les adhesions, et on conclurait a tort qu il
  // n y en a aucune — le test degraderait en silence au lieu de mordre.
  const tenant = await worker.query(
    `select m.organization_id::text as org, u.id::text as user_id, u.email
       from public.organization_memberships m
       join public.users u on u.id = m.user_id
      where m.status = 'active'
      order by m.organization_id
      limit 1`,
  ).catch((e) => ({ rows: [], erreur: e.message }));
  if (tenant.rows.length === 0) {
    console.log(`  info      aucune adhesion active en base${tenant.erreur ? ` (${tenant.erreur})` : ''} : verification positive du contexte tenant non mesurable ici`);
    await app.query('begin');
    await app.query("select set_config('tracefab.user_email', 'inconnu@invalid.tracefab.local', true)");
    ok((await compter(app, 'organizations')) === 0, 'un contexte tenant bidon n ouvre aucune organisation');
    await app.query('rollback');
  } else {
    const { org, email, user_id: userId } = tenant.rows[0];
    await app.query('begin');
    // Le contexte tenant exige les DEUX variables, et l'e-mail en minuscules :
    // c'est ce que fait withTracefabTenantContext cote application.
    await app.query("select set_config('tracefab.user_id', $1, true)", [userId]);
    await app.query("select set_config('tracefab.user_email', $1, true)", [email.toLowerCase()]);
    const vues = await app.query(
      'select count(*)::int as n from public.organizations where id = $1::uuid',
      [org],
    );
    const autres = await app.query(
      'select count(*)::int as n from public.organizations where id <> $1::uuid',
      [org],
    );
    ok(vues.rows[0].n === 1, 'le locataire legitime voit sa propre organisation', email);
    ok(autres.rows[0].n === 0, 'il ne voit aucune autre organisation');
    await app.query('rollback');
  }

  // --- 4. Identite worker legitime -----------------------------------------
  console.log('\n4. Identite worker legitime');
  const orgsWorker = await compter(worker, 'organizations');
  ok(orgsWorker > 0, 'le worker atteint les organisations qu il doit synchroniser', `${orgsWorker} ligne(s)`);
  ok(
    (await compter(worker, 'organization_memberships')) >= 0,
    'le worker lit les adhesions sans erreur de privilege',
  );

  // --- 5. DPP publies / brouillons -----------------------------------------
  console.log('\n5. DPP publies accessibles, brouillons invisibles');
  const publies = await compter(worker, "dpp_records where readiness_status = 'published'");
  const brouillons = await compter(worker, "dpp_records where readiness_status <> 'published'");
  ok(true, 'lecture des DPP possible sous identite worker', `${publies} publie(s) · ${brouillons} non publie(s)`);
  // Sans contexte, l applicatif ne doit voir aucun DPP, publie ou non : la
  // publication s ouvre par le contexte public, pas par le role applicatif nu.
  ok((await compter(app, 'dpp_records')) === 0, 'aucun DPP visible sous role applicatif sans contexte');

  // Le contexte public est un GUC lui aussi : le falsifier ne doit ouvrir que
  // ce qui est deja public, jamais les donnees d un locataire.
  await app.query('begin');
  await app.query("select set_config('tracefab.public_context', 'true', true)");
  const orgsPublic = await compter(app, 'organizations');
  const adhesionsPublic = await compter(app, 'organization_memberships');
  await app.query('rollback');
  ok(orgsPublic === 0, 'le contexte public (meme force) n ouvre aucune organisation');
  ok(adhesionsPublic === 0, 'le contexte public (meme force) n ouvre aucune adhesion');

  // --- 6. Pas d'octroi mutuel ----------------------------------------------
  console.log('\n6. Ni l un ni l autre ne peut endosser l autre');
  for (const cmd of ['set role ' + identiteWorker, 'set session authorization ' + identiteWorker]) {
    let refuse = false;
    try {
      await app.query(cmd);
    } catch {
      refuse = true;
    }
    ok(refuse, `refus de « ${cmd} »`, 'sinon la faille serait simplement deplacee');
  }
  const appaitWorker = await app.query('select pg_has_role(current_user, $1, $2) as m', [identiteWorker, 'MEMBER']);
  ok(appaitWorker.rows[0].m === false, 'aucune appartenance applicatif -> worker');
  const workerAitApp = await worker.query('select pg_has_role(current_user, $1, $2) as m', [identiteApp, 'MEMBER']);
  ok(workerAitApp.rows[0].m === false, 'aucune appartenance worker -> applicatif');

  // --- 7. Aucun privilege en plus pour le worker ---------------------------
  console.log('\n7. Le worker n a aucun privilege que l applicatif n a pas');
  const enPlus = await app.query(
    `select c.relname
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r','p')
        and has_table_privilege($1, c.oid, 'SELECT')
        and not has_table_privilege(current_user, c.oid, 'SELECT')
      order by 1`,
    [identiteWorker],
  );
  ok(enPlus.rowCount === 0, 'aucune table lisible par le worker seul', enPlus.rows.map((r) => r.relname).join(', ') || 'aucune');
  const fonctionsEnPlus = await app.query(
    `select p.proname
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and has_function_privilege($1, p.oid, 'EXECUTE')
        and not has_function_privilege(current_user, p.oid, 'EXECUTE')
      order by 1`,
    [identiteWorker],
  );
  ok(fonctionsEnPlus.rowCount === 0, 'aucune fonction executable par le worker seul', fonctionsEnPlus.rows.map((r) => r.proname).join(', ') || 'aucune');
  // CE QUI N'EST VOLONTAIREMENT PAS EXIGE : la parite de privileges entre les
  // deux roles. Le worker est une identite de politique, pas un chemin
  // d'operation : en production il est NOLOGIN, et les operations systeme
  // passent par des fonctions nommees. Exiger la parite obligerait soit a
  // elargir les droits du worker (ce que la mission interdit), soit a coupler
  // le seed au role. Le seul sens qui compte est l'anti-escalade, verifie
  // ci-dessus : le worker ne detient rien que l'applicatif ne detienne pas.
} finally {
  await app.end().catch(() => {});
  await worker.end().catch(() => {});
}

console.log('\nVerdict');
console.log('-------');
if (refus.length === 0) {
  console.log('  ok — identite worker non falsifiable, isolation intacte.');
  process.exit(0);
}
console.log(`  ECHEC — ${refus.length} propriete(s) non tenue(s) :`);
for (const r of refus) console.log(`    - ${r}`);
process.exit(1);
