#!/usr/bin/env node
/**
 * PROUVE OU REFUTE LE CONTOURNEMENT D'ISOLATION PAR LE CONTEXTE WORKER.
 *
 * LE DEFAUT, TEL QU'IL A ETE MESURE LE 27/10/2026
 *
 * Cinq politiques RLS sont gardees par un GUC de session :
 *     current_setting('tracefab.worker_context', true) = 'true'
 * (users, organizations, organization_memberships, data_requests,
 *  data_request_items, data_responses). Un GUC prefixe par un nom de schema est
 * POSITIONNABLE PAR N'IMPORTE QUEL ROLE :
 *     SET tracefab.worker_context = 'true';
 * Mesure sur base jetable, role `tracefab_app` sans BYPASSRLS :
 *     sans le GUC : organizations 0, users 0, memberships 0
 *     apres le SET : organizations 2, users 2, memberships 2
 * L'isolation multi-organisations de ces tables ne repose donc pas sur la RLS
 * mais sur la bonne volonte de l'appelant. La suite `test:neon:rls` ne le voit
 * pas : elle ne tente jamais ce SET.
 *
 * CE QUE FAIT CE SCRIPT
 *   Il se connecte avec le role applicatif (jamais un role privilegie), mesure
 *   trois etats, et rend un verdict :
 *     1. sans contexte      -> doit etre 0 sur les tables de locataire ;
 *     2. GUC worker pose    -> doit rester 0 ; si > 0, l'isolation est percee ;
 *     3. apres RESET        -> doit revenir a 0 (pas de fuite residuelle).
 *   Il ne modifie aucune donnee : `SET` et `RESET` ne touchent que la session.
 *
 * USAGE (base jetable uniquement)
 *   TF_RLS_APP_URL='postgresql://tracefab_app:...@127.0.0.1:PORT/tracefab_test' \
 *     node scripts/prouver_bypass_contexte_worker.mjs
 *
 * CODES DE SORTIE
 *   0 isolation tient (le GUC ne donne rien) ;
 *   1 isolation percee — le role applicatif lit les donnees de tous les
 *     locataires apres avoir pose le GUC lui-meme ;
 *   2 usage, cible non locale, ou connexion impossible.
 */
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';

const url = process.env.TF_RLS_APP_URL;
if (!url) {
  console.error('NON EXECUTE — TF_RLS_APP_URL obligatoire (role applicatif, sans BYPASSRLS).');
  process.exit(2);
}
if (!/@(?:127\.0\.0\.1|localhost)[:/]/.test(url)) {
  console.error('REFUS — ce banc ne se joue que sur une base jetable locale.');
  process.exit(2);
}

const TABLES = ['organizations', 'users', 'organization_memberships',
  'tracefab_products', 'documents', 'dpp_records'];

const client = new pg.Client({ connectionString: url, ssl: sslDepuisUrl(url), application_name: 'tracefab-preuve-bypass' });
await client.connect();

const compter = async () => {
  const out = {};
  for (const t of TABLES) {
    try {
      const r = await client.query(`SELECT count(*)::int AS n FROM ${t}`);
      out[t] = r.rows[0].n;
    } catch (e) {
      out[t] = `erreur ${e.code}`;
    }
  }
  return out;
};

const { rows: [ident] } = await client.query(`
  SELECT current_user AS role,
         (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS bypassrls,
         current_setting('tracefab.worker_context', true) AS guc_initial`);

console.log('Preuve de contournement par le contexte worker');
console.log(`  role de test : ${ident.role} (BYPASSRLS=${ident.bypassrls}) — un role privilegie ne prouverait rien`);

const sansContexte = await compter();
console.log('\n  1. sans contexte arme');
for (const [t, n] of Object.entries(sansContexte)) console.log(`     ${t.padEnd(28)} ${n}`);

let gucPose = false;
try {
  await client.query("SET tracefab.worker_context = 'true'");
  gucPose = true;
} catch (e) {
  console.log(`\n  2. SET refuse par le serveur : ${e.code} — ${e.message.slice(0, 80)}`);
}
const avecContexte = gucPose ? await compter() : {};
if (gucPose) {
  console.log('\n  2. GUC worker pose par le role applicatif LUI-MEME');
  for (const [t, n] of Object.entries(avecContexte)) console.log(`     ${t.padEnd(28)} ${n}`);
}

await client.query('RESET tracefab.worker_context');
const apresReset = await compter();
console.log('\n  3. apres RESET');
for (const [t, n] of Object.entries(apresReset)) console.log(`     ${t.padEnd(28)} ${n}`);

await client.end();

// Verdict : la comparaison porte sur les tables de locataire, la ou le GUC
// ouvre les politiques worker. Une valeur non nulle apres SET est la fuite.
const TABLES_LOCATAIRE = ['organizations', 'users', 'organization_memberships'];
const fuites = TABLES_LOCATAIRE.filter((t) => typeof avecContexte[t] === 'number' && avecContexte[t] > 0);
const contextePropre = TABLES_LOCATAIRE.every((t) => sansContexte[t] === 0);
const resetPropre = TABLES_LOCATAIRE.every((t) => apresReset[t] === 0);

console.log('\nVerdict');
console.log('-------');
if (!contextePropre) {
  console.log('  ATTENTION — sans contexte, des lignes sont deja visibles : le probleme est plus large que le GUC.');
}
if (fuites.length) {
  console.error(`  ECHEC — le role applicatif lit ${fuites.length} table(s) de locataire apres avoir pose le GUC :`);
  for (const t of fuites) console.error(`          ${t} : ${sansContexte[t]} -> ${avecContexte[t]} ligne(s)`);
  console.error('  L isolation de ces tables ne repose pas sur la RLS mais sur la bonne volonte de l appelant.');
  process.exit(1);
}
if (!resetPropre) {
  console.error('  ECHEC — le contexte survit au RESET : fuite residuelle.');
  process.exit(1);
}
console.log('  ok — le GUC worker ne donne aucune ligne au role applicatif ; isolation intacte.');
process.exit(0);
