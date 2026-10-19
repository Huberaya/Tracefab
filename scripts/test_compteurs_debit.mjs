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

// Contournement en deux étapes, reproduit avant d'être corrigé : remettre la
// fenêtre dans le passé, puis supprimer la ligne. Chaque étape était
// individuellement autorisée — la politique DELETE laisse passer toute ligne
// dont expires_at est déjà dépassé.
const raccourci = await tente(
  `UPDATE rate_limit_counters SET expires_at = now() - interval '1 hour' WHERE bucket_key = $1`,
  [cle],
);
verifier(
  'raccourcir la fenêtre d un compteur actif est refusé',
  !raccourci.ok && raccourci.code === '42501',
  raccourci.ok ? `${raccourci.count} ligne modifiée` : `${raccourci.code} ${raccourci.message}`,
);

const apresRaccourci = await tente(`DELETE FROM rate_limit_counters WHERE bucket_key = $1`, [cle]);
verifier(
  'le compteur actif ne peut pas être supprimé après la tentative',
  !apresRaccourci.ok || apresRaccourci.count === 0,
  apresRaccourci.ok ? `${apresRaccourci.count} ligne supprimée` : `${apresRaccourci.code} ${apresRaccourci.message}`,
);

/* --- C. Concurrence, atomicité, périmètre des rôles ------------------------ */

console.log('\n  C. upsert concurrent — le chemin réel sous charge');

const NB_UPSERTS = 25;
const NB_CONNEXIONS = 8;
const conns = await Promise.all(
  Array.from({ length: NB_CONNEXIONS }, async () => {
    const c = new pg.Client({ connectionString: urlApp, ssl: sslDepuisUrl(urlApp) });
    await c.connect();
    return c;
  }),
);
const upsert = `INSERT INTO rate_limit_counters (bucket_key, window_start, hits, expires_at)
  VALUES ($1, date_trunc('minute', now()), 1, now() + interval '10 minutes')
  ON CONFLICT (bucket_key, window_start) DO UPDATE SET hits = rate_limit_counters.hits + 1
  RETURNING hits`;
let erreursConcurrence = 0;
await Promise.all(
  Array.from({ length: NB_UPSERTS }, async (_, i) => {
    try {
      await conns[i % NB_CONNEXIONS].query(upsert, ['cle-concurrente']);
    } catch {
      erreursConcurrence += 1;
    }
  }),
);
for (const c of conns) await c.end();
const final = await app.query(`SELECT hits FROM rate_limit_counters WHERE bucket_key = 'cle-concurrente'`);
verifier(
  `${NB_UPSERTS} upserts concurrents sur ${NB_CONNEXIONS} connexions donnent hits = ${NB_UPSERTS}`,
  final.rows[0]?.hits === NB_UPSERTS,
  `hits=${final.rows[0]?.hits}`,
);
verifier('aucun upsert concurrent n échoue', erreursConcurrence === 0, `${erreursConcurrence} erreurs`);

console.log('\n  D. atomicité — une transaction échouée ne laisse rien');

// Les deux lignes sont créées AVANT la transaction, donc déjà validées. Une
// première version les insérait à l'intérieur, et l'assertion attendait alors
// des lignes que le ROLLBACK avait nécessairement fait disparaître : le test
// échouait pour une raison qui n'avait rien à voir avec l'atomicité.
await app.query(
  `INSERT INTO rate_limit_counters (bucket_key, window_start, hits, expires_at)
   VALUES ('atomique-1', date_trunc('minute', now()), 5, now() + interval '10 minutes'),
          ('atomique-2', date_trunc('minute', now()), 7, now() + interval '10 minutes')
   ON CONFLICT DO NOTHING`,
);
await app.query('BEGIN');
// Une modification LÉGITIME d'abord : elle doit elle aussi être annulée, sinon
// la transaction laisserait une trace partielle.
await app.query(`UPDATE rate_limit_counters SET hits = hits + 1 WHERE bucket_key = 'atomique-1'`);
const declenche = await tente(`UPDATE rate_limit_counters SET hits = 0 WHERE bucket_key = 'atomique-2'`);
await app.query('ROLLBACK');
const etat = await app.query(
  `SELECT bucket_key, hits FROM rate_limit_counters WHERE bucket_key LIKE 'atomique-%' ORDER BY 1`,
);
verifier(
  'la modification interdite fait échouer la transaction',
  !declenche.ok && declenche.code === '42501',
  declenche.ok ? 'acceptée' : `${declenche.code} ${declenche.message}`,
);
verifier(
  'après ROLLBACK, les deux lignes validées retrouvent leurs valeurs d origine',
  etat.rows.length === 2 && etat.rows[0].hits === 5 && etat.rows[1].hits === 7,
  etat.rows.map((r) => `${r.bucket_key}=${r.hits}`).join(', ') || 'aucune ligne',
);

console.log('\n  E. périmètre des rôles — rien n a été élargi');

const roles = await app.query(`SELECT rolname FROM pg_roles WHERE rolname NOT LIKE 'pg\\_%' ORDER BY 1`);
const inattendus = [];
for (const { rolname } of roles.rows) {
  const p = await app.query(
    `SELECT has_table_privilege($1,'rate_limit_counters','SELECT') s,
            has_table_privilege($1,'rate_limit_counters','INSERT') i,
            has_table_privilege($1,'rate_limit_counters','UPDATE') u,
            has_table_privilege($1,'rate_limit_counters','DELETE') d`,
    [rolname],
  );
  const r = p.rows[0];
  // Seuls le propriétaire et le rôle applicatif doivent avoir quoi que ce soit.
  const autorise = rolname === APP_ROLE || rolname === 'postgres';
  if (!autorise && (r.s || r.i || r.u || r.d)) inattendus.push(rolname);
}
verifier(
  'aucun rôle supplémentaire n a obtenu de droit sur la table',
  inattendus.length === 0,
  inattendus.join(', '),
);
const pubRole = await app.query(
  `SELECT count(*)::int n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace,
     aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
   WHERE c.relname='rate_limit_counters' AND a.grantee=0`,
);
verifier('PUBLIC n a aucune entrée d ACL sur la table', pubRole.rows[0].n === 0, `${pubRole.rows[0].n} entrées`);

/* --- C. La correction est bien en place ----------------------------------- */

console.log('\n  F. état des politiques');

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

console.log('\n  G. contrat de migration — base fraîche puis seconde application');

// Le contrat d'une migration Prisma est d'être appliquée une fois. Mais une
// migration de sécurité peut être rejouée sur une base déjà provisionnée sous
// une règle antérieure, et elle ne doit alors ni échouer ni affaiblir l'état
// atteint. On la rejoue donc, puis on revérifie l'invariant central.
const reapplication = new pg.Client({ connectionString: url, ssl: sslDepuisUrl(url) });
await reapplication.connect();
const sqlMigration = fs.readFileSync(
  path.join(RACINE, 'prisma', 'migrations', '20261019140000_restreindre_suppression_compteurs_debit', 'migration.sql'),
  'utf8',
);
let secondeApplication = { ok: true };
try {
  await reapplication.query(sqlMigration);
} catch (e) {
  secondeApplication = { ok: false, code: e.code, message: String(e.message).split('\n')[0] };
}
verifier(
  'la migration se rejoue sans erreur',
  secondeApplication.ok,
  `${secondeApplication.code} ${secondeApplication.message}`,
);
await reapplication.end();

const apresSeconde = await tente(`UPDATE rate_limit_counters SET hits = 0 WHERE bucket_key = $1`, [cle]);
verifier(
  'la protection survit à la seconde application',
  !apresSeconde.ok && apresSeconde.code === '42501',
  apresSeconde.ok ? 'acceptée' : `${apresSeconde.code} ${apresSeconde.message}`,
);

const politiquesApres = await app.query(
  `SELECT count(*)::int n FROM pg_policies WHERE tablename = 'rate_limit_counters'`,
);
verifier(
  'la seconde application ne duplique aucune politique',
  politiquesApres.rows[0].n === 4,
  `${politiquesApres.rows[0].n} politiques, attendu 4`,
);

const declencheursApres = await app.query(
  `SELECT count(*)::int n FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
   WHERE c.relname='rate_limit_counters' AND NOT t.tgisinternal`,
);
verifier(
  'la seconde application ne duplique aucun déclencheur',
  declencheursApres.rows[0].n === 1,
  `${declencheursApres.rows[0].n} déclencheurs, attendu 1`,
);

console.log('\n  H. vecteurs de contournement hors RLS');

// Les sections précédentes testent ce que la RLS et le déclencheur refusent.
// Elles ne couvrent pas les chemins qui n'y passent pas. Trois existent, et
// chacun serait un contournement complet s'il était ouvert.

// TRUNCATE : la RLS est une politique par LIGNE, elle ne s'applique pas à
// TRUNCATE. Si le rôle applicatif détenait ce privilège, toute la protection
// ci-dessus serait contournée en une commande.
const avantTruncate = await app.query('SELECT count(*)::int n FROM rate_limit_counters');
const truncate = await tente('TRUNCATE rate_limit_counters');
verifier(
  'TRUNCATE est refusé au rôle applicatif',
  !truncate.ok && truncate.code === '42501',
  truncate.ok ? 'accepté — la RLS ne protège pas de TRUNCATE' : `${truncate.code} ${truncate.message}`,
);
const apresTruncate = await app.query('SELECT count(*)::int n FROM rate_limit_counters');
verifier(
  'aucun compteur ne disparaît par TRUNCATE',
  apresTruncate.rows[0].n === avantTruncate.rows[0].n,
  `${avantTruncate.rows[0].n} avant, ${apresTruncate.rows[0].n} après`,
);

// expires_at à NULL : la garde compare NEW.expires_at < OLD.expires_at, et une
// comparaison avec NULL rend NULL — pas TRUE. La garde NE REFUSERAIT DONC PAS
// la mise à NULL. Ce qui la bloque est la contrainte NOT NULL de la colonne.
// L'assertion porte sur la contrainte, pas sur la garde : si un jour la colonne
// devient nullable, ce test doit rougir, car le contournement redeviendrait
// possible — une ligne à expires_at NULL n'est plus jamais supprimable, mais
// surtout la garde perd son seul point d'appui.
const colonne = await app.query(
  `SELECT is_nullable FROM information_schema.columns
   WHERE table_name = 'rate_limit_counters' AND column_name = 'expires_at'`,
);
verifier(
  'expires_at reste NOT NULL — la garde ne suffit pas seule contre NULL',
  colonne.rows.length === 1 && colonne.rows[0].is_nullable === 'NO',
  colonne.rows[0]?.is_nullable ?? 'colonne introuvable',
);
// La ligne visée doit exister AU MOMENT de l'assertion. Une première version
// réutilisait la ligne de la section B — précisément celle que le
// contournement supprime. Sans la garde, l'UPDATE ne matchait plus aucune
// ligne et rendait « 0 ligne, aucune erreur », lu à tort comme une
// autorisation. Mesuré sur base jetable : un UPDATE portant sur une ligne
// absente ne lève aucune erreur, alors que le même UPDATE sur une ligne
// présente lève bien 23502. L'assertion portait donc sur l'ordre des sections,
// pas sur la contrainte.
const cleNulle = 'controle-not-null';
await app.query(
  `INSERT INTO rate_limit_counters (bucket_key, window_start, hits, expires_at)
   VALUES ($1, date_trunc('minute', now()), 4, now() + interval '10 minutes')
   ON CONFLICT (bucket_key, window_start) DO NOTHING`,
  [cleNulle],
);
const presenteAvant = await app.query(
  'SELECT count(*)::int n FROM rate_limit_counters WHERE bucket_key = $1',
  [cleNulle],
);
verifier(
  'la ligne du contrôle NOT NULL existe avant l essai',
  presenteAvant.rows[0].n === 1,
  `${presenteAvant.rows[0].n} ligne — l assertion suivante ne prouverait rien`,
);
const miseANul = await tente(
  `UPDATE rate_limit_counters SET expires_at = NULL WHERE bucket_key = $1`,
  [cleNulle],
);
verifier(
  'la mise à NULL de expires_at est refusée sur une ligne présente',
  !miseANul.ok,
  'acceptée — la contrainte NOT NULL a disparu',
);
const intacte = await app.query(
  'SELECT expires_at IS NOT NULL AS non_nul FROM rate_limit_counters WHERE bucket_key = $1',
  [cleNulle],
);
verifier(
  'la ligne visée conserve un expires_at non nul',
  intacte.rows.length === 1 && intacte.rows[0].non_nul === true,
  intacte.rows.length === 1 ? 'expires_at à NULL' : 'ligne disparue',
);

// Une fonction SECURITY DEFINER s'exécute avec les droits de son propriétaire,
// pas de l'appelant : elle ignorerait la RLS. Aucune ne doit toucher la table.
const fonctions = await app.query(
  `SELECT p.proname FROM pg_proc p
   WHERE p.prosecdef AND (p.prosrc ILIKE '%rate_limit_counters%' OR p.proname ILIKE '%rate_limit%')`,
);
verifier(
  'aucune fonction SECURITY DEFINER ne touche la table',
  fonctions.rows.length === 0,
  fonctions.rows.map((r) => r.proname).join(', ') || 'aucune',
);

// Une clé étrangère avec ON DELETE CASCADE supprimerait des compteurs en
// cascade, sans passer par la politique DELETE.
const clesEtrangeres = await app.query(
  `SELECT count(*)::int n FROM pg_constraint WHERE confrelid = 'rate_limit_counters'::regclass`,
);
verifier(
  'aucune clé étrangère ne pointe vers la table — pas de cascade possible',
  clesEtrangeres.rows[0].n === 0,
  `${clesEtrangeres.rows[0].n} contrainte(s)`,
);

// Le périmètre exact : au-delà des quatre droits nécessaires, tout est refusé.
const privileges = await app.query(
  `SELECT p, has_table_privilege('tracefab_app', 'rate_limit_counters', p) AS ok
   FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) AS p`,
);
const indus = privileges.rows.filter((r) => r.ok && !['SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(r.p));
verifier(
  'le rôle applicatif ne détient aucun privilège au-delà de SELECT/INSERT/UPDATE/DELETE',
  indus.length === 0,
  indus.map((r) => r.p).join(', ') || 'aucun',
);

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
