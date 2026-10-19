#!/usr/bin/env node
/**
 * Privileges d'execution des fonctions SECURITY DEFINER.
 *
 * POURQUOI CE TEST EXISTE
 *
 * Le durcissement 20261007100000 voulait garantir qu'aucune fonction n'est
 * executable par PUBLIC. Il a retire le droit sur les fonctions existantes,
 * puis pose une instruction qu'il croyait proteger les suivantes :
 *
 *   ALTER DEFAULT PRIVILEGES ... IN SCHEMA public
 *     REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
 *
 * Cette instruction ne fait rien. Les defauts par schema ne font qu'ajouter
 * au defaut global, et l'EXECUTE de PUBLIC sur les fonctions est un defaut
 * integre du moteur : il n'a jamais ete accorde, donc il ne peut pas etre
 * retire. Consequence mesuree : les fonctions creees APRES le durcissement
 * sont nees executables par PUBLIC, et la migration 20261009120000 en a meme
 * accorde une explicitement.
 *
 * Ce test mesure l'etat reel du catalogue, et il echoue quand l'invariant est
 * faux. Il ne compte pas des drapeaux : il interroge `has_function_privilege`.
 *
 * CE QU'IL VERIFIE
 *
 *   A. aucune fonction SECURITY DEFINER n'est executable par PUBLIC ;
 *   B. le role applicatif peut executer ce dont les politiques ont besoin —
 *      sinon la RLS devient « permission denied » au lieu de filtrer ;
 *   C. la fonction de la politique `materials_select_authorized` est
 *      executable par le role applicatif, par mesure et non par lecture ;
 *   D. le defaut global est bien ferme pour les fonctions a venir — la
 *      migration corrective est eprouvee dans les deux sens, en creant une
 *      fonction temoin dans une transaction annulee.
 *
 * Sortie 2 si aucune connexion n'est fournie : un test qui n'a pas tourne
 * n'est pas un test qui passe.
 *
 * Lecture seule pour l'etat existant. La seule ecriture est une fonction
 * temoin creee puis annulee par ROLLBACK.
 */
import pg from 'pg';

const ADMIN_URL = process.env.DATABASE_URL;
const APP_URL = process.env.TF_RLS_APP_URL || null;

if (!ADMIN_URL) {
  console.log('  NON EXECUTE — DATABASE_URL manquant : ce test a besoin d une base.');
  console.log('  Un test qui ne tourne pas ne vaut pas un test qui passe : sortie 2.');
  process.exit(2);
}

const TLS = /sslmode=(require|verify|prefer)/.test(ADMIN_URL);
const ssl = TLS ? { rejectUnauthorized: true } : undefined;

let echecs = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const ko = (m) => { echecs += 1; console.log(`  ECHEC ${m}`); };

const db = new pg.Client({ connectionString: ADMIN_URL, ssl });
await db.connect();

const proprio = (await db.query('SELECT current_user AS r')).rows[0].r;
console.log(`  connexion etablie | proprietaire : ${proprio}`);

// ---------------------------------------------------------------------------
// A. Aucune fonction SECURITY DEFINER executable par PUBLIC
// ---------------------------------------------------------------------------
// La requete est nommee, et non inline, pour que le controle negatif G teste
// EXACTEMENT le detecteur de production. Un controle negatif qui reecrit sa
// propre requete ne prouve rien sur celle qui tourne.
const REQUETE_FONCTIONS_PUBLIQUES = `
  SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args,
         pg_get_userbyid(p.proowner) AS proprietaire,
         EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE') AS public_peut
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.prosecdef
    AND EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE')
  ORDER BY p.proname`;

const publiques = (await db.query(REQUETE_FONCTIONS_PUBLIQUES)).rows;

const totalSecdef = (await db.query(`
  SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.prosecdef`)).rows[0].n;

if (publiques.length === 0) {
  ok(`A. aucune des ${totalSecdef} fonctions SECURITY DEFINER n est executable par PUBLIC`);
} else {
  ko(`A. ${publiques.length} fonction(s) SECURITY DEFINER executable(s) par PUBLIC sur ${totalSecdef}`);
  for (const f of publiques.slice(0, 10)) console.log(`          ${f.proname}(${f.args}) — proprietaire ${f.proprietaire}`);
  console.error('\n  Une fonction SECURITY DEFINER s execute avec les droits de son');
  console.error('  proprietaire. Executable par PUBLIC, tout role connecte peut l appeler.');
  console.error('  Correctif : migration 20261012120000_close_public_execute_gap.');
}

// ---------------------------------------------------------------------------
// B. Le role applicatif peut executer les fonctions appelees par les politiques
// ---------------------------------------------------------------------------
const roleApplicatif = 'tracefab_app';
const roleExiste = (await db.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [roleApplicatif])).rows.length > 0;

if (!roleExiste) {
  console.log(`  ---- B. role ${roleApplicatif} absent de cette base : verification ignoree`);
  console.log('          (il est cree par scripts/seed_rls_fixture.mjs sur une base de test)');
} else {
  // Les fonctions referencees par le corps des politiques RLS du schema public.
  const appelees = (await db.query(`
    WITH politiques AS (
      SELECT p.polname, p.polrelid, pg_get_expr(p.polqual, p.polrelid) AS qual
      FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND p.polqual IS NOT NULL
    ), appels AS (
      SELECT DISTINCT (regexp_matches(qual, 'tracefab_[a-z_]+\\s*\\(', 'g'))[1] AS nom
      FROM politiques
    )
    SELECT a.nom, p.oid, pg_get_function_identity_arguments(p.oid) AS args,
           has_function_privilege($1, p.oid, 'EXECUTE') AS peut
    FROM appels a
    JOIN pg_proc p ON p.proname = trim(trailing '(' from a.nom)
    JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
    ORDER BY a.nom`, [roleApplicatif])).rows;

  if (appelees.length === 0) {
    ok(`B. aucune fonction tracefab_* appelee par une politique — rien a verifier`);
  } else {
    const refusees = appelees.filter((f) => !f.peut);
    if (refusees.length === 0) {
      ok(`B. ${roleApplicatif} peut executer les ${appelees.length} fonction(s) appelee(s) par les politiques`);
    } else {
      ko(`B. ${roleApplicatif} ne peut pas executer ${refusees.length} fonction(s) appelee(s) par une politique`);
      for (const f of refusees.slice(0, 10)) console.log(`          ${f.nom}(${f.args})`);
      console.error('\n  Une politique dont la fonction n est pas executable leve');
      console.error('  « permission denied for function » au lieu de filtrer des lignes.');
    }
  }
}

// ---------------------------------------------------------------------------
// C. La fonction de la politique materials, mesuree et non lue
// ---------------------------------------------------------------------------
const cible = 'public.tracefab_material_visible_via_product(uuid)';
const existe = (await db.query('SELECT to_regprocedure($1) AS oid', [cible])).rows[0].oid;

if (!existe) {
  ko(`C. fonction obligatoire absente de cette base : ${cible}`);
} else {
  const etat = (await db.query(`
    SELECT EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE') AS public_peut,
           pg_get_userbyid(p.proowner) AS proprietaire,
           p.prosecdef
    FROM pg_proc p WHERE p.oid = $1::regprocedure`, [cible])).rows[0];

  if (!etat.prosecdef) {
    ko(`C. ${cible} n est plus SECURITY DEFINER — la politique materials bouclerait`);
  } else if (etat.public_peut) {
    ko(`C. ${cible} est executable par PUBLIC (c est la regression de 20261009120000:75)`);
  } else if (roleExiste) {
    const appPeut = (await db.query('SELECT has_function_privilege($1, $2::regprocedure, $3) AS peut',
      [roleApplicatif, cible, 'EXECUTE'])).rows[0].peut;
    appPeut
      ? ok(`C. ${cible} — SECURITY DEFINER, fermee a PUBLIC, ouverte a ${roleApplicatif}`)
      : ko(`C. ${cible} — fermee a PUBLIC mais ${roleApplicatif} ne peut pas l executer : lecture de materials cassee`);
  } else {
    ok(`C. ${cible} — SECURITY DEFINER et fermee a PUBLIC`);
  }
}

// ---------------------------------------------------------------------------
// D. Le defaut pour les fonctions a venir est-il reellement ferme ?
// ---------------------------------------------------------------------------
// Une fonction temoin est creee puis annulee. Une verification qui se contente
// de lire pg_default_acl ne prouve rien : c'est exactement l'erreur du
// durcissement precedent, qui lisait une instruction au lieu de mesurer une
// fonction. On mesure donc une fonction.
{
  await db.query('BEGIN');
  try {
    await db.query(`CREATE FUNCTION public.tracefab_privilege_probe() RETURNS boolean LANGUAGE sql STABLE AS $probe$ SELECT true $probe$`);
    const temoin = (await db.query(`
      SELECT EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE') AS public_peut, p.proacl::text AS acl
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'tracefab_privilege_probe'`)).rows[0];

    if (temoin.public_peut) {
      ko('D. une fonction creee maintenant est encore executable par PUBLIC — le defaut n est pas ferme');
      console.error('\n  C est le defaut que la migration 20261007100000 croyait fermer.');
      console.error('  La forme utile est globale, sans « IN SCHEMA » :');
      console.error(`    ALTER DEFAULT PRIVILEGES FOR ROLE ${proprio} REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;`);
      console.error('  Correctif : migration 20261012120000_close_public_execute_gap.\n');
    } else {
      ok(`D. une fonction creee par ${proprio} n est plus executable par PUBLIC (acl ${temoin.acl})`);
    }
  } finally {
    await db.query('ROLLBACK');
  }

  const reste = (await db.query(`
    SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'tracefab_privilege_probe'`)).rows[0].n;
  reste === 0
    ? ok('D. la fonction temoin a bien ete annulee par ROLLBACK')
    : ko('D. la fonction temoin subsiste : le ROLLBACK n a pas fonctionne');
}

// ---------------------------------------------------------------------------
// F. Un role non privilegie se voit REFUSER l execution
// ---------------------------------------------------------------------------
// L'invariant A dit que PUBLIC ne peut pas executer ces fonctions. Un
// invariant sur le pseudo-role PUBLIC pourrait etre vrai alors qu'un role
// reel, lui, passe — par heritage, par un GRANT nominatif oublie, ou par une
// adhesion de role. La seule mesure qui tranche est celle-ci : creer un role
// qui n'a rien recu, et constater le refus.
//
// Le role est cree dans une transaction qui est TOUJOURS annulee : rien ne
// subsiste, et le test est rejouable.
{
  const FONCTIONS_A_FERMER = [
    'public.tracefab_material_visible_via_product(uuid)',
    'public.tracefab_product_is_public(uuid)',
    'public.tracefab_material_is_public(uuid)',
    'public.tracefab_supplier_site_is_public(uuid)',
    'public.tracefab_public_brand(uuid)',
    'public.tracefab_public_context()',
  ];

  await db.query('BEGIN');
  try {
    const nomRole = 'tracefab_sondage_sans_droit';
    const dejaLa = (await db.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [nomRole])).rows.length > 0;
    if (dejaLa) {
      ko(`F. le role sonde ${nomRole} existe deja : le controle serait fausse`);
    } else {
      await db.query(`CREATE ROLE ${nomRole} NOLOGIN`);
      const resultats = [];
      for (const signature of FONCTIONS_A_FERMER) {
        const existe = (await db.query('SELECT to_regprocedure($1) AS oid', [signature])).rows[0].oid;
        if (!existe) {
          ko(`F. fonction obligatoire absente de cette base : ${signature}`);
          continue;
        }
        const peut = (await db.query('SELECT has_function_privilege($1, $2::regprocedure, $3) AS peut',
          [nomRole, signature, 'EXECUTE'])).rows[0].peut;
        resultats.push([signature, peut]);
      }
      const ouvertes = resultats.filter(([, peut]) => peut);
      if (resultats.length === 0) {
        ok('F. aucune des fonctions visees n existe ici : rien a mesurer');
      } else if (ouvertes.length === 0) {
        ok(`F. un role sans aucun droit ne peut executer aucune des ${resultats.length} fonction(s) visees`);
      } else {
        ko(`F. ${ouvertes.length} fonction(s) restent executables par un role sans droit`);
        for (const [signature] of ouvertes) console.log(`          ${signature}`);
        console.error('\n  Le pseudo-role PUBLIC peut etre ferme alors qu un role reel passe encore,');
        console.error('  par heritage ou par un GRANT nominatif oublie. Chercher un GRANT explicit.');
      }
    }
  } catch (error) {
    ko(`F. le controle de refus n a pas pu s executer : ${String(error.message).split('\n')[0]}`);
  } finally {
    await db.query('ROLLBACK').catch(() => {});
  }

  const reste = (await db.query("SELECT count(*)::int AS n FROM pg_roles WHERE rolname = 'tracefab_sondage_sans_droit'")).rows[0].n;
  reste === 0
    ? ok('F. le role sonde a bien ete annule par ROLLBACK')
    : ko('F. le role sonde subsiste : le ROLLBACK n a pas fonctionne');
}

// ---------------------------------------------------------------------------
// G. CONTROLE NEGATIF — le detecteur attrape-t-il une porte rouverte ?
// ---------------------------------------------------------------------------
// A dit « aucune fonction executable par PUBLIC ». Un constat vide ne prouve
// pas que la mesure fonctionne : elle pourrait interroger la mauvaise colonne
// et renvoyer zero quoi qu'il arrive. On rouvre donc la porte exprès, dans une
// transaction annulee, et on EXIGE que le detecteur de A la voie.
//
// Ce scenario n'est pas theorique : mesure faite sur base jetable (sonde du
// 2026-10-12), un ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ...
// TO PUBLIC re-ouvre l'execution par PUBLIC pour les fonctions a venir, alors
// que la regle globale, elle, reste fermee. C'est le chemin par lequel la
// fermeture peut etre defaite sans qu'aucune ligne existante ne change.
{
  await db.query('BEGIN');
  try {
    await db.query(`CREATE FUNCTION tracefab_controle_negatif() RETURNS int LANGUAGE sql SECURITY DEFINER AS $cn$ SELECT 1 $cn$`);
    await db.query('GRANT EXECUTE ON FUNCTION tracefab_controle_negatif() TO PUBLIC');

    const vue = (await db.query(REQUETE_FONCTIONS_PUBLIQUES)).rows;
    const attrapee = vue.some((f) => f.proname === 'tracefab_controle_negatif');

    attrapee
      ? ok('G. porte rouverte exprès : le detecteur de A la vue immediatement')
      : ko('G. une fonction SECURITY DEFINER rendue executable par PUBLIC n a PAS ete vue par le detecteur de A — le constat A ne prouve rien');
  } catch (error) {
    ko(`G. le controle negatif n a pas pu s executer : ${String(error.message).split('\n')[0]}`);
  } finally {
    await db.query('ROLLBACK').catch(() => {});
  }

  const reste = (await db.query(`
    SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'tracefab_controle_negatif'`)).rows[0].n;
  reste === 0
    ? ok('G. la porte rouverte a ete refermee par ROLLBACK : la base est dans son etat initial')
    : ko('G. la fonction de controle negatif subsiste : le ROLLBACK n a pas fonctionne');
}

// ---------------------------------------------------------------------------
// H. Privileges de TABLES, SEQUENCES et SCHEMA — au-dela des fonctions
// ---------------------------------------------------------------------------
// L'audit TF-3 a montre des GRANT SELECT TO PUBLIC re-introduits sur les
// tables DPP par les migrations 20261016* alors que les controles CI ne
// couvraient que les FONCTIONS. Ce controle mesure le catalogue reel des
// objets : tables, sequences, schema. Un privilege interdit detecte echoue.
const REQUETE_OBJETS_PUBLICS = `
  SELECT 'table'::text AS kind, c.relname AS name,
         array_agg(DISTINCT acl.privilege_type ORDER BY acl.privilege_type) AS privileges
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault(CASE c.relkind WHEN 'r' THEN 'r'::"char" ELSE 'S'::"char" END, c.relowner))) acl
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'S') AND acl.grantee = 0
  GROUP BY c.relname, c.relkind
  UNION ALL
  SELECT 'schema', n.nspname,
         array_agg(DISTINCT acl.privilege_type ORDER BY acl.privilege_type)
  FROM pg_namespace n
  CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) acl
  WHERE n.nspname = 'public' AND acl.grantee = 0 AND acl.privilege_type <> 'USAGE'
  GROUP BY n.nspname
  ORDER BY 1, 2`;

const objetsPublics = (await db.query(REQUETE_OBJETS_PUBLICS)).rows;
if (objetsPublics.length === 0) {
  ok('H. aucun objet du schema public n accorde de privilege a PUBLIC (tables, sequences, schema hors USAGE)');
} else {
  for (const objet of objetsPublics) {
    ko(`H. ${objet.kind} ${objet.name} accorde ${objet.privileges.join(',')} a PUBLIC`);
  }
}

// Tables DPP append-only : SELECT pour le role applicatif, pas d'ecriture.
const TABLES_DPP = ['dpp_lifecycle_events', 'dpp_claims', 'dpp_claim_evidence', 'dpp_resolvable_identifiers'];
for (const table of TABLES_DPP) {
  const droits = (await db.query(`
    SELECT has_table_privilege('tracefab_app', $1, 'SELECT') AS s,
           has_table_privilege('tracefab_app', $1, 'INSERT') AS i,
           has_table_privilege('tracefab_app', $1, 'UPDATE') AS u,
           has_table_privilege('tracefab_app', $1, 'DELETE') AS d`,
    [table])).rows[0];
  if (!droits) { ko(`H. table ${table} introuvable`); continue; }
  const rls = (await db.query(
    `SELECT relrowsecurity AS r, relforcerowsecurity AS f FROM pg_class WHERE relname = $1`, [table])).rows[0];
  if (droits.s && !droits.i && !droits.u && !droits.d) {
    ok(`H. ${table} : tracefab_app en lecture seule (mutations par fonctions SECURITY DEFINER)`);
  } else {
    ko(`H. ${table} : privileges tracefab_app inattendus (S=${droits.s} I=${droits.i} U=${droits.u} D=${droits.d})`);
  }
  if (rls && rls.r && rls.f) {
    ok(`H. ${table} : RLS activee ET forcee`);
  } else {
    ko(`H. ${table} : RLS non forcee (relrowsecurity=${rls?.r}, force=${rls?.f})`);
  }
}

// Controle negatif : un privilege PUBLIC introduit sur une table temoin doit
// etre vu par le detecteur. Transaction annulee : la base reste inchangee.
{
  await db.query('BEGIN');
  try {
    await db.query(`CREATE TABLE tracefab_controle_negatif_table (id int)`);
    await db.query(`GRANT SELECT ON tracefab_controle_negatif_table TO PUBLIC`);
    const detecte = (await db.query(REQUETE_OBJETS_PUBLICS)).rows;
    const temoin = detecte.find((o) => o.name === 'tracefab_controle_negatif_table');
    if (temoin) {
      ok('H. controle negatif : le detecteur de privileges PUBLIC attrape une table reintroduite');
    } else {
      ko('H. controle negatif : le detecteur voile un GRANT SELECT TO PUBLIC reintroduit');
    }
  } finally {
    await db.query('ROLLBACK');
  }
  const reste = (await db.query(
    `SELECT count(*)::int AS n FROM pg_class WHERE relname = 'tracefab_controle_negatif_table'`)).rows[0].n;
  reste === 0
    ? ok('H. la table temoin a ete annulee par ROLLBACK')
    : ko('H. la table temoin subsiste apres ROLLBACK');
}

await db.end();

if (APP_URL) {
  const app = new pg.Client({ connectionString: APP_URL, ssl: TLS ? { rejectUnauthorized: true } : undefined });
  try {
    await app.connect();
    const identite = (await app.query('SELECT current_user AS r, current_setting($1, true) AS bypass', ['session_authorization'])).rows[0];
    const bypass = (await app.query(`SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user`)).rows[0];
    bypass && bypass.rolbypassrls === false
      ? ok(`E. le role applicatif ${identite.r} est bien soumis a la RLS (BYPASSRLS=false)`)
      : ko('E. le role applicatif porte BYPASSRLS : les politiques ne seraient pas evaluees');
    await app.end();
  } catch (error) {
    ko(`E. connexion avec le role applicatif impossible : ${String(error.message).split('\n')[0]}`);
  }
}

console.log('\n  --------------------------------------------');
console.log(`  ${echecs === 0 ? 'Privileges fonctions + objets : OK.' : `Privileges fonctions + objets : ${echecs} echec(s).`}`);
console.log('  --------------------------------------------\n');
if (echecs > 0) process.exit(1);
