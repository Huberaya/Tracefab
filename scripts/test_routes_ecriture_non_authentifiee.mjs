#!/usr/bin/env -S npx tsx
/**
 * Épreuve — POST non authentifié sur les trois routes modifiées par la PR #58.
 *
 *   documents/[documentId]/scan.ts          (nouveau)
 *   documents/upload-intent.ts              (modifié)
 *   supplier/documents/[documentId]/scan.ts (modifié)
 *
 * Ces trois routes sont POST uniquement et exigent `requireClerkUser`. Aucune
 * n'est vérifiable par un GET de navigateur, et un POST authentifié sur
 * `upload-intent` appelle `tracefab_register_document`, qui CRÉE un document.
 * Le parcours authentifié ne peut donc pas être exercé sur un déploiement
 * partagé ; seul le refus l'est.
 *
 * Ce que cette suite établit
 *   1. chacune des trois routes renvoie 401 `{"error":"unauthorized"}` ;
 *   2. ce 401 vient de l'application, pas d'une protection de déploiement ;
 *   3. aucun document n'est créé, modifié ni supprimé ;
 *   4. le limiteur de débit ÉCRIT avant le gestionnaire : `rate_limit_counters`
 *      reçoit une ligne. Effet de bord réel, mesuré — pas supposé absent.
 *
 * Ce qu'elle n'établit PAS : le parcours authentifié (autorisation, quota,
 * stockage), ni le comportement sur un déploiement réel.
 *
 * Deux modes :
 *   - `DATABASE_URL` fournie → base déjà prête (cas de la CI, qui applique les
 *     migrations en amont). La garde refuse tout hôte managé.
 *   - sans `DATABASE_URL` → base PostgreSQL jetable créée puis détruite ici.
 *
 * Sorties : 0 vert · 1 échec · 2 non exécuté · 3 cible refusée.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import pg from 'pg';

const SORTIE_ECHEC = 1;
const SORTIE_PREREQUIS = 2;

/* --- 1. La base : fournie, ou jetable créée ici ----------------------------- */

let serveur = null;
let chaineAdmin;

if (process.env.DATABASE_URL) {
  // Refus par défaut : aucune suite touchant une base ne doit joindre un hôte
  // managé. La garde sort elle-même (code 3) et n'émet alors aucune requête.
  const { requireThrowawayDb } = await import('./lib/require-throwaway-db.mjs');
  requireThrowawayDb({
    variables: ['DATABASE_URL'],
    purpose: 'épreuve POST non authentifié sur les routes de la PR',
    exitOnFailure: true,
  });
  chaineAdmin = process.env.DATABASE_URL;
  console.log('\n  base fournie par l environnement');
} else {
  const PORT = 55432;
  const DIR = '.epreuve-pg';
  chaineAdmin = `postgresql://postgres:postgres@127.0.0.1:${PORT}/tracefab_test`;
  console.log('\n  1. base jetable locale');
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  serveur = new EmbeddedPostgres({
    databaseDir: path.resolve(DIR), user: 'postgres', password: 'postgres',
    port: PORT, persistent: false,
  });
  await serveur.initialise();
  await serveur.start();
  const amorce = new pg.Client({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres` });
  await amorce.connect();
  await amorce.query('CREATE DATABASE tracefab_test');
  await amorce.end();

  console.log('  2. rôle applicatif, migrations, privilèges (scripts du dépôt)');
  const environnement = { ...process.env, DATABASE_URL: chaineAdmin, TF_APP_PASSWORD: 'isolation_ci_jetable' };
  execFileSync('node', ['scripts/prepare_ci_db_role.mjs'], { env: environnement, stdio: 'inherit' });
  const mig = new pg.Client({ connectionString: chaineAdmin });
  await mig.connect();
  const dossiers = fs.readdirSync('prisma/migrations').filter((d) => /^\d{14}_/.test(d)).sort();
  for (const d of dossiers) {
    const sql = fs.readFileSync(path.join('prisma/migrations', d, 'migration.sql'), 'utf8');
    try {
      await mig.query('BEGIN'); await mig.query(sql); await mig.query('COMMIT');
    } catch (e) {
      try { await mig.query('ROLLBACK'); } catch {}
      console.log(`  ECHEC ${d} : ${e.code ?? ''} ${String(e.message).split('\n')[0].slice(0, 100)}`);
      await mig.end(); if (serveur) await serveur.stop(); process.exit(SORTIE_ECHEC);
    }
  }
  // `_prisma_migrations` n'est volontairement pas tenue : cette épreuve ne la
  // lit pas, et les routes testées non plus. La journaliser ici n'ajouterait
  // qu'une table à créer avant la boucle, pour rien.
  console.log(`     ${dossiers.length} migrations appliquées`);
  await mig.end();
  execFileSync('node', ['scripts/bootstrap_app_role.mjs'], { env: environnement, stdio: 'inherit' });
  process.env.DATABASE_URL = chaineAdmin;
}

/* --- 2. Le gabarit Clerk ---------------------------------------------------- */

// `requireClerkUser` teste la PRÉSENCE de la clé avant toute autre chose
// (api/_lib/auth.ts) : absente, il lève `missing_clerk_secret_key` et les routes
// répondent 503 `clerk_not_configured` sans atteindre le contrôle de jeton. La
// CI ne définit cette variable nulle part.
//
// Valeur ci-dessous = GABARIT, aucune clé réelle, aucun compte correspondant.
// Elle n'est jamais utilisée : sans en-tête `authorization`, l'exécution s'arrête
// sur `UnauthorizedError` avant `verifyToken` et avant `createClerkClient`.
// Aucun appel réseau vers Clerk n'est émis.
//
// À poser AVANT l'import : `clerkSecretKey` est lu au chargement du module.
process.env.CLERK_SECRET_KEY ||= 'sk_gabarit_epreuve_locale_sans_valeur';

/* --- 3. Le répartiteur réel ------------------------------------------------- */

console.log('\n  3. import du répartiteur');
let handler;
try {
  ({ default: handler } = await import('../api/index.ts'));
} catch (e) {
  console.log('  NON EXECUTE — ' + String(e.message).split('\n')[0]);
  console.log('  Client Prisma absent ? Lancez `npm run db:generate`.');
  if (serveur) await serveur.stop();
  process.exit(SORTIE_PREREQUIS);
}

/* --- 4. Doubles de requête et de réponse ------------------------------------ */

function reponse() {
  const h = {};
  const r = {
    statusCode: 200, emitted: null,
    getHeader: (n) => h[String(n).toLowerCase()],
    setHeader: (n, v) => { h[String(n).toLowerCase()] = v; return r; },
    status(c) { r.statusCode = c; return r; },
    json(p) { r.emitted = p; return r; },
    send(p) { r.emitted = p; return r; },
    end() { return r; }, set() { return r; }, on() { return r; },
  };
  return r;
}

// Aucun en-tête `authorization` : c'est l'objet même de l'épreuve. Aucun `fetch`
// non plus — la requête est un objet passé au gestionnaire dans le processus,
// donc aucun socket ne peut joindre un hôte distant.
const requete = (chemin) => ({
  url: chemin, method: 'POST', query: {}, body: {},
  headers: { host: 'tracefab.test', 'user-agent': 'epreuve-ecriture-non-authentifiee' },
  socket: { remoteAddress: '203.0.113.10' },
  on() {}, once() {}, removeListener() {},
});

const UUID = '00000000-0000-4000-8000-000000000000';
const routes = [
  { nom: 'scan marque', chemin: `documents/${UUID}/scan` },
  { nom: 'intention depot', chemin: 'documents/upload-intent' },
  { nom: 'scan fournisseur', chemin: `supplier/documents/${UUID}/scan` },
];

const estProtectionPlateforme = (corps) =>
  /vercel_auth_enabled|Protected by Vercel Authentication/i.test(JSON.stringify(corps ?? ''));

/* --- 5. Cas ----------------------------------------------------------------- */

let assertions = 0;
let echecs = 0;
const verifier = (nom, cond, obs) => {
  assertions += 1;
  if (cond) console.log(`  ok    ${nom}`);
  else { echecs += 1; console.log(`  ECHEC ${nom} — observé : ${obs}`); }
};

const admin = new pg.Client({ connectionString: chaineAdmin });
await admin.connect();
const compte = async (t) => (await admin.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;

console.log('\n  4. épreuve');
try {
  const docsAvant = await compte('documents');
  const cptAvant = await compte('rate_limit_counters');

  for (const route of routes) {
    const res = reponse();
    const vrai = console.error;
    console.error = () => {};
    try { await handler(requete(route.chemin), res); } finally { console.error = vrai; }
    verifier(`${route.nom} — 401 applicatif`,
      res.statusCode === 401 && res.emitted?.error === 'unauthorized',
      `${res.statusCode} ${JSON.stringify(res.emitted)}`);
    verifier(`${route.nom} — pas une réponse de plateforme`,
      !estProtectionPlateforme(res.emitted), JSON.stringify(res.emitted));
  }

  const docsApres = await compte('documents');
  const cptApres = await compte('rate_limit_counters');
  console.log(`  documents ${docsAvant} -> ${docsApres} · compteurs ${cptAvant} -> ${cptApres}`);

  verifier('aucun document créé ni modifié', docsApres === docsAvant, `${docsAvant} -> ${docsApres}`);
  // Les trois requêtes partagent la même empreinte (même classe `public-write`,
  // même adresse) et tombent dans la même fenêtre de 300 s : une seule ligne,
  // incrémentée trois fois. L'attente est donc >= 1 ligne, pas 3.
  verifier('le limiteur a écrit (effet de bord mesuré)', cptApres > cptAvant, `${cptAvant} -> ${cptApres}`);
} catch (e) {
  echecs += 1;
  console.log(`  ECHEC — ${e.code ?? e.message}`);
} finally {
  await admin.end();
}

if (serveur) {
  await serveur.stop();
  fs.rmSync('.epreuve-pg', { recursive: true, force: true });
  console.log('  base jetable détruite');
}

console.log(`\n  ${assertions - echecs}/${assertions} assertions vertes\n`);
process.exit(echecs > 0 ? SORTIE_ECHEC : 0);
