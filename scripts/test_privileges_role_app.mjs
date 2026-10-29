#!/usr/bin/env node
/**
 * Contrôle — les privilèges du rôle applicatif sont minimaux et éprouvés.
 *
 * POURQUOI CE CONTRÔLE EXISTE
 *
 * `scripts/lib/tracefab_app_role.mjs` accordait
 * `SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public` au rôle
 * applicatif. Toute table était donc modifiable directement, ce qui vidait de
 * son sens le principe « mutations par fonctions SECURITY DEFINER » et laissait
 * la RLS comme seule barrière. L'octroi a été réduit à la lecture générale plus
 * l'écriture sur quatre tables nommées.
 *
 * Ce contrôle vérifie trois choses, et les trois sont nécessaires :
 *
 *   1. l'état réel des privilèges, mesuré en se connectant avec le rôle — pas
 *      lu dans le code de provisioning ;
 *   2. le comportement : une écriture directe sur une table non autorisée doit
 *      échouer, celle sur une table autorisée doit réussir ;
 *   3. l'absence de régression dans le code : si l'octroi global réapparaît, le
 *      contrôle échoue même avant d'avoir mesuré quoi que ce soit.
 *
 * Pourquoi une base dédiée : `bootstrap_app_role.mjs` n'est exécuté par aucun
 * job CI. Ce contrôle le lance donc lui-même, sur une base qu'il crée et
 * détruit dans le même cluster, pour ne pas modifier les privilèges vus par les
 * autres suites du job.
 *
 * Aucune chaîne de connexion n'est affichée. Aucun secret journalisé.
 *
 * Sorties : 0 conforme · 1 défaut · 2 prérequis manquant · 3 cible refusée.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { requireThrowawayDb } from './lib/require-throwaway-db.mjs';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';
import { APP_ROLE, TABLES_ECRITURE_DIRECTE } from './lib/tracefab_app_role.mjs';
import { API_RUNTIME_FUNCTION_NAMES, RLS_POLICY_FUNCTION_NAMES, RUNTIME_FUNCTION_NAMES } from './lib/tracefab_runtime_functions.mjs';

const SORTIE_DEFAUT = 1;
const SORTIE_PREREQUIS = 2;

const RACINE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE_EPHEMERE = 'tracefab_privileges_ephemere';
const MOT_DE_PASSE = process.env.TF_APP_PASSWORD || 'epreuve_locale_jetable';

/**
 * Tables dont l'écriture directe est légitime.
 *
 * Importée, PAS recopiée. Cette constante était dupliquée ici, et c'est ce qui
 * a laissé passer l'erreur du 19 octobre : la liste du provisioning et celle du
 * contrôle disaient toutes deux « 4 tables », donc le contrôle validait la liste
 * au lieu de la contester. Une seule source désormais —
 * scripts/lib/tracefab_app_role.mjs — et sa justesse est vérifiée à part par
 * scripts/test_tables_ecriture_directe.mjs, qui la re-dérive depuis api/.
 */

let assertions = 0;
let echecs = 0;
const verifier = (nom, cond, obs) => {
  assertions += 1;
  if (cond) console.log(`  ok    ${nom}`);
  else { echecs += 1; console.log(`  ECHEC ${nom} — observé : ${obs}`); }
};

/* --- 0. Régression dans le code de provisioning ---------------------------- */

console.log('\n  1. code de provisioning — absence d octroi global');
// Les lignes de commentaire sont écartées avant l'analyse. Le fichier explique
// l'ancien octroi global pour justifier sa suppression : sans ce filtre, ce
// commentaire déclenche un faux positif — défaut constaté au premier lancement.
const sourceRole = fs
  .readFileSync(path.join(RACINE, 'scripts', 'lib', 'tracefab_app_role.mjs'), 'utf8')
  .split('\n')
  .filter((l) => {
    const t = l.trim();
    return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
  })
  .join('\n');
verifier(
  'aucun octroi global INSERT/UPDATE/DELETE sur toutes les tables',
  !/GRANT[^;]*\bINSERT[^;]*ON ALL TABLES/i.test(sourceRole),
  'un GRANT ... INSERT ... ON ALL TABLES est présent',
);
verifier(
  'aucun ALTER DEFAULT PRIVILEGES accordant INSERT par défaut',
  !/ALTER DEFAULT PRIVILEGES[^;]*\bGRANT\b[^;]*\bINSERT\b[^;]*ON TABLES/i.test(sourceRole),
  'un ALTER DEFAULT PRIVILEGES ... INSERT ... ON TABLES est présent',
);
verifier(
  'la liste des tables en écriture directe est explicite',
  sourceRole.includes('TABLES_ECRITURE_DIRECTE'),
  'la constante TABLES_ECRITURE_DIRECTE a disparu',
);
verifier(
  'le bootstrap n accorde pas EXECUTE globalement',
  !/GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO/i.test(sourceRole),
  'un GRANT EXECUTE ON ALL FUNCTIONS est présent',
);
verifier(
  'le bootstrap ferme le défaut EXECUTE applicatif futur',
  sourceRole.includes('REVOKE EXECUTE ON FUNCTIONS FROM ${APP_ROLE}')
    && !/ALTER DEFAULT PRIVILEGES[^;]*GRANT EXECUTE ON FUNCTIONS TO ${APP_ROLE}/i.test(sourceRole),
  'le défaut EXECUTE applicatif reste accordé',
);
const migrationFunctionAcl = fs.readFileSync(
  path.join(RACINE, 'prisma', 'migrations', '20261021120000_limit_app_function_execute', 'migration.sql'),
  'utf8',
);
const allowlistSqlBlock = migrationFunctionAcl.match(/runtime_names text\[\] := ARRAY\[([\s\S]*?)\]::text\[\];/);
const allowlistSqlNames = allowlistSqlBlock
  ? [...allowlistSqlBlock[1].matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]).sort()
  : [];
// La liste figee de 20261021120000 n est plus la source de verite : elle ne
// peut pas contenir de fonction creee plus tard (la migration verifie que
// chaque nom existe deja et leve 42883 sinon). Les ajouts passent par le
// registre runtime (migration 20261028120000), qui recoit un INSERT par
// migration posterieure. Le perimetre attendu est donc l union des deux.
const registreAjouts = [];
for (const dossier of fs.readdirSync(path.join(RACINE, 'prisma', 'migrations')).sort()) {
  if (dossier <= '20261028120000_runtime_function_registry') continue;
  const fichier = path.join(RACINE, 'prisma', 'migrations', dossier, 'migration.sql');
  if (!fs.existsSync(fichier)) continue;
  const sql = fs.readFileSync(fichier, 'utf8').replace(/--[^\n]*/g, '');
  for (const bloc of sql.matchAll(/INSERT INTO public\.tracefab_runtime_function_registry[\s\S]*?;/g)) {
    for (const ligne of bloc[0].matchAll(/\(\s*'([a-z0-9_]+)'\s*,/g)) registreAjouts.push(ligne[1]);
  }
}
const allowlistAttendue = [...new Set([...allowlistSqlNames, ...registreAjouts])].sort();
verifier(
  'le module runtime est synchronisé avec la liste figée et le registre',
  JSON.stringify(allowlistAttendue) === JSON.stringify([...RUNTIME_FUNCTION_NAMES].sort()),
  `module=${RUNTIME_FUNCTION_NAMES.length}, figée=${allowlistSqlNames.length}, registre ajouté=${registreAjouts.length}, attendu=${allowlistAttendue.length}`,
);
verifier(
  'la liste figée garde son périmètre d origine',
  allowlistSqlNames.length === 84,
  `figée=${allowlistSqlNames.length}`,
);

// Ré-extraction indépendante des appels SQL directs de api/. Les commentaires
// sont retirés pour qu'une mention documentaire ne devienne pas un droit DB.
// Les noms de tables sont exclus : INSERT INTO tracefab_x (...) ressemble à un
// appel de fonction pour une expression régulière naïve.
function fichiersTypeScript(dir, acc = []) {
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) fichiersTypeScript(full, acc);
    else if (/\.ts$/.test(entry)) acc.push(full);
  }
  return acc;
}
const tablesConnues = new Set();
for (const dossier of fs.readdirSync(path.join(RACINE, 'prisma', 'migrations')).sort()) {
  const fichierMigration = path.join(RACINE, 'prisma', 'migrations', dossier, 'migration.sql');
  if (!fs.existsSync(fichierMigration)) continue;
  const sql = fs.readFileSync(fichierMigration, 'utf8');
  for (const m of sql.matchAll(/\bCREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:"?public"?\.)?"?([a-z0-9_]+)"?/gi)) tablesConnues.add(m[1]);
  for (const m of sql.matchAll(/\bDROP TABLE\s+(?:IF EXISTS\s+)?(?:"?public"?\.)?"?([a-z0-9_]+)"?/gi)) tablesConnues.delete(m[1]);
}
const fonctionsApiObservees = new Set();
for (const fichierApi of fichiersTypeScript(path.join(RACINE, 'api'))) {
  const src = fs.readFileSync(fichierApi, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1');
  for (const m of src.matchAll(/\b(tracefab_[a-z0-9_]+)\s*\(/gi)) {
    const nom = m[1].toLowerCase();
    if (!tablesConnues.has(nom)) fonctionsApiObservees.add(nom);
  }
}
const fonctionsApiTriees = [...fonctionsApiObservees].sort();
verifier(
  'l allowlist API est exactement dérivée des appels SQL dans api/',
  JSON.stringify(fonctionsApiTriees) === JSON.stringify([...API_RUNTIME_FUNCTION_NAMES].sort()),
  `attendues=${API_RUNTIME_FUNCTION_NAMES.length} ; observées=${fonctionsApiTriees.length} ; différences=${[...new Set([...fonctionsApiTriees, ...API_RUNTIME_FUNCTION_NAMES])].filter((n) => fonctionsApiTriees.includes(n) !== API_RUNTIME_FUNCTION_NAMES.includes(n)).join(', ')}`,
);

/* --- 1. Prérequis ---------------------------------------------------------- */

const urlAdmin = process.env.DATABASE_URL;
if (!urlAdmin) {
  console.log('\n  NON EXECUTE — DATABASE_URL absente.');
  console.log('  Ce contrôle exige un PostgreSQL. Il doit être raccordé au job');
  console.log('  qui fournit la base jetable, pas au job sans service.');
  process.exit(SORTIE_PREREQUIS);
}

// Seule DATABASE_URL est gardée : ce contrôle construit lui-même la connexion
// du rôle applicatif sur la base éphémère qu'il crée. Exiger TF_RLS_APP_URL
// ferait échouer le contrôle là où cette variable n'existe pas, alors qu'il n'en
// a pas besoin.
requireThrowawayDb({
  variables: ['DATABASE_URL'],
  purpose: 'contrôle des privilèges minimaux du rôle applicatif',
  exitOnFailure: true,
});

const hote = (urlAdmin.match(/@([^/:]+)/) || [])[1] ?? 'illisible';

// La connexion d'administration vise la base de maintenance `postgres`, pas la
// base configurée. CREATE DATABASE ne peut pas s'exécuter depuis une base qui
// n'existe pas encore, et le contrôle doit pouvoir tourner avant tout
// déploiement : avec urlAdmin tel quel, il mourait en 3D000 invalid_catalog_name
// dès que la base configurée était absente.
const urlMaintenance = urlAdmin.replace(/\/[^/?]+(\?|$)/, '/postgres$1');
const admin = new pg.Client({ connectionString: urlMaintenance, ssl: sslDepuisUrl(urlMaintenance) });
console.log(`\n  2. base éphémère sur ${hote}`);

await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${BASE_EPHEMERE}`);
await admin.query(`CREATE DATABASE ${BASE_EPHEMERE}`);

const urlEphemere = urlAdmin.replace(/\/[^/?]+(\?|$)/, `/${BASE_EPHEMERE}$1`);
const urlApp = urlEphemere.replace(/:\/\/[^@]*@/, `://${APP_ROLE}:${encodeURIComponent(MOT_DE_PASSE)}@`);

let sortie = 0;
let app = null;
try {
  // Le mot de passe repris de l'environnement : dans la CI, TF_APP_PASSWORD est
  // celui qu'emploie TF_RLS_APP_URL. En réutiliser un autre réinitialiserait le
  // mot de passe du rôle pour tout le cluster et casserait les suites suivantes.
  const env = { ...process.env, DATABASE_URL: urlEphemere, TF_APP_PASSWORD: MOT_DE_PASSE };

  // `prepare_ci_db_role.mjs` n'est pas appelé : il refuse toute base qui ne
  // s'appelle pas tracefab_test, et il ne fait que CREATE ROLE — ce que
  // `ensureAppRole` fait déjà, de façon idempotente, dans le bootstrap.
  //
  // L'ORDRE EST CELUI DE LA CI ET DE PRODUCTION : le rôle est provisionné AVANT
  // les migrations (`db:prepare-ci-role` puis `db:deploy:throwaway`). Ce n'est
  // pas un détail. La migration 20261014130000 contient un bloc
  // $preserve_runtime_acl$ qui, si le rôle existe déjà, recopie sur lui les
  // privilèges relationnels de PUBLIC avant de les révoquer. Mesuré : 36 tables
  // en écriture dans cet ordre, 4 dans l'ordre inverse. Contrôler l'ordre
  // inverse reviendrait à mesurer une configuration que personne ne déploie.
  execFileSync('node', [path.join(RACINE, 'scripts', 'bootstrap_app_role.mjs')], { env, stdio: 'ignore' });
  console.log('     provisioning du rôle applicatif exécuté (avant migrations, ordre réel)');

  const mig = new pg.Client({ connectionString: urlEphemere, ssl: sslDepuisUrl(urlEphemere) });
  await mig.connect();
  // Prisma crée ce registre avant d'exécuter les fichiers SQL. Ce test exécute
  // les migrations directement pour éprouver leur ordre; il doit donc créer
  // le même objet technique afin de vérifier que le runtime ne peut pas le
  // modifier après la migration de durcissement.
  await mig.query(`
    CREATE TABLE public._prisma_migrations (
      id VARCHAR(36) PRIMARY KEY NOT NULL,
      checksum VARCHAR(64) NOT NULL,
      finished_at TIMESTAMPTZ,
      migration_name VARCHAR(255) NOT NULL,
      logs TEXT,
      rolled_back_at TIMESTAMPTZ,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      applied_steps_count INTEGER NOT NULL DEFAULT 0
    )
  `);
  // Simuler le défaut historique observé sur Neon : les tables futures héritent
  // par défaut de DML pour tracefab_app et PUBLIC. La migration doit le supprimer.
  const ownerName = (await mig.query('SELECT current_user AS owner')).rows[0].owner;
  const quotedOwner = '"' + String(ownerName).replace(/"/g, '""') + '"';
  await mig.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${quotedOwner} GRANT INSERT, UPDATE, DELETE ON TABLES TO ${APP_ROLE}`);
  await mig.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${quotedOwner} GRANT INSERT, UPDATE, DELETE ON TABLES TO PUBLIC`);
  await mig.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${quotedOwner} IN SCHEMA public GRANT INSERT, UPDATE, DELETE ON TABLES TO ${APP_ROLE}`);
  await mig.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${quotedOwner} IN SCHEMA public GRANT INSERT, UPDATE, DELETE ON TABLES TO PUBLIC`);

  const dossiers = fs.readdirSync(path.join(RACINE, 'prisma', 'migrations'))
    .filter((d) => /^\d{14}_/.test(d)).sort();
  for (const d of dossiers) {
    const sql = fs.readFileSync(path.join(RACINE, 'prisma', 'migrations', d, 'migration.sql'), 'utf8');
    await mig.query('BEGIN');
    try { await mig.query(sql); await mig.query('COMMIT'); }
    catch (e) {
      await mig.query('ROLLBACK');
      console.log(`  ECHEC migration ${d} : ${e.code} ${String(e.message).split('\n')[0]}`);
      await mig.end();
      sortie = SORTIE_DEFAUT;
      throw new Error('migration');
    }
  }
  const defaultsDml = await mig.query(`
    SELECT count(*)::int AS n
    FROM pg_default_acl d
    CROSS JOIN LATERAL aclexplode(d.defaclacl) a
    WHERE d.defaclobjtype = 'r'
      AND (d.defaclnamespace = 0 OR d.defaclnamespace = 'public'::regnamespace)
      AND a.grantee IN (0, '${APP_ROLE}'::regrole)
      AND a.privilege_type IN ('INSERT', 'UPDATE', 'DELETE')
  `);
  verifier(
    'les migrations ferment les privilèges DML par défaut pour tracefab_app et PUBLIC',
    defaultsDml.rows[0]?.n === 0,
    `${defaultsDml.rows[0]?.n ?? 'inconnu'} privilège(s) DML futur(s) subsistent`,
  );
  await mig.end();

  // Regression: re-running the documented idempotent bootstrap after migrations
  // must not undo the migration's least-privilege grants on the Prisma ledger.
  execFileSync('node', [path.join(RACINE, 'scripts', 'bootstrap_app_role.mjs')], { env, stdio: 'ignore' });
  console.log('     re-bootstrap après migrations exécuté pour vérifier l’absence de régression');
  console.log(`     ${dossiers.length} migrations appliquées`);

  /* --- 2. Privilèges réels, mesurés en se connectant avec le rôle ---------- */

  console.log('\n  3. privilèges mesurés avec le rôle applicatif');
  app = new pg.Client({ connectionString: urlApp, ssl: sslDepuisUrl(urlApp) });
  await app.connect();

  const identite = await app.query('SELECT current_user AS u, (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS b');
  verifier('la connexion est bien le rôle applicatif', identite.rows[0].u === APP_ROLE, identite.rows[0].u);
  verifier('le rôle ne contourne pas la RLS', identite.rows[0].b === false, `rolbypassrls=${identite.rows[0].b}`);

  // Les privilèges effectifs incluent les appartenances de rôle, pas seulement
  // les ACL explicites. Une adhésion indirecte à un rôle administratif invalide
  // le modèle même si tracefab_app paraît lui-même non privilégié.
  const rolesElevated = await app.query(`
    SELECT r.rolname, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb
    FROM pg_roles r
    WHERE (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb)
      AND pg_has_role(current_user, r.oid, 'MEMBER')
  `);
  verifier(
    'aucun privilège élevé direct ou hérité via les rôles',
    rolesElevated.rows.length === 0,
    rolesElevated.rows.map((r) => r.rolname).join(', ') || 'aucun rôle élevé hérité',
  );

  // Mesurer les droits EFFECTIFS (y compris héritage et PUBLIC) sur chaque
  // table : une ACL directe absente ne suffit pas à prouver un refus.
  const effectiveDml = await app.query(`
    SELECT c.relname AS nom,
      has_table_privilege(current_user, c.oid, 'INSERT') AS i,
      has_table_privilege(current_user, c.oid, 'UPDATE') AS u,
      has_table_privilege(current_user, c.oid, 'DELETE') AS d
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      AND c.relname <> '_prisma_migrations'
    ORDER BY c.relname
  `);
  const allowWrite = new Set(TABLES_ECRITURE_DIRECTE);
  const unexpectedEffective = effectiveDml.rows.filter((r) =>
    (r.i || r.u || r.d) && !allowWrite.has(r.nom));
  verifier(
    'aucun DML effectif direct, hérité ou PUBLIC hors des tables autorisées',
    unexpectedEffective.length === 0,
    unexpectedEffective.map((r) => r.nom).join(', ') || 'aucun DML effectif hors allowlist',
  );

  // Le catalogue PEF et les règles de green claims sont volontairement publics,
  // mais uniquement en lecture et sur les entrées actives. Ces deux exceptions
  // n'ont pas besoin de contexte tenant ; la politique RLS doit le prouver.
  const referencePolicies = await app.query(`
    SELECT tablename,
      bool_or(cmd = 'SELECT' AND 'public' = ANY(roles)
        AND COALESCE(qual, '') ILIKE '%is_active%'
        AND COALESCE(qual, '') ILIKE '%true%') AS public_active_select
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('pef_emission_factors', 'green_claims_rules')
    GROUP BY tablename
  `);
  const referencePolicyMap = new Map(referencePolicies.rows.map((r) => [r.tablename, r.public_active_select]));
  verifier(
    'PEF et green claims ont une politique SELECT publique active-only',
    referencePolicyMap.get('pef_emission_factors') === true
      && referencePolicyMap.get('green_claims_rules') === true,
    JSON.stringify(Object.fromEntries(referencePolicyMap)),
  );

  // Le confinement ne vient PAS des privilèges de table.
  //
  // Mesure : les migrations accordent elles-mêmes `SELECT, INSERT, UPDATE,
  // DELETE ... TO PUBLIC` sur de nombreuses tables (rate_limit_counters,
  // supplier_universal_passports, transaction_certificates, ...).
  // has_table_privilege renvoie donc vrai sur 36 des 51 tables, quel que soit
  // ce que fait le provisioning. Restreindre les GRANT du bootstrap était
  // nécessaire mais non suffisant : c'est la RLS qui confine réellement.
  //
  // L'assertion porte donc sur le vrai mécanisme de confinement : toute table
  // applicative porte une RLS active ET forcée, sans exception.
  const rls = await app.query(`
    SELECT c.relname AS nom, c.relrowsecurity AS active, c.relforcerowsecurity AS forcee
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r' AND c.relname <> '_prisma_migrations'
    ORDER BY 1`);
  const sansRls = rls.rows.filter((r) => !r.active || !r.forcee).map((r) => r.nom);
  verifier(
    `toutes les tables applicatives ont la RLS active et forcée (${rls.rows.length} tables)`,
    sansRls.length === 0,
    `sans RLS active et forcée : ${sansRls.join(', ') || 'aucune'}`,
  );

  // Chaque table approuvée pour l'écriture directe doit l'accepter.
  for (const table of TABLES_ECRITURE_DIRECTE) {
    try {
      await app.query(`DELETE FROM ${table} WHERE false`);
      verifier(`écriture directe possible sur ${table}`, true);
    } catch (e) {
      verifier(`écriture directe possible sur ${table}`, false, `${e.code} ${String(e.message).split('\n')[0]}`);
    }
  }

  // Garde anti-régression centrale de C2. Mesurée par aclexplode et non par
  // has_table_privilege : cette dernière renvoie vrai dès qu'un rôle hérite du
  // droit, et ne distingue donc pas un octroi explicite d'un héritage.
  //
  // Sans la migration 20261019120000_restreindre_dml_role_applicatif, cette
  // assertion vaut 36 tables dans l'ordre réel de déploiement, parce que le bloc
  // $preserve_runtime_acl$ de la migration 20261014130000 recopie sur le rôle
  // applicatif les privilèges relationnels de PUBLIC avant de les révoquer.
  const dml = await app.query(`
    SELECT c.relname
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace,
         aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
    WHERE n.nspname='public' AND c.relkind IN ('r','p')
      AND a.grantee = '${APP_ROLE}'::regrole
      AND a.privilege_type IN ('INSERT','UPDATE','DELETE')
    GROUP BY 1 ORDER BY 1`);
  const observees = dml.rows.map((r) => r.relname);
  verifier(
    `l'écriture directe est limitée aux ${TABLES_ECRITURE_DIRECTE.length} tables approuvées`,
    JSON.stringify(observees) === JSON.stringify([...TABLES_ECRITURE_DIRECTE].sort()),
    `${observees.length} tables : ${observees.join(', ')}`,
  );

  // Aucun DML ne doit subsister pour PUBLIC. Mesuré à zéro sur l'état courant :
  // cette assertion existe parce que rien n'empêche une migration future de
  // réaccorder du DML à PUBLIC, ce que $preserve_runtime_acl$ reporterait alors
  // silencieusement sur le rôle applicatif.
  const pub = await app.query(`
    SELECT count(*)::int n
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace,
         aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m')
      AND a.grantee = 0 AND a.privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')`);
  verifier('aucun DML n est accordé à PUBLIC', pub.rows[0].n === 0, `${pub.rows[0].n} entrées`);

  // Le registre Prisma n'est pas une table applicative et n'a pas de RLS.
  // Le runtime ne doit donc pas pouvoir modifier son historique, même si une
  // future migration ajoute un GRANT par héritage ou par défaut.
  const historiqueMigrations = await app.query(`
    SELECT has_table_privilege(current_user, 'public._prisma_migrations', 'SELECT') AS s,
           has_table_privilege(current_user, 'public._prisma_migrations', 'INSERT') AS i,
           has_table_privilege(current_user, 'public._prisma_migrations', 'UPDATE') AS u,
           has_table_privilege(current_user, 'public._prisma_migrations', 'DELETE') AS d,
           has_table_privilege(current_user, 'public._prisma_migrations', 'TRUNCATE') AS t
  `);
  const hm = historiqueMigrations.rows[0];
  verifier(
    'le rôle applicatif ne peut ni lire ni modifier le registre des migrations',
    hm && !hm.s && !hm.i && !hm.u && !hm.d && !hm.t,
    JSON.stringify(hm),
  );

  const lecture = await app.query(`
    SELECT c.relname AS nom, has_table_privilege('${APP_ROLE}', c.oid, 'SELECT') AS s
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r' AND c.relname <> '_prisma_migrations' ORDER BY 1`);
  verifier(
    'la lecture reste disponible sur les tables métier',
    lecture.rows.every((r) => r.s),
    `${lecture.rows.filter((r) => !r.s).length} table(s) sans SELECT`,
  );

  /* --- 3. Comportement : ce qui doit échouer, ce qui doit passer ----------- */

  console.log('\n  4. comportement réel');

  // Écriture directe sur une table NON autorisée : doit être refusée.
  // `suppliers` n'est pas dans la liste — ses mutations passent par fonction.
  // DELETE ... WHERE false exige le privilège sans dépendre d'une colonne et ne
  // supprime aucune ligne : une première version employait un INSERT et échouait
  // sur une colonne inexistante (42703) avant même d'atteindre le privilège.
  try {
    await app.query(`DELETE FROM suppliers WHERE false`);
    verifier('écriture directe sur suppliers refusée', false, 'DELETE accepté');
  } catch (e) {
    verifier('écriture directe sur suppliers refusée', e.code === '42501', `${e.code} ${String(e.message).split('\n')[0]}`);
  }

  // Le limiteur doit pouvoir écrire : sinon toutes les requêtes tombent en 503.
  const windowMs = 300 * 1000;
  const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);
  try {
    const r = await app.query(
      `INSERT INTO rate_limit_counters (bucket_key, window_start, hits, expires_at)
       VALUES ($1, $2, 1, $3)
       ON CONFLICT (bucket_key, window_start) DO UPDATE SET hits = rate_limit_counters.hits + 1
       RETURNING hits`,
      ['controle:203.0.113.10', windowStart, new Date(windowStart.getTime() + windowMs * 2)],
    );
    verifier('le limiteur peut écrire', typeof r.rows[0]?.hits === 'number', 'aucun hits retourné');
  } catch (e) {
    verifier('le limiteur peut écrire', false, `${e.code} ${String(e.message).split('\n')[0]}`);
  }

  const politiquesFonctions = await app.query(`
    WITH bodies AS (
      SELECT COALESCE(pg_get_expr(pol.polqual, pol.polrelid), '') || ' ' ||
             COALESCE(pg_get_expr(pol.polwithcheck, pol.polrelid), '') AS body
        FROM pg_policy pol
        JOIN pg_class c ON c.oid = pol.polrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
    )
    SELECT DISTINCT (m.matches)[1] AS name
      FROM bodies b
      CROSS JOIN LATERAL regexp_matches(b.body, '(tracefab_[a-z0-9_]+)[[:space:]]*\\(', 'g') AS m(matches)
     ORDER BY name
  `);
  const fonctionsRlsObservees = politiquesFonctions.rows.map((r) => r.name);
  verifier(
    'allowlist RLS correspond exactement aux fonctions des politiques',
    JSON.stringify(fonctionsRlsObservees) === JSON.stringify([...RLS_POLICY_FUNCTION_NAMES].sort()),
    `attendues=${RLS_POLICY_FUNCTION_NAMES.length} ; observées=${fonctionsRlsObservees.length} ; différences=${[...new Set([...fonctionsRlsObservees, ...RLS_POLICY_FUNCTION_NAMES])].filter((n) => fonctionsRlsObservees.includes(n) !== RLS_POLICY_FUNCTION_NAMES.includes(n)).join(', ')}`,
  );

  // Le rôle applicatif ne doit recevoir EXECUTE que sur les fonctions SQL
  // réellement appelées par api/ ou les politiques RLS. Les fonctions
  // SECURITY DEFINER internes et les triggers restent hors de l'allowlist.
  const grantsFonctions = await app.query(`
    SELECT p.proname
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
     WHERE n.nspname = 'public'
       AND p.proname LIKE 'tracefab_%'
       AND acl.grantee = '${APP_ROLE}'::regrole
       AND acl.privilege_type = 'EXECUTE'
     ORDER BY p.proname`);
  const fonctionsObservees = grantsFonctions.rows.map((r) => r.proname);
  const fonctionsAttendues = [...RUNTIME_FUNCTION_NAMES].sort();
  verifier(
    'EXECUTE explicite correspond exactement à l allowlist runtime/RLS',
    JSON.stringify(fonctionsObservees) === JSON.stringify(fonctionsAttendues),
    `attendues=${fonctionsAttendues.length} ; observees=${fonctionsObservees.length} ; extras/manquants=${[...new Set([...fonctionsObservees, ...fonctionsAttendues])].filter((n) => fonctionsObservees.includes(n) !== fonctionsAttendues.includes(n)).join(', ')}`,
  );

  // Contrôle négatif du défaut futur : une fonction créée par le propriétaire
  // après la migration ne doit pas devenir exécutable par tracefab_app.
  const probe = new pg.Client({ connectionString: urlEphemere, ssl: sslDepuisUrl(urlEphemere) });
  await probe.connect();
  try {
    await probe.query('BEGIN');
    await probe.query(`CREATE FUNCTION public.tracefab_runtime_execute_probe() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$`);
    const futureGrant = await probe.query(
      `SELECT has_function_privilege($1, 'public.tracefab_runtime_execute_probe()', 'EXECUTE') AS allowed`,
      [APP_ROLE],
    );
    verifier(
      'une fonction future n hérite pas EXECUTE pour le runtime',
      futureGrant.rows[0]?.allowed === false,
      `allowed=${futureGrant.rows[0]?.allowed}`,
    );
  } finally {
    await probe.query('ROLLBACK');
    await probe.end();
  }

  await app.end();
  app = null;
} catch (e) {
  if (e.message !== 'migration') {
    echecs += 1;
    console.log(`  ECHEC — ${e.code ?? String(e.message).split('\n')[0]}`);
  }
  sortie = SORTIE_DEFAUT;
} finally {
  if (app) await app.end().catch(() => {});
  await admin.query(`DROP DATABASE IF EXISTS ${BASE_EPHEMERE}`);
  await admin.end();
  console.log('  base éphémère détruite');
}

console.log(`\n  ${assertions - echecs}/${assertions} assertions vertes\n`);
process.exit(echecs > 0 ? SORTIE_DEFAUT : sortie);
