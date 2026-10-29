#!/usr/bin/env node
/**
 * Inspection en LECTURE SEULE d'une base TraceFab avant toute migration.
 *
 * POURQUOI CE SCRIPT EXISTE
 *
 * Une migration ne se juge pas sur le dépôt mais sur la base qui la reçoit.
 * Avant d'appliquer `20261027100000_dpp_quality_gate_requires_assessment`, il
 * faut savoir trois choses, et aucune ne peut se deviner :
 *
 *   1. l'état du registre `_prisma_migrations` (ce qui est RÉELLEMENT appliqué,
 *      pas ce que le dépôt contient) ;
 *   2. la définition en place de `tracefab_dpp_requirement_met` — ancienne
 *      (l'absence d'évaluation suffit) ou corrigée (une évaluation est exigée) ;
 *   3. l'impact : combien de produits sont aujourd'hui `data_ready` sans aucune
 *      évaluation qualité, donc combien basculeraient de « prêt » à « bloqué ».
 *
 * GARANTIES
 *
 * - **Session en lecture seule imposée par le serveur** :
 *   `SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY`. Même si une
 *   instruction d'écriture se glissait dans le script, PostgreSQL la
 *   refuserait. Ce n'est pas une convention, c'est un refus du moteur.
 * - Aucune instruction d'écriture dans le code : seuls SELECT/WITH/SHOW
 *   passent la garde `lireSeulement`.
 * - `statement_timeout` et `lock_timeout` courts : une inspection ne doit pas
 *   peser sur une base en service.
 * - Le mot de passe n'est jamais affiché : seule l'identité de la cible l'est.
 * - Un échec de connexion est rapporté tel quel, sans tentative de repli.
 *
 * LIMITE IMPORTANTE — LA RLS
 *
 * Sur une base protégée par RLS, un rôle d'audit ne voit que les lignes que les
 * politiques autorisent : souvent aucune. Les compteurs de données sont donc
 * potentiellement partiels, et le script le DIT au lieu d'afficher des zéros
 * trompeurs. Les lectures de catalogue (définition de fonction, registre des
 * migrations) restent fiables.
 *
 * CE QU'IL NE FAIT PAS
 *
 * Il n'applique rien. Une migration doit passer par `prisma migrate deploy`,
 * qui écrit le registre `_prisma_migrations`. Exécuter le SQL à la main
 * laisserait ce registre en désaccord avec le schéma, et c'est précisément ce
 * que les garde-fous du dépôt interdisent.
 *
 * USAGE
 *
 *   DATABASE_URL='postgresql://…' node scripts/preflight_etat_base.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('NON EXECUTE — DATABASE_URL est obligatoire.');
  process.exit(2);
}

/* Le script s'interdit toute écriture, y compris par copier-coller malheureux :
 * chaque requete passe par ce controle avant d'etre envoyee. */
function lireSeulement(sql) {
  const sansEspaces = String(sql).replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim();
  if (!/^(SELECT|WITH|SHOW)\b/i.test(sansEspaces)) {
    throw new Error(`instruction non autorisee par ce script (lecture seule) : ${sansEspaces.slice(0, 60)}`);
  }
  return sql;
}

const cible = (() => {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || 5432}${u.pathname}`;
  } catch {
    return 'URL illisible';
  }
})();

const client = new pg.Client({
  connectionString: url,
  ssl: sslDepuisUrl(url),
  application_name: 'tracefab-preflight-lecture-seule',
});

const q = (sql, params = []) => client.query(lireSeulement(sql), params);
const ligne = (titre) => console.log(`\n${titre}\n${'-'.repeat(titre.length)}`);

await client.connect();

// Refus serveur de toute écriture, avant la premiere lecture. Ces instructions
// sont statiques et ne dependent d'aucune donnee : elles ne passent pas par la
// garde `lireSeulement`, qui protege les requetes construites.
await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
await client.query("SET statement_timeout = '15s'");
await client.query("SET lock_timeout = '2s'");
const { rows: [garde] } = await client.query('SHOW transaction_read_only');
if (garde.transaction_read_only !== 'on') {
  console.error('REFUS — la session n a pas pu etre placee en lecture seule. Arret avant toute lecture.');
  await client.end().catch(() => {});
  process.exit(3);
}

let sortie = 0;
try {
  const { rows: [identite] } = await q(`
    SELECT current_database() AS base, current_user AS role,
           current_setting('server_version') AS version,
           (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superutilisateur,
           (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS contourne_rls
  `);
  ligne(`Cible ${cible}`);
  console.log(`base ${identite.base} · rôle ${identite.role} · PostgreSQL ${identite.version}`);
  console.log(`superutilisateur : ${identite.superutilisateur} · contourne RLS : ${identite.contourne_rls}`);
  console.log('session en lecture seule : imposée par le serveur (transaction_read_only = on)');

  const { rows: [rls] } = await q(`
    SELECT
      (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relrowsecurity
          AND c.relname IN ('tracefab_products','data_quality_scores','data_quality_issues','dpp_records')) AS tables_sous_rls
  `);
  // Le role voit-il toutes les lignes ?
  const voitTout = identite.superutilisateur || identite.contourne_rls;
  if (!voitTout && Number(rls.tables_sous_rls) > 0) {
    console.log('');
    console.log(`RLS ACTIVE sur ${rls.tables_sous_rls}/4 table(s) interrogée(s), et ce rôle n'a ni SUPERUSER`);
    console.log('ni BYPASSRLS : les COMPTEURS de données ci-dessous ne montrent que les lignes');
    console.log('visibles par ce rôle (souvent zéro). Ils ne valent pas mesure globale.');
    console.log('Les lectures de catalogue (fonction, registre, profil) restent exactes.');
  }

  /* -- 1. Le registre des migrations -------------------------------------- */
  ligne('1. Registre _prisma_migrations');
  const { rows: registreExiste } = await q(`
    SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS present
  `);
  const migrationsDepot = readdirSync(path.join(process.cwd(), 'prisma/migrations'))
    .filter((nom) => /^\d/.test(nom))
    .sort();

  if (!registreExiste[0].present) {
    console.log('ABSENT — aucune migration Prisma enregistrée sur cette base.');
    console.log(`Le dépôt en contient ${migrationsDepot.length}. Prisma traiterait cette base comme vierge.`);
    sortie = 1;
  } else {
    const { rows: appliquees } = await q(`
      SELECT migration_name, finished_at IS NOT NULL AS terminee, rolled_back_at
      FROM _prisma_migrations ORDER BY started_at
    `);
    const terminees = appliquees.filter((m) => m.terminee && !m.rolled_back_at).map((m) => m.migration_name);
    console.log(`${terminees.length} migration(s) terminée(s) sur ${migrationsDepot.length} dans le dépôt.`);
    const enEchec = appliquees.filter((m) => !m.terminee);
    if (enEchec.length) {
      console.log(`EN ÉCHEC (finished_at NULL) : ${enEchec.map((m) => m.migration_name).join(', ')}`);
      sortie = 1;
    }

    const manquantes = migrationsDepot.filter((nom) => !terminees.includes(nom));
    console.log(manquantes.length
      ? `Non appliquées ici (${manquantes.length}) : ${manquantes.slice(0, 6).join(', ')}${manquantes.length > 6 ? '…' : ''}`
      : 'Aucune migration du dépôt ne manque.');
    const inconnues = terminees.filter((nom) => !migrationsDepot.includes(nom));
    if (inconnues.length) console.log(`Appliquées mais absentes du dépôt : ${inconnues.join(', ')}`);
  }

  /* -- 2. La définition en place de la barrière --------------------------- */
  ligne('2. Définition en place de tracefab_dpp_requirement_met');
  const { rows: fonction } = await q(`
    SELECT p.oid::regprocedure::text AS signature,
           position('data_quality_scores' IN p.prosrc) > 0 AS evalue_qualite,
           position('quality.no_open_issues' IN p.prosrc) > 0 AS contient_barriere,
           p.prosecdef AS security_definer,
           has_function_privilege('public', p.oid, 'execute') AS public_peut_executer
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'tracefab_dpp_requirement_met'
  `);
  let etatBarriere = 'absente';
  if (!fonction.length) {
    console.log("La fonction n'existe pas sur cette base : la barrière qualité n'y est pas installée.");
    sortie = sortie || 1;
  } else {
    for (const f of fonction) {
      console.log(`${f.signature} · SECURITY DEFINER : ${f.security_definer} · PUBLIC peut exécuter : ${f.public_peut_executer}`);
      console.log(f.evalue_qualite
        ? '→ corrigée : exige une évaluation qualité persistée.'
        : '→ ANCIENNE : l\'absence d\'évaluation suffit à franchir la barrière (faux vert).');
      etatBarriere = f.evalue_qualite ? 'corrigee' : 'ancienne';
    }
    if (etatBarriere === 'ancienne') sortie = 1;
  }

  /* -- 3. L'impact mesurable ---------------------------------------------- */
  ligne('3. Impact sur les données');
  const { rows: [impact] } = await q(`
    SELECT
      (SELECT count(*) FROM tracefab_products) AS produits,
      (SELECT count(*) FROM tracefab_products p
        WHERE NOT EXISTS (SELECT 1 FROM data_quality_scores s WHERE s.product_id = p.id)) AS sans_evaluation,
      (SELECT count(*) FROM tracefab_products p
        WHERE p.data_readiness::text = 'data_ready'
          AND NOT EXISTS (SELECT 1 FROM data_quality_scores s WHERE s.product_id = p.id)) AS data_ready_sans_evaluation,
      (SELECT count(*) FROM data_quality_scores) AS evaluations,
      (SELECT count(*) FROM data_quality_issues q WHERE q.status::text IN ('open','acknowledged')) AS anomalies_ouvertes,
      (SELECT count(*) FROM dpp_records r WHERE r.readiness_status::text IN ('ready_to_publish','published')) AS dossiers_pret_ou_publies,
      (SELECT count(*) FROM dpp_records r
        WHERE r.readiness_status::text IN ('ready_to_publish','published')
          AND NOT EXISTS (SELECT 1 FROM data_quality_scores s WHERE s.product_id = r.product_id)) AS dossiers_publies_sans_evaluation
  `);
  const partiel = !voitTout && Number(rls.tables_sous_rls) > 0 ? ' (vue partielle — RLS) ' : '';
  if (partiel) console.log(`Compteurs${partiel}: à lire comme un minorant, pas comme une mesure.`);
  console.log(`produits : ${impact.produits} · sans evaluation qualite : ${impact.sans_evaluation}`);
  console.log(`évaluations persistées : ${impact.evaluations} · anomalies ouvertes : ${impact.anomalies_ouvertes}`);
  console.log(`produits « data_ready » sans évaluation : ${impact.data_ready_sans_evaluation}`);
  console.log(`dossiers prêts ou publiés : ${impact.dossiers_pret_ou_publies}`
    + ` · dont SANS évaluation qualité : ${impact.dossiers_publies_sans_evaluation}`);
  if (Number(impact.dossiers_publies_sans_evaluation) > 0) {
    console.log('POINT DE VIGILANCE — ces dossiers ont été déclarés prêts sans évaluation :');
    console.log('après la migration, leur prochaine revue sera refusée tant que la qualité');
    console.log("n'aura pas été calculée. C'est l'effet attendu, pas une régression.");
  }

  /* -- 4. Le profil DPP actif --------------------------------------------- */
  ligne('4. Profil d\'exigences DPP');
  const { rows: profils } = await q(`
    SELECT profile_key, profile_version, status,
           jsonb_array_length(definition -> 'requirements') AS exigences
    FROM dpp_requirement_profiles ORDER BY profile_key, profile_version
  `);
  if (!profils.length) console.log('Aucun profil : la préparation DPP ne peut pas être évaluée sur cette base.');
  for (const p of profils) {
    console.log(`${p.profile_key} v${p.profile_version} · ${p.status} · ${p.exigences} exigence(s)`);
  }
  if (profils.length && !profils.some((p) => Number(p.exigences) === 13 && p.status === 'active')) {
    console.log("ATTENTION — aucun profil actif à 13 exigences : le comportement observé ne sera pas celui décrit par le journal.");
  }

  ligne('Synthèse');
  console.log(`barrière qualité : ${etatBarriere}`);
  console.log(sortie === 0
    ? 'État cohérent avec le dépôt. Aucune écriture effectuée.'
    : 'Écart(s) à examiner ci-dessus. Aucune écriture effectuée.');
} catch (error) {
  console.error(`\nÉCHEC DE LECTURE : ${error.message}`);
  sortie = 1;
} finally {
  await client.end().catch(() => {});
}

process.exit(sortie);
