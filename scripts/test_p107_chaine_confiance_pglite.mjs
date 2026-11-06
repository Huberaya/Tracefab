#!/usr/bin/env node
/**
 * P10.7 — CHAÎNE DE CONFIANCE HMAC : PREUVE PAR EXÉCUTION, PAS PAR LECTURE.
 *
 * CE QUE CE TEST FAIT
 * -------------------
 * Il applique la CHAÎNE COMPLÈTE des migrations sur un PostgreSQL jetable
 * (PGlite / PostgreSQL 18.6), provisionne une clé HMAC générée en mémoire par
 * `crypto.randomBytes` (jamais écrite sur disque, jamais affichée), active le
 * mode STRICT sur cette seule base, endosse le rôle applicatif `tracefab_app`
 * par `SET ROLE`, puis exécute les scénarios d'attaque de la mission à travers
 * de vraies transactions SQL et de vraies fonctions `SECURITY DEFINER`.
 *
 * Aucun test ne se contente de chercher une chaîne dans un fichier : chaque
 * assertion interroge le moteur. Le témoin négatif est systématique — les
 * contrôles qui doivent refuser sont accompagnés d'un contrôle qui doit
 * accepter, sinon un vérificateur cassé « réussirait » tous les refus.
 *
 * CE QUE CE TEST NE PROUVE PAS
 * ----------------------------
 * NIVEAU 1/2 UNIQUEMENT (PostgreSQL jetable local). Il ne prouve PAS Neon
 * isolé, PAS une Vercel Preview, PAS Production, PAS une requête HTTP
 * authentifiée, PAS le rôle réellement utilisé par Prisma sur un déploiement.
 * Une clé présente ici n'est pas une clé provisionnée sur un environnement
 * servant. Voir `docs/security/2026-11-06-p107-rapport-final.md`.
 *
 * Usage : npm run test:hmac:chaine-confiance
 * Sorties : 0 conforme · 1 preuve en échec · 2 PGlite absent (non exécuté).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, randomBytes } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = path.join(ROOT, 'prisma', 'migrations');

let PGlite, pgcrypto, uuid_ossp;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
  ({ pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto'));
  ({ uuid_ossp } = await import('@electric-sql/pglite/contrib/uuid_ossp'));
} catch {
  console.error('  NON EXECUTE — @electric-sql/pglite absent : npm ci avant cette suite.');
  process.exit(2);
}

let assertions = 0;
let echecs = 0;
const ok = (libelle, condition, detail = '') => {
  assertions += 1;
  if (condition) { console.log(`  ok    ${libelle}`); return true; }
  echecs += 1;
  console.error(`  ECHEC ${libelle}${detail ? ` — ${detail}` : ''}`);
  return false;
};
const section = (t) => console.log(`\n${t}\n${'-'.repeat(t.length)}`);

/* Fixtures : deux marques, deux utilisateurs, deux produits. */
const A = 'a0000000-0000-4000-8000-000000000001';
const B = 'b0000000-0000-4000-8000-000000000002';
const U_A = '10000000-0000-4000-8000-000000000002';
const U_B = '10000000-0000-4000-8000-000000000003';
const USAGE = 'tracefab_identity';
const maintenant = () => Math.floor(Date.now() / 1000);

/* -------------------------------------------------------------------------- *
 * Montage de la base jetable.
 * ------------------------------------------------------------------------- */
const db = new PGlite({ extensions: { pgcrypto, uuid_ossp } });
await db.waitReady;
const versionPG = (await db.query('SELECT version() AS v')).rows[0].v;

await db.exec(`
  CREATE ROLE tracefab_worker NOLOGIN NOSUPERUSER NOBYPASSRLS;
  CREATE ROLE tracefab_migrator NOLOGIN NOSUPERUSER NOBYPASSRLS;
  CREATE ROLE tracefab_app LOGIN PASSWORD 'runtime'
    NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION;
  GRANT USAGE ON SCHEMA public TO tracefab_app;
`);

const dossiers = fs.readdirSync(MIGRATIONS)
  .filter((d) => /^\d{14}_/.test(d) && fs.existsSync(path.join(MIGRATIONS, d, 'migration.sql')))
  .sort();
const CORRECTIF = '20261106120000_p107_hmac_forme_canonique_et_ttl';
section('S0 — montage : chaîne complète, rôles, clé, mode strict');
ok('la migration de canonicalisation P10.7 est présente dans la chaîne',
  dossiers.includes(CORRECTIF), `trouvés=${dossiers.length}`);

let appliquees = 0;
for (const d of dossiers) {
  try {
    await db.exec(fs.readFileSync(path.join(MIGRATIONS, d, 'migration.sql'), 'utf8'));
    appliquees += 1;
  } catch (e) {
    console.error(`  ECHEC migration ${d} : ${e.message}`);
    echecs += 1;
    break;
  }
}
ok(`les ${dossiers.length} migrations s'appliquent dans l'ordre sans erreur`,
  appliquees === dossiers.length, `${appliquees}/${dossiers.length}`);
ok('PostgreSQL jetable réel (pas un mock)', /PostgreSQL/i.test(versionPG), versionPG.slice(0, 60));

/* Clés : DEUX clés distinctes générées par un CSPRNG, jamais affichées. */
const cleV1 = randomBytes(32);            // Buffer, 32 octets = 256 bits
const cleV2 = randomBytes(32);
const cleFausse = randomBytes(32);
ok('clé de 32 octets issue de crypto.randomBytes', cleV1.length === 32 && cleV2.length === 32);
ok('les deux versions de clé sont distinctes', !cleV1.equals(cleV2));

await db.query(
  `INSERT INTO public.tracefab_identity_cles (version, secret, actif)
   VALUES (1, $1, true)`,
  [cleV1],
);
await db.query('UPDATE public.tracefab_identity_politique SET strict = true WHERE singleton');
const strictMesure = (await db.query(
  'SELECT strict FROM public.tracefab_identity_politique WHERE singleton')).rows[0].strict;
ok('mode STRICT réellement actif sur la base jetable', strictMesure === true, `strict=${strictMesure}`);

await db.exec(`
  INSERT INTO organizations (id,type,legal_name,status) VALUES
    ('${A}','brand','Marque A','active'),
    ('${B}','brand','Marque B','active');
  INSERT INTO users (id,clerk_user_id,email,full_name) VALUES
    ('${U_A}','clerk_a','a@example.test','Utilisateur A'),
    ('${U_B}','clerk_b','b@example.test','Utilisateur B');
  INSERT INTO organization_memberships (organization_id,user_id,role,status) VALUES
    ('${A}','${U_A}','admin','active'),
    ('${B}','${U_B}','admin','active');
  INSERT INTO tracefab_products (id,brand_organization_id,reference,name,status) VALUES
    ('20000000-0000-4000-8000-000000000001','${A}','REF-A','Produit A','draft'),
    ('20000000-0000-4000-8000-000000000002','${B}','REF-B','Produit B','draft');
`);

/* -------------------------------------------------------------------------- *
 * S1 — identité PostgreSQL : catalogue, appartenances transitives, SET ROLE.
 * ------------------------------------------------------------------------- */
section('S1 — identité PostgreSQL réellement mesurée sur la connexion');
{
  const r = (await db.query(`
    SELECT current_user::text AS cu, session_user::text AS su,
           current_database() AS base, current_schema() AS sch,
           current_setting('application_name', true) AS appl,
           pg_backend_pid() AS pid
  `)).rows[0];
  ok('current_user et session_user lus sur la connexion', r.cu === 'postgres' && r.su === 'postgres',
    `cu=${r.cu} su=${r.su}`);
  ok('base et schéma identifiés', r.base === 'postgres' || typeof r.base === 'string', `base=${r.base}`);
  ok('pg_backend_pid() renvoie un pid réel', Number.isInteger(Number(r.pid)), `pid=${r.pid}`);

  const roles = (await db.query(`
    SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls,
           rolinherit, rolcanlogin
      FROM pg_roles
     WHERE rolname IN ('tracefab_app','tracefab_worker','tracefab_migrator','neondb_owner')
     ORDER BY rolname
  `)).rows;
  const app = roles.find((x) => x.rolname === 'tracefab_app');
  ok('tracefab_app existe avec NOSUPERUSER / NOBYPASSRLS / NOCREATEROLE / NOCREATEDB',
    !!app && app.rolsuper === false && app.rolbypassrls === false
      && app.rolcreaterole === false && app.rolcreatedb === false, JSON.stringify(app));
  ok('tracefab_worker est NOLOGIN et sans BYPASSRLS',
    roles.some((x) => x.rolname === 'tracefab_worker' && x.rolcanlogin === false && x.rolbypassrls === false));

  const atteignables = (await db.query(`
    WITH RECURSIVE a(oid, profondeur) AS (
      SELECT r.oid, 0 FROM pg_roles r WHERE r.rolname = 'tracefab_app'
      UNION
      SELECT m.roleid, a.profondeur + 1
        FROM pg_auth_members m JOIN a ON a.oid = m.member
    )
    SELECT r.rolname, r.rolsuper, r.rolbypassrls
      FROM a JOIN pg_roles r ON r.oid = a.oid
  `)).rows;
  ok('aucune appartenance TRANSITIVE ne porte SUPERUSER ou BYPASSRLS',
    atteignables.every((x) => !x.rolsuper && !x.rolbypassrls),
    JSON.stringify(atteignables));

  const acl = (await db.query(`
    SELECT has_table_privilege('tracefab_app','public.tracefab_identity_cles','SELECT') AS lit_cles,
           has_table_privilege('tracefab_app','public.tracefab_identity_cles','UPDATE') AS ecrit_cles,
           has_table_privilege('tracefab_app','public.tracefab_identity_politique','SELECT') AS lit_politique,
           has_table_privilege('tracefab_app','public.tracefab_identity_politique','UPDATE') AS ecrit_politique,
           has_function_privilege('tracefab_app','public.tracefab_identity_jeton_utilisateur(text)','EXECUTE') AS verifie
  `)).rows[0];
  ok('le runtime NE PEUT PAS lire la table des clés', acl.lit_cles === false, `select=${acl.lit_cles}`);
  ok('le runtime NE PEUT PAS modifier les clés', acl.ecrit_cles === false);
  ok('le runtime peut lire le réglage mais PAS le modifier',
    acl.lit_politique === true && acl.ecrit_politique === false);
  ok('le runtime peut VÉRIFIER un jeton', acl.verifie === true);

  // Les deux seules fonctions nommées `hmac` en `public` sont les primitives
  // pgcrypto (immutable, SECURITY INVOKER, sans aucune clé) : ce ne sont PAS des
  // oracles de signature. Ce qu'on refuse, c'est une fonction APPLICATIVE qui
  // signerait ou rendrait un MAC à partir des clés stockées.
  const primitives = (await db.query(`
    SELECT p.proname, p.prosecdef, p.provolatile, pg_get_function_result(p.oid) AS resultat
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'hmac'
  `)).rows;
  ok('les primitives hmac présentes sont bien pgcrypto (invoker, immutable, bytea)',
    primitives.length >= 1 && primitives.every((f) => f.prosecdef === false
      && f.provolatile === 'i' && f.resultat === 'bytea'), JSON.stringify(primitives));

  const signantes = (await db.query(`
    SELECT p.proname, pg_get_function_result(p.oid) AS resultat
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND (p.proname ILIKE '%sign%' OR p.proname ILIKE '%signature%'
            OR p.proname ILIKE '%mac%' OR p.proname ILIKE '%hmac%')
       AND p.proname <> 'hmac'
  `)).rows;
  ok('aucune fonction applicative ne SIGNE et aucune ne rend un MAC',
    signantes.length === 0, signantes.map((f) => f.proname).join(', '));

  const resultatVerif = (await db.query(`
    SELECT pg_get_function_result(p.oid) AS r
      FROM pg_proc p
     WHERE p.oid = 'public.tracefab_identity_jeton_utilisateur(text)'::regprocedure
  `)).rows[0].r;
  ok('le vérificateur ne rend qu’un UUID ou NULL (jamais un MAC)', resultatVerif === 'uuid', resultatVerif);

  // Preuve comportementale : même avec la primitive HMAC publique, le runtime
  // ne peut pas fabriquer une signature avec une clé stockée.
  let signatureAvecCleStockeeRefusee = false;
  await db.exec('SET ROLE tracefab_app');
  try {
    await db.query(`SELECT public.hmac(convert_to('v1|forge','UTF8'),
      (SELECT secret FROM public.tracefab_identity_cles LIMIT 1), 'sha256')`);
  } catch (e) { signatureAvecCleStockeeRefusee = /permission denied|42501/i.test(e.message); }
  await db.exec('RESET ROLE');
  ok('le runtime ne peut PAS calculer un MAC avec une clé stockée',
    signatureAvecCleStockeeRefusee);
}

/* -------------------------------------------------------------------------- *
 * S2 — endossement du rôle applicatif et tentative d'élévation.
 * ------------------------------------------------------------------------- */
section('S2 — SET ROLE, élévation refusée, frontière de confiance');
{
  await db.exec('SET ROLE tracefab_app');
  const ident = (await db.query(`
    SELECT current_user::text AS cu, session_user::text AS su
  `)).rows[0];
  ok('current_user = tracefab_app après SET ROLE', ident.cu === 'tracefab_app', `cu=${ident.cu}`);
  ok('session_user reste la connexion d’origine (différence documentée)',
    ident.su === 'postgres', `su=${ident.su}`);

  // NOTE D'EXACTITUDE : sous `SET ROLE` seul, `session_user` reste `postgres`
  // (superutilisateur), et PostgreSQL autorise alors `SET ROLE` vers n'importe
  // quel rôle — c'est un artefact du harnais, PAS le comportement d'un
  // déploiement où le serveur se CONNECTE en `tracefab_app`. La vraie mesure
  // d'élévation est faite en S9 avec `SET SESSION AUTHORIZATION`.
  ok('sous SET ROLE seul, session_user reste superutilisateur (artefact identifié)',
    ident.su === 'postgres', `su=${ident.su}`);

  let refusLectureCles = false;
  try { await db.query('SELECT secret FROM public.tracefab_identity_cles LIMIT 1'); }
  catch (e) { refusLectureCles = /permission denied|42501/i.test(e.message); }
  ok('SELECT sur les clés est REFUSÉ au runtime (mesure réelle, pas un GRANT lu)',
    refusLectureCles);

  let refusBasculeStrict = false;
  try { await db.query('UPDATE public.tracefab_identity_politique SET strict = false WHERE singleton'); }
  catch (e) { refusBasculeStrict = /permission denied|42501/i.test(e.message); }
  ok('le runtime ne peut PAS désactiver le mode strict', refusBasculeStrict);
}

/* -------------------------------------------------------------------------- *
 * Helpers : signature (côté application) et transaction (côté base).
 * ------------------------------------------------------------------------- */
const corpsDe = ({ userId = U_A, org = A, exp = maintenant() + 60,
                   usage = USAGE, version = 'v1' } = {}) =>
  `${version}|${userId}|${org}|${usage}|${exp}`;

const signer = (opts = {}) => {
  const cle = opts.cle ?? cleV1;
  const corps = opts.corpsBrut ?? corpsDe(opts);
  const mac = createHmac('sha256', cle).update(corps).digest('hex');
  return `${corps}.${mac}`;
};

/** Une « requête » : transaction réelle, GUC transactionnels, toujours annulée. */
async function requete(gucs, corps) {
  await db.exec('BEGIN');
  try {
    for (const [cle, valeur] of Object.entries(gucs)) {
      if (valeur !== undefined) {
        await db.query('SELECT set_config($1, $2, true)', [cle, valeur]);
      }
    }
    return await corps();
  } finally {
    await db.exec('ROLLBACK').catch(() => {});
  }
}

const identiteDans = (jeton, org = A, gucs = {}) => requete({
  'tracefab.identity': jeton,
  'tracefab.active_organization_id': org,
  ...gucs,
}, async () => {
  const r = await db.query('SELECT public.tracefab_current_user_id()::text AS id');
  return r.rows[0].id;
});

/* -------------------------------------------------------------------------- *
 * S3 — les 20 scénarios cryptographiques de la mission.
 * ------------------------------------------------------------------------- */
section('S3 — 20 scénarios cryptographiques (signature, falsification, rejeu)');
{
  const T = signer();
  const C = [];
  const cas = (id, libelle, attendu, obtenu) =>
    C.push({ id, libelle, reussi: attendu === obtenu, attendu, obtenu });

  cas('C01', 'signature valide', U_A, await identiteDans(T));
  cas('C02', 'signature modifiée', null, await identiteDans(T.slice(0, -1) + (T.endsWith('a') ? 'b' : 'a')));
  cas('C03', 'identité modifiée APRÈS signature', null, await identiteDans(
    signer({ userId: U_B }).replace(U_B, U_A) /* MAC du corps U_B, corps U_A */));
  cas('C04', 'tenant modifié APRÈS signature', null, await identiteDans(T, B));
  cas('C05', 'usage (catégorie de contexte) non autorisé dans le corps signé', null, await identiteDans(
    signer({ usage: 'tracefab_system' })));
  cas('C06', 'expiration dépassée', null, await identiteDans(signer({ exp: maintenant() - 5 })));
  cas('C07', 'signature absente', null, await identiteDans(''));
  cas('C08', 'clé absente (jeton signé par une clé non provisionnée)', null,
    await identiteDans(signer({ cle: cleFausse })));
  cas('C09', 'clé incorrecte / MAC d’une autre clé', null, await identiteDans(
    `${corpsDe()}.${createHmac('sha256', cleFausse).update(corpsDe()).digest('hex')}`));
  cas('C10', 'version de protocole inconnue', null, await identiteDans(signer({ version: 'v9' })));
  cas('C11', 'champ obligatoire absent', null, await identiteDans(
    (() => { const c = 'v1||' + A + '|' + USAGE + '|' + (maintenant() + 60);
      return `${c}.${createHmac('sha256', cleV1).update(c).digest('hex')}`; })()));
  cas('C12', 'sérialisation ambiguë : suffixe après le MAC', null, await identiteDans(`${T}.EXTRA`));
  cas('C13', 'mauvaise catégorie de contexte', null,
    await identiteDans(signer({ usage: 'tracefab_identity_systeme' })));
  cas('C14', 'signature d’un autre usage réutilisée', null,
    await identiteDans(signer({ usage: 'tracefab_worker' })));
  cas('C15', 'réutilisation dans une AUTRE transaction (rejeu)', U_A,
    await identiteDans(T)); // MESURE : le jeton v1 est encore accepté -> risque R1
  cas('C16', 'rejeu d’une signature expirée', null,
    await identiteDans(signer({ exp: maintenant() - 1 })));
  cas('C17', 'rotation : jeton de l’ancienne clé encore accepté', U_A,
    await (async () => {
      await db.exec('RESET ROLE');
      await db.query('INSERT INTO public.tracefab_identity_cles (version, secret, actif) VALUES (2, $1, true)', [cleV2]);
      await db.exec('SET ROLE tracefab_app');
      return identiteDans(T);
    })());
  cas('C18', 'révocation : ancienne clé désactivée, ancien jeton refusé', null,
    await (async () => {
      await db.exec('RESET ROLE');
      await db.query('UPDATE public.tracefab_identity_cles SET actif = false WHERE version = 1');
      await db.exec('SET ROLE tracefab_app');
      return identiteDans(T);
    })());
  cas('C19', 'contexte utilisateur / tenant incohérent', null, await (async () => {
    const jetonB = signer({ userId: U_B, org: B, cle: cleV2 });
    return identiteDans(jetonB, A);
  })());
  cas('C20', 'fabrication d’un contexte par le runtime (GUC seul, strict)', null,
    await identiteDans('', A, { 'tracefab.user_id': U_A, 'tracefab.user_email': 'forge@example.test' }));

  for (const c of C) {
    ok(`${c.id} ${c.libelle}`, c.reussi, `attendu=${c.attendu} obtenu=${c.obtenu}`);
  }
  // Témoins positifs : le vérificateur n'est pas simplement « toujours NULL ».
  const T2 = signer({ cle: cleV2 });
  ok('TÉMOIN POSITIF : jeton valide signé par la nouvelle clé accepté',
    (await identiteDans(T2)) === U_A);
  ok('la réutilisation dans une même transaction reste possible (multi-appels RLS)',
    await requete({
      'tracefab.identity': T2,
      'tracefab.active_organization_id': A,
    }, async () => {
      const a = await db.query('SELECT public.tracefab_current_user_id()::text AS id');
      const b = await db.query('SELECT public.tracefab_current_user_id()::text AS id');
      return a.rows[0].id === U_A && b.rows[0].id === U_A;
    }));
  // Mesure EXPLICITE du risque résiduel, jamais présentée comme une protection.
  const rejoue = await identiteDans(T2);
  ok('MESURE DU RISQUE R1 : un jeton valide est rejouable dans une transaction distincte',
    rejoue === U_A, `identité rendue=${rejoue}`);
}

/* -------------------------------------------------------------------------- *
 * S4 — forme canonique et plafond d'expiration (correctif 20261106120000).
 * ------------------------------------------------------------------------- */
section('S4 — canonicalisation et durée de vie bornée (défauts D1/D2 mesurés puis fermés)');
{
  const T = signer({ cle: cleV2 });
  ok('jeton canonique accepté', (await identiteDans(T)) === U_A);
  ok('D1 suffixe après le MAC : REFUSÉ', (await identiteDans(`${T}.EVIL`)) === null);
  ok('D1 deux points : REFUSÉ', (await identiteDans(`${T}.x.y`)) === null);
  ok('D1 MAC tronqué : REFUSÉ', (await identiteDans(T.slice(0, -2))) === null);
  ok('D1 MAC non hexadécimal : REFUSÉ',
    (await identiteDans(`${corpsDe()}.${'z'.repeat(64)}`)) === null);
  ok('D2 expiration quasi-perpétuelle : REFUSÉE',
    (await identiteDans(signer({ cle: cleV2, exp: 999999999999 }))) === null);
  ok('D2 expiration au-delà du plafond de 600 s : REFUSÉE',
    (await identiteDans(signer({ cle: cleV2, exp: maintenant() + 3600 }))) === null);
  ok('D2 expiration à la seconde courante : REFUSÉE',
    (await identiteDans(signer({ cle: cleV2, exp: maintenant() }))) === null);
  ok('D2 expiration légitime de +120 s : ACCEPTÉE',
    (await identiteDans(signer({ cle: cleV2, exp: maintenant() + 120 }))) === U_A);
  ok('D2 borne haute juste sous le plafond : ACCEPTÉE',
    (await identiteDans(signer({ cle: cleV2, exp: maintenant() + 599 }))) === U_A);
  ok('D1 champs surnuméraires dans le corps : REFUSÉS',
    (await identiteDans((() => {
      const c = `${corpsDe()}|EXTRA`;
      return `${c}.${createHmac('sha256', cleV2).update(c).digest('hex')}`;
    })())) === null);
}

/* -------------------------------------------------------------------------- *
 * S5 — GUC, portée transactionnelle et réutilisation de la connexion (pool).
 * ------------------------------------------------------------------------- */
section('S5 — GUC transactionnels : A → B → sans contexte → falsifié → erreur → reprise');
{
  const TA = signer({ userId: U_A, org: A, cle: cleV2 });
  const TB = signer({ userId: U_B, org: B, cle: cleV2 });

  const rA = await requete({ 'tracefab.identity': TA, 'tracefab.active_organization_id': A },
    async () => (await db.query('SELECT public.tracefab_current_user_id()::text AS id')).rows[0].id);
  ok('requête A authentifiée sous tenant A', rA === U_A, `id=${rA}`);

  const apresA = await db.query(`SELECT coalesce(current_setting('tracefab.identity', true),'') AS j,
    coalesce(current_setting('tracefab.active_organization_id', true),'') AS o`);
  ok('après la fin de A, aucun GUC ne subsiste sur la connexion réutilisée',
    apresA.rows[0].j === '' && apresA.rows[0].o === '', JSON.stringify(apresA.rows[0]));

  const rB = await requete({ 'tracefab.identity': TB, 'tracefab.active_organization_id': B },
    async () => (await db.query('SELECT public.tracefab_current_user_id()::text AS id')).rows[0].id);
  ok('requête B sur la MÊME connexion n’hérite pas de A', rB === U_B, `id=${rB}`);

  const rC = await requete({}, async () =>
    (await db.query('SELECT public.tracefab_current_user_id()::text AS id')).rows[0].id);
  ok('requête C sans contexte : identité NULL (fail-closed)', rC === null, `id=${rC}`);

  // Falsification DÉTERMINISTE : remplacer le dernier octet par une valeur
  // DIFFÉRENTE. Un remplacement fixe par '0' était sans effet un seizième du
  // temps (quand le MAC se terminait déjà par 0) et rendait la suite instable.
  const dernier = TA.slice(-1);
  const TAfalsifie = TA.slice(0, -1) + (dernier === 'a' ? 'b' : 'a');
  const rD = await requete({
    'tracefab.identity': TAfalsifie,
    'tracefab.active_organization_id': A,
    'tracefab.user_id': U_A,
  }, async () => (await db.query('SELECT public.tracefab_current_user_id()::text AS id')).rows[0].id);
  ok('requête D avec signature falsifiée + GUC forgé : identité NULL', rD === null, `id=${rD}`);

  // Erreur au milieu d'une transaction, rollback, puis nouvelle requête saine.
  let erreurObservee = false;
  try {
    await requete({ 'tracefab.identity': TA, 'tracefab.active_organization_id': A }, async () => {
      await db.query('SELECT 1/0');
      return 'jamais';
    });
  } catch { erreurObservee = true; }
  ok('une erreur SQL au milieu d’une transaction est bien propagée', erreurObservee);

  const apresErreur = await db.query(
    `SELECT coalesce(current_setting('tracefab.identity', true),'') AS j`);
  ok('après ROLLBACK, la connexion ne conserve aucun jeton',
    apresErreur.rows[0].j === '', `jeton=${apresErreur.rows[0].j}`);
  const rE = await requete({ 'tracefab.identity': TB, 'tracefab.active_organization_id': B },
    async () => (await db.query('SELECT public.tracefab_current_user_id()::text AS id')).rows[0].id);
  ok('nouvelle requête après erreur : identité correcte, aucune contamination', rE === U_B, `id=${rE}`);

  // Le GUC public/worker ne doit jamais ouvrir une identité privée en strict.
  const rPublic = await requete({
    'tracefab.public_context': 'true',
    'tracefab.worker_context': 'true',
    'tracefab.user_id': U_A,
  }, async () => (await db.query('SELECT public.tracefab_current_user_id()::text AS id')).rows[0].id);
  ok('contexte public/worker + GUC forgé ne crée AUCUNE identité en strict',
    rPublic === null, `id=${rPublic}`);
}

/* -------------------------------------------------------------------------- *
 * S6 — compatibilité RLS et parcours métier en mode strict.
 * ------------------------------------------------------------------------- */
section('S6 — compatibilité RLS sous le rôle applicatif, mode strict actif');
{
  const TA = signer({ userId: U_A, org: A, cle: cleV2 });
  const TB = signer({ userId: U_B, org: B, cle: cleV2 });
  const visibles = (jeton, org) => requete({
    'tracefab.identity': jeton,
    'tracefab.active_organization_id': org,
  }, async () => {
    const r = await db.query('SELECT count(*)::int AS n FROM tracefab_products');
    return r.rows[0].n;
  });
  const nA = await visibles(TA, A);
  const nB = await visibles(TB, B);
  ok('le tenant A voit au moins son produit avec un jeton valide', nA >= 1, `n=${nA}`);
  ok('le tenant B voit au moins son produit avec un jeton valide', nB >= 1, `n=${nB}`);
  const nSansJeton = await requete({ 'tracefab.active_organization_id': A }, async () => {
    const r = await db.query('SELECT count(*)::int AS n FROM tracefab_products');
    return r.rows[0].n;
  });
  ok('sans jeton en mode strict, aucune donnée métier n’est exposée',
    nSansJeton === 0, `n=${nSansJeton}`);
}

/* -------------------------------------------------------------------------- *
 * S7 — inventaire des fonctions privilégiées de la chaîne d'identité.
 * ------------------------------------------------------------------------- */
section('S7 — fonctions SECURITY DEFINER : propriétaire, search_path, exposition');
{
  await db.exec('RESET ROLE');
  const toutes = (await db.query(`
    SELECT p.proname, pg_get_userbyid(p.proowner) AS proprietaire,
           p.proconfig,
           coalesce(p.proacl::text, '') AS acl,
           EXISTS (
             SELECT 1 FROM pg_catalog.aclexplode(
               coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
              WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
           ) AS public_execute
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.prosecdef
     ORDER BY p.proname
  `)).rows;
  ok('des fonctions SECURITY DEFINER existent (l’inventaire n’est pas vide)',
    toutes.length > 0, `n=${toutes.length}`);
  const sansSearchPath = toutes.filter((f) =>
    !Array.isArray(f.proconfig) || !f.proconfig.some((c) => String(c).startsWith('search_path=')));
  ok('TOUTES les fonctions SECURITY DEFINER ont un search_path épinglé',
    sansSearchPath.length === 0, sansSearchPath.map((f) => f.proname).join(', '));
  const exposees = toutes.filter((f) => f.public_execute === true);
  ok('AUCUNE fonction SECURITY DEFINER n’est exécutable par PUBLIC',
    exposees.length === 0, exposees.map((f) => f.proname).join(', '));
  const verif = toutes.find((f) => f.proname === 'tracefab_identity_jeton_utilisateur');
  ok('le vérificateur HMAC est SECURITY DEFINER avec search_path épinglé',
    !!verif && Array.isArray(verif.proconfig)
      && verif.proconfig.some((c) => String(c).includes('search_path=pg_catalog, public')),
    JSON.stringify(verif));
  ok('le vérificateur n’est pas exécutable par PUBLIC',
    !!verif && verif.public_execute === false);
  const registre = (await db.query(
    `SELECT count(*)::int AS n FROM public.tracefab_runtime_function_registry
      WHERE name = 'tracefab_identity_jeton_utilisateur'`)).rows[0].n;
  ok('le vérificateur figure au registre runtime', registre === 1, `n=${registre}`);
  await db.exec('SET ROLE tracefab_app');
}

/* -------------------------------------------------------------------------- *
 * S8 — fail-closed : indisponibilité du vérificateur.
 * ------------------------------------------------------------------------- */
section('S8 — fail-closed : aucune clé active, vérificateur indisponible');
{
  await db.exec('RESET ROLE');
  await db.query('UPDATE public.tracefab_identity_cles SET actif = false');
  await db.exec('SET ROLE tracefab_app');
  const T = signer({ cle: cleV2 });
  ok('aucune clé active : un jeton pourtant bien signé est REFUSÉ',
    (await identiteDans(T)) === null);
  ok('aucune clé active : un GUC forgé ne devient pas une identité',
    (await requete({ 'tracefab.user_id': U_A, 'tracefab.active_organization_id': A },
      async () => (await db.query('SELECT public.tracefab_current_user_id()::text AS id')).rows[0].id)) === null);
  ok('le réglage strict n’a pas été désactivé par le runtime',
    (await db.query('SELECT strict FROM public.tracefab_identity_politique WHERE singleton')).rows[0].strict === true);
  await db.exec('RESET ROLE');
}

/* -------------------------------------------------------------------------- *
 * S9 — vraie connexion applicative : `SET SESSION AUTHORIZATION tracefab_app`.
 * C'est la seule modélisation fidèle du déploiement (session_user = role de
 * connexion). Sous une simple session superutilisateur, `SET ROLE` est permis
 * par PostgreSQL et toute conclusion d'élévation serait fausse.
 * ------------------------------------------------------------------------- */
section('S9 — connexion applicative réelle : élévation de privilèges refusée');
{
  await db.exec('RESET ROLE');
  await db.exec('SET SESSION AUTHORIZATION tracefab_app');
  const ident = (await db.query(
    'SELECT current_user::text AS cu, session_user::text AS su')).rows[0];
  ok('current_user = session_user = tracefab_app (connexion réelle)',
    ident.cu === 'tracefab_app' && ident.su === 'tracefab_app', JSON.stringify(ident));

  const tentatives = ['tracefab_worker', 'tracefab_migrator', 'postgres', 'neondb_owner'];
  for (const cible of tentatives) {
    let refuse = false;
    try { await db.exec(`SET ROLE ${cible}`); } catch { refuse = true; }
    ok(`SET ROLE ${cible} REFUSÉ depuis la connexion applicative`, refuse);
  }
  let refusLecture = false;
  try { await db.query('SELECT secret FROM public.tracefab_identity_cles LIMIT 1'); }
  catch (e) { refusLecture = /permission denied|42501/i.test(e.message); }
  ok('la connexion applicative ne peut pas lire les clés', refusLecture);
  let refusRls = false;
  try { await db.query('ALTER TABLE public.tracefab_identity_cles DISABLE ROW LEVEL SECURITY'); }
  catch (e) { refusRls = /permission denied|42501|must be owner/i.test(e.message); }
  ok('la connexion applicative ne peut pas désactiver RLS', refusRls);
}

await db.close();

console.log(`\n${'='.repeat(72)}`);
console.log(`  P10.7 chaîne de confiance — ${assertions} assertions, ${echecs} échec(s)`);
console.log(`  Environnement : PostgreSQL jetable local (PGlite), AUCUNE base distante.`);
console.log(`  Clé HMAC : générée en mémoire, jamais affichée, jamais versionnée.`);
console.log(`  Ce résultat ne vaut PAS pour Neon, Preview ou Production.`);
console.log('='.repeat(72));
process.exit(echecs === 0 ? 0 : 1);
