#!/usr/bin/env npx tsx
/**
 * P10.5 — le signataire applicatif (TS) et la vérification en base.
 *
 * POURQUOI CE TEST EXISTE
 *
 * `scripts/test_p105_hmac_identite.mjs` prouve que la BASE vérifie : il forge
 * lui-même le HMAC en Node. Il ne prouve pas que l'APPLICATION signe comme la
 * base attend — c'était le maillon non testé, et c'est exactement le genre
 * d'écart (séparateur, encodage, unité de l'échéance) qui ne se voit qu'en
 * exécution.
 *
 * Ce test prend donc le chemin réel :
 *
 *   1. provisionner la clé avec `scripts/provisionner_cle_identite.mjs`, comme
 *      le ferait un opérateur, sans jamais afficher la clé ;
 *   2. signer avec `signerIdentite()` — le code que `api/_lib/context.ts`
 *      appelle à chaque requête ;
 *   3. faire vérifier par PostgreSQL, sous `tracefab_app`, la valeur rendue
 *      par `tracefab_current_user_id()`.
 *
 * Si l'un des trois désaccorde, le test échoue — bruit compris.
 *
 * Env : DATABASE_URL (administration), TF_RLS_APP_URL (runtime).
 * Sortie : 0 conforme · 1 régression · 2 non exécuté · 3 refus.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import process from 'node:process';
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';
import {
  signerIdentite,
  cleIdentite,
  identiteSigneeConfiguree,
  IDENTITY_PURPOSE,
  DUREE_JETON_SECONDES,
} from '../api/_lib/identite-jeton.js';

const URL_ADMIN = (process.env.DATABASE_URL || '').trim();
const URL_APP = (process.env.TF_RLS_APP_URL || '').trim();
if (!URL_ADMIN || !URL_APP) {
  console.error('  NON EXECUTE — DATABASE_URL et TF_RLS_APP_URL sont requises.');
  process.exit(2);
}
const hote = (() => { try { return new URL(URL_ADMIN).hostname; } catch { return ''; } })();
if (!/^(localhost|127\.0\.0\.1|::1|\[::1\])$/.test(hote)) {
  console.error(`  REFUS — cible non locale (${hote || 'illisible'}).`);
  process.exit(3);
}

let assertions = 0;
let echecs = 0;
const ok = (cond: boolean, libelle: string, detail = '') => {
  assertions += 1;
  console.log(`  ${cond ? 'ok   ' : 'ECHEC'} ${libelle}${detail ? ` — ${detail}` : ''}`);
  if (!cond) echecs += 1;
};

const cli = (url: string) => new pg.Client({ connectionString: url, ssl: sslDepuisUrl(url), application_name: 'tracefab-p105-jeton-ts' });
const admin = cli(URL_ADMIN);
await admin.connect();

/* --- la cible : un propriétaire réel -------------------------------------- */
const cible = (await admin.query(
  `SELECT m.user_id, m.organization_id, o.legal_name
     FROM organization_memberships m JOIN organizations o ON o.id = m.organization_id
    WHERE m.role = 'owner' ORDER BY o.created_at, o.id LIMIT 1`)).rows[0];
const autre = (await admin.query(
  `SELECT id FROM organizations WHERE id <> $1 ORDER BY created_at LIMIT 1`, [cible.organization_id])).rows[0];
if (!cible || !autre) {
  console.error('  NON EXECUTE — un propriétaire et deux organisations sont requis.');
  await admin.end();
  process.exit(2);
}
console.log(`  cible : ${cible.legal_name} · organization_id=${cible.organization_id}`);

/* --- 1. provisionnement par le chemin opérateur --------------------------- */
const cle = randomBytes(32).toString('hex');
const versionMax = (await admin.query('SELECT coalesce(max(version), 0) AS v FROM public.tracefab_identity_cles')).rows[0].v;

const sortie = execFileSync('node', ['scripts/provisionner_cle_identite.mjs'], {
  env: { ...process.env, TF_IDENTITY_KEY_HEX: cle, TF_ALLOW_PROVISIONING: 'oui' },
  encoding: 'utf8',
});
ok(/VERDICT\s*:\s*clé provisionnée/i.test(sortie), 'la clé est provisionnée par le script opérateur');
ok(!sortie.includes(cle), 'le script n a exposé la clé dans AUCUNE de ses sorties');

const nouvelles = (await admin.query(
  'SELECT version FROM public.tracefab_identity_cles WHERE version > $1 ORDER BY version', [versionMax])).rows.map((r) => r.version);
ok(nouvelles.length === 1, 'une seule clé a été ajoutée', `version ${nouvelles.join(',')}`);

/* --- 2. le signataire applicatif ------------------------------------------ */
delete process.env.TRACEFAB_IDENTITY_KEY;
ok(!identiteSigneeConfiguree(), 'sans variable d environnement, aucun jeton signé n est annoncé');
ok(signerIdentite({ userId: cible.user_id, organizationId: cible.organization_id, cle: cleIdentite() }) === null,
  'sans clé configurée, signerIdentite retourne null — jamais un jeton non signé');

process.env.TRACEFAB_IDENTITY_KEY = cle;
ok(identiteSigneeConfiguree(), 'avec la clé en environnement, la signature est annoncée');
ok(cleIdentite() === cle, 'cleIdentite rend la clé configurée');

const maintenant = Math.floor(Date.now() / 1000);
const signe = signerIdentite({ userId: cible.user_id, organizationId: cible.organization_id, cle, maintenant });
ok(signe !== null && signe.expiration === maintenant + DUREE_JETON_SECONDES,
  `le jeton porte une échéance de ${DUREE_JETON_SECONDES} s`, `exp=${signe?.expiration}`);

const [corps, mac] = (signe?.jeton ?? '').split('.');
const champs = (corps ?? '').split('|');
ok(champs.length === 5 && champs[0] === 'v1' && champs[1] === cible.user_id
  && champs[2] === cible.organization_id && champs[3] === IDENTITY_PURPOSE
  && /^\d+$/.test(champs[4] ?? ''),
  'format v1|<user>|<org>|usage|<exp> conforme', corps);
ok(/^[0-9a-f]{64}$/.test(mac ?? ''), 'le MAC est un HMAC-SHA256 hexadécimal de 64 caractères');

ok(signerIdentite({ userId: cible.user_id, organizationId: cible.organization_id, cle: 'trop-court' }) === null,
  'une clé trop courte est REFUSÉE, pas tronquée');
ok(signerIdentite({ userId: cible.user_id, organizationId: cible.organization_id, cle: 'z'.repeat(64) }) === null,
  'une clé qui n est pas de l hexadécimal est REFUSÉE — sinon Buffer.from tronquerait silencieusement');

/* --- 3. la base vérifie ce que l application a signé ---------------------- */
const app = cli(URL_APP);
await app.connect();

async function identiteVue(gucs: Record<string, string>): Promise<string | null> {
  await app.query('BEGIN');
  try {
    for (const [k, v] of Object.entries(gucs)) {
      await app.query('SELECT set_config($1,$2,true)', [k, v]);
    }
    const r = await app.query('SELECT public.tracefab_current_user_id() AS u');
    return r.rows[0].u;
  } catch {
    return null;
  } finally {
    await app.query('ROLLBACK').catch(() => {});
  }
}

const contexte = (jeton: string, org = cible.organization_id, user = cible.user_id) => ({
  'tracefab.user_id': user,
  'tracefab.active_organization_id': org,
  'tracefab.identity': jeton,
});

const vu = await identiteVue(contexte(signe!.jeton));
ok(vu === cible.user_id, 'la base reconnaît le jeton signé par le code applicatif', `vu=${vu}`);

const autreCle = randomBytes(32).toString('hex');
const jetonAutreCle = signerIdentite({ userId: cible.user_id, organizationId: cible.organization_id, cle: autreCle })!.jeton;
ok((await identiteVue(contexte(jetonAutreCle))) !== cible.user_id,
  'un jeton signé avec une AUTRE clé n est pas reconnu — la clé est bien un secret');

const jetonAutreOrg = signerIdentite({ userId: cible.user_id, organizationId: autre.id, cle })!.jeton;
ok((await identiteVue(contexte(jetonAutreOrg))) !== cible.user_id,
  'un jeton émis pour une autre organisation ne vaut pas dans ce contexte');

const expire = signerIdentite({ userId: cible.user_id, organizationId: cible.organization_id, cle, maintenant: maintenant - 3600 })!.jeton;
ok((await identiteVue(contexte(expire))) !== cible.user_id, 'un jeton expiré n est pas reconnu');

// Le GUC seul ne doit pas suffire dès que le mode strict est actif : c'est le
// résidu R-A1, et c'est ce que le jeton vient fermer.
const strictAvant = (await admin.query('SELECT strict FROM public.tracefab_identity_politique WHERE singleton')).rows[0].strict;
await admin.query('UPDATE public.tracefab_identity_politique SET strict = true, modifie_le = now() WHERE singleton');
try {
  ok((await identiteVue({ 'tracefab.user_id': cible.user_id, 'tracefab.active_organization_id': cible.organization_id })) === null,
    'en mode strict, le GUC tracefab.user_id seul ne rend AUCUNE identité');
  ok((await identiteVue(contexte(signe!.jeton))) === cible.user_id,
    'en mode strict, le jeton signé continue de fonctionner');
} finally {
  await admin.query('UPDATE public.tracefab_identity_politique SET strict = $1, modifie_le = now() WHERE singleton', [strictAvant]);
}

/* --- 4. nettoyage --------------------------------------------------------- */
for (const v of nouvelles) {
  await admin.query('DELETE FROM public.tracefab_identity_cles WHERE version = $1', [v]);
}
const restant = (await admin.query('SELECT count(*)::int AS n FROM public.tracefab_identity_cles WHERE version > $1', [versionMax])).rows[0].n;
ok(restant === 0, 'la clé de test est retirée — aucune clé résiduelle');

await app.end();
await admin.end();

console.log('');
if (echecs === 0) {
  console.log(`  Signataire applicatif + vérification en base : ${assertions} assertions.`);
  process.exit(0);
}
console.log(`  ${echecs} ÉCHEC sur ${assertions} assertions.`);
process.exit(1);
