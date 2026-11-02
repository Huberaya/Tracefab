#!/usr/bin/env node
/**
 * HMAC d'identité — les huit scénarios exigés, mesurés sur base jetable.
 *
 * CE QUE CE TEST PROUVE
 *
 *   1. identité légitime            -> acceptée, données du locataire visibles
 *   2. identité d'une autre org     -> l'identité est bien celle du jeton, et
 *                                      elle ne voit RIEN de l'autre organisation
 *   3. GUC forgé sans jeton (strict)-> refusé
 *   4. jeton falsifié               -> refusé
 *   5. jeton expiré                 -> refusé
 *   6. jeton rejoué autre contexte  -> refusé (organisation signée ≠ session)
 *   7. clé inaccessible au runtime  -> 42501, vérifié par exécution
 *   8. connexion physique réutilisée-> aucun contexte résiduel
 *
 * Et un contrôle négatif qui donne sa valeur à l'ensemble : si l'on force la
 * clé à une valeur connue de l'appelant, le jeton falsifié DOIT être accepté.
 * Sans ce contrôle, un « refusé » pourrait venir d'une simple erreur de forme
 * du jeton, pas de la vérification.
 *
 * Le test n'utilise ni secret d'exploitation ni production : il pose sa propre
 * clé dans une base jetable, et la retire à la fin.
 *
 * Sortie : 0 conforme · 1 régression · 2 non exécuté · 3 refus.
 */
import process from 'node:process';
import { createHmac, randomBytes } from 'node:crypto';
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';

const urlAdmin = (process.env.DATABASE_URL || '').trim();
const urlApp = (process.env.TF_RLS_APP_URL || '').trim();
if (!urlAdmin || !urlApp) {
  console.error('  NON EXECUTE — DATABASE_URL et TF_RLS_APP_URL sont requises.');
  process.exit(2);
}
const hote = (() => { try { return new URL(urlAdmin).hostname; } catch { return ''; } })();
if (!/^(localhost|127\.0\.0\.1|::1|\[::1\])$/.test(hote)) {
  console.error(`  REFUS — cible non locale (${hote || 'illisible'}).`);
  process.exit(3);
}

let echecs = 0;
let assertions = 0;
const ok = (cond, libelle, detail = '') => {
  assertions += 1;
  console.log(`  ${cond ? 'ok   ' : 'ECHEC'} ${libelle}${detail ? ` — ${detail}` : ''}`);
  if (!cond) echecs += 1;
};

const admin = new pg.Client({ connectionString: urlAdmin, ssl: sslDepuisUrl(urlAdmin), application_name: 'tracefab-hmac-admin' });
await admin.connect();

// ---------------------------------------------------------------------------
// Fixtures : deux locataires réels, et une clé de test.
// ---------------------------------------------------------------------------
const locataires = (await admin.query(
  `SELECT o.id, o.legal_name, m.user_id
     FROM organizations o
     JOIN organization_memberships m ON m.organization_id = o.id AND m.role = 'owner'
    ORDER BY o.created_at, o.id LIMIT 2`,
)).rows;
if (locataires.length < 2) {
  console.error('  NON EXECUTE — il faut deux locataires ; jouer npm run db:seed-rls d abord.');
  await admin.end();
  process.exit(2);
}
const [A, B] = locataires;

const secret = randomBytes(32);
const VERSION = 99001; // version de test, hors plage des versions d exploitation
await admin.query('DELETE FROM public.tracefab_identity_cles WHERE version = $1', [VERSION]);
await admin.query(
  `INSERT INTO public.tracefab_identity_cles (version, secret, actif) VALUES ($1, $2, false)`,
  [VERSION, secret],
);

const signer = (corps, cle = secret) => createHmac('sha256', cle).update(corps).digest('hex');
const jeton = ({ userId, orgId, exp, usage = 'tracefab_identity', cle = secret }) => {
  const corps = `v1|${userId}|${orgId}|${usage}|${exp}`;
  return `${corps}.${signer(corps, cle)}`;
};
const MAINTENANT = Math.floor(Date.now() / 1000);

/** Ouvre une transaction, arme les GUC, exécute `corps`, annule tout. */
const app = new pg.Client({ connectionString: urlApp, ssl: sslDepuisUrl(urlApp), application_name: 'tracefab-hmac-runtime' });
await app.connect();

async function dansTransaction({ identite, userId, orgId }, corps) {
  await app.query('BEGIN');
  try {
    if (identite !== undefined) await app.query('SELECT set_config($1,$2,true)', ['tracefab.identity', identite]);
    if (userId !== undefined) await app.query('SELECT set_config($1,$2,true)', ['tracefab.user_id', userId]);
    if (orgId !== undefined) await app.query('SELECT set_config($1,$2,true)', ['tracefab.active_organization_id', orgId]);
    return await corps();
  } finally {
    await app.query('ROLLBACK').catch(() => {});
  }
}
const identite = () => app.query('SELECT public.tracefab_current_user_id() AS id').then((r) => r.rows[0].id);
const produits = (orgId) => app.query(
  'SELECT count(*)::int AS n FROM tracefab_products WHERE brand_organization_id = $1', [orgId],
).then((r) => r.rows[0].n);

// La clé de test doit être ACTIVE pour que la vérification l'utilise.
await admin.query('UPDATE public.tracefab_identity_cles SET actif = (version = $1)', [VERSION]);

// ---------------------------------------------------------------------------
// 1. Identité légitime
// ---------------------------------------------------------------------------
const jetonA = jeton({ userId: A.user_id, orgId: A.id, exp: MAINTENANT + 60 });
const r1 = await dansTransaction({ identite: jetonA, orgId: A.id }, async () => ({
  id: await identite(), n: await produits(A.id),
}));
ok(r1.id === A.user_id, 'S1 jeton légitime : l identité rendue est celle du jeton', `${r1.id}`);
ok(r1.n > 0, 'S1 jeton légitime : le locataire voit ses produits', `${r1.n} produit(s)`);

// ---------------------------------------------------------------------------
// 2. Identité d'une autre organisation
// ---------------------------------------------------------------------------
// Le jeton est signé pour A mais vise l'organisation B : la vérification le
// refuse (organisation signée ≠ GUC). Même si l'on aligne le GUC sur la valeur
// signée, l'identité reste A — et A ne voit rien de B.
const jetonAorgB = jeton({ userId: A.user_id, orgId: B.id, exp: MAINTENANT + 60 });
const r2a = await dansTransaction({ identite: jetonAorgB, orgId: A.id }, () => identite());
ok(r2a === null, 'S2 jeton lié à B présenté dans un contexte A : refusé', `${r2a}`);

const r2b = await dansTransaction({ identite: jetonAorgB, orgId: B.id }, async () => ({
  id: await identite(), n: await produits(B.id),
}));
ok(r2b.id === A.user_id && r2b.n === 0,
  'S2 même avec le contexte aligné, A ne voit aucun produit de B',
  `identité=${r2b.id} produits de B vus=${r2b.n}`);

// ---------------------------------------------------------------------------
// 3. GUC forgé sans jeton, en mode strict
// ---------------------------------------------------------------------------
const strictAvant = (await admin.query('SELECT strict FROM public.tracefab_identity_politique WHERE singleton')).rows[0].strict;
await admin.query('UPDATE public.tracefab_identity_politique SET strict = true, modifie_le = now() WHERE singleton');
try {
  const r3 = await dansTransaction({ userId: B.user_id, orgId: B.id }, () => identite());
  ok(r3 === null, 'S3 GUC forgé sans jeton en mode strict : refusé', `${r3}`);
  const n3 = await dansTransaction({ userId: B.user_id, orgId: B.id }, () => produits(B.id));
  ok(n3 === 0, 'S3 aucune ligne de B visible par usurpation du GUC', `${n3} ligne(s)`);
} finally {
  await admin.query('UPDATE public.tracefab_identity_politique SET strict = $1, modifie_le = now() WHERE singleton', [strictAvant]);
}

// ---------------------------------------------------------------------------
// 4. Jeton falsifié
// ---------------------------------------------------------------------------
const jetonFalsifie = jeton({ userId: B.user_id, orgId: B.id, exp: MAINTENANT + 60 });
const corpsFalsifie = jetonFalsifie.split('.')[0];
const macFalsifie = jetonFalsifie.split('.')[1];
const jetonAutreCorps = `${corpsFalsifie}.${signer(corpsFalsifie, randomBytes(32))}`;
const r4 = await dansTransaction({ identite: jetonAutreCorps, orgId: B.id }, () => identite());
ok(r4 === null, 'S4 jeton dont le MAC ne correspond pas : refusé', `${r4}`);

// Le corps modifié, MAC conservé (l'attaque la plus évidente).
const corpsModifie = `v1|${A.user_id}|${B.id}|tracefab_identity|${MAINTENANT + 60}`;
const r4b = await dansTransaction({ identite: `${corpsModifie}.${macFalsifie}`, orgId: B.id }, () => identite());
ok(r4b === null, 'S4 jeton au corps modifié, MAC conservé : refusé', `${r4b}`);

// ---------------------------------------------------------------------------
// 5. Jeton expiré
// ---------------------------------------------------------------------------
const jetonExpire = jeton({ userId: A.user_id, orgId: A.id, exp: MAINTENANT - 5 });
const r5 = await dansTransaction({ identite: jetonExpire, orgId: A.id }, () => identite());
ok(r5 === null, 'S5 jeton expiré : refusé', `${r5}`);

// ---------------------------------------------------------------------------
// 6. Jeton rejoué dans un autre contexte
// ---------------------------------------------------------------------------
const r6 = await dansTransaction({ identite: jetonA, orgId: B.id }, () => identite());
ok(r6 === null, 'S6 jeton de A rejoué avec un autre active_organization_id : refusé', `${r6}`);
const r6b = await dansTransaction({ identite: jetonA, orgId: '' }, () => identite());
ok(r6b === null, 'S6 jeton sans organisation en session : refusé', `${r6b}`);

// ---------------------------------------------------------------------------
// 7. La clé est inaccessible au runtime
// ---------------------------------------------------------------------------
let lectureCle = null;
try {
  await app.query('SELECT version, secret FROM public.tracefab_identity_cles LIMIT 1');
  lectureCle = 'ACCEPTEE';
} catch (e) {
  lectureCle = `${e.code || ''} ${e.message.split('\n')[0].slice(0, 50)}`;
}
ok(String(lectureCle).startsWith('42501'), 'S7 tracefab_app ne peut pas lire la clé', String(lectureCle));

// Aucune fonction accessible au runtime ne signe : on cherche une fonction
// exécutable par l'app qui rendrait un MAC (donc un oracle de signature).
// Le filtre porte sur les fonctions `tracefab_*` : `hmac()` de pgcrypto est
// exécutable par tout le monde et ne constitue PAS un oracle ici — il faut
// déjà détenir la clé pour s'en servir, et la clé n'est pas lisible.
const oracle = await admin.query(
  `SELECT p.proname
     FROM pg_catalog.pg_proc p
     JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname LIKE 'tracefab\\_%'
      AND (p.proname ILIKE '%sign%' OR p.proname ILIKE '%mac%' OR p.proname ILIKE '%hmac%')
      AND has_function_privilege('tracefab_app', p.oid, 'EXECUTE')
      AND p.proname <> 'tracefab_identity_jeton_utilisateur'`,
);
ok(oracle.rows.length === 0, 'S7 aucune fonction de signature accessible au runtime',
  oracle.rows.map((r) => r.proname).join(', ') || 'aucune');

// ---------------------------------------------------------------------------
// 8. Connexion physique réutilisée : aucun contexte résiduel
// ---------------------------------------------------------------------------
const pid = () => app.query('SELECT pg_backend_pid() AS p').then((r) => r.rows[0].p);
const pids = new Set();
const tour1 = await dansTransaction({ identite: jetonA, orgId: A.id }, async () => {
  pids.add(await pid());
  return identite();
});
const tour2 = await dansTransaction({}, async () => {
  pids.add(await pid());
  return { id: await identite(), n: await app.query('SELECT count(*)::int AS n FROM tracefab_products').then((r) => r.rows[0].n) };
});
ok(tour1 === A.user_id && tour2.id === null && tour2.n === 0,
  'S8 sur la même connexion, l identité ne survit pas à la transaction',
  `tours=${pids.size} pid · après=${tour2.id} · lignes=${tour2.n}`);

// ---------------------------------------------------------------------------
// Contrôle négatif : une clé connue de l'appelant rend la falsification valide.
// ---------------------------------------------------------------------------
const cleConnue = randomBytes(32);
await admin.query('UPDATE public.tracefab_identity_cles SET secret = $1 WHERE version = $2', [cleConnue, VERSION]);
const jetonForge = jeton({ userId: B.user_id, orgId: B.id, exp: MAINTENANT + 60, cle: cleConnue });
const rControle = await dansTransaction({ identite: jetonForge, orgId: B.id }, () => identite());
ok(rControle === B.user_id,
  'contrôle négatif : avec la clé, le même jeton est accepté — la vérification est bien la clé',
  `identité=${rControle}`);

// Restauration : la clé de test disparaît, la politique reprend sa valeur.
await admin.query('DELETE FROM public.tracefab_identity_cles WHERE version = $1', [VERSION]);
await admin.query('UPDATE public.tracefab_identity_politique SET strict = $1, modifie_le = now() WHERE singleton', [strictAvant]);
const residus = await admin.query('SELECT count(*)::int AS n FROM public.tracefab_identity_cles');
console.log(`  info  clés restantes après le test : ${residus.rows[0].n}`);

await app.end();
await admin.end();

console.log('');
if (echecs === 0) {
  console.log(`  HMAC d'identité : ${assertions} assertions — les huit scénarios sont couverts.`);
  process.exit(0);
}
console.log(`  ${echecs} ÉCHEC sur ${assertions} assertions.`);
process.exit(1);
