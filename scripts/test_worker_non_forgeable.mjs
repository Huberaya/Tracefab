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
 * CE TEST ECHOUE SUR LE CODE VULNERABLE, ET PAS SEULEMENT IL PASSE SUR LE
 * CORRECTIF. C'est la seule facon d'en faire une non-regression : verifie le
 * 28/10/2026 en remettant une seule politique sur le GUC, la propriete 2 tombe
 * immediatement.
 *
 * POURQUOI IL NE SE CONNECTE PAS SOUS L'IDENTITE WORKER
 *
 * En production, `tracefab_worker` est NOLOGIN : il n'existe aucun mot de passe
 * a fournir, et c'est voulu. Les proprietes qui concernent le worker sont donc
 * verifiees a travers le role applicatif (les fonctions nommees) et par le
 * catalogue. Un test qui exigerait une connexion worker imposerait de rendre ce
 * role connectable — c'est-a-dire d'affaiblir le modele pour pouvoir le tester.
 *
 * Variables :
 *   TF_RLS_APP_URL  connexion du role applicatif (sans BYPASSRLS) — obligatoire
 *   DATABASE_URL    connexion d'administration, pour les fixtures et le
 *                   catalogue — obligatoire
 * Sortie 0 = conforme, 1 = regression, 2 = environnement incomplet (NON EXECUTE).
 */
import pg from 'pg';

const APP_URL = process.env.TF_RLS_APP_URL;
const ADMIN_URL = process.env.DATABASE_URL;

if (!APP_URL || !ADMIN_URL) {
  console.log('NON EXECUTE — TF_RLS_APP_URL et DATABASE_URL sont obligatoires.');
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

const app = new pg.Client({ connectionString: APP_URL, ssl: false });
const admin = new pg.Client({ connectionString: ADMIN_URL, ssl: false });

const compter = async (client, cible) =>
  (await client.query(`select count(*)::int as n from ${cible}`)).rows[0].n;

try {
  await app.connect();
  await admin.connect();

  // Un role privilegie ne prouverait rien : on refuse de conclure plutot que
  // d'afficher un vert trompeur.
  const attributs = await app.query(
    'select rolbypassrls, rolsuper from pg_roles where rolname = current_user',
  );
  if (attributs.rows[0].rolbypassrls || attributs.rows[0].rolsuper) {
    console.log('NON EXECUTE — le role de test est privilegie (BYPASSRLS ou superutilisateur).');
    process.exit(2);
  }
  console.log(`Identite applicative : ${(await app.query('select current_user as u')).rows[0].u}\n`);

  const TABLES_SENSIBLES = ['public.organizations', 'public.users', 'public.organization_memberships'];

  // --- 1. Sans contexte -----------------------------------------------------
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
  // La decouverte passe par la connexion d'administration : sous le role
  // applicatif et sans contexte, la RLS masque les adhesions, et on conclurait a
  // tort qu il n y en a aucune — le test degraderait en silence.
  const tenant = await admin.query(
    `select m.organization_id::text as org, u.id::text as user_id, u.email
       from public.organization_memberships m
       join public.users u on u.id = m.user_id
      where m.status = 'active'
      order by m.organization_id
      limit 1`,
  );
  if (tenant.rows.length === 0) {
    console.log('  info      aucune adhesion active : verification positive non mesurable ici');
    refus.push('contexte tenant legitime non mesurable (aucune adhesion active)');
  } else {
    const { org, user_id: userId, email } = tenant.rows[0];
    await app.query('begin');
    // Le contexte tenant exige les DEUX variables, et l e-mail en minuscules :
    // c est ce que fait withTracefabTenantContext cote application.
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

  // --- 4. Les six operations worker sous le role applicatif ----------------
  console.log('\n4. Operations systeme sous identite autorisee');
  await app.query('begin');
  try {
    const upsert = await app.query(
      "select * from tracefab_upsert_clerk_user('t_worker_check', 'Controle@Example.FR', 'Controle')",
    );
    ok(
      upsert.rows[0]?.email === 'controle@example.fr',
      'tracefab_upsert_clerk_user ecrit et normalise',
    );
    const ensure = await app.query(
      "select * from tracefab_ensure_clerk_user('t_worker_check', 'autre@example.fr', 'Autre')",
    );
    ok(
      ensure.rows[0]?.email === 'controle@example.fr',
      'tracefab_ensure_clerk_user ne reecrit pas un compte existant',
    );
    const sante = await app.query('select * from tracefab_notification_outbox_health()');
    ok(
      typeof sante.rows[0]?.pending === 'number',
      'tracefab_notification_outbox_health rend des compteurs',
    );
    const suppression = await app.query("select tracefab_soft_delete_clerk_user('t_worker_check') as n");
    ok(suppression.rows[0].n === 1, 'tracefab_soft_delete_clerk_user touche une seule ligne');
    const inconnue = await app.query("select tracefab_archive_clerk_organization('org_absente') as r");
    ok(inconnue.rows[0].r === false, 'tracefab_archive_clerk_organization rend false si inconnue');
  } finally {
    await app.query('rollback');
  }
  console.log('  info      transaction annulee : aucune donnee conservee');
  // Controle de parametres : hors transaction, parce qu'une erreur volontaire
  // avorterait la transaction en cours.
  const mauvais = await app
    .query("select * from tracefab_upsert_clerk_user('', 'x@y.fr', 'X')")
    .then(() => '')
    .catch((e) => e.message);
  ok(mauvais === 'clerk_user_id_required', 'un identifiant vide est refuse', String(mauvais));

  // --- 5. DPP publies / brouillons -----------------------------------------
  console.log('\n5. DPP et contexte public');
  ok((await compter(app, 'public.dpp_records')) === 0, 'aucun DPP visible sous role applicatif sans contexte');
  await app.query('begin');
  await app.query("select set_config('tracefab.public_context', 'true', true)");
  const orgsPublic = await compter(app, 'public.organizations');
  const adhesionsPublic = await compter(app, 'public.organization_memberships');
  await app.query('rollback');
  ok(orgsPublic === 0, 'le contexte public (meme force) n ouvre aucune organisation');
  ok(adhesionsPublic === 0, 'le contexte public (meme force) n ouvre aucune adhesion');

  // --- 6. Ni l un ni l autre ne peut endosser l autre ----------------------
  console.log('\n6. Ni l un ni l autre ne peut endosser l autre');
  for (const cmd of ['set role tracefab_worker', 'set session authorization tracefab_worker']) {
    let refuse = false;
    try {
      await app.query(cmd);
    } catch {
      refuse = true;
    }
    ok(refuse, `refus de « ${cmd} »`, 'sinon la faille serait simplement deplacee');
  }
  const appMembreWorker = await admin.query(
    "select pg_has_role('tracefab_app', 'tracefab_worker', 'MEMBER') as m",
  );
  ok(appMembreWorker.rows[0].m === false, 'aucune appartenance applicatif -> worker');
  const workerMembreApp = await admin.query(
    "select pg_has_role('tracefab_worker', 'tracefab_app', 'MEMBER') as m",
  );
  ok(workerMembreApp.rows[0].m === false, 'aucune appartenance worker -> applicatif');

  // --- 7. Aucun elargissement de privilege ---------------------------------
  console.log('\n7. Aucun elargissement');
  const worker = await admin.query(
    "select rolcanlogin, rolbypassrls, rolsuper, rolcreaterole, rolcreatedb from pg_roles where rolname = 'tracefab_worker'",
  );
  const w = worker.rows[0];
  ok(!!w, 'le role tracefab_worker existe');
  if (w) {
    ok(
      !w.rolbypassrls && !w.rolsuper && !w.rolcreaterole && !w.rolcreatedb,
      'tracefab_worker ne porte aucun attribut privilegie',
      `bypassrls=${w.rolbypassrls} super=${w.rolsuper}`,
    );
  }
  // Le worker ne doit rien pouvoir lire que l applicatif ne puisse lire : le
  // seul sens qui compte est l anti-escalade.
  const enPlus = await admin.query(
    `select c.relname
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r','p')
        and has_table_privilege('tracefab_worker', c.oid, 'SELECT')
        and not has_table_privilege('tracefab_app', c.oid, 'SELECT')
      order by 1`,
  );
  ok(
    enPlus.rowCount === 0,
    'aucune table lisible par le worker seul',
    enPlus.rows.map((r) => r.relname).join(', ') || 'aucune',
  );

  // --- 8. Le registre runtime est ferme ------------------------------------
  console.log('\n8. Le registre runtime n ouvre rien');
  const rlsRegistre = await admin.query(
    `select c.relrowsecurity as rls, c.relforcerowsecurity as forcee
       from pg_class c where c.oid = 'public.tracefab_runtime_function_registry'::regclass`,
  );
  const rl = rlsRegistre.rows[0];
  ok(!!rl, 'le registre existe');
  if (rl) {
    ok(rl.rls === true, 'RLS activee sur le registre');
    ok(rl.forcee === true, 'RLS forcee sur le registre');
  }
  // Le seed accorde SELECT sur toutes les tables au role applicatif, et le
  // registre est cree avant lui : il herite donc de ce privilege. Ce n'est pas
  // un elargissement du a la migration, et c'est sans consequence — la RLS est
  // forcee et la politique n'autorise que le proprietaire. Ce qui compte est le
  // fait observable : le role applicatif ne lit AUCUNE ligne.
  const lues = await app
    .query('select count(*)::int as n from public.tracefab_runtime_function_registry')
    .then((r) => r.rows[0].n)
    .catch(() => 'refus');
  ok(lues === 0 || lues === 'refus', 'le role applicatif ne lit aucune ligne du registre', String(lues));
  const politiqueProprietaire = await admin.query(
    `select count(*)::int as n
       from pg_policies
      where schemaname = 'public'
        and tablename = 'tracefab_runtime_function_registry'
        and qual like '%relowner%'`,
  );
  ok(
    politiqueProprietaire.rows[0].n === 1,
    'la seule politique du registre est reservee a son proprietaire',
  );

  // --- 9. Le registre porte bien le perimetre herite ------------------------
  console.log('\n9. Le registre porte le perimetre herite');
  const herites = await admin.query(
    `select count(*)::int as n from public.tracefab_runtime_function_registry
      where registered_by = '20261021120000_limit_app_function_execute'`,
  );
  ok(herites.rows[0].n === 84, 'les 84 fonctions heritees sont toutes reprises', String(herites.rows[0].n));
  const executables = await admin.query(
    `select count(*)::int as n
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prokind = 'f'
        and pg_catalog.has_function_privilege('tracefab_app', p.oid, 'EXECUTE')
        and p.proname not in (select name from public.tracefab_runtime_function_registry)`,
  );
  ok(executables.rows[0].n === 0, 'aucune fonction executable hors registre', String(executables.rows[0].n));
} finally {
  await app.end().catch(() => {});
  await admin.end().catch(() => {});
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
