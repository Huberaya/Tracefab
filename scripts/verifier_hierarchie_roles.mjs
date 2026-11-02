#!/usr/bin/env node
/**
 * B4 — le runtime peut-il prendre un rôle privilégié ? (mesure, pas inventaire)
 *
 * POURQUOI CE TEST EXISTE
 *
 * P10.4 a mesuré le scénario complet sur une base jetable : `tracefab_app`
 * devient membre du rôle propriétaire, exécute `SET ROLE`, et lit alors les
 * produits des DEUX organisations (0 → 4 lignes). L'isolation inter-
 * organisations, dans ce cas, ne repose plus sur la base du tout.
 *
 * Un test qui se contenterait de lire `pg_auth_members` ne prouverait pas
 * grand-chose : ce qui compte n'est pas l'absence d'une ligne dans le
 * catalogue, c'est l'échec RÉEL de `SET ROLE`. Ce script essaie donc de
 * prendre chaque rôle privilégié, depuis une connexion ouverte avec les
 * identifiants du runtime.
 *
 * LE CONTRÔLE POSITIF, SANS LEQUEL TOUT CECI EST DÉCORATIF
 *
 * Si `SET ROLE` échouait pour une raison quelconque (rôle inexistant, faute de
 * frappe dans le nom, connexion morte), le test passerait au vert sans rien
 * prouver. On accorde donc temporairement l'appartenance, on vérifie que
 * `SET ROLE` RÉUSSIT ALORS et que les données des deux organisations
 * deviennent lisibles, puis on révoque et on vérifie que tout redevient fermé.
 * Si le contrôle positif ne bascule pas, le test échoue : c'est lui qui donne
 * sa valeur au reste.
 *
 * CE QUE LE SCRIPT NE FAIT PAS
 *   - il ne tourne jamais contre une base managée (garde ci-dessous) ;
 *   - il ne laisse aucune appartenance derrière lui (révocation dans `finally`,
 *     revérifiée) ;
 *   - il n'affiche jamais de chaîne de connexion.
 *
 * Sortie : 0 conforme · 1 régression · 2 non exécuté · 3 refus.
 */
import process from 'node:process';
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';
import {
  ROLE_APP, ROLE_MIGRATOR, ROLE_WORKER,
  appartenancesDirectes, appartenancesTransitives, etatRole,
} from './lib/tracefab_roles.mjs';

const urlApp = (process.env.TF_RLS_APP_URL || '').trim();
const urlAdmin = (process.env.DATABASE_URL || '').trim();
if (!urlApp || !urlAdmin) {
  console.error('  NON EXECUTE — DATABASE_URL (administration) et TF_RLS_APP_URL (runtime) sont requises.');
  process.exit(2);
}

// Garde : jamais contre une base managée. Ce test CRÉE et RÉVOQUE des
// appartenances ; le faire en production serait exactement le dégât qu'il
// mesure.
const hote = (() => { try { return new URL(urlAdmin).hostname; } catch { return ''; } })();
if (!/^(localhost|127\.0\.0\.1|::1|\[::1\])$/.test(hote)) {
  console.error(`  REFUS — cible non locale (${hote || 'illisible'}). Ce test modifie des appartenances.`);
  process.exit(3);
}

let echecs = 0;
let assertions = 0;
const ok = (cond, libelle, detail = '') => {
  assertions += 1;
  console.log(`  ${cond ? 'ok   ' : 'ECHEC'} ${libelle}${detail ? ` — ${detail}` : ''}`);
  if (!cond) echecs += 1;
};

const admin = new pg.Client({ connectionString: urlAdmin, ssl: sslDepuisUrl(urlAdmin), application_name: 'tracefab-hierarchie-admin' });
await admin.connect();
const app = new pg.Client({ connectionString: urlApp, ssl: sslDepuisUrl(urlApp), application_name: 'tracefab-hierarchie-runtime' });
await app.connect();

// ---------------------------------------------------------------------------
// 1. L'état déclaré : aucune appartenance, aucune transitivité.
// ---------------------------------------------------------------------------
const etatApp = await etatRole(admin, ROLE_APP);
ok(etatApp !== null, `le rôle ${ROLE_APP} existe`);
ok(etatApp?.rolsuper === false && etatApp?.rolbypassrls === false,
  `${ROLE_APP} n a ni SUPERUSER ni BYPASSRLS`,
  `superuser=${etatApp?.rolsuper} bypassrls=${etatApp?.rolbypassrls}`);

const directes = await appartenancesDirectes(admin, ROLE_APP);
const transitives = await appartenancesTransitives(admin, ROLE_APP);
ok(directes.length === 0, `${ROLE_APP} n a aucune appartenance directe`,
  directes.map((a) => `${a.role_accorde}(admin=${a.admin_option},set=${a.set_option})`).join(', ') || 'aucune');
ok(transitives.length === 0, `${ROLE_APP} n atteint aucun rôle par transitivité`,
  transitives.map((t) => `${t.atteint}(profondeur ${t.profondeur})`).join(', ') || 'aucune');

// ---------------------------------------------------------------------------
// 2. Le comportement réel : `SET ROLE` doit échouer, essayé pour de vrai.
// ---------------------------------------------------------------------------
const privilegies = [...new Set([ROLE_MIGRATOR, ROLE_WORKER, 'postgres'].filter(Boolean))];
const existants = [];
for (const nom of privilegies) {
  const etat = await etatRole(admin, nom);
  if (etat) existants.push(nom);
}

async function tenterPriseDeRole(nom) {
  try {
    await app.query('BEGIN');
    await app.query(`SET ROLE ${nom}`);
    await app.query('ROLLBACK');
    return { pris: true, erreur: null };
  } catch (e) {
    await app.query('ROLLBACK').catch(() => {});
    return { pris: false, erreur: `${e.code || ''} ${e.message.split('\n')[0].slice(0, 70)}` };
  }
}

for (const nom of existants) {
  const essai = await tenterPriseDeRole(nom);
  ok(essai.pris === false, `${ROLE_APP} ne peut pas prendre le rôle ${nom}`, essai.erreur || 'PRIS');
}

// Lecture réelle des données des deux organisations, sans contexte : c'est la
// conséquence concrète, celle que P10.4 avait mesurée (0 → 4).
const sansContexte = (await app.query('SELECT count(*)::int n FROM tracefab_products')).rows[0].n;
ok(sansContexte === 0, 'sans contexte, le runtime ne voit aucun produit', `${sansContexte} ligne(s)`);

// ---------------------------------------------------------------------------
// 3. Contrôle positif : l'appartenance rend-elle vraiment l'escalade possible ?
// ---------------------------------------------------------------------------
const cible = existants.find((n) => n === ROLE_MIGRATOR) || existants[0];
let controlePositif = false;
if (cible) {
  await admin.query(`GRANT ${cible} TO ${ROLE_APP}`);
  try {
    const essai = await tenterPriseDeRole(cible);
    let vus = null;
    if (essai.pris) {
      // La connexion d'essai a été annulée ; on refait l'escalade pour mesurer
      // ce qu'elle donne vraiment, puis on annule.
      await app.query('BEGIN');
      await app.query(`SET ROLE ${cible}`);
      vus = (await app.query('SELECT count(*)::int n FROM tracefab_products')).rows[0].n;
      await app.query('ROLLBACK');
    }
    controlePositif = essai.pris && vus !== null && vus > 0;
    ok(controlePositif,
      'contrôle positif : avec l appartenance, l escalade réussit et les données des deux organisations deviennent lisibles',
      `SET ROLE=${essai.pris ? 'accepté' : 'refusé'} · lignes vues=${vus}`);
  } finally {
    await admin.query(`REVOKE ${cible} FROM ${ROLE_APP}`).catch(async () => {
      await admin.query(`REVOKE ${cible} FROM ${ROLE_APP} GRANTED BY ${cible}`).catch(() => {});
    });
  }
  // Retour à l'état fermé, revérifié : c'est la preuve que le test ne laisse
  // pas la faille derrière lui.
  const apres = await tenterPriseDeRole(cible);
  ok(apres.pris === false, `après révocation, ${ROLE_APP} ne peut plus prendre ${cible}`, apres.erreur || 'PRIS');
} else {
  ok(false, 'contrôle positif : un rôle privilégié existe pour l éprouver', 'aucun rôle candidat');
}

// ---------------------------------------------------------------------------
// 4. Le worker reste utilisable par le chemin prévu, et par lui seul.
// ---------------------------------------------------------------------------
const worker = await etatRole(admin, ROLE_WORKER);
if (worker) {
  ok(worker.rolcanlogin === false, `${ROLE_WORKER} n est pas connectable (NOLOGIN)`, `login=${worker.rolcanlogin}`);
  const membresWorker = await admin.query(
    `SELECT r.rolname FROM pg_catalog.pg_auth_members m
       JOIN pg_catalog.pg_roles r ON r.oid = m.member
       JOIN pg_catalog.pg_roles c ON c.oid = m.roleid
      WHERE c.rolname = $1`, [ROLE_WORKER],
  );
  ok(membresWorker.rows.every((r2) => r2.rolname !== ROLE_APP),
    `${ROLE_APP} n est pas membre de ${ROLE_WORKER}`,
    membresWorker.rows.map((r2) => r2.rolname).join(', ') || 'aucun membre');
}

await app.end();
await admin.end();

console.log('');
if (echecs === 0) {
  console.log(`  Hiérarchie des rôles : ${assertions} assertions — aucune escalade possible, contrôle positif concluant.`);
  process.exit(0);
}
console.log(`  ${echecs} ÉCHEC sur ${assertions} assertions — le runtime peut atteindre un rôle privilégié.`);
process.exit(1);
