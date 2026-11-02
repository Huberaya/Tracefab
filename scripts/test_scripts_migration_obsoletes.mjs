#!/usr/bin/env node
/**
 * P10.2 — les scripts de migration à `GRANT ... TO PUBLIC` ne doivent pas revenir.
 *
 * CE QUI S'EST PASSÉ
 *
 * `scripts/apply_migration_chantier{2,3,4,5}.mjs` reproduisaient le SQL des
 * migrations du 20261006, dont des `GRANT SELECT, INSERT, UPDATE, DELETE ... TO
 * PUBLIC` sur neuf tables et un `GRANT EXECUTE ... TO PUBLIC` sur
 * `tracefab_ingest_plm_erp_payload`, fonction SECURITY DEFINER exécutée avec
 * les droits d'un superutilisateur.
 *
 * Ces droits ont été abrogés par `20261014130000_revoke_public_schema_privileges`
 * et `20261019120000_restreindre_dml_role_applicatif`. Les quatre scripts
 * étaient donc obsolètes, sans consommateur, et leur rejeu rouvrait l'accès.
 * Ils ont été supprimés (P10.2).
 *
 * CE QUE CE TEST EMPÊCHE
 *
 *   A. le retour des quatre fichiers ;
 *   B. le retour du motif fautif ailleurs dans `scripts/` — un `GRANT ... TO
 *      PUBLIC` sur l'une des neuf tables ou sur la fonction d'ingestion ;
 *   C. une réintroduction par une commande npm ou un workflow ;
 *   D. en base (quand `DATABASE_URL` est fourni) : PUBLIC ne doit plus avoir
 *      EXECUTE sur la fonction, aucun autre rôle non plus, et la fonction doit
 *      porter la garde de rôle et le `search_path` épinglé.
 *
 * CE QU'IL NE FAIT PAS
 *
 *   — il ne juge pas les migrations historiques : elles portent légitimement
 *     ces GRANT, puis les révocations. On ne réécrit pas l'histoire.
 *   — il ne teste pas l'exécution de la fonction : c'est
 *     `test_ingest_payload_acl.mjs`.
 *
 * Sorties : 0 tout est conforme · 1 au moins un contrôle échoue.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');

let vertes = 0;
const rouges = [];
function verifier(libelle, condition, detail) {
  if (condition) {
    vertes += 1;
    console.log(`  ok    ${libelle}`);
  } else {
    rouges.push(libelle);
    console.log(`  ECHEC ${libelle}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Les neuf tables visées par les GRANT des scripts supprimés. */
const TABLES_CONCERNEES = [
  'plm_erp_integrations', 'plm_erp_sync_jobs',
  'pef_emission_factors', 'product_pef_assessments',
  'green_claims_rules', 'product_green_claims', 'green_claims_audits',
  'quality_corrective_action_plans', 'quality_cap_messages',
];

const SCRIPTS_SUPPRIMES = [
  'apply_migration_chantier2', 'apply_migration_chantier3',
  'apply_migration_chantier4', 'apply_migration_chantier5',
];

console.log('\n  A. les quatre scripts restent supprimés');
for (const nom of SCRIPTS_SUPPRIMES) {
  verifier(`scripts/${nom}.mjs est absent`, !existsSync(join(RACINE, 'scripts', `${nom}.mjs`)));
}

console.log('\n  B. aucun GRANT vers PUBLIC ne subsiste dans scripts/');
{
  const fichiers = readdirSync(join(RACINE, 'scripts'), { withFileTypes: true })
    .filter((e) => e.isFile() && /\.(mjs|ts|js|sh)$/.test(e.name))
    .map((e) => `scripts/${e.name}`);
  // On inspecte aussi lib/, ou une fonction d'aide pourrait porter le motif.
  for (const sous of ['lib', 'fixtures']) {
    const d = join(RACINE, 'scripts', sous);
    if (!existsSync(d)) continue;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isFile() && /\.(mjs|ts|js|sh|sql)$/.test(e.name)) fichiers.push(`scripts/${sous}/${e.name}`);
    }
  }

  const motifTable = new RegExp(
    `GRANT\\s+[^;]*\\b(?:${TABLES_CONCERNEES.join('|')})\\b[^;]*\\bTO\\s+PUBLIC`,
    'i',
  );
  const motifFonction = /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+(?:public\.)?tracefab_ingest_plm_erp_payload[^;]*\bTO\s+PUBLIC/i;

  const coupables = [];
  for (const rel of fichiers) {
    const corps = readFileSync(join(RACINE, rel), 'utf8');
    // Ce test cite les motifs : il se déclarerait coupable lui-même.
    if (rel === 'scripts/test_scripts_migration_obsoletes.mjs') continue;
    if (motifTable.test(corps) || motifFonction.test(corps)) coupables.push(rel);
  }
  verifier(
    `${fichiers.length} fichiers inspectés : aucun GRANT vers PUBLIC sur les objets concernés`,
    coupables.length === 0,
    coupables.join(', '),
  );
}

console.log('\n  C. aucune commande ni workflow ne les réintroduit');
{
  const pkg = JSON.parse(readFileSync(join(RACINE, 'package.json'), 'utf8'));
  const commandes = Object.entries(pkg.scripts || {})
    .filter(([, cmd]) => SCRIPTS_SUPPRIMES.some((n) => cmd.includes(n)))
    .map(([k]) => k);
  verifier('aucune entrée de package.json ne les invoque', commandes.length === 0, commandes.join(', '));

  const wfDir = join(RACINE, '.github', 'workflows');
  const fautifs = existsSync(wfDir)
    ? readdirSync(wfDir)
      .filter((f) => {
        const corps = readFileSync(join(wfDir, f), 'utf8');
        return SCRIPTS_SUPPRIMES.some((n) => corps.includes(n));
      })
    : [];
  verifier('aucun workflow ne les invoque', fautifs.length === 0, fautifs.join(', '));
}

console.log('\n  D. état réel du catalogue en base');
{
  const url = (process.env.DATABASE_URL || '').trim();
  if (!url) {
    // Deux usages, assumés et distincts :
    //   — `verification` (CI) n'a AUCUNE base : les contrôles A a C, qui sont
    //     statiques, y tournent et y suffisent. La partie D n'y est pas
    //     mesurée, et ce script ne prétend pas le contraire : il écrit
    //     « non mesuré », jamais « ok ».
    //   — le job `base-de-donnees` le relance AVEC DATABASE_URL : la partie D
    //     y mesure le catalogue réel, et un défaut y fait échouer la CI.
    // `TF_EXIGER_CATALOGUE=1` transforme l'absence de base en échec, pour
    // qu'un appelant puisse refuser ce mode dégradé.
    if (process.env.TF_EXIGER_CATALOGUE === '1') {
      verifier('DATABASE_URL fourni : le catalogue doit être mesuré', false, 'aucune cible');
    } else {
      console.log('  non mesuré  partie D — aucune DATABASE_URL (contrôles statiques seulement)');
      console.log('              relancer dans le job base-de-donnees pour mesurer le catalogue');
    }
  } else {
    // La partie D LIT le catalogue : elle exige malgré tout une cible classée
    // jetable, pour qu'un DATABASE_URL de production ne fasse jamais entrer un
    // inventaire de production dans un journal de CI.
    const { requireThrowawayDb } = await import('./lib/require-throwaway-db.mjs');
    requireThrowawayDb({
      variables: ['DATABASE_URL'],
      purpose: 'lecture du catalogue pour les scripts obsoletes',
      exitOnFailure: true,
    });
    const { default: pg } = await import('pg');
    const { sslDepuisUrl } = await import('./lib/pg-ssl.mjs');
    const c = new pg.Client({ connectionString: url, ssl: sslDepuisUrl(url) });
    await c.connect();
    try {
      const signature = `public.tracefab_ingest_plm_erp_payload(uuid,text,jsonb,uuid)`;

      const pub = await c.query(
        `SELECT has_function_privilege('public', $1::regprocedure, 'EXECUTE') AS peut`, [signature]);
      verifier('PUBLIC n a pas EXECUTE sur la fonction d ingestion', pub.rows[0].peut === false);

      const autres = await c.query(`
        SELECT DISTINCT a.grantee::regrole::text AS role_name
          FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
         WHERE p.oid = $1::regprocedure AND a.privilege_type = 'EXECUTE'
           AND a.grantee <> 0
           AND a.grantee::regrole::text NOT IN ('tracefab_app', pg_get_userbyid(p.proowner))`,
        [signature]);
      verifier('aucun rôle hors tracefab_app et propriétaire ne détient EXECUTE',
        autres.rows.length === 0, autres.rows.map((r) => r.role_name).join(', '));

      const app = await c.query(
        `SELECT has_function_privilege('tracefab_app', $1::regprocedure, 'EXECUTE') AS peut`, [signature]);
      verifier('le rôle applicatif conserve EXECUTE', app.rows[0].peut === true);

      const def = await c.query(`
        SELECT p.prosecdef, array_to_string(p.proconfig, ',') AS config,
               pg_get_functiondef(p.oid) AS corps
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'tracefab_ingest_plm_erp_payload'`);
      verifier('la fonction existe et reste SECURITY DEFINER',
        def.rows.length === 1 && def.rows[0].prosecdef === true);
      verifier('search_path épinglé sur pg_catalog',
        /search_path=pg_catalog/.test(def.rows[0]?.config || ''), def.rows[0]?.config);
      verifier('la garde de rôle est présente dans le corps',
        /ingest_role_not_allowed/.test(def.rows[0]?.corps || ''));

      for (const t of TABLES_CONCERNEES) {
        const r = await c.query(`
          SELECT has_table_privilege('public', $1, 'INSERT') AS ins,
                 has_table_privilege('public', $1, 'UPDATE') AS upd,
                 has_table_privilege('public', $1, 'DELETE') AS del`, [`public.${t}`]);
        const d = r.rows[0];
        if (d === undefined) continue;
        verifier(`${t} : PUBLIC sans INSERT/UPDATE/DELETE`,
          d.ins === false && d.upd === false && d.del === false,
          `ins=${d.ins} upd=${d.upd} del=${d.del}`);
      }
    } finally {
      await c.end();
    }
  }
}

console.log('\n  --------------------------------------------');
console.log(`  ${vertes}/${vertes + rouges.length} assertions vertes`);
if (rouges.length > 0) {
  console.log(`  en échec : ${rouges.join(' · ')}`);
  process.exit(1);
}
console.log('  ok — les scripts obsolètes ne peuvent pas revenir, et PUBLIC n a plus accès.\n');
process.exit(0);
