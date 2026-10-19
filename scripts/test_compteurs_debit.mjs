#!/usr/bin/env node
/**
 * Limitation de débit — opérations légitimes préservées, abus refusés.
 *
 * Ce contrôle existe parce que le risque a été reproduit, pas déduit : sous le
 * rôle applicatif, `DELETE FROM rate_limit_counters` sans filtre supprimait
 * tous les compteurs, y compris les fenêtres actives, parce que la politique
 * 20261008100000 était `FOR ALL ... USING (true) WITH CHECK (true)`.
 *
 * Il vérifie les deux faces, et dans cet ordre :
 *
 *   POSITIF — ce que le runtime fait réellement, dans api/_lib/rate-limit.ts :
 *     · INSERT d'un compteur neuf, puis upsert qui incrémente hits ;
 *     · DELETE des fenêtres expirées, le nettoyage opportuniste de la ligne 415.
 *     Si l'un des deux casse, la migration corrective a cassé le limiteur et le
 *     test échoue — c'est volontairement vérifié AVANT les cas négatifs.
 *
 *   NÉGATIF — ce qu'un rôle applicatif compromis ne doit plus pouvoir faire :
 *     · vider la table sans filtre ;
 *     · ramener hits à zéro par UPDATE ;
 *     · déplacer un compteur sur une autre fenêtre.
 *
 * Le provisioning suit l'ordre réel de la CI et de Production : le rôle est
 * créé AVANT les migrations.
 *
 * Sorties : 0 conforme · 1 défaut · 2 prérequis manquant.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';
import { requireThrowawayDb } from './lib/require-throwaway-db.mjs';

const RACINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SORTIE_DEFAUT = 1;
const SORTIE_PREREQUIS = 2;

const APP_ROLE = 'tracefab_app';
const BASE_EPHEMERE = 'tracefab_compteurs_debit';
const MOT_DE_PASSE = process.env.TF_APP_PASSWORD || 'epreuve_locale_jetable';

let vertes = 0;
let rouges = 0;
const echecs = [];

function verifier(etiquette, ok, detail) {
  if (ok) {
    vertes += 1;
    console.log(`    ok    ${etiquette}`);
  } else {
    rouges += 1;
    echecs.push(etiquette);
    console.log(`    ECHEC ${etiquette}${detail ? ` — observé : ${detail}` : ''}`);
  }
}

requireThrowawayDb({
  variables: ['DATABASE_URL'],
  purpose: 'limitation de débit — opérations légitimes et abus',
  exitOnFailure: true,
});

const urlAdmin = process.env.DATABASE_URL;
const hote = (urlAdmin.match(/@([^/:]+)/) || [])[1] ?? 'illisible';
const urlMaintenance = urlAdmin.replace(/\/[^/?]+(\?|$)/, '/postgres$1');

const admin = new pg.Client({ connectionString: urlMaintenance, ssl: sslDepuisUrl(urlMaintenance) });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${BASE_EPHEMERE}`);
await admin.query(`CREATE DATABASE ${BASE_EPHEMERE}`);
await admin.end();

const url = urlAdmin.replace(/\/[^/?]+(\?|$)/, `/${BASE_EPHEMERE}$1`);
const urlApp = url.replace(/:\/\/[^@]*@/, `://${APP_ROLE}:${encodeURIComponent(MOT_DE_PASSE)}@`);

console.log(`\n  base éphémère sur ${hote} — ${BASE_EPHEMERE}`);

// Rôle AVANT les migrations : ordre réel.
execFileSync('node', [path.join(RACINE, 'scripts', 'bootstrap_app_role.mjs')], {
  env: { ...process.env, DATABASE_URL: url, TF_APP_PASSWORD: MOT_DE_PASSE },
  stdio: 'ignore',
});

const mig = new pg.Client({ connectionString: url, ssl: sslDepuisUrl(url) });
await mig.connect();
await mig.query(
  `CREATE TABLE IF NOT EXISTS _prisma_migrations (
     id text PRIMARY KEY, checksum text NOT NULL, finished_at timestamptz,
     migration_name text NOT NULL, logs text, rolled_back_at timestamptz,
     started_at timestamptz NOT NULL DEFAULT now(), applied_steps_count integer NOT NULL DEFAULT 0)`,
);
const dossiers = fs
  .readdirSync(path.join(RACINE, 'prisma', 'migrations'), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();
for (const d of dossiers) {
  const sql = fs.readFileSync(path.join(RACINE, 'prisma', 'migrations', d, 'migration.sql'), 'utf8');
  if (!sql.trim() || sql.trim() === '-- This is an empty migration.') continue;
  try {
    await mig.query(sql);
  } catch (e) {
    console.log(`    MIGRATION EN ECHEC ${d} — ${e.code} ${String(e.message).split('\n')[0]}`);
  }
}
await mig.end();
console.log(`  ${dossiers.length} migrations appliquées, provisioning avant migrations`);

const app = new pg.Client({ connectionString: urlApp, ssl: sslDepuisUrl(urlApp) });
await app.connect();

const ident = await app.query('SELECT current_user AS u, (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS b');
verifier('la connexion est le rôle applicatif', ident.rows[0].u === APP_ROLE, ident.rows[0].u);
verifier('le rôle ne contourne pas la RLS', ident.rows[0].b === false, `rolbypassrls=${ident.rows[0].b}`);

async function tente(sql, params = []) {
  try {
    const r = await app.query(sql, params);
    return { ok: true, rows: r.rows, count: r.rowCount };
  } catch (e) {
    return { ok: false, code: e.code, message: String(e.message).split('\n')[0] };
  }
}

/* --- POSITIF : le chemin réel du limiteur --------------------------------- */

console.log('\n  A. opérations légitimes — api/_lib/rate-limit.ts');

const cle = 'empreinte-client-synthetique';
const ins = await tente(
  `INSERT INTO rate_limit_counters (bucket_key, window_start, hits, expires_at)
   VALUES ($1, date_trunc('minute', now()), 1, now() + interval '10 minutes')
   ON CONFLICT (bucket_key, window_start) DO UPDATE SET hits = rate_limit_counters.hits + 1
   RETURNING hits`,
  [cle],
);
verifier('insertion du premier compteur, hits = 1', ins.ok && ins.rows[0]?.hits === 1, ins.ok ? `hits=${ins.rows[0]?.hits}` : `${ins.code} ${ins.message}`);

let dernier = 1;
for (const attendu of [2, 3]) {
  const r = await tente(
    `INSERT INTO rate_limit_counters (bucket_key, window_start, hits, expires_at)
     VALUES ($1, date_trunc('minute', now()), 1, now() + interval '10 minutes')
     ON CONFLICT (bucket_key, window_start) DO UPDATE SET hits = rate_limit_counters.hits + 1
     RETURNING hits`,
    [cle],
  );
  verifier(`upsert légitime : hits passe à ${attendu}`, r.ok && r.rows[0]?.hits === attendu, r.ok ? `hits=${r.rows[0]?.hits}` : `${r.code} ${r.message}`);
  if (r.ok) dernier = r.rows[0].hits;
}

const lecture = await tente(`SELECT hits FROM rate_limit_counters WHERE bucket_key = $1`, [cle]);
verifier('lecture du compteur par le rôle applicatif', lecture.ok && lecture.rows[0]?.hits === dernier, lecture.ok ? `hits=${lecture.rows[0]?.hits}` : `${lecture.code} ${lecture.message}`);

// Une fenêtre expirée, puis le nettoyage légitime de la ligne 415.
await tente(
  `INSERT INTO rate_limit_counters (bucket_key, window_start, hits, expires_at)
   VALUES ('fenetre-expiree', date_trunc('minute', now()) - interval '2 hours', 99, now() - interval '1 hour')
   ON CONFLICT DO NOTHING`,
);
const purge = await tente(`DELETE FROM rate_limit_counters WHERE expires_at < NOW()`);
verifier('nettoyage légitime des fenêtres expirées', purge.ok && purge.count === 1, purge.ok ? `${purge.count} ligne` : `${purge.code} ${purge.message}`);

/* --- NÉGATIF : ce qui doit être refusé ------------------------------------ */

console.log('\n  B. abus — ce qu un rôle applicatif compromis ne doit plus pouvoir faire');

// Trois compteurs actifs appartenant à d'autres clients, plus un expiré.
for (const [k, minutes] of [['victime-1', 10], ['victime-2', 10], ['victime-expiree', -60]]) {
  await tente(
    `INSERT INTO rate_limit_counters (bucket_key, window_start, hits, expires_at)
     VALUES ($1, date_trunc('minute', now()), 47, now() + ($2 || ' minutes')::interval)
     ON CONFLICT DO NOTHING`,
    [k, String(minutes)],
  );
}
const actifsAvant = await app.query(
  `SELECT count(*)::int n FROM rate_limit_counters WHERE expires_at >= now()`,
);

const vidage = await tente(`DELETE FROM rate_limit_counters`);
const actifsApres = await app.query(
  `SELECT count(*)::int n FROM rate_limit_counters WHERE expires_at >= now()`,
);
verifier(
  'un DELETE sans filtre ne supprime aucun compteur actif',
  actifsApres.rows[0].n === actifsAvant.rows[0].n,
  `${actifsAvant.rows[0].n} actifs avant, ${actifsApres.rows[0].n} après (supprimées : ${vidage.ok ? vidage.count : vidage.code})`,
);
verifier(
  'le DELETE sans filtre atteint tout de même les fenêtres expirées',
  vidage.ok && vidage.count >= 1,
  vidage.ok ? `${vidage.count} ligne` : `${vidage.code} ${vidage.message}`,
);

const remise = await tente(`UPDATE rate_limit_counters SET hits = 0 WHERE bucket_key = $1`, [cle]);
verifier(
  'ramener hits à zéro est refusé',
  !remise.ok && remise.code === '42501',
  remise.ok ? `${remise.count} ligne modifiée` : `${remise.code} ${remise.message}`,
);

const intact = await app.query(`SELECT hits FROM rate_limit_counters WHERE bucket_key = $1`, [cle]);
verifier('le compteur visé conserve sa valeur', intact.rows[0]?.hits === dernier, `hits=${intact.rows[0]?.hits}, attendu ${dernier}`);

const deplacement = await tente(
  `UPDATE rate_limit_counters SET window_start = date_trunc('minute', now()) + interval '5 minutes' WHERE bucket_key = $1`,
  [cle],
);
verifier(
  'déplacer un compteur sur une autre fenêtre est refusé',
  !deplacement.ok && deplacement.code === '42501',
  deplacement.ok ? `${deplacement.count} ligne modifiée` : `${deplacement.code} ${deplacement.message}`,
);

/* --- C. La correction est bien en place ----------------------------------- */

console.log('\n  C. état des politiques');

const pol = await app.query(
  `SELECT policyname, cmd, qual FROM pg_policies WHERE tablename = 'rate_limit_counters' ORDER BY 1`,
);
const parCmd = Object.fromEntries(pol.rows.map((r) => [r.cmd, r]));
verifier('la politique globale FOR ALL a disparu', !parCmd.ALL, parCmd.ALL ? parCmd.ALL.policyname : '');
verifier(
  'la suppression est bornée aux fenêtres expirées',
  parCmd.DELETE && /expires_at\s*<\s*now\(\)/.test(parCmd.DELETE.qual ?? ''),
  parCmd.DELETE ? `USING = ${parCmd.DELETE.qual}` : 'aucune politique DELETE',
);
verifier('la lecture reste globale', parCmd.SELECT && parCmd.SELECT.qual === 'true', parCmd.SELECT?.qual);
verifier('l insertion reste globale', !!parCmd.INSERT, parCmd.INSERT ? 'ok' : 'absente');
verifier('la mise à jour reste globale', parCmd.UPDATE && parCmd.UPDATE.qual === 'true', parCmd.UPDATE?.qual);

const decl = await app.query(
  `SELECT count(*)::int n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
   WHERE c.relname = 'rate_limit_counters' AND NOT t.tgisinternal`,
);
verifier('un déclencheur garde les mises à jour', decl.rows[0].n === 1, `${decl.rows[0].n} déclencheur`);

await app.end();

const nettoyeur = new pg.Client({ connectionString: urlMaintenance, ssl: sslDepuisUrl(urlMaintenance) });
await nettoyeur.connect();
await nettoyeur.query(`DROP DATABASE IF EXISTS ${BASE_EPHEMERE}`);
await nettoyeur.end();
console.log('  base éphémère détruite');

console.log(`\n  ${vertes}/${vertes + rouges} assertions vertes`);
if (rouges > 0) {
  console.log(`  en échec : ${echecs.join(' ; ')}`);
  process.exit(SORTIE_DEFAUT);
}
console.log('  ok — limiteur préservé, abus refusés.');
process.exit(0);
