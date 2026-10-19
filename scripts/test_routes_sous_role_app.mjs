#!/usr/bin/env -S npx tsx
/**
 * Épreuve — les trois routes POST de la PR, l'application connectée sous le
 * rôle restreint `tracefab_app` au lieu du propriétaire de la base.
 *
 * POURQUOI CETTE SUITE EXISTE
 *
 * Production tourne sous `neondb_owner`, dont `rolbypassrls` est vrai : la RLS
 * ne s'y applique pas. La bascule vers `tracefab_app` est préparée mais non
 * exécutée. Avant de la décider, il faut savoir si l'application fonctionne
 * encore quand sa connexion est restreinte — et il faut le MESURER, pas le
 * déduire de la configuration attendue.
 *
 * Le point le plus fragile est connu : le limiteur de débit écrit directement
 * dans `rate_limit_counters` avant tout gestionnaire, et il est en échec
 * fermé. Si le rôle restreint ne peut pas écrire, TOUTES les requêtes — y
 * compris les légitimes — tombent en 503 `rate_limiter_unavailable`.
 *
 * CE QUI EST MESURÉ
 *
 *   1. l'identité réelle de la connexion, lue à travers le client Prisma de
 *      l'application (`api/_lib/prisma.ts`), pas supposée depuis une variable ;
 *   2. `rolbypassrls` faux, donc la RLS s'applique vraiment ;
 *   3. les trois routes rendent 401 `{"error":"unauthorized"}` ;
 *   4. aucun document créé ni modifié ;
 *   5. le limiteur écrit malgré le rôle restreint.
 *
 * CE QUI N'EST PAS ÉTABLI : le parcours authentifié, qui exige un jeton Clerk
 * valide et crée un document réel.
 *
 * Base PostgreSQL jetable, créée puis détruite ici. Aucune cible distante :
 * l'hôte est `127.0.0.1` et le mot de passe du rôle est tiré au sort sur
 * place, sans valeur réelle derrière.
 *
 * Sorties : 0 vert · 1 échec · 2 non exécuté.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import pg from 'pg';

const SORTIE_ECHEC = 1;
const SORTIE_PREREQUIS = 2;

const PORT = 55435;
const DIR = '.role-app-pg';
const HOTE = '127.0.0.1';
const MOT_DE_PASSE = crypto.randomBytes(18).toString('base64url');
const URL_PROPRIETAIRE = `postgresql://postgres:postgres@${HOTE}:${PORT}/tracefab_test`;
const URL_APP = `postgresql://tracefab_app:${MOT_DE_PASSE}@${HOTE}:${PORT}/tracefab_test`;

/* --- 1. Base jetable -------------------------------------------------------- */

console.log('\n  1. base jetable locale');
const { default: EmbeddedPostgres } = await import('embedded-postgres');
const serveur = new EmbeddedPostgres({
  databaseDir: path.resolve(DIR), user: 'postgres', password: 'postgres',
  port: PORT, persistent: false,
});
await serveur.initialise();
await serveur.start();

const amorce = new pg.Client({ connectionString: `postgresql://postgres:postgres@${HOTE}:${PORT}/postgres` });
await amorce.connect();
await amorce.query('CREATE DATABASE tracefab_test');
await amorce.end();

console.log('  2. rôle applicatif, migrations, privilèges (scripts du dépôt)');
const environnement = { ...process.env, DATABASE_URL: URL_PROPRIETAIRE, TF_APP_PASSWORD: MOT_DE_PASSE };
execFileSync('node', ['scripts/prepare_ci_db_role.mjs'], { env: environnement, stdio: 'inherit' });

const mig = new pg.Client({ connectionString: URL_PROPRIETAIRE });
await mig.connect();
const dossiers = fs.readdirSync('prisma/migrations').filter((d) => /^\d{14}_/.test(d)).sort();
for (const d of dossiers) {
  const sql = fs.readFileSync(path.join('prisma/migrations', d, 'migration.sql'), 'utf8');
  await mig.query('BEGIN');
  try { await mig.query(sql); await mig.query('COMMIT'); }
  catch (e) {
    await mig.query('ROLLBACK');
    console.log(`  ECHEC ${d} : ${e.code ?? ''} ${String(e.message).split('\n')[0].slice(0, 100)}`);
    await mig.end(); await serveur.stop(); process.exit(SORTIE_ECHEC);
  }
}
await mig.end();
console.log(`     ${dossiers.length} migrations appliquées`);
execFileSync('node', ['scripts/bootstrap_app_role.mjs'], { env: environnement, stdio: 'inherit' });

// La connexion de l'application devient celle du rôle restreint. C'est le cœur
// de l'épreuve : tout ce qui suit passe par ce rôle, y compris Prisma.
process.env.DATABASE_URL = URL_APP;

/* --- 2. Gabarit Clerk ------------------------------------------------------- */

// `requireClerkUser` teste la présence de la clé avant le jeton. Sans variable,
// les routes répondent 503 `clerk_not_configured` sans atteindre le contrôle.
// Gabarit sans valeur réelle, jamais utilisé : sans en-tête `authorization`
// l'exécution s'arrête sur `UnauthorizedError` avant `verifyToken`, donc aucun
// appel réseau vers Clerk n'est émis. À poser avant l'import.
process.env.CLERK_SECRET_KEY ||= 'sk_gabarit_epreuve_locale_sans_valeur';

/* --- 3. Répartiteur et client Prisma de l'application ----------------------- */

console.log('\n  3. import du répartiteur et du client Prisma de l application');
let handler;
let prisma;
try {
  ({ default: handler } = await import('../api/index.ts'));
  ({ prisma } = await import('../api/_lib/prisma.ts'));
} catch (e) {
  const message = String(e.message).split('\n')[0];
  console.log('  NON EXECUTE — ' + message);
  // Deux causes distinctes, et les confondre envoie chercher au mauvais endroit.
  if (/Cannot find module|ERR_MODULE_NOT_FOUND|\.js' imported from/.test(message)) {
    console.log('  Chargeur inadapté : ce fichier importe du TypeScript. Lancez-le');
    console.log('  avec `npx tsx scripts/test_routes_sous_role_app.mjs`, pas avec `node`.');
  } else {
    console.log('  Client Prisma absent ? Lancez `npm run db:generate`.');
  }
  await serveur.stop();
  fs.rmSync(DIR, { recursive: true, force: true });
  process.exit(SORTIE_PREREQUIS);
}

/* --- 4. Doublures de requête et de réponse ---------------------------------- */

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

// Aucun en-tête `authorization` : c'est l'objet de l'épreuve. Aucun `fetch` non
// plus — la requête est un objet passé au gestionnaire dans le processus, donc
// aucun socket ne peut joindre un hôte distant.
const requete = (chemin) => ({
  url: chemin, method: 'POST', query: {}, body: {},
  headers: { host: 'tracefab.test', 'user-agent': 'epreuve-role-app' },
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

/* --- 5. Assertions ---------------------------------------------------------- */

let assertions = 0;
let echecs = 0;
const verifier = (nom, cond, obs) => {
  assertions += 1;
  if (cond) console.log(`  ok    ${nom}`);
  else { echecs += 1; console.log(`  ECHEC ${nom} — observé : ${obs}`); }
};

console.log('\n  4. identité de la connexion, lue via le client Prisma de l application');
try {
  // Mesure, pas déduction : c'est le client de l'application qui répond, sur la
  // connexion qu'il emploie réellement.
  const identite = await prisma.$queryRaw`
    SELECT current_user AS utilisateur,
           session_user AS session,
           (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS contourne_rls,
           (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser`;
  const i = identite[0];
  console.log(`     current_user=${i.utilisateur} · session_user=${i.session} · contourne_rls=${i.contourne_rls} · superuser=${i.superuser}`);
  verifier('la connexion de l application est bien tracefab_app',
    i.utilisateur === 'tracefab_app' && i.session === 'tracefab_app',
    `${i.utilisateur} / ${i.session}`);
  verifier('le role ne contourne pas la RLS',
    i.contourne_rls === false && i.superuser === false,
    `contourne_rls=${i.contourne_rls} superuser=${i.superuser}`);
} catch (e) {
  echecs += 2; assertions += 2;
  console.log(`  ECHEC identité — ${e.code ?? String(e.message).split('\n')[0]}`);
}

// Comptages par le même rôle, pour que les chiffres reflètent ce que
// l'application voit réellement.
const app = new pg.Client({ connectionString: URL_APP });
await app.connect();
const compte = async (t) => (await app.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;

console.log('\n  5. épreuve sous rôle restreint');
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
  // même adresse) dans une fenêtre de 300 s : une ligne incrémentée trois fois.
  verifier('le limiteur écrit sous role restreint', cptApres > cptAvant, `${cptAvant} -> ${cptApres}`);
} catch (e) {
  echecs += 1;
  console.log(`  ECHEC — ${e.code ?? String(e.message).split('\n')[0]}`);
} finally {
  await app.end();
}

await prisma.$disconnect().catch(() => {});
await serveur.stop();
fs.rmSync(DIR, { recursive: true, force: true });
console.log('  base jetable détruite');

console.log(`\n  ${assertions - echecs}/${assertions} assertions vertes\n`);
process.exit(echecs > 0 ? SORTIE_ECHEC : 0);
