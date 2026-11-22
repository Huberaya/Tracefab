#!/usr/bin/env node
/**
 * Identite applicative du job « Base » — controle BLOQUANT (R13, 30/10).
 *
 * POURQUOI
 *
 * Le job `base-de-donnees` cree des roles : il a besoin d'une connexion
 * d'administration, `postgres`, superutilisateur. Cette connexion porte
 * `BYPASSRLS` : toute mesure de RLS faite avec elle serait un contournement
 * mesure, pas une protection. L'identite applicative doit donc etre une AUTRE
 * connexion (`TF_RLS_APP_URL`, role `tracefab_app`), et cette difference doit
 * etre PROUVEE par connexion, pas supposee par convention.
 *
 * CE QUI EST VERIFIE
 *   1. `TF_RLS_APP_URL` est presente            -> sinon sortie 2 (bloquant) ;
 *   2. elle n'est pas identique a `DATABASE_URL` -> sinon sortie 3 ;
 *   3. la session obtenue est `tracefab_app`    -> sinon sortie 3 ;
 *   4. elle ne porte ni SUPERUSER, BYPASSRLS, CREATEROLE ni CREATEDB ;
 *   5. les deux URL visent le MEME cluster (`system_identifier`).
 *
 * Sorties : 0 conforme · 2 non configure (bloquant) · 3 identite incorrecte.
 */
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';
import { classifyTarget } from './lib/require-throwaway-db.mjs';
import { assertMemeCluster, assertRoleApplicatif } from './lib/identite_app.mjs';

const admin = (process.env.DATABASE_URL || '').trim();
const app = (process.env.TF_RLS_APP_URL || '').trim();

if (!admin) {
  console.error('  NON EXECUTE — DATABASE_URL absente : le job n a pas de base, il ne peut rien mesurer.');
  process.exit(2);
}
// La cible d'administration reste classee : ce controle ne doit pas devenir une
// porte d'entree vers une base non jetable.
const verdict = classifyTarget(admin);
if (!verdict.allowed) {
  console.error(`  REFUS — DATABASE_URL non jetable (${verdict.code}). Aucune connexion ouverte.`);
  process.exit(3);
}
if (!app) {
  console.error('  NON EXECUTE — TF_RLS_APP_URL obligatoire.');
  console.error('  Sans elle, les suites RLS mesureraient la RLS avec le role d administration,');
  console.error('  qui porte BYPASSRLS : un vert obtenu en contournant ce qu on veut prouver.');
  process.exit(2);
}
if (app === admin) {
  console.error('  REFUS — TF_RLS_APP_URL est identique a DATABASE_URL.');
  console.error('  L identite applicative serait l identite d administration : la RLS ne serait pas evaluee.');
  process.exit(3);
}

const clientAdmin = new pg.Client({ connectionString: admin, ssl: sslDepuisUrl(admin) });
const clientApp = new pg.Client({ connectionString: app, ssl: sslDepuisUrl(app) });

try {
  await clientAdmin.connect();
  await clientApp.connect();

  try {
    await assertRoleApplicatif(clientApp, { attendu: 'tracefab_app', etiquette: 'identite applicative CI' });
  } catch (e) {
    console.error(`  REFUS — ${e.message}`);
    process.exitCode = 3;
    throw e;
  }
  await assertMemeCluster(clientAdmin, clientApp);

  const { rows } = await clientAdmin.query(
    "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
  );
  console.log('  identite applicative : tracefab_app — SUPERUSER=false BYPASSRLS=false');
  console.log(`  identite d administration : ${rows[0].rolname} — SUPERUSER=${rows[0].rolsuper} BYPASSRLS=${rows[0].rolbypassrls}`);
  console.log('  meme cluster : oui (system_identifier identique)');
  console.log('  ok — les suites RLS ne tournent pas sous l identite d administration.');
} catch (e) {
  if (process.exitCode !== 3) {
    console.error(`  ECHEC — ${e.code ?? ''} ${String(e.message).split('\n')[0]}`);
    process.exitCode = 1;
  }
} finally {
  await clientAdmin.end().catch(() => {});
  await clientApp.end().catch(() => {});
}
process.exit(process.exitCode ?? 0);
