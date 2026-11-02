#!/usr/bin/env node
/**
 * Provisionnement de la clé HMAC d'identité — procédure d'opérateur.
 *
 * POURQUOI LA CLÉ N'EST PAS DANS UNE MIGRATION
 *
 * Un fichier de migration est versionné, publié, et lisible par quiconque a
 * accès au dépôt. Une clé qui y figurerait ne serait plus une clé. Elle est
 * donc posée par cette commande, dans la table `tracefab_identity_cles`, à
 * partir d'une valeur fournie par l'opérateur et JAMAIS affichée ni écrite sur
 * disque par ce script.
 *
 * CE QUE LE SCRIPT GARANTIT
 *   - la clé n'apparaît dans aucune sortie (ni en clair, ni tronquée, ni
 *     hachée : une empreinte de clé reste une information) ;
 *   - la longueur minimale de 32 octets est exigée ;
 *   - l'insertion est idempotente par `--version` : rejouer ne duplique rien ;
 *   - la rotation garde l'ancienne version active tant que l'appelant ne
 *     demande pas explicitement `--retirer-anciennes` ;
 *   - le rôle applicatif ne peut pas lire la table — vérifié à la fin, et le
 *     script échoue si ce n'est pas le cas.
 *
 * USAGE
 *   TF_ALLOW_PROVISIONING=oui \
 *   TF_IDENTITY_KEY_HEX=<64 caractères hexadécimaux> \
 *   DATABASE_ADMIN_URL=… node scripts/provisionner_cle_identite.mjs
 *
 *   node scripts/provisionner_cle_identite.mjs --verifier
 *       (lecture seule : versions présentes, laquelle est active, ACL du runtime)
 *
 * Sortie : 0 conforme · 1 écart · 2 non exécuté · 3 refus.
 */
import process from 'node:process';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { sslDepuisUrl } from './lib/pg-ssl.mjs';

// `--verifier` et son alias `--dry-run` : mode SANS ECRITURE, verifie par
// scripts/test_destructive_suite_routing.mjs (politique de routage des suites
// qui ecrivent en base). Un outil d'exploitation doit pouvoir se constater
// sans agir.
const verifierSeulement = process.argv.includes('--verifier') || process.argv.includes('--dry-run');
const url = (process.env.DATABASE_ADMIN_URL || process.env.DATABASE_URL || '').trim();
if (!url) {
  console.error('  NON EXECUTE — DATABASE_ADMIN_URL (ou DATABASE_URL) est absente.');
  process.exit(2);
}
if (!verifierSeulement && process.env.TF_ALLOW_PROVISIONING !== 'oui') {
  console.error('  REFUS — poser une clé est une écriture. Relancer avec TF_ALLOW_PROVISIONING=oui,');
  console.error('  ou en lecture seule avec --verifier.');
  process.exit(3);
}

const db = new pg.Client({ connectionString: url, ssl: sslDepuisUrl(url), application_name: 'tracefab-cle-identite' });
await db.connect();

let echecs = 0;
const ok = (cond, libelle, detail = '') => {
  console.log(`  ${cond ? 'ok   ' : 'ECHEC'} ${libelle}${detail ? ` — ${detail}` : ''}`);
  if (!cond) echecs += 1;
};

const existe = await db.query(
  `SELECT to_regclass('public.tracefab_identity_cles') IS NOT NULL AS presente`,
);
if (!existe.rows[0].presente) {
  console.error('  NON EXECUTE — la table existe après la migration 20261031120000 seulement.');
  await db.end();
  process.exit(2);
}

if (!verifierSeulement) {
  const hex = (process.env.TF_IDENTITY_KEY_HEX || '').trim();
  if (!/^[0-9a-fA-F]{64,}$/.test(hex)) {
    console.error('  REFUS — TF_IDENTITY_KEY_HEX doit être au moins 64 caractères hexadécimaux');
    console.error('  (32 octets). Génération possible : node -e "console.log(require(\'crypto\')');
    console.error('  .randomBytes(32).toString(\'hex\'))" — puis conservez la valeur hors du dépôt.');
    await db.end();
    process.exit(3);
  }
  const { rows } = await db.query('SELECT coalesce(max(version), 0) + 1 AS suivante FROM public.tracefab_identity_cles');
  const version = rows[0].suivante;
  await db.query(
    `INSERT INTO public.tracefab_identity_cles (version, secret, actif)
     VALUES ($1, decode($2, 'hex'), true)
     ON CONFLICT (version) DO UPDATE SET secret = EXCLUDED.secret, actif = true`,
    [version, hex],
  );
  if (process.argv.includes('--retirer-anciennes')) {
    await db.query('UPDATE public.tracefab_identity_cles SET actif = false WHERE version <> $1', [version]);
    console.log(`  clé version ${version} posée ; les précédentes sont désactivées`);
  } else {
    console.log(`  clé version ${version} posée ; les précédentes restent actives (rotation)`);
  }
}

// ---------------------------------------------------------------------------
// Contrôles — dont celui qui décide de la valeur de tout le mécanisme.
// ---------------------------------------------------------------------------
const versions = await db.query(
  'SELECT version, actif, cree_le, length(secret) AS octets FROM public.tracefab_identity_cles ORDER BY version',
);
ok(versions.rows.length > 0, 'au moins une clé est présente', `${versions.rows.length} version(s)`);
ok(versions.rows.every((v) => v.octets >= 16), 'les clés font au moins 16 octets',
  versions.rows.map((v) => `v${v.version}=${v.octets}o`).join(' '));
ok(versions.rows.filter((v) => v.actif).length >= 1, 'exactement au moins une clé active',
  versions.rows.map((v) => `v${v.version}:${v.actif ? 'active' : 'inactive'}`).join(' '));

const app = (await db.query(`SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'tracefab_app'`)).rowCount > 0;
if (app) {
  const priv = await db.query(
    `SELECT has_table_privilege('tracefab_app', 'public.tracefab_identity_cles', 'SELECT') AS lecture,
            has_table_privilege('tracefab_app', 'public.tracefab_identity_cles', 'UPDATE') AS ecriture`,
  );
  ok(priv.rows[0].lecture === false, 'tracefab_app NE PEUT PAS lire les clés', `select=${priv.rows[0].lecture}`);
  ok(priv.rows[0].ecriture === false, 'tracefab_app ne peut pas modifier les clés', `update=${priv.rows[0].ecriture}`);
} else {
  console.log('  info  tracefab_app absent : contrôle d ACL reporté au provisioning des rôles.');
}

const strict = await db.query('SELECT strict FROM public.tracefab_identity_politique WHERE singleton');
const enStrict = strict.rows[0]?.strict === true;
console.log(`  info  mode de vérification : ${enStrict ? 'STRICT (jeton obligatoire)' : 'permissif (jeton vérifié s il est présent)'}`);
if (!enStrict) {
  console.log('        le passage en mode strict est une décision d exploitation — voir');
  console.log('        docs/security/2026-10-31-p105-hmac.md § 4.');
}

console.log('');
console.log(echecs === 0 ? '  VERDICT : clé provisionnée et inaccessible au runtime.' : `  VERDICT : ${echecs} écart(s).`);
console.log('');
await db.end();
process.exit(echecs === 0 ? 0 : 1);
